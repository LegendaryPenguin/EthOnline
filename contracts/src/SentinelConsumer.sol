// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SentinelSignal} from "./SentinelSignal.sol";

/**
 * Authenticate a Sentinel report, or revert.
 *
 * The check order is `docs/SIGNAL.md`'s, and it is load-bearing rather than an
 * optimisation:
 *
 *   1. policy sanity — an unreachable quorum is a misconfiguration that looks like an attack
 *   2. length
 *   3. identity — workflow owner and name
 *   4. quorum   — f + 1 distinct pinned signers
 *   5. decode   — only now
 *   6. version
 *   7. provenance — no zero block, no future block
 *   8. freshness  — against asOfBlock, never against the header timestamp
 *
 * Step 3 is the one integrations skip. A DON signs whatever it runs and anyone can
 * deploy a workflow to it, so signatures alone prove that *some* workflow produced the
 * bytes — including one the attacker deployed. Steps 3 and 4 together are what make the
 * report Sentinel's.
 *
 * Step 5's position matters for a different reason: decoding before authenticating is
 * how an attacker's numbers end up in an event log that something downstream later
 * treats as history.
 */
abstract contract SentinelConsumer {
    using SentinelSignal for bytes;

    /// The DON's signer set, pinned at construction. Tampering surfaces as an unknown
    /// signer rather than as a bad signature, so this set is the thing that catches it.
    mapping(address => bool) public isSigner;
    address[] internal signerList;

    /// Byzantine fault tolerance parameter: `f + 1` distinct signers are required.
    uint256 public immutable f;
    address public immutable workflowOwner;
    bytes10 public immutable workflowName;

    /// Maximum age of the signal's own `asOfBlock`, in blocks.
    uint256 public immutable maxBlockAge;

    error EmptySignerSet();
    error QuorumUnreachable(uint256 signers, uint256 required);
    error WrongWorkflowOwner(address got, address expected);
    error WrongWorkflowName(bytes10 got, bytes10 expected);
    error QuorumNotMet(uint256 accepted, uint256 required);
    error BadSignatureLength(uint256 length);
    error UnrecoverableSignature();
    error UnknownSigner(address signer);
    error DuplicateSigner(address signer);
    error NoProvenance();
    error FutureBlock(uint64 asOfBlock, uint256 currentBlock);
    error StaleSignal(uint256 age, uint256 limit);

    constructor(
        address[] memory signers_,
        uint256 f_,
        address workflowOwner_,
        string memory workflowName_,
        uint256 maxBlockAge_
    ) {
        if (signers_.length == 0) revert EmptySignerSet();
        if (signers_.length < f_ + 1) revert QuorumUnreachable(signers_.length, f_ + 1);
        for (uint256 i = 0; i < signers_.length; i++) {
            // A duplicate here would inflate the apparent size of the signer set and
            // weaken the quorum the deployer thinks they configured.
            if (isSigner[signers_[i]]) revert DuplicateSigner(signers_[i]);
            isSigner[signers_[i]] = true;
            signerList.push(signers_[i]);
        }
        f = f_;
        workflowOwner = workflowOwner_;
        workflowName = SentinelSignal.paddedName(workflowName_);
        maxBlockAge = maxBlockAge_;
    }

    function signers() external view returns (address[] memory) {
        return signerList;
    }

    /**
     * Verify and decode, or revert. `view` on purpose: a caller can simulate the exact
     * check a state-changing submission will perform, without submitting.
     */
    function verify(
        bytes memory rawReport,
        bytes memory reportContext,
        bytes[] memory signatures
    ) public view returns (SentinelSignal.Header memory header, SentinelSignal.Signal memory signal) {
        header = rawReport.parseHeader();

        if (header.workflowOwner != workflowOwner) {
            revert WrongWorkflowOwner(header.workflowOwner, workflowOwner);
        }
        if (header.workflowName != workflowName) {
            revert WrongWorkflowName(header.workflowName, workflowName);
        }

        _requireQuorum(SentinelSignal.reportHash(rawReport, reportContext), signatures);

        signal = SentinelSignal.decodeSignal(rawReport.body());

        if (signal.asOfBlock == 0) revert NoProvenance();
        if (signal.asOfBlock > block.number) revert FutureBlock(signal.asOfBlock, block.number);
        uint256 age = block.number - signal.asOfBlock;
        if (age > maxBlockAge) revert StaleSignal(age, maxBlockAge);
    }

    function _requireQuorum(bytes32 hash, bytes[] memory signatures) internal view {
        uint256 required = f + 1;
        address[] memory accepted = new address[](signatures.length);
        uint256 count;

        for (uint256 i = 0; i < signatures.length; i++) {
            address recovered = _recover(hash, signatures[i]);
            if (!isSigner[recovered]) revert UnknownSigner(recovered);
            for (uint256 j = 0; j < count; j++) {
                // One signer's signature repeated is not a quorum. Counting duplicates
                // would let a single compromised node satisfy f + 1 on its own.
                if (accepted[j] == recovered) revert DuplicateSigner(recovered);
            }
            accepted[count++] = recovered;
        }

        if (count < required) revert QuorumNotMet(count, required);
    }

    function _recover(bytes32 hash, bytes memory signature) private pure returns (address) {
        if (signature.length != 65) revert BadSignatureLength(signature.length);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        // Both encodings appear in the wild: 27/28 from Ethereum tooling, 0/1 raw.
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert UnrecoverableSignature();
        address recovered = ecrecover(hash, v, r, s);
        // ecrecover yields the zero address on malformed input rather than reverting.
        if (recovered == address(0)) revert UnrecoverableSignature();
        return recovered;
    }
}
