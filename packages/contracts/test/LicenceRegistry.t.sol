// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {LeafVerifier} from "../src/LeafVerifier.sol";
import {LicenceRegistry} from "../src/LicenceRegistry.sol";
import {CorpusLeaf} from "../src/lib/CorpusLeaf.sol";
import {MockERC20, MockERC20ReturnsFalse, MockERC20NoReturn, MockERC20Reverting} from "./mocks/MockERC20.sol";

/** A payee-controllable mock: `transfer` fails while blocked, succeeds once unblocked. */
contract MockERC20Blockable {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (blocked[to]) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (blocked[to]) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/**
 * A token whose `transfer` reenters `license()` on the same corpus when it
 * pays the supplier, using the buyer's standing approval. Effects-before-
 * interaction (receipt written, `Licensed` emitted, before any `_pay`) must
 * mean this produces at most a legitimate second sale — never a corrupted or
 * duplicated first receipt, and never a payout not backed by its own
 * `transferFrom`.
 */
contract ReentrantSupplierToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    LicenceRegistry public registry;
    uint256 public corpusId;
    address public attacker; // the supplier address the hook triggers on
    bool public armed;
    uint256 public reentryCount;

    /**
     * `fundAmount` funds and self-approves this contract so the reentrant
     * call it makes is a genuine, fully-collateralised purchase — a real
     * attacker cannot spend the original buyer's allowance, only its own.
     */
    function arm(LicenceRegistry r, uint256 id, address attacker_, uint256 fundAmount) external {
        registry = r;
        corpusId = id;
        attacker = attacker_;
        armed = true;
        balanceOf[address(this)] += fundAmount;
        allowance[address(this)][address(r)] += fundAmount;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (armed && to == attacker && reentryCount == 0) {
            reentryCount++;
            armed = false; // reenter once
            registry.license(corpusId);
        }
        return true;
    }
}

