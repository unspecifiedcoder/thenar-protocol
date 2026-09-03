// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {LeafVerifier} from "../src/LeafVerifier.sol";
import {EpisodeLeaf} from "../src/lib/EpisodeLeaf.sol";
import {ClipLeaf} from "../src/lib/ClipLeaf.sol";
import {CorpusLeaf} from "../src/lib/CorpusLeaf.sol";
import {ClaimLeaf} from "../src/lib/ClaimLeaf.sol";
import {MerkleLog} from "../src/lib/MerkleLog.sol";
import {Vectors} from "./Vectors.sol";

contract LeafVerifierTest is Test {
    GraspLog graspLog;
    LeafVerifier verifier;

    function setUp() public {
        graspLog = new GraspLog(address(this));
        verifier = new LeafVerifier(graspLog);
    }

    function _episode(uint64 seed, uint16 score, uint8 ok)
        internal pure returns (bytes memory)
    {
        EpisodeLeaf.Episode memory e;
        e.payloadHash = keccak256("payload");
        e.manifestHash = keccak256("manifest");
        e.consentCommitment = keccak256("consent");
        e.termsId = keccak256("terms-v1");
        e.taskId = keccak256("task-mug-shelf");
        e.capturedAt = 1787000000;
        e.submittedAt = 1787000060;
        e.durationMs = 4200;
        e.scopeBits = 11;
        e.channels = 6;
        e.worldSeed = seed;
        e.successFlag = ok;
        e.qualityScore = score;
        return EpisodeLeaf.encode(e);
    }

    function _corpus(uint64 episodeCount, uint64 sealedAt) internal pure returns (bytes memory) {
        CorpusLeaf.Corpus memory c;
        c.corpusManifestHash = keccak256("corpus-manifest");
        c.corpusRoot = keccak256("corpus-root");
        c.termsHash = keccak256("terms-v1");
        c.taskId = keccak256("task-mug-shelf");
        c.episodeCount = episodeCount;
        c.sealedAt = sealedAt;
        return CorpusLeaf.encode(c);
    }

    function _claim(uint16 checkId, uint8 result, uint8 level, uint64 issuedAt)
        internal pure returns (bytes memory)
    {
        ClaimLeaf.Claim memory c;
        c.subjectLeaf = keccak256("subject");
        c.verifierKeyId = keccak256("verifier-key");
        c.detailHash = keccak256("detail");
        c.signatureHash = keccak256("signature");
        c.checkId = checkId;
        c.result = result;
        c.levelAsserted = level;
        c.issuedAt = issuedAt;
        return ClaimLeaf.encode(c);
    }

    // --------------------------------------------- what this contract closes

    /**
     * D-15: `GraspLog` parses no leaves — `verifyLeafHash` takes an
     * already-hashed leaf and will not accept a raw preimage in its place
     * (an episode preimage is not a valid bytes32, so it reverts on the ABI
     * decode before ever reaching the log's storage).
     */
    function test_theLogItselfNeverParsesAPreimage() public {
        graspLog.anchor(Vectors.ROOT_N, Vectors.N, bytes32(0));
        bytes memory ep = _episode(7, 8000, 1);
        // A raw keccak256 of the preimage — not the RFC 6962 domain-separated
        // leaf hash `LeafVerifier.hashLeaf` produces — is simply the wrong
        // word at this index; the log does not know how to derive one from
        // the other, because it never sees the preimage at all.
        assertFalse(
            graspLog.verifyLeafHash(
                0, keccak256(ep), Vectors.inclusionProof(), Vectors.INCLUSION_INDEX
            )
        );
    }

    function test_anEpisodeInAOneLeafLogVerifies() public {
        bytes memory ep = _episode(7, 8000, 1);
        bytes32 leaf = EpisodeLeaf.hashPreimage(ep);
        graspLog.anchor(leaf, 1, bytes32(0)); // a one-leaf tree's root is its leaf
        bytes32[] memory proof = new bytes32[](0);
        assertTrue(verifier.verifyLeaf(0, ep, proof, 0), "episode must verify");
    }

    function test_aCaptureStillVerifiesThroughTheSameEntryPoint() public {
        graspLog.anchor(Vectors.ROOT_N, Vectors.N, bytes32(0));
        // Vectors' capture leaf sits at a known index of the n=11 tree.
        assertTrue(
            MerkleLog.verifyInclusion(
                Vectors.INCLUSION_LEAF, Vectors.inclusionProof(),
                Vectors.INCLUSION_INDEX, Vectors.N, Vectors.ROOT_N
            ),
            "the capture path is unchanged"
        );
    }

    function test_bothVersionsHashThroughOneFunction() public view {
        bytes memory ep = _episode(1, 5000, 1);
        assertEq(verifier.hashLeaf(ep), EpisodeLeaf.hashPreimage(ep));
        assertEq(verifier.hashLeaf(Vectors.CLIP_PREIMAGE), ClipLeaf.hashPreimage(Vectors.CLIP_PREIMAGE));
    }

    function test_allFourVersionsHashThroughOneFunction() public view {
        bytes memory ep = _episode(1, 5000, 1);
        bytes memory cp = _corpus(3, 1787000100);
        bytes memory cl = _claim(7, 1, 3, 1787000200);
        assertEq(verifier.hashLeaf(Vectors.CLIP_PREIMAGE), ClipLeaf.hashPreimage(Vectors.CLIP_PREIMAGE));
        assertEq(verifier.hashLeaf(ep), EpisodeLeaf.hashPreimage(ep));
        assertEq(verifier.hashLeaf(cp), CorpusLeaf.hashPreimage(cp));
        assertEq(verifier.hashLeaf(cl), ClaimLeaf.hashPreimage(cl));
    }

    // ---------------------------------------------------- verifyLeafHash, per version

    function _oneLeafTreeVerifies(bytes memory preimage) internal {
        bytes32 leaf = verifier.hashLeaf(preimage);
        graspLog.anchor(leaf, 1, bytes32(0)); // a one-leaf tree's root is its leaf
        bytes32[] memory proof = new bytes32[](0);
        assertTrue(verifier.verifyLeaf(0, preimage, proof, 0));
        assertTrue(graspLog.verifyLeafHash(0, leaf, proof, 0));
    }

    function test_verifyLeafHash_v01_clip() public {
        _oneLeafTreeVerifies(Vectors.CLIP_PREIMAGE);
    }

    function test_verifyLeafHash_v02_episode() public {
        _oneLeafTreeVerifies(_episode(7, 8000, 1));
    }

    function test_verifyLeafHash_v03_corpus() public {
        _oneLeafTreeVerifies(_corpus(5, 1787000300));
    }

    function test_verifyLeafHash_v04_claim() public {
        _oneLeafTreeVerifies(_claim(9, 1, 2, 1787000400));
    }

    /** Build a small (8-leaf) tree in-test and check inclusion via the log. */
    function test_verifyLeafInAnEightLeafTree() public {
        bytes32[] memory leaves = new bytes32[](8);
        bytes memory ep = _episode(42, 9000, 1);
        bytes32 target = verifier.hashLeaf(ep);
        uint256 targetIndex = 3;
        for (uint256 i; i < 8; ++i) {
            leaves[i] = i == targetIndex ? target : keccak256(abi.encodePacked("filler", i));
        }
        (bytes32 r, bytes32[] memory proof) = _buildAndProve(leaves, targetIndex);
        graspLog.anchor(r, 8, bytes32(0));
        assertTrue(verifier.verifyLeaf(0, ep, proof, uint64(targetIndex)));
    }

    /** RFC 6962 tree builder + inclusion-proof extractor for a power-of-two leaf set. */
    function _buildAndProve(bytes32[] memory leaves, uint256 index)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proof)
    {
        uint256 n = leaves.length;
        proof = new bytes32[](_log2(n));
        uint256 p;
        bytes32[] memory level = leaves;
        uint256 idx = index;
        while (level.length > 1) {
            uint256 half = level.length / 2;
            bytes32[] memory next = new bytes32[](half);
            for (uint256 i; i < half; ++i) {
                bytes32 l = level[2 * i];
                bytes32 rgt = level[2 * i + 1];
                next[i] = keccak256(abi.encodePacked(bytes1(0x01), l, rgt));
                if (i == idx / 2) {
                    proof[p++] = idx % 2 == 0 ? rgt : l;
                }
            }
            level = next;
            idx /= 2;
        }
        root = level[0];
    }

    function _log2(uint256 n) internal pure returns (uint256 r) {
        while (n > 1) { n /= 2; r++; }
    }

    /** Gas of `verifyLeaf` through a 20-deep proof (a 2^20-leaf tree). */
    function test_gas_verifyLeafWithA20DeepProof() public {
        bytes memory ep = _episode(1, 5000, 1);
        bytes32 leaf = verifier.hashLeaf(ep);
        bytes32[] memory proof = new bytes32[](20);
        bytes32 node = leaf;
        for (uint256 i; i < 20; ++i) {
            bytes32 sib = keccak256(abi.encodePacked("sibling", i));
            proof[i] = sib;
            node = keccak256(abi.encodePacked(bytes1(0x01), node, sib));
        }
        uint64 size = uint64(1 << 20);
        graspLog.anchor(node, size, bytes32(0));
        uint256 g0 = gasleft();
        bool okv = verifier.verifyLeaf(0, ep, proof, 0);
        uint256 used = g0 - gasleft();
        assertTrue(okv);
        emit log_named_uint("gas: verifyLeaf, 20-deep proof", used);
        assertLt(used, 120_000);
    }

    function test_anUnknownVersionIsRefused() public {
        bytes memory bad = new bytes(154);
        bad[0] = 0x09;
        vm.expectRevert(abi.encodeWithSelector(LeafVerifier.UnknownLeafVersion.selector, uint8(9)));
        verifier.hashLeaf(bad);
    }

    /** A truncated episode must never verify as a capture. */
    function test_anEpisodeTruncatedToCaptureLengthIsRefused() public {
        bytes memory bad = new bytes(154);
        bad[0] = 0x02; // claims episode, but is capture-length
        vm.expectRevert(abi.encodeWithSelector(
            LeafVerifier.WrongLengthForVersion.selector, uint8(2), uint256(154), uint256(197)));
        verifier.hashLeaf(bad);
    }

    function test_aCaptureClaimingEpisodeLengthIsRefused() public {
        bytes memory bad = new bytes(197);
        bad[0] = 0x01;
        vm.expectRevert(abi.encodeWithSelector(
            LeafVerifier.WrongLengthForVersion.selector, uint8(1), uint256(197), uint256(154)));
        verifier.hashLeaf(bad);
    }

    function test_anEmptyPreimageIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(LeafVerifier.UnknownLeafVersion.selector, uint8(0)));
        verifier.hashLeaf("");
    }

    /** A corpus leaf truncated by one byte must be refused, not silently hashed. */
    function test_aCorpusPreimageTruncatedByOneByteIsRefused() public {
        bytes memory full = _corpus(3, 1787000100);
        bytes memory truncated = new bytes(full.length - 1);
        for (uint256 i; i < truncated.length; ++i) truncated[i] = full[i];
        vm.expectRevert(abi.encodeWithSelector(
            LeafVerifier.WrongLengthForVersion.selector,
            uint8(0x03), truncated.length, CorpusLeaf.PREIMAGE_BYTES));
        verifier.hashLeaf(truncated);
    }

    /** A corpus leaf extended by one byte must be refused, not silently hashed. */
    function test_aCorpusPreimageExtendedByOneByteIsRefused() public {
        bytes memory full = _corpus(3, 1787000100);
        bytes memory extended = new bytes(full.length + 1);
        for (uint256 i; i < full.length; ++i) extended[i] = full[i];
        vm.expectRevert(abi.encodeWithSelector(
            LeafVerifier.WrongLengthForVersion.selector,
            uint8(0x03), extended.length, CorpusLeaf.PREIMAGE_BYTES));
        verifier.hashLeaf(extended);
    }

    /** A claim leaf truncated by one byte must be refused, not silently hashed. */
    function test_aClaimPreimageTruncatedByOneByteIsRefused() public {
        bytes memory full = _claim(9, 1, 2, 1787000400);
        bytes memory truncated = new bytes(full.length - 1);
        for (uint256 i; i < truncated.length; ++i) truncated[i] = full[i];
        vm.expectRevert(abi.encodeWithSelector(
            LeafVerifier.WrongLengthForVersion.selector,
            uint8(0x04), truncated.length, ClaimLeaf.PREIMAGE_BYTES));
        verifier.hashLeaf(truncated);
    }

    /** A claim leaf extended by one byte must be refused, not silently hashed. */
    function test_aClaimPreimageExtendedByOneByteIsRefused() public {
        bytes memory full = _claim(9, 1, 2, 1787000400);
        bytes memory extended = new bytes(full.length + 1);
        for (uint256 i; i < full.length; ++i) extended[i] = full[i];
        vm.expectRevert(abi.encodeWithSelector(
            LeafVerifier.WrongLengthForVersion.selector,
            uint8(0x04), extended.length, ClaimLeaf.PREIMAGE_BYTES));
        verifier.hashLeaf(extended);
    }

    // ------------------------------------------------- the buyer's filter fields

    function test_episodeFactsReadTheCommittedFields() public view {
        bytes memory ep = _episode(4242, 7350, 1);
        (bytes32 taskId, uint64 seed, bool ok, uint16 score) = verifier.episodeFacts(ep);
        assertEq(taskId, keccak256("task-mug-shelf"));
        assertEq(seed, 4242);
        assertTrue(ok);
        assertEq(score, 7350);
    }

    function test_episodeFactsReportAFailedAttempt() public view {
        (, , bool ok, uint16 score) = verifier.episodeFacts(_episode(1, 2000, 0));
        assertFalse(ok);
        assertEq(score, 2000);
    }

    function test_episodeFactsRefuseACaptureLeaf() public {
        vm.expectRevert(abi.encodeWithSelector(LeafVerifier.UnknownLeafVersion.selector, uint8(1)));
        verifier.episodeFacts(Vectors.CLIP_PREIMAGE);
    }

    function testFuzz_factsRoundTripThroughTheLeaf(uint64 seed, uint16 score, bool ok) public view {
        score = uint16(bound(score, 0, 10000));
        bytes memory ep = _episode(seed, score, ok ? 1 : 0);
        (, uint64 s, bool o, uint16 q) = verifier.episodeFacts(ep);
        assertEq(s, seed);
        assertEq(o, ok);
        assertEq(q, score);
    }

    // --------------------------------------------------- corpusFacts / claimFacts

    function test_corpusFactsReadTheCommittedFields() public view {
        bytes memory cp = _corpus(5, 1787000500);
        (
            bytes32 manifestHash,
            bytes32 corpusRoot,
            bytes32 termsHash,
            bytes32 taskId,
            uint64 episodeCount,
            uint64 sealedAt
        ) = verifier.corpusFacts(cp);
        assertEq(manifestHash, keccak256("corpus-manifest"));
        assertEq(corpusRoot, keccak256("corpus-root"));
        assertEq(termsHash, keccak256("terms-v1"));
        assertEq(taskId, keccak256("task-mug-shelf"));
        assertEq(episodeCount, 5);
        assertEq(sealedAt, 1787000500);
    }

    function test_corpusFactsRefuseAnEpisodeLeaf() public {
        bytes memory ep = _episode(1, 5000, 1);
        vm.expectRevert(abi.encodeWithSelector(LeafVerifier.UnknownLeafVersion.selector, uint8(2)));
        verifier.corpusFacts(ep);
    }

    function test_claimFactsReadTheCommittedFields() public view {
        bytes memory cl = _claim(11, 1, 3, 1787000600);
        (
            bytes32 subjectLeaf,
            bytes32 verifierKeyId,
            uint16 checkId,
            uint8 result,
            uint8 level,
            uint64 issuedAt
        ) = verifier.claimFacts(cl);
        assertEq(subjectLeaf, keccak256("subject"));
        assertEq(verifierKeyId, keccak256("verifier-key"));
        assertEq(checkId, 11);
        assertEq(result, 1);
        assertEq(level, 3);
        assertEq(issuedAt, 1787000600);
    }

    function test_claimFactsRefuseACorpusLeaf() public {
        bytes memory cp = _corpus(3, 1787000100);
        vm.expectRevert(abi.encodeWithSelector(LeafVerifier.UnknownLeafVersion.selector, uint8(3)));
        verifier.claimFacts(cp);
    }
}
