// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The 154-byte preimage that hashes to one leaf of the log — one accepted clip.
 *
 * What is deliberately absent is the point: no identity, no payload, no free
 * text. A clip is described entirely by hashes and bounded integers, so the
 * log can be published in full without publishing anything about a person.
 *
 * `consentCommitment` is salted with fresh randomness on every submission. A
 * stable pseudonymous identifier written on chain is one no erasure request
 * can ever undo; re-salting means the same contributor's clips cannot be
 * linked to each other by anyone reading the log.
 *
 * Layout, packed big-endian, exactly 154 bytes:
 *
 *   off  size  field
 *     0     1  version              always 0x01
 *     1    32  payloadHash          keccak256 of the clip bytes
 *    33    32  manifestHash         keccak256 of the sensor manifest
 *    65    32  consentCommitment    keccak256(consent record ‖ fresh salt)
 *    97    32  termsId              licence version the capture was made under
 *   129     8  capturedAt           unix seconds, on the device
 *   137     8  submittedAt          unix seconds, at ingest
 *   145     4  durationMs           clip length
 *   149     4  scopeBits            permitted-use flags
 *   153     1  channels             sensor channel count
 */
library ClipLeaf {
    uint8 internal constant VERSION = 0x01;
    uint256 internal constant PREIMAGE_BYTES = 154;

    error WrongPreimageLength(uint256 got);
    error UnsupportedVersion(uint8 got);

    struct Clip {
        bytes32 payloadHash;
        bytes32 manifestHash;
        bytes32 consentCommitment;
        bytes32 termsId;
        uint64 capturedAt;
        uint64 submittedAt;
        uint32 durationMs;
        uint32 scopeBits;
        uint8 channels;
    }

    function encode(Clip memory c) internal pure returns (bytes memory out) {
        out = abi.encodePacked(
            bytes1(VERSION),
            c.payloadHash,
            c.manifestHash,
            c.consentCommitment,
            c.termsId,
            c.capturedAt,
            c.submittedAt,
            c.durationMs,
            c.scopeBits,
            c.channels
        );
        // A leaf whose length can drift is a leaf whose hash means nothing.
        if (out.length != PREIMAGE_BYTES) revert WrongPreimageLength(out.length);
    }

    /** Leaf hash, RFC 6962 domain-separated so no interior node can pose as one. */
    function hash(Clip memory c) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), encode(c)));
    }

    function hashPreimage(bytes memory preimage) internal pure returns (bytes32) {
        if (preimage.length != PREIMAGE_BYTES) revert WrongPreimageLength(preimage.length);
        if (uint8(preimage[0]) != VERSION) revert UnsupportedVersion(uint8(preimage[0]));
        return keccak256(abi.encodePacked(bytes1(0x00), preimage));
    }
}
