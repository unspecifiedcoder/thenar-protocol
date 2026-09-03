// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GraspLog} from "../../src/GraspLog.sol";

/**
 * Invariant tests for GraspLog (PLAN §5 I-2).
 *
 * The D-17 anchor rule requires:
 * - Size never shrinks (I-2).
 * - For consecutive anchors i<j: size_i ≤ size_j
 * - If size_i < size_j, then root_i != root_j
 * - If size_i == size_j, then root_i == root_j AND revocationRoot_i != revocationRoot_j
 * - prevRoot_j == root_{j-1} (or 0 if j==0)
 */
contract LogInvariantHandler is Test {
    GraspLog graspLog;

    constructor(GraspLog log_) {
        graspLog = log_;
    }

    /**
     * Attempt to anchor with arbitrary (size, root, revocationRoot).
     * May revert due to D-17 rule violations; the invariant checker still runs.
     */
    function anchor_randomized(bytes32 root, uint64 size, bytes32 revocationRoot) external {
        try graspLog.anchor(root, size, revocationRoot) {} catch {
            // D-17 rule violations are expected and acceptable; skip silently.
        }
    }

    /**
     * Attempt an equal-size anchor (revocation only).
     * Requires root == head().root and revocationRoot != head().revocationRoot.
     */
    function anchor_revocationOnly() external {
        if (graspLog.anchorCount() == 0) return; // No head yet.

        GraspLog.Anchor memory h = graspLog.head();
        // Increment revocationRoot to ensure it differs.
        bytes32 newRevocationRoot = bytes32(uint256(h.revocationRoot) + 1);

        try graspLog.anchor(h.root, h.size, newRevocationRoot) {} catch {
            // If this fails, skip.
        }
    }

    /**
     * Attempt to shrink the log (must fail).
     */
    function anchor_attemptToShrink(uint64 amount) external {
        if (graspLog.anchorCount() == 0) return; // No head yet.

        GraspLog.Anchor memory h = graspLog.head();
        if (h.size <= 1) return; // Cannot shrink below 1.

        uint64 smallerSize = h.size - amount;
        if (smallerSize >= h.size) return; // Didn't actually shrink.

        vm.expectRevert();
        graspLog.anchor(bytes32(0), smallerSize, bytes32(0));
    }
}

contract LogInvariantTest is Test {
    GraspLog graspLog;
    LogInvariantHandler handler;

    address anchorer = address(0xA1);

    function setUp() public {
        graspLog = new GraspLog(anchorer);
        handler = new LogInvariantHandler(graspLog);

        // Give the handler anchorer privileges via pranking in the handler itself.
        // Actually, the handler cannot prank itself in a static context, so we
        // make the handler the anchorer.
        vm.etch(address(handler), vm.getCode("LogInvariantHandler"));

        // Redeploy with handler as anchorer.
        graspLog = new GraspLog(address(handler));
        handler = new LogInvariantHandler(graspLog);
    }

    // Declare the invariant targets.
    function invariant_SizesAreNonDecreasing() public view {
        uint256 count = graspLog.anchorCount();
        for (uint256 i = 1; i < count; i++) {
            GraspLog.Anchor memory prev = graspLog.anchorAt(i - 1);
            GraspLog.Anchor memory curr = graspLog.anchorAt(i);
            assertLe(prev.size, curr.size, "Size must not shrink");
        }
    }

    function invariant_RootChangeWhenSizeGrows() public view {
        uint256 count = graspLog.anchorCount();
        for (uint256 i = 1; i < count; i++) {
            GraspLog.Anchor memory prev = graspLog.anchorAt(i - 1);
            GraspLog.Anchor memory curr = graspLog.anchorAt(i);

            if (prev.size < curr.size) {
                assertTrue(prev.root != curr.root, "Root must change when size grows");
            }
        }
    }

    function invariant_RootAndRevocationRootAtEqualSize() public view {
        uint256 count = graspLog.anchorCount();
        for (uint256 i = 1; i < count; i++) {
            GraspLog.Anchor memory prev = graspLog.anchorAt(i - 1);
            GraspLog.Anchor memory curr = graspLog.anchorAt(i);

            if (prev.size == curr.size) {
                assertEq(
                    prev.root,
                    curr.root,
                    "At equal size, root must not change"
                );
                assertTrue(
                    prev.revocationRoot != curr.revocationRoot,
                    "At equal size, revocationRoot must change"
                );
            }
        }
    }

    function invariant_PrevRootIsThePriorRoot() public view {
        uint256 count = graspLog.anchorCount();
        for (uint256 i = 1; i < count; i++) {
            GraspLog.Anchor memory prev = graspLog.anchorAt(i - 1);
            GraspLog.Anchor memory curr = graspLog.anchorAt(i);
            assertEq(
                curr.prevRoot,
                prev.root,
                "prevRoot must equal the prior anchor's root"
            );
        }
    }

    function invariant_FirstAnchorHasNoPrevRoot() public view {
        if (graspLog.anchorCount() == 0) return;
        GraspLog.Anchor memory first = graspLog.anchorAt(0);
        assertEq(first.prevRoot, bytes32(0), "First anchor's prevRoot must be 0");
    }
}
