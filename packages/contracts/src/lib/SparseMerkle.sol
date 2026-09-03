// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Sparse Merkle tree over a 256-bit key space, used for revocations.
 *
 * Withdrawal is the hard half of consent. A buyer does not need to prove a
 * clip was revoked — they need to prove it was *not*, as of a specific root.
 * An inclusion list cannot express absence, so revocations live here instead:
 * in a sparse tree, every key has a defined path, and a key that was never
 * written resolves to the empty subtree. Absence becomes provable.
 *
 * Empty subtrees are the zero word at every level, i.e. H(0,0) == 0. That
 * collapses the 256 levels of an empty tree to a single constant and makes a
 * non-membership proof the same shape as a membership one. It is sound as long
 * as no real leaf value is zero, which `insert` refuses.
 *
 * Proofs are compact: `bitmap` marks the levels that carry a non-zero sibling,
 * so a proof is O(populated depth) words rather than a fixed 256.
 */
library SparseMerkle {
    error ZeroLeafValue();
    error ProofLengthMismatch();

    function hashNode(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        if (l == bytes32(0) && r == bytes32(0)) return bytes32(0);
        return keccak256(abi.encodePacked(l, r));
    }

    /**
     * Fold a leaf value up its key path to a root. `value` is zero for a
     * non-membership claim and the leaf hash for a membership claim.
     *
     * Level 0 is the leaf level; the path bit for level i is bit i of the key,
     * so a node is a right child when that bit is 1.
     */
    function computeRoot(
        bytes32 key,
        bytes32 value,
        uint256 bitmap,
        bytes32[] memory siblings
    ) internal pure returns (bytes32) {
        bytes32 node = value;
        uint256 j;
        for (uint256 i; i < 256; ++i) {
            bytes32 sibling;
            if ((bitmap >> i) & 1 == 1) {
                if (j >= siblings.length) revert ProofLengthMismatch();
                sibling = siblings[j++];
            }
            node = ((uint256(key) >> i) & 1 == 1)
                ? hashNode(sibling, node)
                : hashNode(node, sibling);
        }
        if (j != siblings.length) revert ProofLengthMismatch();
        return node;
    }

    /** The key was never written, as of `root`. */
    function verifyNonMembership(
        bytes32 key,
        uint256 bitmap,
        bytes32[] memory siblings,
        bytes32 root
    ) internal pure returns (bool) {
        return computeRoot(key, bytes32(0), bitmap, siblings) == root;
    }

    /** The key carries `value`, as of `root`. */
    function verifyMembership(
        bytes32 key,
        bytes32 value,
        uint256 bitmap,
        bytes32[] memory siblings,
        bytes32 root
    ) internal pure returns (bool) {
        if (value == bytes32(0)) revert ZeroLeafValue();
        return computeRoot(key, value, bitmap, siblings) == root;
    }
}
