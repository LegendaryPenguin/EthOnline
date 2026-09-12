// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReportFixture} from "./Harness.sol";
import {SentinelConsumer} from "../src/SentinelConsumer.sol";
import {SentinelSignal} from "../src/SentinelSignal.sol";

/// A consumer with no behaviour, so verification can be tested without a vault's policy
/// on top of it. `verify` is `view`, so the tests call it directly.
contract PlainConsumer is SentinelConsumer {
    constructor(
        address[] memory signers_,
        uint256 f_,
        address owner_,
        string memory name_,
        uint256 maxBlockAge_
    ) SentinelConsumer(signers_, f_, owner_, name_, maxBlockAge_) {}
}

/**
 * The Solidity consumer against bytes the TypeScript producer emitted.
 *
 * Two claims are under test. First, that `docs/SIGNAL.md` is sufficient to integrate
 * from: these contracts were written from that document and never from `lib/signal/`, so
 * every field asserted below is a field the document described unambiguously enough for
 * an independent implementation to land in the right slot. Second, that the consumer
 * refuses what it must — each negative case asserts a specific error selector, so no
 * test can pass because something else went wrong.
 */
contract SentinelConsumerTest is ReportFixture {
    uint256 internal constant MAX_BLOCK_AGE = 100;

    PlainConsumer internal consumer;

    function setUp() public {
        loadFixture();
        consumer = new PlainConsumer(signers, f, workflowOwner, workflowName, MAX_BLOCK_AGE);
        // The fixture is a recording of a real reading, so the head is placed where that
        // reading was fresh. The staleness rule itself is exercised below by moving it.
        vm.roll(asOfBlock + 10);
    }

    // ─── The document is sufficient ─────────────────────────────────────────────

    function test_DecodesEveryFieldOfTheRealPayload() public view {
        (, SentinelSignal.Signal memory s) = consumer.verify(rawReport, reportContext, signatures);

        assertEq(s.version, expectedString(".expected.version"), "version");
        assertEq(s.asOfBlock, expectedUint(".expected.asOfBlock"), "asOfBlock");
        assertEq(s.borrowersObserved, expectedUint(".expected.borrowersObserved"), "borrowers");
        assertEq(s.debtUsd6, expectedUint(".expected.debtUsd6"), "debtUsd6");
        assertEq(s.evaluableDebtUsd6, expectedUint(".expected.evaluableDebtUsd6"), "evaluable");
        assertEq(
            s.multiProtocolDebtUsd6, expectedUint(".expected.multiProtocolDebtUsd6"), "multiDebt"
        );
        assertEq(
            s.multiProtocolShareBps, expectedUint(".expected.multiProtocolShareBps"), "multiShare"
        );
        assertEq(s.leveredShareBps, expectedUint(".expected.leveredShareBps"), "leveredShare");
        assertEq(s.worstShockBps, expectedUint(".expected.worstShockBps"), "worstShock");
        assertEq(
            s.worstShockDistressedDebtUsd6,
            expectedUint(".expected.worstShockDistressedDebtUsd6"),
            "distressed"
        );
        assertEq(s.systemicRiskScoreBps, expectedUint(".expected.systemicRiskScoreBps"), "score");
        assertEq(s.couplingBuckets, expectedUint(".expected.couplingBuckets"), "coupling");
        assertEq(s.suppressedBuckets, expectedUint(".expected.suppressedBuckets"), "suppressed");
        assertEq(
            s.emodeInferredBorrowers, expectedUint(".expected.emodeInferredBorrowers"), "emodeBorrowers"
        );
        assertEq(s.emodeInferredDebtUsd6, expectedUint(".expected.emodeInferredDebtUsd6"), "emodeDebt");
    }

    function test_TheDecodeIsNotVacuous() public view {
        // Every field above could pass while the tuple was mis-aligned, if the values
        // happened to be zero. They are not: the payload carries real magnitudes.
        (, SentinelSignal.Signal memory s) = consumer.verify(rawReport, reportContext, signatures);
        assertTrue(s.debtUsd6 > 1e15, "observed debt should be billions at 6 decimals");
        assertTrue(s.evaluableDebtUsd6 < s.debtUsd6, "evaluable is a subset of observed");
        assertTrue(s.systemicRiskScoreBps > 0 && s.systemicRiskScoreBps <= 10_000, "score in range");
        assertTrue(s.suppressedBuckets > 0, "the k-anonymity floor withheld buckets in this run");
    }

    function test_ParsesTheHeaderIdentity() public view {
        (SentinelSignal.Header memory h,) = consumer.verify(rawReport, reportContext, signatures);
        assertEq(h.workflowOwner, workflowOwner, "workflowOwner");
        assertEq(bytes32(h.workflowName), bytes32(SentinelSignal.paddedName(workflowName)), "name");
        assertEq(h.version, 1, "report format version");
        assertEq(h.timestamp, 1_760_000_000, "timestamp as pinned by the exporter");
    }

    function test_FixtureSignersMatchDerivedKeys() public view {
        // The tests below mint their own signatures. If this drifted, they would be
        // signing with keys the fixture's signer set does not contain, and every
        // negative test would pass for the wrong reason.
        for (uint256 i = 0; i < signers.length; i++) {
            assertEq(vm.addr(devKey(i)), signers[i], "derived dev key");
        }
    }

    // ─── Tampering ──────────────────────────────────────────────────────────────

    function test_RejectsAFlippedBodyByte() public {
        bytes memory tampered = withByteFlipped(rawReport.length - 1);
        try consumer.verify(tampered, reportContext, signatures) {
            revert("accepted a tampered body");
        } catch (bytes memory err) {
            // Not "bad signature": recovery over the wrong bytes succeeds and yields an
            // unrelated address. The pinned signer set is what catches tampering.
            assertReverted(err, SentinelConsumer.UnknownSigner.selector, "flipped body byte");
        }
    }

    function test_RejectsARewrittenDonId() public {
        // Offset 37. Inside the header, which the outer signature also covers — so a
        // consumer that hashed only the body would accept this.
        try consumer.verify(withByteFlipped(37), reportContext, signatures) {
            revert("accepted a rewritten header field");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.UnknownSigner.selector, "rewritten donId");
        }
    }

    function test_RejectsAReplayUnderADifferentSequenceNumber() public {
        bytes memory context = _copy(reportContext);
        context[63] = bytes1(uint8(context[63]) ^ 0x01);
        try consumer.verify(rawReport, context, signatures) {
            revert("accepted a report under a different context");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.UnknownSigner.selector, "rewritten seqNr");
        }
    }

    // ─── Identity ───────────────────────────────────────────────────────────────

    function test_RejectsAValidlySignedReportFromAnotherWorkflow() public {
        // The forgery integrations miss. The DON signs whatever it runs and anyone can
        // deploy to it, so these signatures are *genuine* — from the right DON, over
        // this exact report. Only the name says it is not Sentinel's.
        bytes memory raw = buildRawReport(
            encodeBody("sentinel-signal/1", asOfBlock, 2201), "attacker", workflowOwner
        );
        bytes[] memory sigs = signWith(raw, reportContext, keys(0, 1));
        try consumer.verify(raw, reportContext, sigs) {
            revert("accepted another workflow's report");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.WrongWorkflowName.selector, "foreign workflow");
        }
    }

    function test_RejectsAnotherOwnersReport() public {
        bytes memory raw = buildRawReport(
            encodeBody("sentinel-signal/1", asOfBlock, 2201), workflowName, address(0xdead)
        );
        bytes[] memory sigs = signWith(raw, reportContext, keys(0, 1));
        try consumer.verify(raw, reportContext, sigs) {
            revert("accepted another owner's report");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.WrongWorkflowOwner.selector, "foreign owner");
        }
    }

    function test_ChecksIdentityBeforeSignatures() public {
        // Order matters, and this proves it holds: the name is wrong *and* the
        // signatures do not cover these bytes. A consumer that verified signatures
        // first would report the wrong reason — and would have spent an ecrecover
        // before learning the report was never Sentinel's.
        bytes memory raw = buildRawReport(
            encodeBody("sentinel-signal/1", asOfBlock, 2201), "attacker", workflowOwner
        );
        try consumer.verify(raw, reportContext, signatures) {
            revert("accepted a mismatched report");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.WrongWorkflowName.selector, "identity first");
        }
    }

    // ─── Quorum ─────────────────────────────────────────────────────────────────

    function test_RejectsASingleSignature() public {
        bytes[] memory one = new bytes[](1);
        one[0] = signatures[0];
        try consumer.verify(rawReport, reportContext, one) {
            revert("accepted a quorum of one where f + 1 is two");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.QuorumNotMet.selector, "short quorum");
        }
    }

    function test_RejectsADuplicatedSignature() public {
        // A single compromised node signing twice must not reach f + 1.
        bytes[] memory doubled = new bytes[](2);
        doubled[0] = signatures[0];
        doubled[1] = signatures[0];
        try consumer.verify(rawReport, reportContext, doubled) {
            revert("counted one signer twice as a quorum");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.DuplicateSigner.selector, "duplicate signer");
        }
    }

    function test_AcceptsADifferentPairFromTheSignerSet() public view {
        // The complement of the duplicate test: two *distinct* signers do reach quorum,
        // so the rejection above is about distinctness and not about the count.
        bytes[] memory pair = new bytes[](2);
        pair[0] = signatures[0];
        pair[1] = thirdSignature;
        consumer.verify(rawReport, reportContext, pair);
    }

    function test_RejectsASignerOutsideTheSet() public {
        // Key 7 is a valid ECDSA key that the pinned set does not contain.
        bytes[] memory sigs = signWith(rawReport, reportContext, keys(0, 7));
        try consumer.verify(rawReport, reportContext, sigs) {
            revert("accepted a signature from outside the DON");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.UnknownSigner.selector, "foreign signer");
        }
    }

    function test_RejectsAMalformedSignature() public {
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = signatures[0];
        sigs[1] = hex"1234";
        try consumer.verify(rawReport, reportContext, sigs) {
            revert("accepted a 2-byte signature");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.BadSignatureLength.selector, "short signature");
        }
    }

    // ─── Semantics ──────────────────────────────────────────────────────────────

    function test_RejectsAnUnknownSignalVersion() public {
        // Correctly signed by the real signer set, and still refused: a decoder reading a
        // later layout would not error, it would return plausible numbers in the wrong
        // fields. This is the one negative case that a signature check cannot cover.
        bytes memory raw = buildRawReport(
            encodeBody("sentinel-signal/2", asOfBlock, 2201), workflowName, workflowOwner
        );
        bytes[] memory sigs = signWith(raw, reportContext, keys(0, 1));
        try consumer.verify(raw, reportContext, sigs) {
            revert("accepted an unknown signal version");
        } catch (bytes memory err) {
            assertReverted(err, SentinelSignal.UnknownVersion.selector, "unknown version");
        }
    }

    function test_RejectsASignalWithNoBlock() public {
        bytes memory raw =
            buildRawReport(encodeBody("sentinel-signal/1", 0, 2201), workflowName, workflowOwner);
        bytes[] memory sigs = signWith(raw, reportContext, keys(0, 1));
        try consumer.verify(raw, reportContext, sigs) {
            revert("accepted a signal with no provenance");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.NoProvenance.selector, "zero block");
        }
    }

    function test_RejectsAFutureBlock() public {
        vm.roll(asOfBlock - 1);
        try consumer.verify(rawReport, reportContext, signatures) {
            revert("accepted a reading from a block the chain has not reached");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.FutureBlock.selector, "future block");
        }
    }

    function test_RejectsAStaleSignal() public {
        vm.roll(asOfBlock + MAX_BLOCK_AGE + 1);
        try consumer.verify(rawReport, reportContext, signatures) {
            revert("accepted a signal past the freshness window");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.StaleSignal.selector, "stale signal");
        }
    }

    function test_AcceptsTheOldestFreshSignal() public {
        // The boundary, from the other side: `age == maxBlockAge` is inside the window.
        vm.roll(asOfBlock + MAX_BLOCK_AGE);
        consumer.verify(rawReport, reportContext, signatures);
    }

    function test_RejectsATruncatedReport() public {
        bytes memory short = new bytes(50);
        try consumer.verify(short, reportContext, signatures) {
            revert("accepted a report shorter than the header");
        } catch (bytes memory err) {
            assertReverted(err, SentinelSignal.ReportTooShort.selector, "truncated report");
        }
    }

    // ─── Deployment-time policy ─────────────────────────────────────────────────

    function test_RefusesAnUnreachableQuorumAtDeployment() public {
        address[] memory one = new address[](1);
        one[0] = signers[0];
        try new PlainConsumer(one, 2, workflowOwner, workflowName, MAX_BLOCK_AGE) {
            revert("deployed a consumer that can never reach quorum");
        } catch (bytes memory err) {
            // Otherwise every report fails for a reason that looks like an attack.
            assertReverted(err, SentinelConsumer.QuorumUnreachable.selector, "unreachable quorum");
        }
    }

    function test_RefusesADuplicatedSignerAtDeployment() public {
        address[] memory dupes = new address[](2);
        dupes[0] = signers[0];
        dupes[1] = signers[0];
        try new PlainConsumer(dupes, 1, workflowOwner, workflowName, MAX_BLOCK_AGE) {
            revert("deployed a consumer whose signer set is one address twice");
        } catch (bytes memory err) {
            assertReverted(err, SentinelConsumer.DuplicateSigner.selector, "duplicate in set");
        }
    }

    // ─── Against real chain state ───────────────────────────────────────────────

    function test_ForkedMainnetHasReachedTheRecordedBlock() public {
        // Only meaningful with a fork, and the whole point of running this suite with
        // `--fork-url`: the recording claims a mainnet block, and mainnet is asked
        // whether it ever produced one. `vm.roll` in the other tests could not.
        string memory rpc = vm.envOr("RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.makePersistent(address(consumer));
        vm.createSelectFork(rpc);
        assertTrue(
            block.number >= asOfBlock,
            "mainnet head is behind the block the signal claims to have read"
        );
        // Against the live head the recording is almost certainly stale, and must be
        // refused on that basis rather than on any other.
        if (block.number - asOfBlock > MAX_BLOCK_AGE) {
            try consumer.verify(rawReport, reportContext, signatures) {
                revert("a recording older than the window was accepted on a live head");
            } catch (bytes memory err) {
                assertReverted(err, SentinelConsumer.StaleSignal.selector, "stale on live head");
            }
        }

        // And it verifies on the same forked chain once the head is placed where the
        // reading was taken — so the refusal above was about age and nothing else.
        vm.roll(asOfBlock + 10);
        consumer.verify(rawReport, reportContext, signatures);
    }
}
