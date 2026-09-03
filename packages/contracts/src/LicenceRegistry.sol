// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GraspLog} from "./GraspLog.sol";
import {LeafVerifier} from "./LeafVerifier.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * GRASP — terms and payment, in one transaction (D-11, D-22, D-27).
 *
 * A corpus is licensed by naming what it is and paying for it in the same
 * call: the corpus (by the manifest and root a 0x03 leaf actually committed
 * to, proven present in the log at a real anchor) and the terms it was sealed
 * under (by their hash — D-27, there is no numeric terms id). A receipt names
 * `(termsHash, corpusManifestHash, corpusRoot)` (I-8), so it is useful on its
 * own, without trusting anything we say about it later.
 *
 * The foundry/curator model is shelved (D-11 / D-22): the only payees are the
 * supplier and the protocol. A supplier that refuses ERC-20 transfers is
 * credited rather than reverting the sale; they can withdraw later. There is
 * no native-token path at all — `payable` appears nowhere in this contract.
 *
 * `sealCorpus` is the only bridge between the log and money. It must never
 * accept a manifest hash the log did not anchor, so it re-derives the leaf
 * hash itself, proves its inclusion through the log, and cross-checks every
 * fact the leaf actually committed to against what the caller claims.
 */
contract LicenceRegistry {
    struct Terms {
        string uri;
        uint64 publishedAt;
        bool retired;
        bool exists;
    }

    struct SealParams {
        bytes32 corpusManifestHash;
        bytes32 corpusRoot;
        bytes32 termsHash;
        uint64 episodeCount;
        address supplier;
        uint128 price;
        address token;
    }

    struct Corpus {
        bytes32 corpusManifestHash;
        bytes32 corpusRoot;
        bytes32 termsHash;
        uint64 episodeCount;
        address supplier;
        uint128 price;
        address token;
        bool open;
        uint64 sealedAt;
        bytes32 anchorRoot;
        uint64 anchorSize;
    }

    struct Receipt {
        address buyer;
        uint256 corpusId;
        bytes32 termsHash;
        bytes32 corpusRoot;
        bytes32 corpusManifestHash;
        uint256 amount;
        address token;
        uint64 at;
        uint64 blockNumber;
    }

    uint16 public constant PROTOCOL_BPS = 250; // 2.5%

    GraspLog public immutable log;
    LeafVerifier public immutable verifier;
    address public treasury;
    address public steward;
    address public pendingSteward;

    mapping(bytes32 => Terms) private _terms;
    Corpus[] private _corpora;
    Receipt[] private _receipts;
    mapping(address => uint256[]) private _byBuyer;

    /// Owed to a payee whose ERC-20 `transfer` failed, keyed by (who, token).
    mapping(address => mapping(address => uint256)) public credited;

    error NotSteward();
    error NotSupplier();
    error TermsExists(bytes32 termsHash);
    error ZeroTermsHash();
    error UnknownTerms(bytes32 termsHash);
    error TermsRetired(bytes32 termsHash);
    error ZeroPrice();
    error ZeroToken();
    error CorpusNotLogged();
    error FactsMismatch(uint8 field);
    error UnknownCorpus(uint256 id);
    error CorpusClosed(uint256 id);
    error TransferFailed();
    error NothingCredited();

    event TermsPublished(bytes32 indexed termsHash, string uri);
    event TermsRetiredEvent(bytes32 indexed termsHash);
    event CorpusSealed(
        uint256 indexed corpusId,
        bytes32 indexed corpusManifestHash,
        bytes32 corpusRoot,
        address indexed supplier,
        uint128 price,
        address token
    );
    event CorpusClosedEvent(uint256 indexed corpusId);
    event Licensed(
        uint256 indexed receiptId,
        uint256 indexed corpusId,
        address indexed buyer,
        uint256 amount,
        uint256 toSupplier,
        uint256 toProtocol
    );
    event Credited(address indexed who, address indexed token, uint256 amount);
    event Withdrawn(address indexed who, address indexed token, uint256 amount);
    event StewardTransferStarted(address indexed from, address indexed to);
    event StewardTransferred(address indexed from, address indexed to);

    constructor(GraspLog log_, LeafVerifier verifier_, address treasury_) {
        log = log_;
        verifier = verifier_;
        treasury = treasury_ == address(0) ? msg.sender : treasury_;
        steward = msg.sender;
    }

    modifier onlySteward() {
        if (msg.sender != steward) revert NotSteward();
        _;
    }

    // ------------------------------------------------------------------ terms

    /**
     * Publish the hash of a licence document. Terms are append-only (I-8):
     * once published a `termsHash` is never reused for different text, only
     * retired. `termsHash == 0` is refused so it can never be mistaken for
     * "no terms" — the sentinel every unset `Corpus.termsHash` would read as.
     */
    function publishTerms(bytes32 termsHash, string calldata uri) external onlySteward {
        if (termsHash == bytes32(0)) revert ZeroTermsHash();
        if (_terms[termsHash].exists) revert TermsExists(termsHash);
        _terms[termsHash] = Terms({uri: uri, publishedAt: uint64(block.timestamp), retired: false, exists: true});
        emit TermsPublished(termsHash, uri);
    }

    /** Existing corpora and receipts stand; only future `sealCorpus`/`license` calls are blocked. */
    function retireTerms(bytes32 termsHash) external onlySteward {
        Terms storage t = _terms[termsHash];
        if (!t.exists) revert UnknownTerms(termsHash);
        t.retired = true;
        emit TermsRetiredEvent(termsHash);
    }

    // ----------------------------------------------------------------- corpus

    /**
     * Freeze a corpus for sale, proving every fact against the 0x03 leaf the
     * log actually anchored rather than trusting the caller's word.
     *
     * Checks, in order:
     *  1. caller is the named supplier or the steward;
     *  2. terms exist, are not retired, price is non-zero, token is non-zero;
     *  3. the preimage hashes to a leaf included in the log at `anchorIndex`;
     *  4. every fact the leaf committed to matches the caller's claim.
     *
     * Sealing the same manifest twice is allowed: two `sealCorpus` calls with
     * identical `SealParams` simply produce two independent corpora (e.g. the
     * same episodes re-offered under different terms or price). Nothing here
     * treats `corpusManifestHash` as a unique key.
     */
    function sealCorpus(
        SealParams calldata p,
        bytes calldata preimage03,
        bytes32[] calldata logProof,
        uint64 leafIndex,
        uint256 anchorIndex
    ) external returns (uint256 corpusId) {
        if (msg.sender != p.supplier && msg.sender != steward) revert NotSupplier();
        _checkTermsSaleable(p.termsHash);
        if (p.price == 0) revert ZeroPrice();
        if (p.token == address(0)) revert ZeroToken();

        bytes32 leaf = verifier.hashLeaf(preimage03);
        if (!log.verifyLeafHash(anchorIndex, leaf, logProof, leafIndex)) revert CorpusNotLogged();
        _checkFacts(p, preimage03);

        corpusId = _pushCorpus(p, log.anchorAt(anchorIndex));
        emit CorpusSealed(corpusId, p.corpusManifestHash, p.corpusRoot, p.supplier, p.price, p.token);
    }

    function _checkTermsSaleable(bytes32 termsHash) private view {
        Terms storage t = _terms[termsHash];
        if (!t.exists) revert UnknownTerms(termsHash);
        if (t.retired) revert TermsRetired(termsHash);
    }

    function _checkFacts(SealParams calldata p, bytes calldata preimage03) private view {
        (bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, , uint64 episodeCount,) =
            verifier.corpusFacts(preimage03);
        if (manifestHash != p.corpusManifestHash) revert FactsMismatch(0);
        if (corpusRoot != p.corpusRoot) revert FactsMismatch(1);
        if (termsHash != p.termsHash) revert FactsMismatch(2);
        if (episodeCount != p.episodeCount) revert FactsMismatch(3);
    }

    function _pushCorpus(SealParams calldata p, GraspLog.Anchor memory a) private returns (uint256 corpusId) {
        corpusId = _corpora.length;
        _corpora.push(
            Corpus({
                corpusManifestHash: p.corpusManifestHash,
                corpusRoot: p.corpusRoot,
                termsHash: p.termsHash,
                episodeCount: p.episodeCount,
                supplier: p.supplier,
                price: p.price,
                token: p.token,
                open: true,
                sealedAt: uint64(block.timestamp),
                anchorRoot: a.root,
                anchorSize: a.size
            })
        );
    }

    function closeCorpus(uint256 corpusId) external {
        Corpus storage c = _corpus(corpusId);
        if (msg.sender != c.supplier && msg.sender != steward) revert NotSupplier();
        c.open = false;
        emit CorpusClosedEvent(corpusId);
    }

    // --------------------------------------------------------------- licensing

    /**
     * Buy a licence. Not payable — settlement is ERC-20 only (D-11 / D-22).
     * The receipt is written and `Licensed` is emitted before any payout
     * (§11.3, cheap-model trap #16): a reentrant call during `_pay` sees a
     * corpus that is still open and money already collected, never a receipt
     * it could rewrite or double.
     */
    function license(uint256 corpusId) external returns (uint256 receiptId) {
        Corpus storage c = _corpus(corpusId);
        if (!c.open) revert CorpusClosed(corpusId);
        if (_terms[c.termsHash].retired) revert TermsRetired(c.termsHash);

        uint256 amount = c.price;
        address token = c.token;

        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, msg.sender, address(this), amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();

        receiptId = _receipts.length;
        _receipts.push(
            Receipt({
                buyer: msg.sender,
                corpusId: corpusId,
                termsHash: c.termsHash,
                corpusRoot: c.corpusRoot,
                corpusManifestHash: c.corpusManifestHash,
                amount: amount,
                token: token,
                at: uint64(block.timestamp),
                blockNumber: uint64(block.number)
            })
        );
        _byBuyer[msg.sender].push(receiptId);

        uint256 toProtocol = (amount * PROTOCOL_BPS) / 10_000;
        uint256 toSupplier = amount - toProtocol;

        emit Licensed(receiptId, corpusId, msg.sender, amount, toSupplier, toProtocol);

        _pay(c.supplier, toSupplier, token);
        _pay(treasury, toProtocol, token);
    }

    /**
     * Pay, or credit if the payee's `transfer` fails or reverts. A hostile
     * `transfer` hook should not be able to block a sale that already
     * collected payment and wrote its receipt.
     */
    function _pay(address to, uint256 amount, address token) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            credited[to][token] += amount;
            emit Credited(to, token, amount);
        }
    }

    /**
     * Pull whatever a failed `transfer` left owed. The balance is zeroed
     * before the external call; if the transfer still fails, the whole call
     * reverts (state included) rather than re-crediting in a loop.
     */
    function withdraw(address token) external {
        uint256 owed = credited[msg.sender][token];
        if (owed == 0) revert NothingCredited();
        credited[msg.sender][token] = 0;
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transfer.selector, msg.sender, owed));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        emit Withdrawn(msg.sender, token, owed);
    }

    // ------------------------------------------------------------------ reads

    function _corpus(uint256 id) private view returns (Corpus storage) {
        if (id >= _corpora.length) revert UnknownCorpus(id);
        return _corpora[id];
    }

    function termsAt(bytes32 termsHash) external view returns (Terms memory) {
        Terms memory t = _terms[termsHash];
        if (!t.exists) revert UnknownTerms(termsHash);
        return t;
    }

    function corpusCount() external view returns (uint256) {
        return _corpora.length;
    }

    function corpusAt(uint256 id) external view returns (Corpus memory) {
        return _corpus(id);
    }

    function receiptCount() external view returns (uint256) {
        return _receipts.length;
    }

    function receiptAt(uint256 id) external view returns (Receipt memory) {
        if (id >= _receipts.length) revert UnknownCorpus(id);
        return _receipts[id];
    }

    function receiptsOf(address buyer) external view returns (uint256[] memory) {
        return _byBuyer[buyer];
    }

    // ------------------------------------------------------------- stewardship

    function setTreasury(address to) external onlySteward {
        treasury = to;
    }

    function transferSteward(address to) external onlySteward {
        pendingSteward = to;
        emit StewardTransferStarted(steward, to);
    }

    function acceptSteward() external {
        if (msg.sender != pendingSteward) revert NotSteward();
        address from = steward;
        steward = msg.sender;
        pendingSteward = address(0);
        emit StewardTransferred(from, msg.sender);
    }
}
