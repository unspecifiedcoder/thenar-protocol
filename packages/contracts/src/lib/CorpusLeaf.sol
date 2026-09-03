// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The 145-byte preimage that hashes to one leaf of the log — a sealed corpus.
 *
 * A corpus is a set of episodes, sealed together under one licence. This leaf
 * commits to the corpus's own manifest (off chain, but content-addressed by
 * `corpusManifestHash`), the root of the episode leaves it contains, and the
 * terms it was sealed under — so a buyer can verify a corpus without trusting
 * whoever assembled it.
 *
 * Layout, packed big-endian, exactly 145 bytes:
 *
 *   off  size  field
 *     0     1  version              always 0x03
 *     1    32  corpusManifestHash   keccak256 of the corpus manifest
 *    33    32  corpusRoot           root of the episode leaves in the corpus
 *    65    32  termsHash            licence sealed under
 *    97    32  taskId               the published TaskSpec hash, or 0 if none
 *   129     8  episodeCount         number of episodes in the corpus (>= 1)
 *   137     8  sealedAt             unix seconds
 */
library CorpusLeaf {
    uint8 internal constant VERSION = 0x03;
    uint256 internal constant PREIMAGE_BYTES = 145;

    error WrongPreimageLength(uint256 got);
    error UnsupportedVersion(uint8 got);
    error EmptyCorpus();

    struct Corpus {
        bytes32 corpusManifestHash;
        bytes32 corpusRoot;
        bytes32 termsHash;
        bytes32 taskId;
        uint64 episodeCount;
        uint64 sealedAt;
    }

    function encode(Corpus memory c) internal pure returns (bytes memory out) {
        if (c.episodeCount == 0) revert EmptyCorpus();
        out = abi.encodePacked(
            bytes1(VERSION),
            c.corpusManifestHash,
            c.corpusRoot,
            c.termsHash,
            c.taskId,
            c.episodeCount,
            c.sealedAt
        );
        // A leaf whose length can drift is a leaf whose hash means nothing.
        if (out.length != PREIMAGE_BYTES) revert WrongPreimageLength(out.length);
    }

    /** RFC 6962 leaf hash, so no interior node can ever pose as a leaf. */
    function hash(Corpus memory c) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), encode(c)));
    }

    function hashPreimage(bytes memory preimage) internal pure returns (bytes32) {
        if (preimage.length != PREIMAGE_BYTES) revert WrongPreimageLength(preimage.length);
        if (uint8(preimage[0]) != VERSION) revert UnsupportedVersion(uint8(preimage[0]));
        return keccak256(abi.encodePacked(bytes1(0x00), preimage));
    }

    function _word(bytes memory data, uint256 offset) private pure returns (bytes32 v) {
        assembly { v := mload(add(add(data, 32), offset)) }
    }

    function _u64(bytes memory data, uint256 offset) private pure returns (uint64 v) {
        for (uint256 i; i < 8; ++i) v = (v << 8) | uint64(uint8(data[offset + i]));
    }

    /** Decode the committed fields a buyer verifies a corpus against. */
    function facts(bytes memory preimage)
        internal
        pure
        returns (
            bytes32 corpusManifestHash,
            bytes32 corpusRoot,
            bytes32 termsHash,
            bytes32 taskId,
            uint64 episodeCount,
            uint64 sealedAt
        )
    {
        if (preimage.length != PREIMAGE_BYTES) revert WrongPreimageLength(preimage.length);
        if (uint8(preimage[0]) != VERSION) revert UnsupportedVersion(uint8(preimage[0]));
        corpusManifestHash = _word(preimage, 1);
        corpusRoot = _word(preimage, 33);
        termsHash = _word(preimage, 65);
        taskId = _word(preimage, 97);
        episodeCount = _u64(preimage, 129);
        sealedAt = _u64(preimage, 137);
        if (episodeCount == 0) revert EmptyCorpus();
    }
}
