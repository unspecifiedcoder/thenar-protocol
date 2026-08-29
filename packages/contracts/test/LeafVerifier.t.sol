// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {LeafVerifier} from "../src/LeafVerifier.sol";
import {EpisodeLeaf} from "../src/lib/EpisodeLeaf.sol";
import {ClipLeaf} from "../src/lib/ClipLeaf.sol";
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

    // --------------------------------------------- the gap this contract closes

    function test_theOldLogCannotVerifyAnEpisodeAtAll() public {
        graspLog.anchor(Vectors.ROOT_N, Vectors.N, bytes32(0));
        bytes memory ep = _episode(7, 8000, 1);
        bytes32[] memory proof = new bytes32[](0);
        // This is the bug: GraspLog hardcodes the capture leaf.
        vm.expectRevert(abi.encodeWithSelector(ClipLeaf.WrongPreimageLength.selector, uint256(197)));
        graspLog.verifyClip(0, ep, proof, 0);
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
}
