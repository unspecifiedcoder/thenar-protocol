// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MerkleLog} from "../src/lib/MerkleLog.sol";
import {Vectors} from "./Vectors.sol";

/**
 * T-008 — a from-scratch Solidity port of PLAN §10.4 (`fileLeaf` /
 * `payloadHash`), independent of any TypeScript code, checked against the
 * vectors the reference implementation produced.
 *
 * §10.4 has never had a Solidity implementation — `payloadHash` is computed
 * off chain, by the server, from a manifest's `files[]` — so this file is
 * not testing production Solidity code. It exists to prove PLAN §5 I-5 the
 * other direction: that the byte rule in §10.4 is unambiguous enough for a
 * second, independent implementation to land on the exact same root as the
 * TypeScript one (`packages/protocol/src/payload.ts`). PLAN §27 trap #3
 * (no second 0x00 when leaf hashes become tree nodes) and trap #4
 * (`abi.encodePacked`, never padded `abi.encode`) both apply here, same as
 * in the TS implementation.
 */
contract PayloadVectorsTest is Test {
    /** `H(0x00 ‖ utf8(path) ‖ 0x1f ‖ fileHash)` — PLAN §10.4. */
    function _fileLeaf(string memory path, bytes32 fileHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), bytes(path), bytes1(0x1f), fileHash));
    }

    /** Largest power of two strictly less than n — mirrors `split()` in `log.ts`. */
    function _splitPoint(uint256 n) internal pure returns (uint256 k) {
        k = 1;
        while (k * 2 < n) k *= 2;
    }

    /**
     * `ctRoot` (PLAN §10.1 node rules) over already-hashed leaves used
     * directly as level-0 nodes — no second 0x00 (§27 trap #3). Mirrors
     * `root()` in `packages/protocol/src/log.ts`, using `MerkleLog.hashNode`
     * (the same 0x01-domain-separated interior-node hash the log itself
     * verifies inclusion proofs against) for every interior node.
     */
    function _ctRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        require(n > 0, "ctRoot: empty");
        if (n == 1) return leaves[0];
        uint256 k = _splitPoint(n);
        bytes32[] memory left = new bytes32[](k);
        bytes32[] memory right = new bytes32[](n - k);
        for (uint256 i; i < k; ++i) left[i] = leaves[i];
        for (uint256 i; i < n - k; ++i) right[i] = leaves[k + i];
        return MerkleLog.hashNode(_ctRoot(left), _ctRoot(right));
    }

    /**
     * Recompute `fileLeaf` for each of the three fixture files
     * (`packages/protocol/test/fixtures/files/{a.txt,b.bin,sub/c.parquet}`)
     * and `payloadHash` over all three, from the vector inputs alone —
     * proving the Solidity port and the TypeScript reference agree on both
     * the per-file leaf and the tree built over them.
     */
    function test_fileLeafAndPayloadHashPortOfSection10_4() public pure {
        bytes32 l0 = _fileLeaf(Vectors.FILE0_PATH, Vectors.FILE0_HASH);
        bytes32 l1 = _fileLeaf(Vectors.FILE1_PATH, Vectors.FILE1_HASH);
        bytes32 l2 = _fileLeaf(Vectors.FILE2_PATH, Vectors.FILE2_HASH);
        assertEq(l0, Vectors.FILE0_LEAF, "FILE0 fileLeaf");
        assertEq(l1, Vectors.FILE1_LEAF, "FILE1 fileLeaf");
        assertEq(l2, Vectors.FILE2_LEAF, "FILE2 fileLeaf");

        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = l0;
        leaves[1] = l1;
        leaves[2] = l2;
        assertEq(_ctRoot(leaves), Vectors.PAYLOAD_HASH, "payloadHash");
    }

    /** A single-file payload's root is just that file's own leaf (§10.4). */
    function test_singleFileTreeIsItsOwnLeaf() public pure {
        bytes32 l0 = _fileLeaf(Vectors.FILE0_PATH, Vectors.FILE0_HASH);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = l0;
        assertEq(_ctRoot(leaves), l0);
    }
}
