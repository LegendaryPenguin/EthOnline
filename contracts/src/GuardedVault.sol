// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SentinelConsumer} from "./SentinelConsumer.sol";
import {SentinelSignal} from "./SentinelSignal.sol";

/**
 * A lending vault that changes what it allows based on Sentinel's signal.
 *
 * This exists to demonstrate that the signal is actionable on-chain, so the interesting
 * parts are the three judgement calls, not the accounting:
 *
 * **It acts on the change, not the level.** `docs/SIGNAL.md` states why: backtesting
 * found an absolute threshold on the score detected 0 of 5 replayable cascade episodes,
 * while a week-on-week change detected 3 of 5 at a median 24-hour lead. Sample
 * composition drifts across months and the level drifts with it. So the vault keeps a
 * checkpoint score and rolls it forward only once the checkpoint is a week old, and
 * compares each new report against that.
 *
 * **It does not act on a fall.** August's structural break in the underlying data was a
 * nine-point drop. A vault keyed on magnitude would have called that a crisis and
 * frozen its users out of a market that was getting safer.
 *
 * **It fails closed.** No signal, or a signal past `maxBlockAge`, does not mean business
 * as usual — `borrow` reverts. A risk oracle whose absence is indistinguishable from an
 * all-clear is worse than no oracle, because it can be silenced.
 *
 * Deliberately not modelled: interest, shares, liquidation, and any real collateral
 * asset. Those would make the file longer without making the demonstration stronger.
 */
contract GuardedVault is SentinelConsumer {
    /// Blocks in 168 hours at ~298.4 blocks/hour, the pairing lag Sentinel's own
    /// calibration uses so that hour-of-day and day-of-week cancel.
    uint256 public constant WEEK_BLOCKS = 50_131;

    /// Operating points from `docs/SIGNAL.md`, in bps of score. Each carries the
    /// false-alarm rate it was calibrated to: 30%, 20%, 10% of ordinary hours.
    uint16 public constant WATCH_RISE_BPS = 61;
    uint16 public constant WARN_RISE_BPS = 87;
    uint16 public constant ALERT_RISE_BPS = 239;

    uint16 public constant COLLATERAL_NORMAL_BPS = 11_000;
    uint16 public constant COLLATERAL_WATCH_BPS = 12_500;
    uint16 public constant COLLATERAL_WARN_BPS = 14_000;
    uint16 public constant COLLATERAL_ALERT_BPS = 17_500;

    enum Stance {
        Unknown,
        Normal,
        Watch,
        Warn,
        Alert
    }

    struct Reading {
        uint64 asOfBlock;
        uint16 scoreBps;
    }

    /// The most recent accepted report.
    Reading public latest;
    /// The comparison point: the oldest reading still inside the week window.
    Reading public checkpoint;

    Stance public stance;
    uint16 public collateralRequirementBps;
    bool public borrowsPaused;

    uint256 public totalBorrowed;
    mapping(address => uint256) public borrowed;

    event SignalAccepted(uint64 asOfBlock, uint16 scoreBps, int256 riseBps, Stance stance);
    event CheckpointRolled(uint64 asOfBlock, uint16 scoreBps);

    error NoSignalYet();
    error NotNewer(uint64 asOfBlock, uint64 latestBlock);
    error BorrowsPaused();
    error Undercollateralized(uint256 collateralValue, uint256 required);

    constructor(
        address[] memory signers_,
        uint256 f_,
        address workflowOwner_,
        string memory workflowName_,
        uint256 maxBlockAge_
    ) SentinelConsumer(signers_, f_, workflowOwner_, workflowName_, maxBlockAge_) {
        // Not `Normal`: until a signal has been seen, the vault has not been told
        // anything, and that is a different state from having been told all is well.
        stance = Stance.Unknown;
        collateralRequirementBps = COLLATERAL_ALERT_BPS;
        borrowsPaused = true;
    }

    /**
     * Submit a report. Reverts unless it authenticates, and unless it is newer than the
     * last one accepted.
     *
     * The monotonicity requirement is replay protection with a purpose beyond
     * bookkeeping: a genuine older report, resubmitted, would move the comparison
     * backwards and could clear an alert that current data does not clear.
     */
    function submitSignal(
        bytes calldata rawReport,
        bytes calldata reportContext,
        bytes[] calldata signatures
    ) external returns (Stance) {
        (, SentinelSignal.Signal memory signal) = verify(rawReport, reportContext, signatures);

        if (signal.asOfBlock <= latest.asOfBlock) {
            revert NotNewer(signal.asOfBlock, latest.asOfBlock);
        }

        Reading memory reading = Reading(signal.asOfBlock, signal.systemicRiskScoreBps);

        if (checkpoint.asOfBlock == 0) {
            checkpoint = reading;
            emit CheckpointRolled(reading.asOfBlock, reading.scoreBps);
        }

        // Signed: a fall is a negative rise and must stay negative rather than
        // underflowing into a very large positive one.
        int256 riseBps = int256(uint256(reading.scoreBps)) - int256(uint256(checkpoint.scoreBps));

        Stance next = Stance.Normal;
        if (riseBps >= int256(uint256(ALERT_RISE_BPS))) next = Stance.Alert;
        else if (riseBps >= int256(uint256(WARN_RISE_BPS))) next = Stance.Warn;
        else if (riseBps >= int256(uint256(WATCH_RISE_BPS))) next = Stance.Watch;

        latest = reading;
        stance = next;
        collateralRequirementBps = _requirementFor(next);
        borrowsPaused = next == Stance.Alert;

        // Rolled after the comparison, so this reading becomes the baseline for the week
        // that follows rather than for itself.
        if (reading.asOfBlock >= checkpoint.asOfBlock + WEEK_BLOCKS) {
            checkpoint = reading;
            emit CheckpointRolled(reading.asOfBlock, reading.scoreBps);
        }

        emit SignalAccepted(reading.asOfBlock, reading.scoreBps, riseBps, next);
        return next;
    }

    /// Whether the vault is currently acting on a signal it considers fresh.
    function signalIsFresh() public view returns (bool) {
        return latest.asOfBlock != 0 && block.number - latest.asOfBlock <= maxBlockAge;
    }

    /**
     * Borrow against collateral, at whatever requirement the current stance sets.
     *
     * Both refusals below are the point of the contract: a paused vault and a stale
     * vault behave the same way, because in neither case does the contract know that
     * borrowing is safe.
     */
    function borrow(uint256 collateralValue, uint256 amount) external {
        if (latest.asOfBlock == 0) revert NoSignalYet();
        if (!signalIsFresh()) {
            revert StaleSignal(block.number - latest.asOfBlock, maxBlockAge);
        }
        if (borrowsPaused) revert BorrowsPaused();

        uint256 required = ((borrowed[msg.sender] + amount) * collateralRequirementBps) / 10_000;
        if (collateralValue < required) revert Undercollateralized(collateralValue, required);

        borrowed[msg.sender] += amount;
        totalBorrowed += amount;
    }

    /// The largest borrow `collateralValue` supports right now. Zero when refusing.
    function borrowCapacity(uint256 collateralValue) external view returns (uint256) {
        if (borrowsPaused || !signalIsFresh()) return 0;
        return (collateralValue * 10_000) / collateralRequirementBps;
    }

    function _requirementFor(Stance s) private pure returns (uint16) {
        if (s == Stance.Alert) return COLLATERAL_ALERT_BPS;
        if (s == Stance.Warn) return COLLATERAL_WARN_BPS;
        if (s == Stance.Watch) return COLLATERAL_WATCH_BPS;
        return COLLATERAL_NORMAL_BPS;
    }
}
