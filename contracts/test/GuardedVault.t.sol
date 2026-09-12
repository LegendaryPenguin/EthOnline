// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReportFixture} from "./Harness.sol";
import {SentinelConsumer} from "../src/SentinelConsumer.sol";
import {GuardedVault} from "../src/GuardedVault.sol";

/**
 * The vault's behaviour: what the signal actually changes.
 *
 * A consumer that verifies a report and then logs it proves the wire format works and
 * nothing else. These tests are about the decisions — that the stance moves on a
 * *rise* against a week-old baseline and not on the level, that a fall moves nothing,
 * that an alert stops new borrowing, and that the absence of a fresh signal is treated
 * as dangerous rather than as permission.
 *
 * Reports here are minted in-test with the dev keys (see `Harness.sol`), because a
 * sequence of readings a week apart is not something a single recorded fixture can
 * supply. The one recorded report is used where its real values matter, in
 * `SentinelConsumer.t.sol`.
 */
contract GuardedVaultTest is ReportFixture {
    uint256 internal constant MAX_BLOCK_AGE = 100;
    uint64 internal constant BASE_BLOCK = 20_000_000;
    uint16 internal constant BASE_SCORE = 2201;

    GuardedVault internal vault;

    function setUp() public {
        loadFixture();
        vault = new GuardedVault(signers, f, workflowOwner, workflowName, MAX_BLOCK_AGE);
        vm.roll(BASE_BLOCK + 10);
    }

    /// Submit a signal at a block with a score, from the head ten blocks later.
    function submit(uint64 blockNumber, uint16 scoreBps) internal returns (GuardedVault.Stance) {
        vm.roll(blockNumber + 10);
        bytes memory raw = buildRawReport(
            encodeBody("sentinel-signal/1", blockNumber, scoreBps), workflowName, workflowOwner
        );
        bytes[] memory sigs = signWith(raw, reportContext, keys(0, 1));
        return vault.submitSignal(raw, reportContext, sigs);
    }

    // ─── Before anything is known ───────────────────────────────────────────────

    function test_StartsClosedRatherThanNormal() public view {
        // Until a signal arrives, the vault has not been told the book is calm — it has
        // not been told anything, and those are different states.
        assertTrue(vault.stance() == GuardedVault.Stance.Unknown, "initial stance");
        assertTrue(vault.borrowsPaused(), "initially paused");
        assertEq(vault.borrowCapacity(1_000_000), 0, "no capacity before a signal");
    }

    function test_RefusesToBorrowBeforeAnySignal() public {
        try vault.borrow(1_000_000, 1) {
            revert("borrowed with no signal at all");
        } catch (bytes memory err) {
            assertReverted(err, GuardedVault.NoSignalYet.selector, "no signal yet");
        }
    }

    // ─── The first signal establishes a baseline, not an alarm ──────────────────

    function test_FirstSignalIsNormalWhateverItsLevel() public {
        // The level is not a threshold: sample composition drifts across months, so a
        // high first reading says nothing until there is something to compare it to.
        GuardedVault.Stance stance = submit(BASE_BLOCK, 9_000);
        assertTrue(stance == GuardedVault.Stance.Normal, "first reading is a baseline");
        assertEq(vault.collateralRequirementBps(), vault.COLLATERAL_NORMAL_BPS(), "requirement");
        assertTrue(!vault.borrowsPaused(), "not paused on a first high reading");
    }

    function test_AllowsBorrowingOnceAFreshSignalExists() public {
        submit(BASE_BLOCK, BASE_SCORE);
        // 110% required, so 1.1 units of collateral supports 1 unit of debt.
        vault.borrow(1_100_000, 1_000_000);
        assertEq(vault.borrowed(address(this)), 1_000_000, "borrowed");

        try vault.borrow(1_000_000, 1_000_000) {
            revert("borrowed beyond the collateral requirement");
        } catch (bytes memory err) {
            assertReverted(err, GuardedVault.Undercollateralized.selector, "thin collateral");
        }
    }

    // ─── The ladder ─────────────────────────────────────────────────────────────

    function test_TightensAtEachOperatingPoint() public {
        submit(BASE_BLOCK, BASE_SCORE);

        // Just under the weakest threshold: nothing moves.
        GuardedVault.Stance quiet = submit(BASE_BLOCK + 100, BASE_SCORE + 60);
        assertTrue(quiet == GuardedVault.Stance.Normal, "60 bps is below watch");
        assertEq(vault.collateralRequirementBps(), vault.COLLATERAL_NORMAL_BPS(), "still normal");

        GuardedVault.Stance watch = submit(BASE_BLOCK + 200, BASE_SCORE + 61);
        assertTrue(watch == GuardedVault.Stance.Watch, "61 bps is the watch point");
        assertEq(vault.collateralRequirementBps(), vault.COLLATERAL_WATCH_BPS(), "watch requirement");

        GuardedVault.Stance warn = submit(BASE_BLOCK + 300, BASE_SCORE + 87);
        assertTrue(warn == GuardedVault.Stance.Warn, "87 bps is the warn point");
        assertEq(vault.collateralRequirementBps(), vault.COLLATERAL_WARN_BPS(), "warn requirement");
        assertTrue(!vault.borrowsPaused(), "warn tightens, it does not stop");

        GuardedVault.Stance alert = submit(BASE_BLOCK + 400, BASE_SCORE + 239);
        assertTrue(alert == GuardedVault.Stance.Alert, "239 bps is the alert point");
        assertTrue(vault.borrowsPaused(), "alert pauses new borrowing");
    }

    function test_CapacityFallsAsTheStanceTightens() public {
        submit(BASE_BLOCK, BASE_SCORE);
        uint256 normal = vault.borrowCapacity(1_000_000);
        submit(BASE_BLOCK + 100, BASE_SCORE + 100);
        uint256 warn = vault.borrowCapacity(1_000_000);
        assertTrue(warn < normal, "the same collateral must support less under warn");
        submit(BASE_BLOCK + 200, BASE_SCORE + 500);
        assertEq(vault.borrowCapacity(1_000_000), 0, "no capacity under alert");
    }

    function test_PausesNewBorrowingUnderAlert() public {
        submit(BASE_BLOCK, BASE_SCORE);
        submit(BASE_BLOCK + 100, BASE_SCORE + 300);
        try vault.borrow(10_000_000, 1) {
            revert("borrowed under an alert, however well collateralized");
        } catch (bytes memory err) {
            assertReverted(err, GuardedVault.BorrowsPaused.selector, "paused");
        }
    }

    // ─── Direction ──────────────────────────────────────────────────────────────

    function test_DoesNotFireOnAFallHoweverLarge() public {
        // August's structural break in the underlying data was a nine-point drop. A
        // vault keyed on magnitude would have frozen its users out of a market that was
        // getting safer.
        submit(BASE_BLOCK, 3_000);
        GuardedVault.Stance stance = submit(BASE_BLOCK + 100, 1_000);
        assertTrue(stance == GuardedVault.Stance.Normal, "a 20-point fall is not an alert");
        assertTrue(!vault.borrowsPaused(), "not paused on a fall");
    }

    function test_ComparesAgainstTheWeekOldBaselineNotThePreviousReport() public {
        // A slow climb of 50 bps per report is invisible to a consumer that compares
        // consecutive readings, and visible to one that holds a week-old baseline. This
        // is the whole reason the checkpoint exists.
        submit(BASE_BLOCK, 2_000);
        GuardedVault.Stance stance;
        for (uint64 i = 1; i <= 5; i++) {
            stance = submit(BASE_BLOCK + i * 100, uint16(2_000 + i * 50));
        }
        assertTrue(stance == GuardedVault.Stance.Alert, "a 250 bps climb should be an alert");
    }

    function test_RollsTheBaselineForwardAfterAWeek() public {
        submit(BASE_BLOCK, 2_000);
        (, uint16 firstBaseline) = vault.checkpoint();
        assertEq(firstBaseline, 2_000, "baseline is the first reading");

        // A week later the elevated level has become the new normal, so the baseline
        // moves and the same level stops reading as a rise.
        uint64 later = BASE_BLOCK + uint64(vault.WEEK_BLOCKS());
        GuardedVault.Stance atRoll = submit(later, 2_400);
        assertTrue(atRoll == GuardedVault.Stance.Alert, "still an alert at the moment of rolling");
        (, uint16 rolled) = vault.checkpoint();
        assertEq(rolled, 2_400, "baseline rolled to the reading that fired");

        GuardedVault.Stance after_ = submit(later + 100, 2_400);
        assertTrue(after_ == GuardedVault.Stance.Normal, "an unchanged level is not a rise");
    }

    // ─── Freshness and replay ───────────────────────────────────────────────────

    function test_StopsBorrowingWhenTheSignalGoesStale() public {
        submit(BASE_BLOCK, BASE_SCORE);
        vault.borrow(1_100_000, 1_000_000);

        vm.roll(BASE_BLOCK + MAX_BLOCK_AGE + 1);
        assertTrue(!vault.signalIsFresh(), "signal should be stale");
        assertEq(vault.borrowCapacity(1_000_000), 0, "no capacity on a stale signal");
        try vault.borrow(10_000_000, 1) {
            revert("borrowed against a stale signal");
        } catch (bytes memory err) {
            // Fails closed. An oracle whose silence reads as an all-clear can be silenced.
            assertReverted(err, SentinelConsumer.StaleSignal.selector, "stale on borrow");
        }
    }

    function test_RefusesToRewindToAnOlderReport() public {
        submit(BASE_BLOCK, BASE_SCORE);
        submit(BASE_BLOCK + 20, BASE_SCORE + 300);
        assertTrue(vault.borrowsPaused(), "alert raised");

        // A genuine, correctly signed, *earlier* report — the baseline reading itself,
        // resubmitted. Accepting it would move the comparison backwards and clear an
        // alert that current data does not clear. The two readings are close together so
        // that the older one is still inside the freshness window: this test is about
        // monotonicity, and a staleness rejection would hide that.
        vm.roll(BASE_BLOCK + 30);
        bytes memory raw = buildRawReport(
            encodeBody("sentinel-signal/1", BASE_BLOCK, BASE_SCORE), workflowName, workflowOwner
        );
        bytes[] memory sigs = signWith(raw, reportContext, keys(0, 1));
        try vault.submitSignal(raw, reportContext, sigs) {
            revert("accepted a replayed older report");
        } catch (bytes memory err) {
            assertReverted(err, GuardedVault.NotNewer.selector, "older report");
        }
        assertTrue(vault.borrowsPaused(), "the alert survived the replay attempt");
    }

    function test_RefusesAnUnauthenticatedSubmission() public {
        // The vault inherits every check in SentinelConsumer; this is the one assertion
        // that the inheritance is actually wired to the state-changing path.
        vm.roll(BASE_BLOCK + 10);
        bytes memory raw = buildRawReport(
            encodeBody("sentinel-signal/1", BASE_BLOCK, BASE_SCORE), workflowName, workflowOwner
        );
        bytes[] memory sigs = signWith(raw, reportContext, keys(0, 7));
        try vault.submitSignal(raw, reportContext, sigs) {
            revert("accepted a report signed from outside the DON");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.UnknownSigner.selector, "foreign signer");
        }
        assertTrue(vault.stance() == GuardedVault.Stance.Unknown, "state unchanged");
    }
}
