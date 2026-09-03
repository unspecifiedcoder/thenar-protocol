// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The 197-byte preimage that hashes to one leaf of the log — one accepted
 * episode.
 *
 * This extends the capture leaf with what the foundry needs and a bare capture
 * did not: which published task the episode was recorded against, which sampled
 * world it happened in, whether the success predicate held, and what the
 * acceptance pipeline scored it. Those four fields are exactly what a buyer
 * filters a corpus on, and without them a corpus cannot prove what it is a
 * corpus *of*.
 *
 * What stays absent is unchanged and is the point: no identity, no payload, no
 * free text. `consentCommitment` is still salted afresh per submission, because
 * a stable pseudonymous identifier written on chain is one no erasure request
 * can ever undo.
 *
 * `worldSeed` is what makes an episode auditable rather than merely stored:
 * with the published spec and this seed, anyone can rebuild the exact scene the
 * demonstration was captured in.
 *
 * Layout, packed big-endian, exactly 197 bytes:
 *
 *   off  size  field
 *     0     1  version              always 0x02
 *     1    32  payloadHash          keccak256 of the episode bytes
 *    33    32  manifestHash         keccak256 of the sensor manifest
 *    65    32  consentCommitment    keccak256(consent record ‖ fresh salt)
 *    97    32  termsId              licence version captured under
 *   129    32  taskId               the published TaskSpec hash
 *   161     8  capturedAt           unix seconds, on the device
 *   169     8  submittedAt          unix seconds, at ingest
 *   177     4  durationMs
 *   181     4  scopeBits            permitted-use flags
 *   185     1  channels             sensor channel count
 *   186     8  worldSeed            the sample that produced the scene
 *   194     1  successFlag          1 if the predicate held, else 0
 *   195     2  qualityScore         acceptance score, basis points
 */
library EpisodeLeaf {
    uint8 internal constant VERSION = 0x02;
    uint256 internal constant PREIMAGE_BYTES = 197;

    error WrongPreimageLength(uint256 got);
    error UnsupportedVersion(uint8 got);
    error ScoreOutOfRange(uint16 got);

    struct Episode {
        bytes32 payloadHash;
        bytes32 manifestHash;
        bytes32 consentCommitment;
        bytes32 termsId;
        bytes32 taskId;
        uint64 capturedAt;
        uint64 submittedAt;
        uint32 durationMs;
        uint32 scopeBits;
        uint8 channels;
        uint64 worldSeed;
        uint8 successFlag;
        uint16 qualityScore;
    }

    function encode(Episode memory e) internal pure returns (bytes memory out) {
        if (e.qualityScore > 10000) revert ScoreOutOfRange(e.qualityScore);
        out = abi.encodePacked(
            bytes1(VERSION),
            e.payloadHash,
            e.manifestHash,
            e.consentCommitment,
            e.termsId,
            e.taskId,
            e.capturedAt,
            e.submittedAt,
            e.durationMs,
            e.scopeBits,
            e.channels,
            e.worldSeed,
            e.successFlag,
            e.qualityScore
        );
        // A leaf whose length can drift is a leaf whose hash means nothing.
        if (out.length != PREIMAGE_BYTES) revert WrongPreimageLength(out.length);
    }

    /** RFC 6962 leaf hash, so no interior node can ever pose as a leaf. */
    function hash(Episode memory e) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), encode(e)));
    }

    function hashPreimage(bytes memory preimage) internal pure returns (bytes32) {
        if (preimage.length != PREIMAGE_BYTES) revert WrongPreimageLength(preimage.length);
        if (uint8(preimage[0]) != VERSION) revert UnsupportedVersion(uint8(preimage[0]));
        return keccak256(abi.encodePacked(bytes1(0x00), preimage));
    }

    /** Read the task a preimage was recorded against, without decoding it all. */
    function taskIdOf(bytes memory preimage) internal pure returns (bytes32 t) {
        if (preimage.length != PREIMAGE_BYTES) revert WrongPreimageLength(preimage.length);
        assembly { t := mload(add(preimage, 161)) } // 32 header + 129 offset
    }
}
