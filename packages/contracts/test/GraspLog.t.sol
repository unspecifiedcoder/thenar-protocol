// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {MerkleLog} from "../src/lib/MerkleLog.sol";
import {SparseMerkle} from "../src/lib/SparseMerkle.sol";
import {ClipLeaf} from "../src/lib/ClipLeaf.sol";
import {Vectors} from "./Vectors.sol";

contract GraspLogTest is Test {
    GraspLog graspLog;
    address anchorer = address(0xA1);
    address stranger = address(0xB0B);

    function setUp() public {
        graspLog = new GraspLog(anchorer);
    }

    function _anchor(bytes32 root, uint64 size, bytes32 rev) internal {
        vm.prank(anchorer);
        graspLog.anchor(root, size, rev);
    }

    // ------------------------------------------------------- the leaf itself

    function test_clipPreimageIsExactly154Bytes() public pure {
        assertEq(Vectors.CLIP_PREIMAGE.length, ClipLeaf.PREIMAGE_BYTES);
        assertEq(ClipLeaf.PREIMAGE_BYTES, 154);
    }

    function test_leafHashMatchesTheReferenceImplementation() public pure {
        assertEq(ClipLeaf.hashPreimage(Vectors.CLIP_PREIMAGE), Vectors.CLIP_LEAF);
    }

    function test_leafRefusesAWrongLengthPreimage() public {
        bytes memory short = hex"0102";
        vm.expectRevert(abi.encodeWithSelector(ClipLeaf.WrongPreimageLength.selector, 2));
        this.callHashPreimage(short);
    }

    function callHashPreimage(bytes calldata p) external pure returns (bytes32) {
        return ClipLeaf.hashPreimage(p);
    }

    // ------------------------------------------------------------- anchoring

    function test_firstAnchorHasNoPrevRoot() public {
        _anchor(bytes32(uint256(1)), 10, bytes32(0));
        GraspLog.Anchor memory a = graspLog.head();
        assertEq(a.prevRoot, bytes32(0));
        assertEq(a.size, 10);
        assertEq(a.blockNumber, uint64(block.number));
    }

    function test_headChainsToThePreviousRoot() public {
        _anchor(bytes32(uint256(1)), 10, bytes32(0));
        _anchor(bytes32(uint256(2)), 20, bytes32(uint256(9)));
        GraspLog.Anchor memory a = graspLog.head();
        assertEq(a.prevRoot, bytes32(uint256(1)));
        assertEq(a.revocationRoot, bytes32(uint256(9)));
        assertEq(graspLog.anchorCount(), 2);
    }

    // --------------------------------------------- D-17 anchor-rule matrix

    function test_anEmptyFirstAnchorIsRefused() public {
        // first anchor, size 0 -> SizeMustGrow(0,0) (kept error)
        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(GraspLog.SizeMustGrow.selector, 0, 0));
        graspLog.anchor(bytes32(uint256(1)), 0, bytes32(0));
    }

    function test_sizeCannotShrink() public {
        // size < head -> SizeMustNotShrink, regardless of root/revocationRoot
        _anchor(bytes32(uint256(1)), 10, bytes32(0));
        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(GraspLog.SizeMustNotShrink.selector, 10, 4));
        graspLog.anchor(bytes32(uint256(2)), 4, bytes32(0));
    }

    function test_sizeCannotShrink_evenWithTheSameRootAndRevocationRoot() public {
        _anchor(bytes32(uint256(1)), 10, bytes32(uint256(5)));
        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(GraspLog.SizeMustNotShrink.selector, 10, 4));
        graspLog.anchor(bytes32(uint256(1)), 4, bytes32(uint256(5)));
    }

    function test_rootMustChange() public {
        // size > head, root same -> RootMustChange
        _anchor(bytes32(uint256(1)), 10, bytes32(0));
        vm.prank(anchorer);
        vm.expectRevert(GraspLog.RootMustChange.selector);
        graspLog.anchor(bytes32(uint256(1)), 11, bytes32(0));
    }

    function test_growingWithAChangedRoot_sameRevocationRoot_isAccepted() public {
        // size > head, root changed, revocationRoot same -> accepted
        _anchor(bytes32(uint256(1)), 10, bytes32(uint256(9)));
        _anchor(bytes32(uint256(2)), 11, bytes32(uint256(9)));
        GraspLog.Anchor memory a = graspLog.head();
        assertEq(a.root, bytes32(uint256(2)));
        assertEq(a.size, 11);
        assertEq(a.revocationRoot, bytes32(uint256(9)));
    }

    function test_growingWithAChangedRoot_changedRevocationRoot_isAccepted() public {
        // size > head, root changed, revocationRoot changed -> accepted
        _anchor(bytes32(uint256(1)), 10, bytes32(uint256(9)));
        _anchor(bytes32(uint256(2)), 11, bytes32(uint256(10)));
        GraspLog.Anchor memory a = graspLog.head();
        assertEq(a.root, bytes32(uint256(2)));
        assertEq(a.revocationRoot, bytes32(uint256(10)));
    }

    function test_equalSizeWithAChangedRoot_isRefused() public {
        // size == head, root changed -> RootMustMatchAtSameSize (row 5: no root
        // swap at equal size, whatever the revocation root does)
        _anchor(bytes32(uint256(1)), 10, bytes32(0));
        vm.prank(anchorer);
        vm.expectRevert(GraspLog.RootMustMatchAtSameSize.selector);
        graspLog.anchor(bytes32(uint256(2)), 10, bytes32(0));
    }

    function test_equalSizeWithAChangedRoot_changedRevocationRoot_isStillRefused() public {
        _anchor(bytes32(uint256(1)), 10, bytes32(uint256(5)));
        vm.prank(anchorer);
        vm.expectRevert(GraspLog.RootMustMatchAtSameSize.selector);
        graspLog.anchor(bytes32(uint256(2)), 10, bytes32(uint256(6)));
    }

    function test_equalSizeWithTheSameRootAndRevocationRoot_isRefused() public {
        // size == head, root same, revocationRoot same -> NothingToAnchor
        _anchor(bytes32(uint256(1)), 10, bytes32(uint256(5)));
        vm.prank(anchorer);
        vm.expectRevert(GraspLog.NothingToAnchor.selector);
        graspLog.anchor(bytes32(uint256(1)), 10, bytes32(uint256(5)));
    }

    function test_equalSizeWithAChangedRevocationRoot_isAccepted() public {
        // size == head, root same, revocationRoot changed -> accepted; prevRoot = root
        _anchor(bytes32(uint256(1)), 10, bytes32(uint256(5)));
        _anchor(bytes32(uint256(1)), 10, bytes32(uint256(6)));
        GraspLog.Anchor memory a = graspLog.head();
        assertEq(a.root, bytes32(uint256(1)));
        assertEq(a.prevRoot, bytes32(uint256(1)), "prevRoot must equal root at equal size");
        assertEq(a.revocationRoot, bytes32(uint256(6)));
        assertEq(a.size, 10);
        assertEq(graspLog.anchorCount(), 2);
    }

    function test_onlyTheAnchorerMayAnchor() public {
        vm.prank(stranger);
        vm.expectRevert(GraspLog.NotAnchorer.selector);
        graspLog.anchor(bytes32(uint256(1)), 1, bytes32(0));
    }

    function test_headRevertsBeforeAnyAnchor() public {
        vm.expectRevert(GraspLog.NoAnchors.selector);
        graspLog.head();
    }

    // ------------------------------------------------------------ indexOfRoot

    function test_indexOfRootIsFalseBeforeAnyAnchor() public view {
        (bool found, uint256 index) = graspLog.indexOfRoot(bytes32(uint256(1)));
        assertFalse(found);
        assertEq(index, 0);
    }

    function test_indexOfRootReportsTheFirstOccurrence() public {
        _anchor(bytes32(uint256(1)), 10, bytes32(0));
        _anchor(bytes32(uint256(2)), 20, bytes32(0));
        (bool found, uint256 index) = graspLog.indexOfRoot(bytes32(uint256(1)));
        assertTrue(found);
        assertEq(index, 0);
        (found, index) = graspLog.indexOfRoot(bytes32(uint256(2)));
        assertTrue(found);
        assertEq(index, 1);
    }

    /**
     * Equal-size anchors reuse the head's root (only the revocation root
     * changes), so `_indexOfRoot` must stay pinned to the first anchor that
     * ever carried it, not move to the later, equal-size one.
     */
    function test_indexOfRootStaysAtTheFirstAnchor_acrossAnEqualSizeAnchor() public {
        _anchor(bytes32(uint256(1)), 10, bytes32(uint256(5)));
        _anchor(bytes32(uint256(1)), 10, bytes32(uint256(6))); // same root, new revocation root
        (bool found, uint256 index) = graspLog.indexOfRoot(bytes32(uint256(1)));
        assertTrue(found);
        assertEq(index, 0, "must report the first occurrence, not the equal-size repeat");
    }

    function test_indexOfRootIsFalseForARootNeverAnchored() public {
        _anchor(bytes32(uint256(1)), 10, bytes32(0));
        (bool found, ) = graspLog.indexOfRoot(bytes32(uint256(999)));
        assertFalse(found);
    }

    // -------------------------------------------------------- verifyLeafHash

    function test_verifyLeafHashProvesInclusionAgainstAnAnchoredRoot() public {
        _anchor(Vectors.ROOT_N, Vectors.N, bytes32(0));
        assertTrue(
            graspLog.verifyLeafHash(
                0, Vectors.INCLUSION_LEAF, Vectors.inclusionProof(), Vectors.INCLUSION_INDEX
            )
        );
    }

    function test_verifyLeafHashRejectsTheWrongLeaf() public {
        _anchor(Vectors.ROOT_N, Vectors.N, bytes32(0));
        assertFalse(
            graspLog.verifyLeafHash(
                0, keccak256("not-the-leaf"), Vectors.inclusionProof(), Vectors.INCLUSION_INDEX
            )
        );
    }

    function test_verifyLeafHashRevertsForAnUnknownAnchor() public {
        vm.expectRevert(abi.encodeWithSelector(GraspLog.UnknownAnchor.selector, 0));
        graspLog.verifyLeafHash(0, Vectors.INCLUSION_LEAF, Vectors.inclusionProof(), Vectors.INCLUSION_INDEX);
    }

    // ---------------------------------------------------- inclusion, on chain

    function test_aClipProvesInclusionAgainstAnAnchoredRoot() public {
        _anchor(Vectors.ROOT_N, Vectors.N, bytes32(0));
        assertTrue(
            MerkleLog.verifyInclusion(
                Vectors.INCLUSION_LEAF,
                Vectors.inclusionProof(),
                Vectors.INCLUSION_INDEX,
                Vectors.N,
                Vectors.ROOT_N
            )
        );
    }

    function test_aSubstitutedLeafFailsInclusion() public pure {
        assertFalse(
            MerkleLog.verifyInclusion(
                keccak256("not-the-clip"),
                Vectors.inclusionProof(),
                Vectors.INCLUSION_INDEX,
                Vectors.N,
                Vectors.ROOT_N
            )
        );
    }

    function test_inclusionRefusesAnIndexPastTheEnd() public {
        vm.expectRevert(MerkleLog.IndexOutOfRange.selector);
        this.callInclusion(Vectors.N, Vectors.N);
    }

    function callInclusion(uint64 idx, uint64 size) external pure returns (bool) {
        return MerkleLog.verifyInclusion(
            Vectors.INCLUSION_LEAF, Vectors.inclusionProof(), idx, size, Vectors.ROOT_N
        );
    }

    // -------------------------------------------------- append-only, on chain

    function test_theLogProvesItWasOnlyAppendedTo() public {
        _anchor(Vectors.ROOT_M, Vectors.M, bytes32(0));
        _anchor(Vectors.ROOT_N, Vectors.N, bytes32(0));
        assertTrue(graspLog.verifyAppendOnly(0, 1, Vectors.consistencyProof()));
    }

    function test_aRewrittenHistoryFailsConsistency() public {
        _anchor(Vectors.ROOT_M, Vectors.M, bytes32(0));
        _anchor(keccak256("a-different-tree"), Vectors.N, bytes32(0));
        assertFalse(graspLog.verifyAppendOnly(0, 1, Vectors.consistencyProof()));
    }

    // ------------------------------------------------------------- revocation

    function test_aKeyNeverRevokedProvesConsentIsLive() public {
        _anchor(Vectors.ROOT_N, Vectors.N, Vectors.SPARSE_ROOT);
        assertTrue(
            graspLog.verifyConsentLive(0, Vectors.KEY_LIVE, Vectors.BITMAP_OUT, Vectors.sparseOut())
        );
    }

    function test_aRevokedKeyCannotProveConsentIsLive() public {
        _anchor(Vectors.ROOT_N, Vectors.N, Vectors.SPARSE_ROOT);
        assertFalse(
            graspLog.verifyConsentLive(0, Vectors.KEY_REVOKED, Vectors.BITMAP_IN, Vectors.sparseIn())
        );
    }

    function test_revocationMembershipMatchesTheReference() public pure {
        assertTrue(
            SparseMerkle.verifyMembership(
                Vectors.KEY_REVOKED,
                Vectors.VALUE_REVOKED,
                Vectors.BITMAP_IN,
                Vectors.sparseIn(),
                Vectors.SPARSE_ROOT
            )
        );
    }

    function test_revocationOnsetReportsTheBlockItBecameKnowable() public {
        // An anchor with nothing revoked, then the one that carries it.
        _anchor(Vectors.ROOT_M, Vectors.M, bytes32(0));
        vm.roll(block.number + 5);
        _anchor(Vectors.ROOT_N, Vectors.N, Vectors.SPARSE_ROOT);

        (uint64 bn, ) = graspLog.revocationOnset(1, GraspLog.OnsetProof({
            consentKey: Vectors.KEY_REVOKED,
            value: Vectors.VALUE_REVOKED,
            bitmapAt: Vectors.BITMAP_IN,
            siblingsAt: Vectors.sparseIn(),
            bitmapBefore: 0,
            siblingsBefore: new bytes32[](0)
        }));
        assertEq(bn, uint64(block.number));
    }

    /**
     * The D-17 case this task exists for: a revocation-only anchor keeps the
     * same size and root as its predecessor (§ anchor-rule matrix, row 7),
     * so `revocationOnset` must still find the onset present at `index` and
     * absent at `index - 1` even though `size_i == size_{i-1}`.
     */
    function test_revocationOnsetAcrossAnEqualSizeAnchorPair() public {
        _anchor(Vectors.ROOT_M, Vectors.M, bytes32(0));       // nothing revoked yet
        vm.roll(block.number + 5);
        _anchor(Vectors.ROOT_M, Vectors.M, Vectors.SPARSE_ROOT); // same size, same root, revocation-only

        assertEq(graspLog.anchorAt(0).size, graspLog.anchorAt(1).size, "sizes must be equal");
        assertEq(graspLog.anchorAt(0).root, graspLog.anchorAt(1).root, "roots must be equal");

        (uint64 bn, ) = graspLog.revocationOnset(1, GraspLog.OnsetProof({
            consentKey: Vectors.KEY_REVOKED,
            value: Vectors.VALUE_REVOKED,
            bitmapAt: Vectors.BITMAP_IN,
            siblingsAt: Vectors.sparseIn(),
            bitmapBefore: 0,
            siblingsBefore: new bytes32[](0)
        }));
        assertEq(bn, uint64(block.number));
    }

    function test_onsetRefusesAnAnchorWhereItWasAlreadyPresent() public {
        _anchor(Vectors.ROOT_M, Vectors.M, Vectors.SPARSE_ROOT);
        _anchor(Vectors.ROOT_N, Vectors.N, Vectors.SPARSE_ROOT);
        vm.expectRevert(GraspLog.NotFirstSighting.selector);
        graspLog.revocationOnset(1, GraspLog.OnsetProof({
            consentKey: Vectors.KEY_REVOKED,
            value: Vectors.VALUE_REVOKED,
            bitmapAt: Vectors.BITMAP_IN,
            siblingsAt: Vectors.sparseIn(),
            bitmapBefore: Vectors.BITMAP_IN,
            siblingsBefore: Vectors.sparseIn()
        }));
    }

    function test_anEmptyRevocationTreeIsTheZeroWord() public pure {
        bytes32[] memory none = new bytes32[](0);
        assertTrue(SparseMerkle.verifyNonMembership(keccak256("anything"), 0, none, bytes32(0)));
    }

    // ------------------------------------------------------------ stewardship

    function test_anchorerHandoverIsTwoStep() public {
        vm.prank(anchorer);
        graspLog.transferAnchorer(stranger);
        assertEq(graspLog.anchorer(), anchorer, "not transferred until accepted");
        vm.prank(stranger);
        graspLog.acceptAnchorer();
        assertEq(graspLog.anchorer(), stranger);
    }

    function test_onlyThePendingAnchorerMayAccept() public {
        vm.prank(anchorer);
        graspLog.transferAnchorer(stranger);
        vm.prank(address(0xDEAD));
        vm.expectRevert(GraspLog.NotPending.selector);
        graspLog.acceptAnchorer();
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_sizeAlwaysGrowsAcrossAnchors(uint64 a, uint64 b, uint64 c) public {
        a = uint64(bound(a, 1, type(uint32).max));
        b = uint64(bound(b, uint256(a) + 1, uint256(type(uint32).max) + 1));
        c = uint64(bound(c, uint256(b) + 1, uint256(type(uint32).max) + 2));
        _anchor(keccak256(abi.encode(a)), a, bytes32(0));
        _anchor(keccak256(abi.encode(b)), b, bytes32(0));
        _anchor(keccak256(abi.encode(c)), c, bytes32(0));
        assertEq(graspLog.head().size, c);
        assertEq(graspLog.anchorCount(), 3);
    }
}
