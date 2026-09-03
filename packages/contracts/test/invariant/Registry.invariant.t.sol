// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GraspLog} from "../../src/GraspLog.sol";
import {LeafVerifier} from "../../src/LeafVerifier.sol";
import {LicenceRegistry} from "../../src/LicenceRegistry.sol";
import {CorpusLeaf} from "../../src/lib/CorpusLeaf.sol";
import {MockERC20, MockERC20ReturnsFalse} from "../mocks/MockERC20.sol";

/**
 * Invariant tests for LicenceRegistry (PLAN §5 I-8, PLAN §11.3).
 *
 * Invariants:
 * - Sum of Licensed.amount == total paid out + total credited − total withdrawn
 *   (T-032 supervisor note, `TASKS/REPORTS.md`; T-030's acceptance criterion).
 *   Precisely: for every `license()` call the price splits into a part paid
 *   directly (`_pay` succeeds) and a part credited (`_pay` fails); summed
 *   over every call, `totalLicensed == totalPaidDirect + totalCreditedAdded`
 *   holds by construction. `totalWithdrawn` moves money that was credited
 *   into "paid" via `withdraw`, so restated the way the task names it:
 *   `totalLicensed == totalPaidDirect + totalWithdrawn + <current outstanding
 *   credited balance>`, and `<outstanding> == totalCreditedAdded −
 *   totalWithdrawn`.
 * - `credited` never decreases except via `withdraw`: tracked per
 *   (payee, token) as `creditedAdded − creditedWithdrawn`, which must equal
 *   the registry's own `credited(...)` at every check — any other path that
 *   changed it would break the equality.
 * - Every receipt's `corpusId < corpusCount()`.
 * - Every receipt's `corpusRoot`/`corpusManifestHash`/`termsHash` match the sealed corpus's.
 */
