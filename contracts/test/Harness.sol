// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Test scaffolding, with no dependencies.
 *
 * `forge-std` is deliberately absent from this project: a consumer integrating from
 * `docs/SIGNAL.md` should be able to copy `src/` into their own build, and a reviewer
 * should be able to run these tests on a fresh clone with nothing installed but
 * `forge`. That costs a few dozen lines here — the cheatcode interface below, and
 * assertion helpers — and buys a suite with a zero-length dependency tree.
 *
 * Reverts are asserted with `try`/`catch` rather than `vm.expectRevert`, which also
 * makes the assertions stronger: each one checks the specific error selector, so a test
 * cannot pass because the call reverted for an unrelated reason.
 */

/// The subset of Foundry's cheatcodes these tests use.
interface Vm {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonString(string calldata json, string calldata key)
        external
        pure
        returns (string memory);
    function parseJsonBytes(string calldata json, string calldata key)
        external
        pure
        returns (bytes memory);
    function parseJsonAddress(string calldata json, string calldata key)
        external
        pure
        returns (address);
    function parseJsonBytesArray(string calldata json, string calldata key)
        external
        pure
        returns (bytes[] memory);
    function parseJsonAddressArray(string calldata json, string calldata key)
        external
        pure
        returns (address[] memory);
    function parseUint(string calldata value) external pure returns (uint256);
    function roll(uint256 blockNumber) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        pure
        returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function envOr(string calldata name, string calldata defaultValue)
        external
        view
        returns (string memory);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function activeFork() external view returns (uint256);
    /// Carries a deployed contract across a fork switch. Without it the consumer's code
    /// does not exist on the new fork and every call reverts for a reason that has
    /// nothing to do with what is under test.
    function makePersistent(address account) external;
}

abstract contract Test {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function assertTrue(bool condition, string memory context) internal pure {
        if (!condition) revert(string.concat("assertTrue failed: ", context));
    }

    function assertEq(uint256 got, uint256 expected, string memory context) internal pure {
        if (got != expected) {
            revert(
                string.concat(
                    context, ": got ", _toString(got), ", expected ", _toString(expected)
                )
            );
        }
    }

    function assertEq(bytes32 got, bytes32 expected, string memory context) internal pure {
        if (got != expected) revert(string.concat("assertEq(bytes32) failed: ", context));
    }

    function assertEq(address got, address expected, string memory context) internal pure {
        if (got != expected) revert(string.concat("assertEq(address) failed: ", context));
    }

    function assertEq(string memory got, string memory expected, string memory context)
        internal
        pure
    {
        if (keccak256(bytes(got)) != keccak256(bytes(expected))) {
            revert(string.concat(context, ": got ", got, ", expected ", expected));
        }
    }

    /// The selector a revert carried. Zero for a bare `revert("...")` or an empty revert.
    function selectorOf(bytes memory err) internal pure returns (bytes4 selector) {
        if (err.length < 4) return bytes4(0);
        selector = bytes4(err[0]) | (bytes4(err[1]) >> 8) | (bytes4(err[2]) >> 16)
            | (bytes4(err[3]) >> 24);
    }

    function assertReverted(bytes memory err, bytes4 expected, string memory context)
        internal
        pure
    {
        bytes4 got = selectorOf(err);
        if (got != expected) {
            revert(
                string.concat(
                    context,
                    ": reverted with selector 0x",
                    _toHex(bytes32(got), 4),
                    ", expected 0x",
                    _toHex(bytes32(expected), 4)
                )
            );
        }
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) digits++;
        bytes memory out = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) out[--digits] = bytes1(uint8(48 + (v % 10)));
        return string(out);
    }

    function _toHex(bytes32 value, uint256 bytesToShow) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(bytesToShow * 2);
        for (uint256 i = 0; i < bytesToShow; i++) {
            uint8 b = uint8(value[i]);
            out[i * 2] = alphabet[b >> 4];
            out[i * 2 + 1] = alphabet[b & 0x0f];
        }
        return string(out);
    }
}

/**
 * The recorded report, and the machinery to construct variants of it.
 *
 * The genuine report is loaded from `test/fixtures/report.json` — real signal bytes from
 * an enclave run against live subgraph data, produced by `npm run fixture:report`.
 * Nothing here imports the TypeScript producer, so a field this suite decodes correctly
 * is a field `docs/SIGNAL.md` described correctly.
 *
 * Variants are built and *signed here*, with the same throwaway dev keys the producer
 * uses. Deriving those keys independently (`keccak256("sentinel-dev-signer-N")`, which
 * `test_FixtureSignersMatchDerivedKeys` checks against the fixture) is what lets this
 * suite mint a valid signature over a report the producer never emitted — an unknown
 * signal version, a truncated body — rather than only mutating bytes after signing.
 */
