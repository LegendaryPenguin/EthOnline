// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Sentinel report parsing and decoding.
 *
 * Written from `docs/SIGNAL.md` alone. Nothing in `contracts/` reads the TypeScript
 * producer's source, and nothing in `lib/` reads this — the two implementations meet
 * only at the bytes, which is what makes them evidence that the document is sufficient
 * to integrate from. Field order and offsets below are the document's, not inferred
 * from a working decoder.
 *
 * Pure and view-free: this library only turns bytes into numbers. Deciding whether the
 * numbers may be trusted is `SentinelConsumer`, and the split is deliberate — a caller
 * cannot reach `decodeSignal` through the verifier without the verification having
 * happened first.
 */
library SentinelSignal {
    /// Fixed by the CRE report format.
    uint256 internal constant HEADER_LENGTH = 109;

    /// The only signal version this library claims to understand.
    string internal constant VERSION = "sentinel-signal/1";
    bytes32 internal constant VERSION_HASH = keccak256(bytes(VERSION));

    struct Header {
        uint8 version;
        bytes32 executionId;
        /// Seconds. When the DON spoke — NOT when the data was read. Never use for staleness.
        uint32 timestamp;
        uint32 donId;
        uint32 donConfigVersion;
        bytes32 workflowId;
        /// Ten bytes, right-padded with NULs on the wire; kept padded here so comparison is exact.
        bytes10 workflowName;
        address workflowOwner;
        uint16 reportId;
    }

    struct Signal {
        string version;
        uint64 asOfBlock;
        uint32 borrowersObserved;
        uint256 debtUsd6;
        uint256 evaluableDebtUsd6;
        uint256 multiProtocolDebtUsd6;
        uint16 multiProtocolShareBps;
        uint16 leveredShareBps;
        uint16 worstShockBps;
        uint256 worstShockDistressedDebtUsd6;
        uint16 systemicRiskScoreBps;
        uint16 couplingBuckets;
        uint16 suppressedBuckets;
        uint32 emodeInferredBorrowers;
        uint256 emodeInferredDebtUsd6;
    }

    error ReportTooShort(uint256 length);
    error UnknownVersion(string version);

    /**
     * The hash the DON signs: keccak256(keccak256(rawReport) ‖ reportContext).
     *
     * The inner hash covers `rawReport`, header included, which is the only reason
     * checking the header proves anything.
     */
    function reportHash(bytes memory rawReport, bytes memory reportContext)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(keccak256(rawReport), reportContext));
    }

    function parseHeader(bytes memory rawReport) internal pure returns (Header memory header) {
        if (rawReport.length < HEADER_LENGTH) revert ReportTooShort(rawReport.length);
        header.version = uint8(rawReport[0]);
        header.executionId = _bytes32At(rawReport, 1);
        header.timestamp = uint32(_uintAt(rawReport, 33, 4));
        header.donId = uint32(_uintAt(rawReport, 37, 4));
        header.donConfigVersion = uint32(_uintAt(rawReport, 41, 4));
        header.workflowId = _bytes32At(rawReport, 45);
        header.workflowName = bytes10(_bytes32At(rawReport, 77));
        header.workflowOwner = address(uint160(_uintAt(rawReport, 87, 20)));
        header.reportId = uint16(_uintAt(rawReport, 107, 2));
    }

    /// Everything after the 109-byte header: a standard ABI-encoded tuple.
    function body(bytes memory rawReport) internal pure returns (bytes memory out) {
        if (rawReport.length < HEADER_LENGTH) revert ReportTooShort(rawReport.length);
        uint256 length = rawReport.length - HEADER_LENGTH;
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = rawReport[HEADER_LENGTH + i];
        }
    }

    /**
     * Decode the signal body, refusing any version whose field layout this code was not
     * written against.
     *
     * The refusal is not defensive politeness. ABI tuples are positional, so a decoder
     * reading a reordered or retyped tuple does not revert — it returns plausible
     * numbers in the wrong fields, and a vault would act on them.
     */
    function decodeSignal(bytes memory signalBody) internal pure returns (Signal memory signal) {
        // Decoded as a flat 15-field tuple rather than as `(Signal)`, because the body is
        // an inlined tuple: `abi.decode(body, (Signal))` would read the first word as a
        // head offset and silently mis-align every field.
        (
            string memory version,
            uint64 asOfBlock,
            uint32 borrowersObserved,
            uint256 debtUsd6,
            uint256 evaluableDebtUsd6,
            uint256 multiProtocolDebtUsd6,
            uint16 multiProtocolShareBps,
            uint16 leveredShareBps,
            uint16 worstShockBps,
            uint256 worstShockDistressedDebtUsd6
        ) = abi.decode(
            signalBody,
            (string, uint64, uint32, uint256, uint256, uint256, uint16, uint16, uint16, uint256)
        );
        if (keccak256(bytes(version)) != VERSION_HASH) revert UnknownVersion(version);

        signal.version = version;
        signal.asOfBlock = asOfBlock;
        signal.borrowersObserved = borrowersObserved;
        signal.debtUsd6 = debtUsd6;
        signal.evaluableDebtUsd6 = evaluableDebtUsd6;
        signal.multiProtocolDebtUsd6 = multiProtocolDebtUsd6;
        signal.multiProtocolShareBps = multiProtocolShareBps;
        signal.leveredShareBps = leveredShareBps;
        signal.worstShockBps = worstShockBps;
        signal.worstShockDistressedDebtUsd6 = worstShockDistressedDebtUsd6;
        _decodeTail(signalBody, signal);
    }

    /**
     * Fields 10 through 14, decoded separately.
     *
     * Only because `abi.decode` with fifteen return values exceeds the stack: the split
     * point carries no meaning, and both halves decode the same buffer from the start,
     * so a field cannot land in the wrong slot as a result of it.
     */
    function _decodeTail(bytes memory signalBody, Signal memory signal) private pure {
        (
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint16 systemicRiskScoreBps,
            uint16 couplingBuckets,
            uint16 suppressedBuckets,
            uint32 emodeInferredBorrowers,
            uint256 emodeInferredDebtUsd6
        ) = abi.decode(
            signalBody,
            (
                string,
                uint64,
                uint32,
                uint256,
                uint256,
                uint256,
                uint16,
                uint16,
                uint16,
                uint256,
                uint16,
                uint16,
                uint16,
                uint32,
                uint256
            )
        );
        signal.systemicRiskScoreBps = systemicRiskScoreBps;
        signal.couplingBuckets = couplingBuckets;
        signal.suppressedBuckets = suppressedBuckets;
        signal.emodeInferredBorrowers = emodeInferredBorrowers;
        signal.emodeInferredDebtUsd6 = emodeInferredDebtUsd6;
    }

    /// Ten-byte NUL-padded name, as the header carries it. `"sentinel"` -> `0x73656e746
    /// 96e656c0000`.
    function paddedName(string memory name) internal pure returns (bytes10) {
        bytes memory raw = bytes(name);
        require(raw.length <= 10, "SentinelSignal: workflow name exceeds ten bytes");
        return bytes10(_bytes32At(abi.encodePacked(raw, new bytes(32 - raw.length)), 0));
    }

    function _bytes32At(bytes memory data, uint256 offset) private pure returns (bytes32 word) {
        require(data.length >= offset + 32, "SentinelSignal: read past end");
        assembly {
            word := mload(add(add(data, 0x20), offset))
        }
    }

    /// A big-endian unsigned integer of `length` bytes. Length is at most 32.
    function _uintAt(bytes memory data, uint256 offset, uint256 length)
        private
        pure
        returns (uint256)
    {
        require(length <= 32, "SentinelSignal: field too wide");
        require(data.length >= offset + length, "SentinelSignal: read past end");
        uint256 value;
        for (uint256 i = 0; i < length; i++) {
            value = (value << 8) | uint8(data[offset + i]);
        }
        return value;
    }
}
