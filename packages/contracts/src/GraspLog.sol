// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleLog} from "./lib/MerkleLog.sol";
import {SparseMerkle} from "./lib/SparseMerkle.sol";
import {ClipLeaf} from "./lib/ClipLeaf.sol";

/**
 * GRASP — the anchor.
 *
 * Hashes on chain, everything else off it. A buyer needs to verify a slice of
 * capture data without trusting our internal records, and a contributor needs
 * to withdraw consent without us being able to pretend they did not. That is
 * the whole job of this contract, and it is deliberately not more.
 *
 * The log is an append-only Merkle tree in the Certificate Transparency style,
 * living off chain and anchored here with its previous root and its size. A
 * pile of independent roots would prove nothing about ordering; a monotonic
 * head with a size is what makes a consistency proof possible. The chain
 * anchors the log. The chain is not the log.
 *
 * Revocations ride in the same call as a sparse-tree root — one extra word per
 * anchor — because absence of a revocation is what a buyer's counsel actually
 * needs, and only a sparse tree can prove it.
 *
 * At an hourly cadence this is 24 transactions a day. It does not need, and
 * does not claim to need, a chain of its own.
 */
contract GraspLog {
    using MerkleLog for bytes32;
    using SparseMerkle for bytes32;

    struct Anchor {
        bytes32 root;            // log root after this batch
        bytes32 prevRoot;        // the head this one extends
        bytes32 revocationRoot;  // sparse tree of withdrawn consent
        uint64 size;             // total leaves in the log
        uint64 at;               // block timestamp
        uint64 blockNumber;      // the block it became publicly knowable
    }

    address public anchorer;
    address public pendingAnchorer;
    Anchor[] private _anchors;

    error NotAnchorer();
    error NotPending();
    error SizeMustGrow(uint64 head, uint64 next);
    error RootMustChange();
    error NoAnchors();
    error UnknownAnchor(uint256 index);
    error NotFirstSighting();

    event Anchored(
        uint256 indexed index,
        bytes32 indexed root,
        bytes32 prevRoot,
        bytes32 revocationRoot,
        uint64 size,
        uint64 at
    );
    event AnchorerTransferStarted(address indexed from, address indexed to);
    event AnchorerTransferred(address indexed from, address indexed to);

    constructor(address anchorer_) {
        anchorer = anchorer_ == address(0) ? msg.sender : anchorer_;
    }

    modifier onlyAnchorer() {
        if (msg.sender != anchorer) revert NotAnchorer();
        _;
    }

    // --------------------------------------------------------------- anchoring

    /**
     * Extend the head. The new size must strictly exceed the old one and the
     * root must actually change: an anchor that says nothing happened is a
     * transaction that should not have been sent, and silently accepting it
     * would let the head stutter without anyone noticing.
     *
     * `prevRoot` is recorded rather than passed, so a caller cannot claim to
     * extend a head that was never current.
     */
    function anchor(bytes32 root, uint64 size, bytes32 revocationRoot)
        external
        onlyAnchorer
        returns (uint256 index)
    {
        bytes32 prev;
        if (_anchors.length > 0) {
            Anchor storage h = _anchors[_anchors.length - 1];
            if (size <= h.size) revert SizeMustGrow(h.size, size);
            if (root == h.root) revert RootMustChange();
            prev = h.root;
        } else if (size == 0) {
            revert SizeMustGrow(0, 0);
        }

        index = _anchors.length;
        _anchors.push(
            Anchor({
                root: root,
                prevRoot: prev,
                revocationRoot: revocationRoot,
                size: size,
                at: uint64(block.timestamp),
                blockNumber: uint64(block.number)
            })
        );
        emit Anchored(index, root, prev, revocationRoot, size, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------ reads

    function anchorCount() external view returns (uint256) {
        return _anchors.length;
    }

    function anchorAt(uint256 index) external view returns (Anchor memory) {
        if (index >= _anchors.length) revert UnknownAnchor(index);
        return _anchors[index];
    }

    function head() external view returns (Anchor memory) {
        if (_anchors.length == 0) revert NoAnchors();
        return _anchors[_anchors.length - 1];
    }

    // ------------------------------------------------------------ verification

    /** This clip is in the log as of the root anchored at `index`. */
    function verifyClip(
        uint256 index,
        bytes calldata preimage,
        bytes32[] calldata proof,
        uint64 leafIndex
    ) external view returns (bool) {
        if (index >= _anchors.length) revert UnknownAnchor(index);
        Anchor storage a = _anchors[index];
        bytes32 leaf = ClipLeaf.hashPreimage(preimage);
        return MerkleLog.verifyInclusion(leaf, proof, leafIndex, a.size, a.root);
    }

    /** Nothing before anchor `later` was rewritten to produce it. */
    function verifyAppendOnly(uint256 earlier, uint256 later, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        if (earlier >= _anchors.length) revert UnknownAnchor(earlier);
        if (later >= _anchors.length) revert UnknownAnchor(later);
        Anchor storage e = _anchors[earlier];
        Anchor storage l = _anchors[later];
        return MerkleLog.verifyConsistency(e.size, e.root, l.size, l.root, proof);
    }

    /**
     * Consent for this clip had NOT been withdrawn as of anchor `index`.
     * This is the proof a buyer actually relies on, and the reason revocations
     * are a sparse tree rather than a list.
     */
    function verifyConsentLive(
        uint256 index,
        bytes32 consentKey,
        uint256 bitmap,
        bytes32[] calldata siblings
    ) external view returns (bool) {
        if (index >= _anchors.length) revert UnknownAnchor(index);
        return SparseMerkle.verifyNonMembership(
            consentKey, bitmap, siblings, _anchors[index].revocationRoot
        );
    }

    /**
     * A revocation, proved present at one anchor and absent at the one before.
     * Grouped into a struct because the walk needs both proofs and six loose
     * parameters is more than the stack will carry.
     */
    struct OnsetProof {
        bytes32 consentKey;
        bytes32 value;
        uint256 bitmapAt;
        bytes32[] siblingsAt;
        uint256 bitmapBefore;
        bytes32[] siblingsBefore;
    }

    /**
     * The block at which a withdrawal became publicly knowable — proved, not
     * asserted: present at `index`, absent at `index - 1`. A buyer's counsel
     * needs the moment it became discoverable, not the moment we noticed.
     */
    function revocationOnset(uint256 index, OnsetProof calldata p)
        external
        view
        returns (uint64 blockNumber, uint64 at)
    {
        if (index >= _anchors.length) revert UnknownAnchor(index);

        if (!SparseMerkle.verifyMembership(
                p.consentKey, p.value, p.bitmapAt, p.siblingsAt, _anchors[index].revocationRoot
            )) revert NotFirstSighting();

        if (index > 0) {
            if (!SparseMerkle.verifyNonMembership(
                    p.consentKey, p.bitmapBefore, p.siblingsBefore,
                    _anchors[index - 1].revocationRoot
                )) revert NotFirstSighting();
        }
        return (_anchors[index].blockNumber, _anchors[index].at);
    }

    // ------------------------------------------------------------- stewardship

    function transferAnchorer(address to) external onlyAnchorer {
        pendingAnchorer = to;
        emit AnchorerTransferStarted(anchorer, to);
    }

    function acceptAnchorer() external {
        if (msg.sender != pendingAnchorer) revert NotPending();
        address from = anchorer;
        anchorer = msg.sender;
        pendingAnchorer = address(0);
        emit AnchorerTransferred(from, msg.sender);
    }
}