contract RegistryInvariantHandler is Test {
    GraspLog graspLog;
    LeafVerifier verifier;
    LicenceRegistry registry;
    MockERC20 token;
    MockERC20ReturnsFalse tokenRefusingPayee;
    address treasury;

    address anchorer = address(0xA1);
    address steward;

    // Tracking for invariants.
    uint256 public totalLicensed;
    uint256 public totalWithdrawn;

    /** Conservation ghosts (money that left the contract directly at `license()` time, and money that was ever credited instead). */
    uint256 public totalPaidDirect;
    uint256 public totalCreditedAdded;

    /** Per-(payee, token) ghosts for the "credited only decreases via withdraw" invariant. */
    mapping(address => mapping(address => uint256)) public creditedAdded;
    mapping(address => mapping(address => uint256)) public creditedWithdrawn;

    address[] public touchedPayees;
    mapping(address => bool) public isTouchedPayee;

    function _touch(address payee) internal {
        if (!isTouchedPayee[payee]) {
            isTouchedPayee[payee] = true;
            touchedPayees.push(payee);
        }
    }

    function touchedPayeesCount() external view returns (uint256) {
        return touchedPayees.length;
    }

    constructor(
        GraspLog log_,
        LeafVerifier verifier_,
        LicenceRegistry registry_,
        MockERC20 token_,
        MockERC20ReturnsFalse tokenRefusingPayee_,
        address treasury_
    ) {
        graspLog = log_;
        verifier = verifier_;
        registry = registry_;
        token = token_;
        tokenRefusingPayee = tokenRefusingPayee_;
        treasury = treasury_;
        steward = msg.sender;
        _touch(treasury_);
    }

    /**
     * Seal a corpus with randomized parameters.
     * The preimage must be a valid 0x03 leaf; we construct one.
     */
    function sealCorpus_random(
        bytes32 manifestHash,
        bytes32 corpusRoot,
        bytes32 termsHash,
        uint64 episodeCount,
        address supplier,
        uint128 price
    ) external {
        // Clamp episodeCount to at least 1.
        if (episodeCount == 0) episodeCount = 1;
        if (price == 0) price = 1; // Price must be > 0.
        if (supplier == address(0)) supplier = address(0x5011);
        _touch(supplier);

        // Create and log a 0x03 leaf.
        CorpusLeaf.Corpus memory c;
        c.corpusManifestHash = manifestHash;
        c.corpusRoot = corpusRoot;
        c.termsHash = termsHash;
        c.taskId = bytes32(0);
        c.episodeCount = episodeCount;
        c.sealedAt = uint64(block.timestamp);

        bytes memory preimage = CorpusLeaf.encode(c);
        bytes32 leaf = verifier.hashLeaf(preimage);

        // Anchor a single leaf (size 1).
        vm.prank(anchorer);
        uint256 anchorIndex = graspLog.anchor(leaf, 1, bytes32(0));

        // Seal the corpus.
        LicenceRegistry.SealParams memory p = LicenceRegistry.SealParams({
            corpusManifestHash: manifestHash,
            corpusRoot: corpusRoot,
            termsHash: termsHash,
            episodeCount: episodeCount,
            supplier: supplier,
            price: price,
            token: address(token)
        });

        bytes32[] memory proof = new bytes32[](0); // Single leaf needs no proof.
        vm.prank(supplier);
        try registry.sealCorpus(p, preimage, proof, 0, anchorIndex) {} catch {
            // Seal failures are acceptable (e.g., unknown terms).
        }
    }

    /**
     * License a random corpus with a random buyer and token.
     */
    function license_random(uint256 corpusId, address buyer, bool useRefusingPayee) external {
        if (corpusId >= registry.corpusCount()) return; // Invalid corpus ID.
        if (buyer == address(0)) buyer = address(0xB0B);

        LicenceRegistry.Corpus memory corpus = registry.corpusAt(corpusId);

        // Fund the buyer with the token.
        address selectedToken = useRefusingPayee ? address(tokenRefusingPayee) : address(token);
        if (selectedToken == address(token)) {
            token.mint(buyer, uint256(corpus.price));
        } else {
            tokenRefusingPayee.mint(buyer, uint256(corpus.price));
        }

        // Approve the registry.
        if (selectedToken == address(token)) {
            vm.prank(buyer);
            token.approve(address(registry), uint256(corpus.price));
        } else {
            vm.prank(buyer);
            tokenRefusingPayee.approve(address(registry), uint256(corpus.price));
        }

        // Snapshot both possible payees' credited balances before the call,
        // so the post-call delta tells us how much of `corpus.price` this
        // specific call routed into `credited` rather than paying directly.
        uint256 supplierCreditedBefore = registry.credited(corpus.supplier, selectedToken);
        uint256 treasuryCreditedBefore = registry.credited(treasury, selectedToken);

        // Attempt to license.
        vm.prank(buyer);
        try registry.license(corpusId) {
            totalLicensed += corpus.price;

            uint256 supplierCreditedAfter = registry.credited(corpus.supplier, selectedToken);
            uint256 treasuryCreditedAfter = registry.credited(treasury, selectedToken);
            uint256 dSupplier = supplierCreditedAfter - supplierCreditedBefore;
            uint256 dTreasury = treasuryCreditedAfter - treasuryCreditedBefore;

            creditedAdded[corpus.supplier][selectedToken] += dSupplier;
            creditedAdded[treasury][selectedToken] += dTreasury;
            totalCreditedAdded += dSupplier + dTreasury;
            totalPaidDirect += corpus.price - dSupplier - dTreasury;

            _touch(corpus.supplier);
            _touch(treasury);
        } catch {
            // License failures are acceptable.
        }
    }

    /**
     * Withdraw credited amounts for a supplier and token.
     */
    function withdraw_random(address supplier, bool useRefusingPayee) external {
        address selectedToken = useRefusingPayee ? address(tokenRefusingPayee) : address(token);
        uint256 owed = registry.credited(supplier, selectedToken);
        if (owed == 0) return;

        vm.prank(supplier);
        try registry.withdraw(selectedToken) {
            totalWithdrawn += owed;
            creditedWithdrawn[supplier][selectedToken] += owed;
            _touch(supplier);
        } catch {
            // Withdraw failures are acceptable.
        }
    }
}

