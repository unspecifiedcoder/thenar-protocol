// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * RFC 6962 (Certificate Transparency) Merkle tree verification.
 *
 * The log is append-only and lives off chain; this library is what lets anyone
 * check a claim about it against a root that was anchored on chain. Two proofs
 * matter and they are different things:
 *
 *   - inclusion:   this leaf is in the tree of size n with root r
 *   - consistency: the tree of size m with root r1 is a prefix of the tree of
 *                  size n with root r2 — i.e. nothing was rewritten
 *
 * Publishing roots without consistency proves nothing about ordering, which is
 * the reason the log carries a monotonic head rather than a bag of roots.
 *
 * Domain separation follows RFC 6962: leaves are hashed with a 0x00 prefix and
 * interior nodes with 0x01, so no interior node can ever be forged as a leaf.
 */
library MerkleLog {
    error BadProofLength();
    error IndexOutOfRange();
    error EmptyTree();

    function hashLeaf(bytes memory preimage) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), preimage));
    }

    function hashNode(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x01), l, r));
    }

    /**
     * Verify that `leaf` sits at `index` in a tree of `size` leaves whose root
     * is `root`. The path is ordered leaf-to-root, and sibling side is derived
     * from the index rather than supplied, so a proof cannot lie about shape.
     */
    function verifyInclusion(
        bytes32 leaf,
        bytes32[] memory proof,
        uint64 index,
        uint64 size,
        bytes32 root
    ) internal pure returns (bool) {
        if (size == 0) revert EmptyTree();
        if (index >= size) revert IndexOutOfRange();

        bytes32 node = leaf;
        uint64 i = index;
        uint64 n = size;
        uint256 p;

        // Walk up. At each level the node is a right child when i is odd; when
        // i is even it is a left child, and it only has a sibling if it is not
        // the last node on that level (RFC 6962 trees are not padded).
        while (n > 1) {
            if (i % 2 == 1) {
                if (p >= proof.length) revert BadProofLength();
                node = hashNode(proof[p++], node);
            } else if (i + 1 < n) {
                if (p >= proof.length) revert BadProofLength();
                node = hashNode(node, proof[p++]);
            }
            i /= 2;
            n = (n + 1) / 2;
        }
        if (p != proof.length) revert BadProofLength();
        return node == root;
    }

    /**
     * Verify that a tree of `m` leaves with root `first` is a prefix of a tree
     * of `n` leaves with root `second` — RFC 6962 section 2.1.2.
     */
    function verifyConsistency(
        uint64 m,
        bytes32 first,
        uint64 n,
        bytes32 second,
        bytes32[] memory proof
    ) internal pure returns (bool) {
        if (m == 0 || m > n) return false;
        if (m == n) return proof.length == 0 && first == second;

        uint64 node = m - 1;
        uint64 last = n - 1;

        // Rise to the level where the prefix boundary sits.
        while (node % 2 == 1) {
            node /= 2;
            last /= 2;
        }

        uint256 p;
        bytes32 fr;
        bytes32 sr;

        if (node > 0) {
            if (proof.length == 0) return false;
            fr = proof[p];
            sr = proof[p];
            p++;
        } else {
            // The prefix is a complete left subtree, so its root is `first`.
            fr = first;
            sr = first;
        }

        while (node > 0) {
            if (node % 2 == 1) {
                if (p >= proof.length) return false;
                bytes32 s = proof[p++];
                fr = hashNode(s, fr);
                sr = hashNode(s, sr);
            } else if (node < last) {
                if (p >= proof.length) return false;
                sr = hashNode(sr, proof[p++]);
            }
            node /= 2;
            last /= 2;
        }

        while (last > 0) {
            if (p >= proof.length) return false;
            sr = hashNode(sr, proof[p++]);
            last /= 2;
        }

        return p == proof.length && fr == first && sr == second;
    }
}