abstract contract ReportFixture is Test {
    string internal constant FIXTURE = "./test/fixtures/report.json";

    bytes internal rawReport;
    bytes internal reportContext;
    bytes[] internal signatures;
    bytes internal thirdSignature;
    address[] internal signers;
    uint256 internal f;
    address internal workflowOwner;
    string internal workflowName;
    string internal fixtureJson;

    uint64 internal asOfBlock;

    function loadFixture() internal {
        fixtureJson = vm.readFile(FIXTURE);
        rawReport = vm.parseJsonBytes(fixtureJson, ".rawReport");
        reportContext = vm.parseJsonBytes(fixtureJson, ".reportContext");
        signatures = vm.parseJsonBytesArray(fixtureJson, ".signatures");
        thirdSignature = vm.parseJsonBytes(fixtureJson, ".thirdSignature");
        signers = vm.parseJsonAddressArray(fixtureJson, ".signers");
        f = expectedUint(".f");
        workflowOwner = vm.parseJsonAddress(fixtureJson, ".workflowOwner");
        workflowName = vm.parseJsonString(fixtureJson, ".workflowName");
        asOfBlock = uint64(expectedUint(".expected.asOfBlock"));
    }

    /// Numbers in the fixture are decimal strings; see the exporter for why.
    function expectedUint(string memory key) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(fixtureJson, key));
    }

    function expectedString(string memory key) internal view returns (string memory) {
        return vm.parseJsonString(fixtureJson, key);
    }

    /// The dev signing keys, derived the way the producer derives them.
    function devKey(uint256 index) internal pure returns (uint256) {
        return uint256(keccak256(bytes(string.concat("sentinel-dev-signer-", _index(index)))));
    }

    function _index(uint256 index) private pure returns (string memory) {
        require(index < 10, "dev key index is single-digit in the producer");
        bytes memory out = new bytes(1);
        out[0] = bytes1(uint8(48 + index));
        return string(out);
    }

    /// A copy of the genuine report with one byte XORed — tampering, after signing.
    function withByteFlipped(uint256 offset) internal view returns (bytes memory out) {
        out = _copy(rawReport);
        out[offset] = bytes1(uint8(out[offset]) ^ 0x01);
    }

    function _copy(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length);
        for (uint256 i = 0; i < data.length; i++) out[i] = data[i];
    }

    /**
     * Assemble a 109-byte header over an arbitrary body.
     *
     * Offsets are `docs/SIGNAL.md`'s table, written out positionally so that a mistake
     * in the document would show up here as a decode failure rather than being
     * papered over by reusing the library under test.
     */
    function buildRawReport(bytes memory body_, string memory name, address owner)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory nameBytes = bytes(name);
        require(nameBytes.length <= 10, "name exceeds ten bytes");
        bytes memory padded = new bytes(10);
        for (uint256 i = 0; i < nameBytes.length; i++) padded[i] = nameBytes[i];

        return abi.encodePacked(
            uint8(1), // 0    report format version
            bytes32(uint256(0x1111) << 240), // 1    executionId
            uint32(1_760_000_000), // 33   timestamp
            uint32(1), // 37   donId
            uint32(1), // 41   donConfigVersion
            bytes32(uint256(0x2222) << 240), // 45   workflowId
            padded, // 77   workflowName, NUL-padded to ten
            owner, // 87   workflowOwner
            uint16(1), // 107  reportId
            body_ // 109  the ABI-encoded signal
        );
    }

    function reportHash(bytes memory raw, bytes memory context) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(keccak256(raw), context));
    }

    /// Sign a report with the given dev key indices, producing 65-byte r‖s‖v signatures.
    function signWith(bytes memory raw, bytes memory context, uint256[] memory keyIndices)
        internal
        view
        returns (bytes[] memory out)
    {
        bytes32 hash = reportHash(raw, context);
        out = new bytes[](keyIndices.length);
        for (uint256 i = 0; i < keyIndices.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(devKey(keyIndices[i]), hash);
            out[i] = abi.encodePacked(r, s, v);
        }
    }

    function keys(uint256 a) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = a;
    }

    function keys(uint256 a, uint256 b) internal pure returns (uint256[] memory out) {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }

    /// The signal body, encoded field by field from the document's field list.
    function encodeBody(string memory version, uint64 blockNumber, uint16 scoreBps)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            version,
            blockNumber,
            uint32(90), // borrowersObserved
            uint256(5_719_318_802_446_351), // debtUsd6
            uint256(2_866_777_614_673_399), // evaluableDebtUsd6
            uint256(35_923_754_337_877), // multiProtocolDebtUsd6
            uint16(125), // multiProtocolShareBps
            uint16(4330), // leveredShareBps
            uint16(3000), // worstShockBps
            uint256(1_215_514_673_345_420), // worstShockDistressedDebtUsd6
            scoreBps,
            uint16(0), // couplingBuckets
            uint16(3), // suppressedBuckets
            uint32(6), // emodeInferredBorrowers
            uint256(1_036_965_965_190_114) // emodeInferredDebtUsd6
        );
    }
}