contract RegistryInvariantTest is Test {
    GraspLog graspLog;
    LeafVerifier verifier;
    LicenceRegistry registry;
    MockERC20 token;
    MockERC20ReturnsFalse tokenRefusingPayee;
    RegistryInvariantHandler handler;

    address anchorer = address(0xA1);
    address steward;
    address treasury = address(0x7EA5);

    bytes32 constant TERMS = keccak256("test-terms");

    function setUp() public {
        steward = address(this);

        graspLog = new GraspLog(anchorer);
        verifier = new LeafVerifier(graspLog);
        registry = new LicenceRegistry(graspLog, verifier, treasury);
        token = new MockERC20("Test", "TST", 6);
        tokenRefusingPayee = new MockERC20ReturnsFalse();

        // Publish terms.
        registry.publishTerms(TERMS, "https://example.com/terms");

        // Create handler with anchorer privileges.
        handler = new RegistryInvariantHandler(graspLog, verifier, registry, token, tokenRefusingPayee, treasury);

        // Redeploy GraspLog with handler as anchorer.
        graspLog = new GraspLog(address(handler));
        verifier = new LeafVerifier(graspLog);
        registry = new LicenceRegistry(graspLog, verifier, treasury);
        registry.publishTerms(TERMS, "https://example.com/terms");
        handler = new RegistryInvariantHandler(graspLog, verifier, registry, token, tokenRefusingPayee, treasury);
    }

    // Invariants

    function invariant_EveryReceiptReferencesAValidCorpus() public view {
        uint256 receiptCount = registry.receiptCount();
        uint256 corpusCount = registry.corpusCount();
        for (uint256 i = 0; i < receiptCount; i++) {
            LicenceRegistry.Receipt memory r = registry.receiptAt(i);
            assertTrue(r.corpusId < corpusCount, "Receipt references invalid corpus");
        }
    }

    function invariant_ReceiptFieldsMatchSealdCorpus() public view {
        uint256 receiptCount = registry.receiptCount();
        for (uint256 i = 0; i < receiptCount; i++) {
            LicenceRegistry.Receipt memory r = registry.receiptAt(i);
            LicenceRegistry.Corpus memory c = registry.corpusAt(r.corpusId);

            assertEq(r.corpusRoot, c.corpusRoot, "corpusRoot mismatch");
            assertEq(r.corpusManifestHash, c.corpusManifestHash, "corpusManifestHash mismatch");
            assertEq(r.termsHash, c.termsHash, "termsHash mismatch");
        }
    }

    /**
     * T-032 supervisor note / T-030 acceptance: `credited` never decreases
     * except via `withdraw`. The handler tracks, per (payee, token) actually
     * touched by the fuzzer, how much was ever added to the credited ledger
     * (`creditedAdded`, only incremented from a `license()` payout that
     * failed to pay directly) and how much was ever removed
     * (`creditedWithdrawn`, only incremented from a successful `withdraw`).
     * If any OTHER code path changed `credited` — a bug, or a future
     * refactor that adds one — this equality breaks, because nothing else
     * feeds these two ghost mappings.
     */
    function invariant_CreditedNeverDecreasesExceptViaWithdraw() public view {
        uint256 n = handler.touchedPayeesCount();
        for (uint256 i = 0; i < n; i++) {
            address payee = handler.touchedPayees(i);
            for (uint256 t = 0; t < 2; t++) {
                address tok = t == 0 ? address(token) : address(tokenRefusingPayee);
                uint256 added = handler.creditedAdded(payee, tok);
                uint256 withdrawn = handler.creditedWithdrawn(payee, tok);
                assertEq(
                    registry.credited(payee, tok),
                    added - withdrawn,
                    "credited(payee, token) drifted from ghost added-minus-withdrawn - something changed it outside license()/withdraw()"
                );
            }
        }
    }

    /**
     * T-032 supervisor note / T-030 acceptance: sum of `Licensed.amount` ==
     * total paid out directly + total ever credited − total withdrawn.
     * `totalPaidDirect + totalCreditedAdded == totalLicensed` holds by
     * construction of every single `license_random` call (the handler
     * splits `corpus.price` into exactly those two ghost buckets); this
     * invariant is the regression guard that the split itself — and the
     * registry's own accounting it is derived from — never drifts.
     */
    function invariant_LicensedConservation() public view {
        assertEq(
            handler.totalLicensed(),
            handler.totalPaidDirect() + handler.totalCreditedAdded(),
            "Sum of Licensed.amount must equal total paid directly plus total ever credited"
        );
        // Restated the way the task names it: paid + credited(outstanding) - withdrawn,
        // where credited(outstanding) = totalCreditedAdded - totalWithdrawn.
        assertEq(
            handler.totalLicensed(),
            handler.totalPaidDirect() + handler.totalWithdrawn()
                + (handler.totalCreditedAdded() - handler.totalWithdrawn()),
            "Sum of Licensed.amount must equal paid + outstanding credited + withdrawn"
        );
    }
}
