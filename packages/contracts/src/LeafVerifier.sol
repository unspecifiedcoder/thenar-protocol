// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GraspLog} from "./GraspLog.sol";
import {ClipLeaf} from "./lib/ClipLeaf.sol";
import {EpisodeLeaf} from "./lib/EpisodeLeaf.sol";
import {CorpusLeaf} from "./lib/CorpusLeaf.sol";
import {ClaimLeaf} from "./lib/ClaimLeaf.sol";

/**
 * Verify any leaf version (0x01-0x04) against the anchors the log already
 * holds. `GraspLog` itself parses no leaves (D-15): it only checks inclusion
 * of an already-hashed leaf via `verifyLeafHash`. This contract is the one
 * place that knows how each version's preimage is laid out and hashed.
 *
 * Verification is a pure function of the leaf, the proof and the root, and the
 * root is public on the log. So this contract holds nothing, migrates nothing,
 * and dispatches on the leaf's own version byte — which is what the version
 * byte was for.
 */
contract LeafVerifier {
    GraspLog public immutable log;

    error UnknownLeafVersion(uint8 version);
    error WrongLengthForVersion(uint8 version, uint256 got, uint256 want);

    constructor(GraspLog log_) {
        log = log_;
    }

    /**
     * Hash a preimage of either version, refusing anything else. A leaf whose
     * version and length disagree is refused rather than hashed, because a
     * truncated episode that happened to be 154 bytes must never verify as a
     * capture.
     */
    function hashLeaf(bytes calldata preimage) public pure returns (bytes32) {
        if (preimage.length == 0) revert UnknownLeafVersion(0);
        uint8 v = uint8(preimage[0]);
        if (v == ClipLeaf.VERSION) {
            if (preimage.length != ClipLeaf.PREIMAGE_BYTES) {
                revert WrongLengthForVersion(v, preimage.length, ClipLeaf.PREIMAGE_BYTES);
            }
            return ClipLeaf.hashPreimage(preimage);
        }
        if (v == EpisodeLeaf.VERSION) {
            if (preimage.length != EpisodeLeaf.PREIMAGE_BYTES) {
                revert WrongLengthForVersion(v, preimage.length, EpisodeLeaf.PREIMAGE_BYTES);
            }
            return EpisodeLeaf.hashPreimage(preimage);
        }
        if (v == CorpusLeaf.VERSION) {
            if (preimage.length != CorpusLeaf.PREIMAGE_BYTES) {
                revert WrongLengthForVersion(v, preimage.length, CorpusLeaf.PREIMAGE_BYTES);
            }
            return CorpusLeaf.hashPreimage(preimage);
        }
        if (v == ClaimLeaf.VERSION) {
            if (preimage.length != ClaimLeaf.PREIMAGE_BYTES) {
                revert WrongLengthForVersion(v, preimage.length, ClaimLeaf.PREIMAGE_BYTES);
            }
            return ClaimLeaf.hashPreimage(preimage);
        }
        revert UnknownLeafVersion(v);
    }

    /** This leaf — any version 0x01-0x04 — is in the log as of anchor `index`. */
    function verifyLeaf(
        uint256 index,
        bytes calldata preimage,
        bytes32[] calldata proof,
        uint64 leafIndex
    ) external view returns (bool) {
        return log.verifyLeafHash(index, hashLeaf(preimage), proof, leafIndex);
    }

    /**
     * The fields a buyer filters a corpus on, read straight from the preimage
     * they were committed under rather than from an index we keep.
     */
    function episodeFacts(bytes calldata preimage)
        external
        pure
        returns (bytes32 taskId, uint64 worldSeed, bool success, uint16 qualityScore)
    {
        uint8 v = uint8(preimage[0]);
        if (v != EpisodeLeaf.VERSION) revert UnknownLeafVersion(v);
        if (preimage.length != EpisodeLeaf.PREIMAGE_BYTES) {
            revert WrongLengthForVersion(v, preimage.length, EpisodeLeaf.PREIMAGE_BYTES);
        }
        taskId = bytes32(preimage[129:161]);
        worldSeed = uint64(bytes8(preimage[186:194]));
        success = uint8(preimage[194]) == 1;
        qualityScore = uint16(bytes2(preimage[195:197]));
    }

    /**
     * The fields a buyer checks a sealed corpus against, read straight from
     * the preimage it was committed under.
     */
    function corpusFacts(bytes calldata preimage)
        external
        pure
        returns (
            bytes32 manifestHash,
            bytes32 corpusRoot,
            bytes32 termsHash,
            bytes32 taskId,
            uint64 episodeCount,
            uint64 sealedAt
        )
    {
        uint8 v = uint8(preimage[0]);
        if (v != CorpusLeaf.VERSION) revert UnknownLeafVersion(v);
        if (preimage.length != CorpusLeaf.PREIMAGE_BYTES) {
            revert WrongLengthForVersion(v, preimage.length, CorpusLeaf.PREIMAGE_BYTES);
        }
        (manifestHash, corpusRoot, termsHash, taskId, episodeCount, sealedAt) = CorpusLeaf.facts(preimage);
    }

    /**
     * The fields a buyer checks a verifier's claim against, read straight
     * from the preimage it was committed under.
     */
    function claimFacts(bytes calldata preimage)
        external
        pure
        returns (
            bytes32 subjectLeaf,
            bytes32 verifierKeyId,
            uint16 checkId,
            uint8 result,
            uint8 level,
            uint64 issuedAt
        )
    {
        uint8 v = uint8(preimage[0]);
        if (v != ClaimLeaf.VERSION) revert UnknownLeafVersion(v);
        if (preimage.length != ClaimLeaf.PREIMAGE_BYTES) {
            revert WrongLengthForVersion(v, preimage.length, ClaimLeaf.PREIMAGE_BYTES);
        }
        (subjectLeaf, verifierKeyId, , , checkId, result, level, issuedAt) = ClaimLeaf.facts(preimage);
    }

    /** Which version a preimage claims to be, without hashing it. */
    function leafVersion(bytes calldata preimage) external pure returns (uint8) {
        if (preimage.length == 0) revert UnknownLeafVersion(0);
        return uint8(preimage[0]);
    }
}
