// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {LeafVerifier} from "../src/LeafVerifier.sol";
import {LicenceRegistry} from "../src/LicenceRegistry.sol";
import {MerkleLog} from "../src/lib/MerkleLog.sol";
import {SparseMerkle} from "../src/lib/SparseMerkle.sol";
import {ClaimLeaf} from "../src/lib/ClaimLeaf.sol";
import {CorpusLeaf} from "../src/lib/CorpusLeaf.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * T-030 — adversarial suite, Solidity level (TASK-030.md "Attacks" 1-8,
 * 13-15). Each named test attempts one PLAN §7 threat against `GraspLog`,
 * `LeafVerifier` or `LicenceRegistry` and asserts the SPECIFIC refusal —
 * a named error, or `false` from a boolean-returning verifier — never just
 * "it reverted". Regression guard for I-10.
 */
contract AdversarialTest is Test {
    GraspLog graspLog;
    LeafVerifier verifier;
    LicenceRegistry registry;
    MockERC20 usdc;

    address anchorer = address(0xA1);
    address steward = address(this);
    address treasury = address(0x7EA5);
    address supplier = address(0x5011);
    address buyer = address(0xB0B);

    bytes32 constant TERMS = keccak256("adversarial-terms-v1");

    function setUp() public {
        graspLog = new GraspLog(anchorer);
        verifier = new LeafVerifier(graspLog);
        registry = new LicenceRegistry(graspLog, verifier, treasury);
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        registry.publishTerms(TERMS, "https://thenar.io/terms/adversarial-v1");
    }

    function _anchor(bytes32 root, uint64 size, bytes32 rev) internal returns (uint256 index) {
        vm.prank(anchorer);
        index = graspLog.anchor(root, size, rev);
    }

    // ------------------------------------------------------------ tree helpers
    // Mirrors LicenceRegistry.t.sol's `_buildAndProve` / `_log2`.

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
        while (n > 1) {
            n /= 2;
            r++;
        }
    }

    function _leaves(uint256 n, string memory salt) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](n);
        for (uint256 i; i < n; ++i) out[i] = keccak256(abi.encodePacked(salt, i));
    }

    // =======================================================================
    // Attack 1 — inclusion proof with a sibling moved to the other side
    // (must fail; side derives from index, never from the proof).
    // =======================================================================
    function test_attack1_siblingMovedToTheOtherSideIsRefused() public {
        bytes32[] memory leaves = _leaves(8, "adv1");
        uint256 targetIndex = 5; // odd index: sibling combines on the left
        (bytes32 root, bytes32[] memory proof) = _buildAndProve(leaves, targetIndex);
        uint256 anchorIndex = _anchor(root, 8, bytes32(0));

        // Sanity: the honest proof, at its honest index, verifies.
        assertTrue(graspLog.verifyLeafHash(anchorIndex, leaves[targetIndex], proof, uint64(targetIndex)));

        // The attack: replay the *same* proof array against an index of the
        // opposite parity (4, its sibling in the tree) — this is exactly
        // "move the sibling to the other side", since `MerkleLog` derives
        // combine order from the index, not from any side flag in the
        // proof itself. The wrong parity produces the wrong root.
        assertFalse(graspLog.verifyLeafHash(anchorIndex, leaves[targetIndex], proof, uint64(targetIndex - 1)));
    }

    // =======================================================================
    // Attack 2 — proof padded with one extra sibling / truncated by one.
    // =======================================================================
    function test_attack2_paddedProofReverts() public {
        bytes32[] memory leaves = _leaves(8, "adv2");
        uint256 targetIndex = 3;
        (bytes32 root, bytes32[] memory proof) = _buildAndProve(leaves, targetIndex);
        uint256 anchorIndex = _anchor(root, 8, bytes32(0));

        bytes32[] memory padded = new bytes32[](proof.length + 1);
        for (uint256 i; i < proof.length; ++i) padded[i] = proof[i];
        padded[proof.length] = keccak256("extra-sibling");

        vm.expectRevert(MerkleLog.BadProofLength.selector);
        this.callVerifyLeafHash(anchorIndex, leaves[targetIndex], padded, uint64(targetIndex));
    }

    function test_attack2_truncatedProofReverts() public {
        bytes32[] memory leaves = _leaves(8, "adv2t");
        uint256 targetIndex = 3;
        (bytes32 root, bytes32[] memory proof) = _buildAndProve(leaves, targetIndex);
        uint256 anchorIndex = _anchor(root, 8, bytes32(0));

        bytes32[] memory truncated = new bytes32[](proof.length - 1);
        for (uint256 i; i < truncated.length; ++i) truncated[i] = proof[i];

        vm.expectRevert(MerkleLog.BadProofLength.selector);
        this.callVerifyLeafHash(anchorIndex, leaves[targetIndex], truncated, uint64(targetIndex));
    }

    /** `graspLog.verifyLeafHash` is `external view`; routed through `this.` so `vm.expectRevert` sees the external call. */
    function callVerifyLeafHash(uint256 anchorIndex, bytes32 leaf, bytes32[] calldata proof, uint64 leafIndex)
        external
        view
        returns (bool)
    {
        return graspLog.verifyLeafHash(anchorIndex, leaf, proof, leafIndex);
    }

    // =======================================================================
    // Attack 3 — leaf index >= size; size 0.
    // =======================================================================
    function test_attack3_indexAtSizeIsRefused() public {
        bytes32[] memory leaves = _leaves(8, "adv3");
        (bytes32 root, bytes32[] memory proof) = _buildAndProve(leaves, 7);
        uint256 anchorIndex = _anchor(root, 8, bytes32(0));

        vm.expectRevert(MerkleLog.IndexOutOfRange.selector);
        this.callVerifyLeafHash(anchorIndex, leaves[7], proof, 8);
    }

    function test_attack3_indexWellAboveSizeIsRefused() public {
        bytes32[] memory leaves = _leaves(8, "adv3b");
        (bytes32 root, bytes32[] memory proof) = _buildAndProve(leaves, 7);
        uint256 anchorIndex = _anchor(root, 8, bytes32(0));

        vm.expectRevert(MerkleLog.IndexOutOfRange.selector);
        this.callVerifyLeafHash(anchorIndex, leaves[7], proof, 255);
    }

    function test_attack3_sizeZeroIsRefused() public {
        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert(MerkleLog.EmptyTree.selector);
        this.callVerifyInclusion(keccak256("anything"), empty, 0, 0, bytes32(0));
    }

    /** Routed through `this.` (external call) so `vm.expectRevert` sees a call frame to catch. */
    function callVerifyInclusion(bytes32 leaf, bytes32[] calldata proof, uint64 index, uint64 size, bytes32 root)
        external
        pure
        returns (bool)
    {
        return MerkleLog.verifyInclusion(leaf, proof, index, size, root);
    }

    // =======================================================================
    // Attack 4 — consistency proof from a *different* log with the same size.
    // =======================================================================
    function test_attack4_consistencyProofFromADifferentLogIsRefused() public pure {
        bytes32[] memory leavesA = _leaves(11, "adv4-a");
        bytes32[] memory leavesB = _leaves(11, "adv4-b"); // same size, different content

        bytes32 rootA11 = _ctRoot(leavesA);
        bytes32 rootB11 = _ctRoot(leavesB);
        assertTrue(rootA11 != rootB11, "sanity: two different logs of the same size have different roots");

        // A's own consistency proof, m=7 -> n=11, built off chain the way
        // `MerkleLog.verifyConsistency` expects (append-only construction).
        bytes32[] memory proofFromA = _consistencyProof(leavesA, 7, 11);
        bytes32 rootA7 = _ctRoot(_slice(leavesA, 7));

        assertTrue(MerkleLog.verifyConsistency(7, rootA7, 11, rootA11, proofFromA), "sanity: verifies against A's own roots");
        assertFalse(MerkleLog.verifyConsistency(7, rootA7, 11, rootB11, proofFromA),
            "A's consistency proof must not verify against log B's root of the same size");
    }

    function _slice(bytes32[] memory leaves, uint256 n) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](n);
        for (uint256 i; i < n; ++i) out[i] = leaves[i];
    }

    /** §10.1 node rules over an arbitrary (not necessarily power-of-two) leaf count — mirrors `log.ts`'s `root()`. */
    function _split(uint256 n) internal pure returns (uint256 k) {
        k = 1;
        while (k * 2 < n) k *= 2;
    }

    function _ctRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 1) return leaves[0];
        uint256 k = _split(n);
        bytes32 l = _ctRoot(_slice(leaves, k));
        bytes32 r = _ctRoot(_rightOf(leaves, k));
        return keccak256(abi.encodePacked(bytes1(0x01), l, r));
    }

    /** RFC 6962 §2.1.2 consistency proof, built the same recursive way the TS reference (`log.ts`) does. */
    function _consistencyProof(bytes32[] memory leaves, uint256 m, uint256 n) internal pure returns (bytes32[] memory) {
        return _sub(_slice(leaves, n), m, true);
    }

    function _sub(bytes32[] memory leaves, uint256 m, bool isComplete) internal pure returns (bytes32[] memory) {
        uint256 n = leaves.length;
        if (m == n) {
            if (isComplete) return new bytes32[](0);
            bytes32[] memory single = new bytes32[](1);
            single[0] = _ctRoot(leaves);
            return single;
        }
        uint256 k = _split(n);
        if (m <= k) {
            bytes32[] memory left = _sub(_slice(leaves, k), m, isComplete);
            bytes32[] memory rightPart = _rightOf(leaves, k);
            bytes32 rRoot = _ctRoot(rightPart);
            return _append(left, rRoot);
        } else {
            bytes32[] memory rightPart = _rightOf(leaves, k);
            bytes32[] memory right = _sub(rightPart, m - k, false);
            bytes32[] memory leftPart = _slice(leaves, k);
            bytes32 lRoot = _ctRoot(leftPart);
            return _append(right, lRoot);
        }
    }

    function _rightOf(bytes32[] memory leaves, uint256 k) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](leaves.length - k);
        for (uint256 i; i < out.length; ++i) out[i] = leaves[k + i];
    }

    function _append(bytes32[] memory arr, bytes32 v) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](arr.length + 1);
        for (uint256 i; i < arr.length; ++i) out[i] = arr[i];
        out[arr.length] = v;
    }

    // =======================================================================
    // Attack 5 — interior node presented as a leaf (0x01-prefixed value
    // passed as a leaf hash).
    // =======================================================================
    function test_attack5_interiorNodePresentedAsALeafIsRefused() public {
        bytes32[] memory leaves = _leaves(8, "adv5");
        uint256 targetIndex = 2;
        (bytes32 root, bytes32[] memory proof) = _buildAndProve(leaves, targetIndex);
        uint256 anchorIndex = _anchor(root, 8, bytes32(0));

        // An interior node — domain-separated with 0x01, never 0x00 — one
        // level above leaves 4/5.
        bytes32 interiorNode = keccak256(abi.encodePacked(bytes1(0x01), leaves[4], leaves[5]));
        for (uint256 i; i < leaves.length; ++i) {
            assertTrue(interiorNode != leaves[i], "sanity: domain separation - an interior hash never equals a leaf hash");
        }

        assertFalse(graspLog.verifyLeafHash(anchorIndex, interiorNode, proof, uint64(targetIndex)),
            "an interior node substituted for the real leaf must not verify");
    }

    // =======================================================================
    // Attack 6 — SMT non-membership proof for a key that is present (must
    // fail); membership with zero value reverts `ZeroLeafValue`.
    // =======================================================================
    function test_attack6_nonMembershipForAPresentKeyIsRefused() public pure {
        bytes32 key = keccak256("adv6-present-key");
        bytes32 value = keccak256("adv6-present-value");
        bytes32[] memory noSiblings = new bytes32[](0);
        // A single-key sparse tree: every sibling at every level is the
        // implicit zero word (bitmap = 0), which is exactly how a compact
        // proof represents an otherwise-empty tree with one real leaf.
        bytes32 root = SparseMerkle.computeRoot(key, value, 0, noSiblings);

        assertTrue(SparseMerkle.verifyMembership(key, value, 0, noSiblings, root), "sanity: honest membership verifies");
        assertFalse(SparseMerkle.verifyNonMembership(key, 0, noSiblings, root),
            "a non-membership proof for a key that IS present must not verify");
    }

    function test_attack6_membershipWithZeroValueReverts() public {
        bytes32 key = keccak256("adv6-zero-key");
        bytes32[] memory noSiblings = new bytes32[](0);
        vm.expectRevert(SparseMerkle.ZeroLeafValue.selector);
        this.callVerifyMembership(key, bytes32(0), 0, noSiblings, keccak256("some-root"));
    }

    /** Routed through `this.` (external call) so `vm.expectRevert` sees a call frame to catch. */
    function callVerifyMembership(bytes32 key, bytes32 value, uint256 bitmap, bytes32[] calldata siblings, bytes32 root)
        external
        pure
        returns (bool)
    {
        return SparseMerkle.verifyMembership(key, value, bitmap, siblings, root);
    }

    // =======================================================================
    // Attack 7 — onset proof where the key is also present at index-1
    // (not a first sighting).
    // =======================================================================
    function test_attack7_onsetWhereKeyAlsoPresentAtIndexMinusOneIsRefused() public {
        bytes32 key = keccak256("adv7-key");
        bytes32 value = keccak256("adv7-value");
        bytes32[] memory noSiblings = new bytes32[](0);
        // Same key, same value, at BOTH anchors — the revocation root does
        // not change, so this is emphatically not a first sighting.
        bytes32 revRoot = SparseMerkle.computeRoot(key, value, 0, noSiblings);

        uint256 idx0 = _anchor(keccak256("adv7-root-0"), 1, revRoot);
        uint256 idx1 = _anchor(keccak256("adv7-root-1"), 2, revRoot); // size grows, revocationRoot unchanged
        assertEq(idx1, idx0 + 1);

        GraspLog.OnsetProof memory p = GraspLog.OnsetProof({
            consentKey: key,
            value: value,
            bitmapAt: 0,
            siblingsAt: noSiblings,
            bitmapBefore: 0,
            siblingsBefore: noSiblings
        });

        vm.expectRevert(GraspLog.NotFirstSighting.selector);
        this.callRevocationOnset(idx1, p);
    }

    function callRevocationOnset(uint256 index, GraspLog.OnsetProof calldata p) external view returns (uint64, uint64) {
        return graspLog.revocationOnset(index, p);
    }

    // =======================================================================
    // Attack 8 — anchor with `size` equal / `root` unchanged (reverts).
    // =======================================================================
    function test_attack8_equalSizeSameRootSameRevocationRootReverts() public {
        _anchor(keccak256("adv8-root"), 5, keccak256("adv8-rev"));
        vm.prank(anchorer);
        vm.expectRevert(GraspLog.NothingToAnchor.selector);
        graspLog.anchor(keccak256("adv8-root"), 5, keccak256("adv8-rev"));
    }

    function test_attack8_growingSizeWithUnchangedRootReverts() public {
        _anchor(keccak256("adv8b-root"), 5, bytes32(0));
        vm.prank(anchorer);
        vm.expectRevert(GraspLog.RootMustChange.selector);
        graspLog.anchor(keccak256("adv8b-root"), 6, keccak256("adv8b-rev-2"));
    }

    // -- T-005 anchor-rule matrix rows, reprised here for attack 15's context --

    function test_attack15matrix_sizeMayNotShrink() public {
        _anchor(keccak256("adv15-shrink-root"), 10, bytes32(0));
        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(GraspLog.SizeMustNotShrink.selector, uint64(10), uint64(3)));
        graspLog.anchor(keccak256("adv15-shrink-root-2"), 3, bytes32(0));
    }

    function test_attack15matrix_equalSizeRootSwapReverts() public {
        _anchor(keccak256("adv15-swap-root"), 10, bytes32(0));
        vm.prank(anchorer);
        vm.expectRevert(GraspLog.RootMustMatchAtSameSize.selector);
        graspLog.anchor(keccak256("adv15-swap-root-DIFFERENT"), 10, keccak256("adv15-swap-rev"));
    }

    function test_attack15matrix_nothingToAnchorReverts() public {
        _anchor(keccak256("adv15-nta-root"), 10, keccak256("adv15-nta-rev"));
        vm.prank(anchorer);
        vm.expectRevert(GraspLog.NothingToAnchor.selector);
        graspLog.anchor(keccak256("adv15-nta-root"), 10, keccak256("adv15-nta-rev"));
    }

    // =======================================================================
    // Attack 13 — a 145-byte preimage whose version byte is 0x04 (claim
    // length confused with corpus length), and a 141-byte one whose version
    // byte is 0x03 (corpus length confused with claim length). Both revert
    // `WrongLengthForVersion`, never parse.
    // =======================================================================
    function test_attack13_claimVersionAtCorpusLengthReverts() public {
        bytes memory bad = new bytes(CorpusLeaf.PREIMAGE_BYTES); // 145 bytes
        bad[0] = bytes1(ClaimLeaf.VERSION); // 0x04
        vm.expectRevert(abi.encodeWithSelector(
            LeafVerifier.WrongLengthForVersion.selector, ClaimLeaf.VERSION, uint256(145), ClaimLeaf.PREIMAGE_BYTES));
        verifier.hashLeaf(bad);
    }

    function test_attack13_corpusVersionAtClaimLengthReverts() public {
        bytes memory bad = new bytes(ClaimLeaf.PREIMAGE_BYTES); // 141 bytes
        bad[0] = bytes1(CorpusLeaf.VERSION); // 0x03
        vm.expectRevert(abi.encodeWithSelector(
            LeafVerifier.WrongLengthForVersion.selector, CorpusLeaf.VERSION, uint256(141), CorpusLeaf.PREIMAGE_BYTES));
        verifier.hashLeaf(bad);
    }

    // =======================================================================
    // Attack 14 — `sealCorpus` with a corpus manifest never logged; with a
    // proof for a different leaf; with each `SealParams` field mismatched
    // (`FactsMismatch(i)`).
    // =======================================================================
    function _corpusPreimage(bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, uint64 episodeCount)
        internal
        view
        returns (bytes memory)
    {
        CorpusLeaf.Corpus memory c;
        c.corpusManifestHash = manifestHash;
        c.corpusRoot = corpusRoot;
        c.termsHash = termsHash;
        c.taskId = bytes32(0);
        c.episodeCount = episodeCount;
        c.sealedAt = uint64(block.timestamp);
        return CorpusLeaf.encode(c);
    }

    function test_attack14_corpusManifestNeverLoggedReverts() public {
        // A well-formed 0x03 preimage that was never hashed into any tree
        // the log anchored — a fabricated inclusion attempt.
        bytes memory pre = _corpusPreimage(keccak256("adv14-manifest"), keccak256("adv14-croot"), TERMS, 5);
        bytes32 leaf = verifier.hashLeaf(pre);
        // Anchor SOME unrelated tree that does not contain this leaf.
        bytes32[] memory unrelated = _leaves(4, "adv14-unrelated");
        (bytes32 root, bytes32[] memory proof) = _buildAndProve(unrelated, 0);
        uint256 anchorIndex = _anchor(root, 4, bytes32(0));
        assertFalse(graspLog.verifyLeafHash(anchorIndex, leaf, proof, 0), "sanity: this leaf really isn't in that tree");

        (bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, , uint64 episodeCount,) = verifier.corpusFacts(pre);
        LicenceRegistry.SealParams memory p = LicenceRegistry.SealParams({
            corpusManifestHash: manifestHash, corpusRoot: corpusRoot, termsHash: termsHash,
            episodeCount: episodeCount, supplier: supplier, price: 100, token: address(usdc)
        });
        vm.prank(supplier);
        vm.expectRevert(LicenceRegistry.CorpusNotLogged.selector);
        registry.sealCorpus(p, pre, proof, 0, anchorIndex);
    }

    function test_attack14_proofForADifferentLeafReverts() public {
        bytes memory pre = _corpusPreimage(keccak256("adv14b-manifest"), keccak256("adv14b-croot"), TERMS, 3);
        bytes32 leaf = verifier.hashLeaf(pre);

        bytes32[] memory leaves = new bytes32[](8);
        uint256 targetIndex = 3;
        for (uint256 i; i < 8; ++i) leaves[i] = i == targetIndex ? leaf : keccak256(abi.encodePacked("adv14b-filler", i));
        (bytes32 root,) = _buildAndProve(leaves, targetIndex);
        // Proof for a DIFFERENT index in the same tree — not this leaf's own proof.
        (, bytes32[] memory wrongProof) = _buildAndProve(leaves, targetIndex == 0 ? 1 : 0);
        uint256 anchorIndex = _anchor(root, 8, bytes32(0));

        (bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, , uint64 episodeCount,) = verifier.corpusFacts(pre);
        LicenceRegistry.SealParams memory p = LicenceRegistry.SealParams({
            corpusManifestHash: manifestHash, corpusRoot: corpusRoot, termsHash: termsHash,
            episodeCount: episodeCount, supplier: supplier, price: 100, token: address(usdc)
        });
        vm.prank(supplier);
        vm.expectRevert(LicenceRegistry.CorpusNotLogged.selector);
        registry.sealCorpus(p, pre, wrongProof, uint64(targetIndex), anchorIndex);
    }

    function _sealedFixture(bytes memory pre)
        internal
        returns (bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex, bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, uint64 episodeCount)
    {
        bytes32 leaf = verifier.hashLeaf(pre);
        bytes32[] memory leaves = new bytes32[](8);
        leafIndex = 5;
        for (uint256 i; i < 8; ++i) leaves[i] = i == leafIndex ? leaf : keccak256(abi.encodePacked("adv14c-filler", i));
        bytes32 root;
        (root, proof) = _buildAndProve(leaves, leafIndex);
        anchorIndex = _anchor(root, 8, bytes32(0));
        (manifestHash, corpusRoot, termsHash, , episodeCount,) = verifier.corpusFacts(pre);
    }

    function test_attack14_eachSealParamsFieldMismatchReverts() public {
        bytes memory pre = _corpusPreimage(keccak256("adv14c-manifest"), keccak256("adv14c-croot"), TERMS, 4);
        (bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex, bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, uint64 episodeCount) = _sealedFixture(pre);

        // field 0: corpusManifestHash mismatch
        {
            LicenceRegistry.SealParams memory p = LicenceRegistry.SealParams({
                corpusManifestHash: keccak256("wrong-manifest-hash"), corpusRoot: corpusRoot, termsHash: termsHash,
                episodeCount: episodeCount, supplier: supplier, price: 100, token: address(usdc)
            });
            vm.prank(supplier);
            vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.FactsMismatch.selector, uint8(0)));
            registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
        }
        // field 1: corpusRoot mismatch
        {
            LicenceRegistry.SealParams memory p = LicenceRegistry.SealParams({
                corpusManifestHash: manifestHash, corpusRoot: keccak256("wrong-corpus-root"), termsHash: termsHash,
                episodeCount: episodeCount, supplier: supplier, price: 100, token: address(usdc)
            });
            vm.prank(supplier);
            vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.FactsMismatch.selector, uint8(1)));
            registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
        }
        // field 2: termsHash mismatch (use a second, real, published terms hash so we hit FactsMismatch, not UnknownTerms)
        {
            bytes32 otherTerms = keccak256("adv14c-other-terms");
            registry.publishTerms(otherTerms, "https://thenar.io/terms/other");
            LicenceRegistry.SealParams memory p = LicenceRegistry.SealParams({
                corpusManifestHash: manifestHash, corpusRoot: corpusRoot, termsHash: otherTerms,
                episodeCount: episodeCount, supplier: supplier, price: 100, token: address(usdc)
            });
            vm.prank(supplier);
            vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.FactsMismatch.selector, uint8(2)));
            registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
        }
        // field 3: episodeCount mismatch
        {
            LicenceRegistry.SealParams memory p = LicenceRegistry.SealParams({
                corpusManifestHash: manifestHash, corpusRoot: corpusRoot, termsHash: termsHash,
                episodeCount: episodeCount + 1, supplier: supplier, price: 100, token: address(usdc)
            });
            vm.prank(supplier);
            vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.FactsMismatch.selector, uint8(3)));
            registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
        }
    }

    // =======================================================================
    // Attack 15 — `license` on retired terms; on a closed corpus; with
    // insufficient allowance.
    // =======================================================================
    function _seal(bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, uint64 episodeCount, uint128 price)
        internal
        returns (uint256 corpusId)
    {
        bytes memory pre = _corpusPreimage(manifestHash, corpusRoot, termsHash, episodeCount);
        (bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex, , , ,) = _sealedFixture(pre);
        LicenceRegistry.SealParams memory p = LicenceRegistry.SealParams({
            corpusManifestHash: manifestHash, corpusRoot: corpusRoot, termsHash: termsHash,
            episodeCount: episodeCount, supplier: supplier, price: price, token: address(usdc)
        });
        vm.prank(supplier);
        corpusId = registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    function test_attack15_licenseOnRetiredTermsReverts() public {
        bytes32 termsForThisTest = keccak256("adv15-retired-terms");
        registry.publishTerms(termsForThisTest, "https://thenar.io/terms/retiring");
        uint256 corpusId = _seal(keccak256("adv15a-manifest"), keccak256("adv15a-croot"), termsForThisTest, 2, 100);

        registry.retireTerms(termsForThisTest);

        usdc.mint(buyer, 100);
        vm.prank(buyer);
        usdc.approve(address(registry), 100);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.TermsRetired.selector, termsForThisTest));
        registry.license(corpusId);
    }

    function test_attack15_licenseOnAClosedCorpusReverts() public {
        uint256 corpusId = _seal(keccak256("adv15b-manifest"), keccak256("adv15b-croot"), TERMS, 2, 100);
        vm.prank(supplier);
        registry.closeCorpus(corpusId);

        usdc.mint(buyer, 100);
        vm.prank(buyer);
        usdc.approve(address(registry), 100);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.CorpusClosed.selector, corpusId));
        registry.license(corpusId);
    }

    function test_attack15_licenseWithInsufficientAllowanceReverts() public {
        uint256 corpusId = _seal(keccak256("adv15c-manifest"), keccak256("adv15c-croot"), TERMS, 2, 100);

        usdc.mint(buyer, 100);
        vm.prank(buyer);
        usdc.approve(address(registry), 40); // less than the 100 price
        vm.prank(buyer);
        vm.expectRevert(LicenceRegistry.TransferFailed.selector);
        registry.license(corpusId);
    }
}