contract LicenceRegistryTest is Test {
    GraspLog graspLog;
    LeafVerifier verifier;
    LicenceRegistry registry;
    MockERC20 usdc;

    address steward = address(this);
    address treasury = address(0x7EA5);
    address supplier = address(0x5011);
    address buyer = address(0xB0B);

    bytes32 constant TERMS = keccak256("terms-v1");

    function setUp() public {
        graspLog = new GraspLog(address(this));
        verifier = new LeafVerifier(graspLog);
        registry = new LicenceRegistry(graspLog, verifier, treasury);
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);

        registry.publishTerms(TERMS, "https://thenar.io/terms/v1");
    }

    // --------------------------------------------------------------- helpers

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

    /** RFC 6962 tree builder + inclusion-proof extractor (mirrors LeafVerifier.t.sol). */
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

    /**
     * Build an 8-leaf tree with the given preimage's leaf at index 3, anchor
     * it, and return everything `sealCorpus` needs.
     */
    function _sealed(bytes memory preimage, uint128 price, address token)
        internal
        returns (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex)
    {
        bytes32[] memory leaves = new bytes32[](8);
        bytes32 target = verifier.hashLeaf(preimage);
        leafIndex = 3;
        for (uint256 i; i < 8; ++i) {
            leaves[i] = i == leafIndex ? target : keccak256(abi.encodePacked("filler", i));
        }
        bytes32 root;
        (root, proof) = _buildAndProve(leaves, leafIndex);
        anchorIndex = graspLog.anchor(root, 8, bytes32(0));

        (bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, , uint64 episodeCount,) =
            verifier.corpusFacts(preimage);
        p = LicenceRegistry.SealParams({
            corpusManifestHash: manifestHash,
            corpusRoot: corpusRoot,
            termsHash: termsHash,
            episodeCount: episodeCount,
            supplier: supplier,
            price: price,
            token: token
        });
    }

    /**
     * Like `_sealed`, but anchors a bigger (16-leaf) tree so a second call
     * over the same preimage still satisfies D-17 (size must grow whenever
     * the root changes) instead of colliding with the previous anchor.
     */
    function _sealedGrow(bytes memory preimage, uint128 price, address token)
        internal
        returns (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex)
    {
        bytes32[] memory leaves = new bytes32[](16);
        bytes32 target = verifier.hashLeaf(preimage);
        leafIndex = 7;
        for (uint256 i; i < 16; ++i) {
            leaves[i] = i == leafIndex ? target : keccak256(abi.encodePacked("filler-grow", i));
        }
        bytes32 root;
        (root, proof) = _buildAndProve(leaves, leafIndex);
        anchorIndex = graspLog.anchor(root, 16, bytes32(0));

        (bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, , uint64 episodeCount,) =
            verifier.corpusFacts(preimage);
        p = LicenceRegistry.SealParams({
            corpusManifestHash: manifestHash,
            corpusRoot: corpusRoot,
            termsHash: termsHash,
            episodeCount: episodeCount,
            supplier: supplier,
            price: price,
            token: token
        });
    }

    function _sealedDefault(uint128 price, address token) internal returns (uint256 corpusId) {
        bytes memory pre = _corpusPreimage(keccak256("manifest"), keccak256("croot"), TERMS, 5);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, price, token);
        vm.prank(supplier);
        corpusId = registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    // ------------------------------------------------------------------ terms

    function test_publishAndReadTerms() public view {
        LicenceRegistry.Terms memory t = registry.termsAt(TERMS);
        assertEq(t.uri, "https://thenar.io/terms/v1");
        assertFalse(t.retired);
        assertTrue(t.exists);
    }

    function test_onlyStewardPublishesTerms() public {
        vm.prank(buyer);
        vm.expectRevert(LicenceRegistry.NotSteward.selector);
        registry.publishTerms(keccak256("other"), "x");
    }

    function test_zeroTermsHashRefused() public {
        vm.expectRevert(LicenceRegistry.ZeroTermsHash.selector);
        registry.publishTerms(bytes32(0), "x");
    }

    function test_termsCannotBePublishedTwice() public {
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.TermsExists.selector, TERMS));
        registry.publishTerms(TERMS, "again");
    }

    function test_unknownTermsReverts() public {
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.UnknownTerms.selector, keccak256("nope")));
        registry.termsAt(keccak256("nope"));
    }

    function test_retireTermsMarksRetired() public {
        registry.retireTerms(TERMS);
        assertTrue(registry.termsAt(TERMS).retired);
    }

    function test_onlyStewardRetiresTerms() public {
        vm.prank(buyer);
        vm.expectRevert(LicenceRegistry.NotSteward.selector);
        registry.retireTerms(TERMS);
    }

    function test_retireUnknownTermsReverts() public {
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.UnknownTerms.selector, keccak256("nope")));
        registry.retireTerms(keccak256("nope"));
    }

    // ----------------------------------------------------------------- sealCorpus

    function test_sealCorpusStoresAnchorAndEmits() public {
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 4);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 1000, address(usdc));

        vm.expectEmit(true, true, true, true);
        emit LicenceRegistry.CorpusSealed(0, p.corpusManifestHash, p.corpusRoot, supplier, p.price, p.token);
        vm.prank(supplier);
        uint256 id = registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);

        LicenceRegistry.Corpus memory c = registry.corpusAt(id);
        assertEq(c.corpusManifestHash, p.corpusManifestHash);
        assertEq(c.corpusRoot, p.corpusRoot);
        assertEq(c.termsHash, TERMS);
        assertEq(c.episodeCount, 4);
        assertEq(c.supplier, supplier);
        assertEq(c.price, 1000);
        assertEq(c.token, address(usdc));
        assertTrue(c.open);
        assertEq(c.anchorSize, 8);
        GraspLog.Anchor memory a = graspLog.anchorAt(anchorIndex);
        assertEq(c.anchorRoot, a.root);
        assertEq(registry.corpusCount(), 1);
    }

    function test_stewardMaySealOnBehalfOfSupplier() public {
        bytes memory pre = _corpusPreimage(keccak256("m2"), keccak256("r2"), TERMS, 2);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 500, address(usdc));
        // steward == address(this); do not prank.
        uint256 id = registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
        assertEq(registry.corpusAt(id).supplier, supplier);
    }

    function test_sealingSameManifestTwiceIsAllowed() public {
        bytes memory pre = _corpusPreimage(keccak256("dupe"), keccak256("dupe-root"), TERMS, 3);
        (LicenceRegistry.SealParams memory p1, bytes32[] memory proof1, uint64 li1, uint256 ai1) =
            _sealed(pre, 100, address(usdc));
        vm.prank(supplier);
        uint256 id1 = registry.sealCorpus(p1, pre, proof1, li1, ai1);

        (LicenceRegistry.SealParams memory p2, bytes32[] memory proof2, uint64 li2, uint256 ai2) =
            _sealedGrow(pre, 200, address(usdc));
        vm.prank(supplier);
        uint256 id2 = registry.sealCorpus(p2, pre, proof2, li2, ai2);

        assertTrue(id1 != id2);
        assertEq(registry.corpusCount(), 2);
    }

    function test_sealCorpusRejectsCallerOtherThanSupplierOrSteward() public {
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 1);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 100, address(usdc));
        vm.prank(buyer);
        vm.expectRevert(LicenceRegistry.NotSupplier.selector);
        registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    function test_sealCorpusRejectsUnknownTerms() public {
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), keccak256("ghost-terms"), 1);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 100, address(usdc));
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.UnknownTerms.selector, keccak256("ghost-terms")));
        registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    function test_sealCorpusRejectsRetiredTerms() public {
        registry.retireTerms(TERMS);
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 1);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 100, address(usdc));
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.TermsRetired.selector, TERMS));
        registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    function test_sealCorpusRejectsZeroPrice() public {
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 1);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 0, address(usdc));
        vm.prank(supplier);
        vm.expectRevert(LicenceRegistry.ZeroPrice.selector);
        registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    function test_sealCorpusRejectsZeroToken() public {
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 1);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 100, address(0));
        vm.prank(supplier);
        vm.expectRevert(LicenceRegistry.ZeroToken.selector);
        registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    function test_sealCorpusRejectsProofForADifferentLeaf() public {
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 1);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof,, uint256 anchorIndex) =
            _sealed(pre, 100, address(usdc));
        vm.prank(supplier);
        vm.expectRevert(LicenceRegistry.CorpusNotLogged.selector);
        // Claim a different leaf index than the one the proof was built for.
        registry.sealCorpus(p, pre, proof, 5, anchorIndex);
    }

    function test_sealCorpusRejectsWrongAnchorIndex() public {
        // An unrelated first anchor at index 0. Its size (5) is chosen so an
        // inclusion proof for (index 3, size 8) — what `_sealed` below
        // builds — walks the same number of levels against it (three) as
        // against the real size-8 anchor, so verification runs to
        // completion and reports a root mismatch (`CorpusNotLogged`)
        // instead of reverting on proof length.
        graspLog.anchor(keccak256("unrelated"), 5, bytes32(0));

        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 1);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex,) =
            _sealed(pre, 100, address(usdc));

        vm.prank(supplier);
        vm.expectRevert(LicenceRegistry.CorpusNotLogged.selector);
        registry.sealCorpus(p, pre, proof, leafIndex, 0);
    }

    function test_sealCorpusRejectsManifestHashMismatch() public {
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 1);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 100, address(usdc));
        p.corpusManifestHash = keccak256("wrong");
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.FactsMismatch.selector, uint8(0)));
        registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    function test_sealCorpusRejectsCorpusRootMismatch() public {
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 1);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 100, address(usdc));
        p.corpusRoot = keccak256("wrong");
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.FactsMismatch.selector, uint8(1)));
        registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    function test_sealCorpusRejectsTermsHashMismatch() public {
        registry.publishTerms(keccak256("other-terms"), "https://thenar.io/terms/other");
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 1);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 100, address(usdc));
        p.termsHash = keccak256("other-terms");
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.FactsMismatch.selector, uint8(2)));
        registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    function test_sealCorpusRejectsEpisodeCountMismatch() public {
        bytes memory pre = _corpusPreimage(keccak256("m"), keccak256("r"), TERMS, 3);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 100, address(usdc));
        p.episodeCount = 4;
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.FactsMismatch.selector, uint8(3)));
        registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
    }

    function test_corpusAtUnknownReverts() public {
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.UnknownCorpus.selector, uint256(0)));
        registry.corpusAt(0);
    }

    // ----------------------------------------------------------- closeCorpus

    function test_closeCorpusBySupplier() public {
        uint256 id = _sealedDefault(100, address(usdc));
        vm.prank(supplier);
        registry.closeCorpus(id);
        assertFalse(registry.corpusAt(id).open);
    }

    function test_closeCorpusBySteward() public {
        uint256 id = _sealedDefault(100, address(usdc));
        registry.closeCorpus(id);
        assertFalse(registry.corpusAt(id).open);
    }

    function test_closeCorpusRejectsOthers() public {
        uint256 id = _sealedDefault(100, address(usdc));
        vm.prank(buyer);
        vm.expectRevert(LicenceRegistry.NotSupplier.selector);
        registry.closeCorpus(id);
    }

    // -------------------------------------------------------------- license

    function _fundBuyer(uint256 amount) internal {
        usdc.mint(buyer, amount);
        vm.prank(buyer);
        usdc.approve(address(registry), amount);
    }

    function test_licenseWritesReceiptBeforePayoutAndEmits() public {
        uint256 id = _sealedDefault(1_000_000, address(usdc)); // 1 mUSDC (6dp)
        _fundBuyer(1_000_000);

        vm.expectEmit(true, true, true, true);
        emit LicenceRegistry.Licensed(0, id, buyer, 1_000_000, 975_000, 25_000);
        vm.prank(buyer);
        uint256 receiptId = registry.license(id);

        LicenceRegistry.Receipt memory r = registry.receiptAt(receiptId);
        assertEq(r.buyer, buyer);
        assertEq(r.corpusId, id);
        assertEq(r.termsHash, TERMS);
        assertEq(r.amount, 1_000_000);
        assertEq(r.token, address(usdc));
        assertEq(registry.receiptCount(), 1);
        assertEq(registry.receiptsOf(buyer).length, 1);
        assertEq(registry.receiptsOf(buyer)[0], receiptId);

        assertEq(usdc.balanceOf(supplier), 975_000);
        assertEq(usdc.balanceOf(treasury), 25_000);
    }

    function test_licenseRejectsUnknownCorpus() public {
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.UnknownCorpus.selector, uint256(0)));
        registry.license(0);
    }

    function test_licenseRejectsClosedCorpus() public {
        uint256 id = _sealedDefault(100, address(usdc));
        registry.closeCorpus(id);
        _fundBuyer(100);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.CorpusClosed.selector, id));
        registry.license(id);
    }

    function test_licenseRejectsRetiredTerms() public {
        uint256 id = _sealedDefault(100, address(usdc));
        registry.retireTerms(TERMS);
        _fundBuyer(100);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(LicenceRegistry.TermsRetired.selector, TERMS));
        registry.license(id);
    }

    function test_licenseRejectsFailedTransferFrom_returnsFalse() public {
        MockERC20ReturnsFalse bad = new MockERC20ReturnsFalse();
        uint256 id = _sealedDefault(100, address(bad));
        vm.prank(buyer);
        vm.expectRevert(LicenceRegistry.TransferFailed.selector);
        registry.license(id);
    }

    function test_licenseRejectsFailedTransferFrom_reverting() public {
        MockERC20Reverting bad = new MockERC20Reverting();
        uint256 id = _sealedDefault(100, address(bad));
        vm.prank(buyer);
        vm.expectRevert(LicenceRegistry.TransferFailed.selector);
        registry.license(id);
    }

    function test_licenseAcceptsNoReturnValueToken() public {
        MockERC20NoReturn tok = new MockERC20NoReturn();
        uint256 id = _sealedDefault(1_000_000, address(tok));
        tok.mint(buyer, 1_000_000);
        vm.prank(buyer);
        tok.approve(address(registry), 1_000_000);

        vm.prank(buyer);
        uint256 receiptId = registry.license(id);
        assertEq(tok.balanceOf(supplier), 975_000);
        assertEq(tok.balanceOf(treasury), 25_000);
        assertEq(registry.receiptAt(receiptId).amount, 1_000_000);
    }

    function test_licenseCreditsWhenSupplierTransferReturnsFalse() public {
        // MockERC20ReturnsFalse fails both transfer and transferFrom, so a
        // token that fails only the payout (not the pull-in) needs its own
        // mock: MockERC20Blockable, where `transfer` alone can be refused.
        MockERC20Blockable tok = new MockERC20Blockable();
        uint256 id = _sealedDefault(1_000_000, address(tok));
        tok.mint(buyer, 1_000_000);
        vm.prank(buyer);
        tok.approve(address(registry), 1_000_000);
        tok.setBlocked(supplier, true);

        vm.expectEmit(true, true, true, true);
        emit LicenceRegistry.Credited(supplier, address(tok), 975_000);
        vm.prank(buyer);
        registry.license(id);

        assertEq(registry.credited(supplier, address(tok)), 975_000);
        assertEq(tok.balanceOf(treasury), 25_000);
    }

    function test_creditThenWithdraw() public {
        MockERC20Blockable tok = new MockERC20Blockable();
        uint256 id = _sealedDefault(1_000_000, address(tok));
        tok.mint(buyer, 1_000_000);
        vm.prank(buyer);
        tok.approve(address(registry), 1_000_000);
        tok.setBlocked(supplier, true);

        vm.prank(buyer);
        registry.license(id);
        assertEq(registry.credited(supplier, address(tok)), 975_000);

        tok.setBlocked(supplier, false);
        vm.expectEmit(true, true, true, true);
        emit LicenceRegistry.Withdrawn(supplier, address(tok), 975_000);
        vm.prank(supplier);
        registry.withdraw(address(tok));

        assertEq(registry.credited(supplier, address(tok)), 0);
        assertEq(tok.balanceOf(supplier), 975_000);
    }

    function test_withdrawRejectsNothingCredited() public {
        vm.prank(supplier);
        vm.expectRevert(LicenceRegistry.NothingCredited.selector);
        registry.withdraw(address(usdc));
    }

    function test_withdrawRevertsWithoutRecreditingWhenTransferStillFails() public {
        MockERC20Blockable tok = new MockERC20Blockable();
        uint256 id = _sealedDefault(1_000_000, address(tok));
        tok.mint(buyer, 1_000_000);
        vm.prank(buyer);
        tok.approve(address(registry), 1_000_000);
        tok.setBlocked(supplier, true);
        vm.prank(buyer);
        registry.license(id);

        // Still blocked: withdraw must revert, and the credit must survive
        // (the whole call, including the zeroing, is reverted).
        vm.prank(supplier);
        vm.expectRevert(LicenceRegistry.TransferFailed.selector);
        registry.withdraw(address(tok));
        assertEq(registry.credited(supplier, address(tok)), 975_000);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_splitIsWeiExact(uint96 price) public {
        price = uint96(bound(price, 1, 1_000_000_000 * 1e6)); // up to 1B mUSDC, 6dp
        uint256 id = _sealedDefault(price, address(usdc));
        _fundBuyer(price);

        vm.prank(buyer);
        registry.license(id);

        uint256 toProtocol = (uint256(price) * 250) / 10_000;
        uint256 toSupplier = uint256(price) - toProtocol;
        assertEq(usdc.balanceOf(supplier), toSupplier);
        assertEq(usdc.balanceOf(treasury), toProtocol);
        assertEq(toSupplier + toProtocol, price);
    }

    // ---------------------------------------------------------- stewardship

    function test_twoStepStewardTransfer() public {
        address next = address(0x5EED);
        registry.transferSteward(next);
        assertEq(registry.pendingSteward(), next);
        assertEq(registry.steward(), address(this));

        vm.prank(next);
        registry.acceptSteward();
        assertEq(registry.steward(), next);
        assertEq(registry.pendingSteward(), address(0));
    }

    function test_acceptStewardRejectsNonPending() public {
        registry.transferSteward(address(0x5EED));
        vm.prank(buyer);
        vm.expectRevert(LicenceRegistry.NotSteward.selector);
        registry.acceptSteward();
    }

    function test_onlyStewardTransfersSteward() public {
        vm.prank(buyer);
        vm.expectRevert(LicenceRegistry.NotSteward.selector);
        registry.transferSteward(buyer);
    }

    function test_setTreasury() public {
        registry.setTreasury(buyer);
        assertEq(registry.treasury(), buyer);
    }

    function test_onlyStewardSetsTreasury() public {
        vm.prank(buyer);
        vm.expectRevert(LicenceRegistry.NotSteward.selector);
        registry.setTreasury(buyer);
    }

    // ------------------------------------------------------------ reentrancy

    /**
     * A supplier payout token that reenters `license()` on the same corpus.
     * Effects-before-interaction must mean the first receipt is untouched and
     * every payout is backed by its own `transferFrom` — the reentrant call
     * is just a second, independent, fully-paid-for sale.
     */
    function test_reentrantSupplierTransferCannotAlterReceiptOrDoublePay() public {
        ReentrantSupplierToken tok = new ReentrantSupplierToken();
        uint256 id = _sealedDefault(1_000_000, address(tok));
        tok.mint(buyer, 1_000_000);
        vm.prank(buyer);
        tok.approve(address(registry), 1_000_000);
        // The reentrant call is funded and approved by the token itself, not
        // by spending the original buyer's allowance a second time.
        tok.arm(registry, id, supplier, 1_000_000);

        vm.prank(buyer);
        uint256 firstReceipt = registry.license(id);

        // The reentrant call fired during the first call's supplier payout.
        assertEq(tok.reentryCount(), 1);
        assertEq(registry.receiptCount(), 2, "reentrancy must add a second, independent sale");

        LicenceRegistry.Receipt memory r0 = registry.receiptAt(firstReceipt);
        assertEq(r0.buyer, buyer);
        assertEq(r0.corpusId, id);
        assertEq(r0.amount, 1_000_000, "the first receipt must not be altered by the reentrant call");

        LicenceRegistry.Receipt memory r1 = registry.receiptAt(1);
        assertEq(r1.amount, 1_000_000);

        // Every unit paid to the supplier is backed by exactly two transferFroms.
        assertEq(tok.balanceOf(supplier), 975_000 * 2, "no double-pay: supplier gets exactly two legitimate cuts");
        assertEq(tok.balanceOf(treasury), 25_000 * 2);
        assertEq(tok.balanceOf(buyer), 0);
    }

    // --------------------------------------------------------------- gas

    function test_gas_license() public {
        uint256 id = _sealedDefault(1_000_000, address(usdc));
        _fundBuyer(1_000_000);
        vm.prank(buyer);
        uint256 g0 = gasleft();
        registry.license(id);
        uint256 used = g0 - gasleft();
        emit log_named_uint("gas: license()", used);
    }

    function test_gas_sealCorpus() public {
        bytes memory pre = _corpusPreimage(keccak256("gasm"), keccak256("gasr"), TERMS, 6);
        (LicenceRegistry.SealParams memory p, bytes32[] memory proof, uint64 leafIndex, uint256 anchorIndex) =
            _sealed(pre, 100, address(usdc));
        vm.prank(supplier);
        uint256 g0 = gasleft();
        registry.sealCorpus(p, pre, proof, leafIndex, anchorIndex);
        uint256 used = g0 - gasleft();
        emit log_named_uint("gas: sealCorpus()", used);
    }
}
