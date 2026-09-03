// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The 141-byte preimage that hashes to one leaf of the log — a verifier's
 * signed opinion about another leaf.
 *
 * A claim ties a check result to the leaf it was run against (`subjectLeaf`,
 * itself a hash, so nothing about the subject is re-published here), the key
 * that signed it, and a hash of the detail a buyer can request separately.
 * The claim never carries the signature bytes themselves on chain — only
 * `signatureHash`, so the log commits to the claim without growing with the
 * signature scheme.
 *
 * Layout, packed big-endian, exactly 141 bytes:
 *
 *   off  size  field
 *     0     1  version              always 0x04
 *     1    32  subjectLeaf          the leaf hash this claim is about
 *    33    32  verifierKeyId        keccak256 of the verifier's pubkey bytes
 *    65    32  detailHash           keccak256 of the off-chain detail object
 *    97    32  signatureHash        keccak256 of the signature bytes
 *   129     2  checkId              §10.9 check identifier (nonzero)
 *   131     1  result               0 fail, 1 pass, 2 inconclusive
 *   132     1  levelAsserted        <= 4
 *   133     8  issuedAt             unix seconds (nonzero)
 */
library ClaimLeaf {
    uint8 internal constant VERSION = 0x04;
    uint256 internal constant PREIMAGE_BYTES = 141;

    error WrongPreimageLength(uint256 got);
    error UnsupportedVersion(uint8 got);
    error ResultOutOfRange(uint8 got);
    error LevelOutOfRange(uint8 got);
    error CheckIdMustBeNonzero();
    error IssuedAtMustBeNonzero();

    struct Claim {
        bytes32 subjectLeaf;
        bytes32 verifierKeyId;
        bytes32 detailHash;
        bytes32 signatureHash;
        uint16 checkId;
        uint8 result;
        uint8 levelAsserted;
        uint64 issuedAt;
    }

    function _validate(uint16 checkId, uint8 result, uint8 levelAsserted, uint64 issuedAt) private pure {
        if (result > 2) revert ResultOutOfRange(result);
        if (levelAsserted > 4) revert LevelOutOfRange(levelAsserted);
        if (checkId == 0) revert CheckIdMustBeNonzero();
        if (issuedAt == 0) revert IssuedAtMustBeNonzero();
    }

    function encode(Claim memory c) internal pure returns (bytes memory out) {
        _validate(c.checkId, c.result, c.levelAsserted, c.issuedAt);
        out = abi.encodePacked(
            bytes1(VERSION),
            c.subjectLeaf,
            c.verifierKeyId,
            c.detailHash,
            c.signatureHash,
            c.checkId,
            c.result,
            c.levelAsserted,
            c.issuedAt
        );
        // A leaf whose length can drift is a leaf whose hash means nothing.
        if (out.length != PREIMAGE_BYTES) revert WrongPreimageLength(out.length);
    }

    /** RFC 6962 leaf hash, so no interior node can ever pose as a leaf. */
    function hash(Claim memory c) internal pure returns (bytes32) {
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

    function _u16(bytes memory data, uint256 offset) private pure returns (uint16 v) {
        v = (uint16(uint8(data[offset])) << 8) | uint16(uint8(data[offset + 1]));
    }

    function _u64(bytes memory data, uint256 offset) private pure returns (uint64 v) {
        for (uint256 i; i < 8; ++i) v = (v << 8) | uint64(uint8(data[offset + i]));
    }

    /** Decode the committed fields, validating the same invariants `encode` enforces. */
    function facts(bytes memory preimage)
        internal
        pure
        returns (
            bytes32 subjectLeaf,
            bytes32 verifierKeyId,
            bytes32 detailHash,
            bytes32 signatureHash,
            uint16 checkId,
            uint8 result,
            uint8 levelAsserted,
            uint64 issuedAt
        )
    {
        if (preimage.length != PREIMAGE_BYTES) revert WrongPreimageLength(preimage.length);
        if (uint8(preimage[0]) != VERSION) revert UnsupportedVersion(uint8(preimage[0]));
        subjectLeaf = _word(preimage, 1);
        verifierKeyId = _word(preimage, 33);
        detailHash = _word(preimage, 65);
        signatureHash = _word(preimage, 97);
        checkId = _u16(preimage, 129);
        result = uint8(preimage[131]);
        levelAsserted = uint8(preimage[132]);
        issuedAt = _u64(preimage, 133);
        _validate(checkId, result, levelAsserted, issuedAt);
    }
}
