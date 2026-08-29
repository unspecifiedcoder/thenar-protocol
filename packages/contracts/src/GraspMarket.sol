// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GraspLog} from "./GraspLog.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * GRASP — terms and payment, in one transaction.
 *
 * This is the only part of the design where a chain genuinely beats the
 * alternatives. Off chain, the claim that a buyer paid for a specific corpus
 * under a specific version of the licence is our word against theirs. On chain
 * it is a transfer and a statement of terms, in the same call, and neither of
 * us can revise it afterwards.
 *
 * A purchase names three things and binds them together: the corpus (by the
 * log root it was drawn from), the licence version, and the money. The corpus
 * root must be one this contract's log actually anchored, so a receipt cannot
 * point at a tree that was never published.
 */
contract GraspMarket {
    struct Terms {
        bytes32 documentHash; // keccak256 of the licence text
        string uri;           // where that text is published
        uint64 publishedAt;
        address publisher;
        bool retired;         // no longer offered; existing receipts stand
    }

    struct Receipt {
        address buyer;
        uint256 termsId;
        bytes32 corpusRoot;
        uint64 corpusSize;
        uint256 anchorIndex;
        address token;        // address(0) = native
        uint256 amount;
        uint64 at;
        uint64 blockNumber;
    }

    GraspLog public immutable log;
    address public treasury;
    address public steward;

    Terms[] private _terms;
    Receipt[] private _receipts;
    mapping(address => uint256[]) private _byBuyer;

    error NotSteward();
    error UnknownTerms(uint256 id);
    error TermsRetired(uint256 id);
    error CorpusNotAnchored(bytes32 root, uint256 anchorIndex);
    error ZeroAmount();
    error NativeWithToken();
    error WrongNativeValue(uint256 sent, uint256 want);
    error TransferFailed();
    error EmptyDocumentHash();

    event TermsPublished(uint256 indexed id, bytes32 indexed documentHash, string uri);
    event TermsRetiredEvent(uint256 indexed id);
    event Purchased(
        uint256 indexed receiptId,
        address indexed buyer,
        uint256 indexed termsId,
        bytes32 corpusRoot,
        uint64 corpusSize,
        address token,
        uint256 amount
    );
    event TreasuryChanged(address indexed from, address indexed to);

    constructor(GraspLog log_, address treasury_) {
        log = log_;
        treasury = treasury_ == address(0) ? msg.sender : treasury_;
        steward = msg.sender;
    }

    modifier onlySteward() {
        if (msg.sender != steward) revert NotSteward();
        _;
    }

    // ------------------------------------------------------------------ terms

    /**
     * Publish a licence version. Terms are append-only: retiring one stops it
     * being offered but never touches a receipt that already cites it, because
     * the whole value of the receipt is that it cannot be revised.
     */
    function publishTerms(bytes32 documentHash, string calldata uri)
        external
        onlySteward
        returns (uint256 id)
    {
        if (documentHash == bytes32(0)) revert EmptyDocumentHash();
        id = _terms.length;
        _terms.push(
            Terms({
                documentHash: documentHash,
                uri: uri,
                publishedAt: uint64(block.timestamp),
                publisher: msg.sender,
                retired: false
            })
        );
        emit TermsPublished(id, documentHash, uri);
    }

    function retireTerms(uint256 id) external onlySteward {
        if (id >= _terms.length) revert UnknownTerms(id);
        _terms[id].retired = true;
        emit TermsRetiredEvent(id);
    }

    function termsCount() external view returns (uint256) {
        return _terms.length;
    }

    function termsAt(uint256 id) external view returns (Terms memory) {
        if (id >= _terms.length) revert UnknownTerms(id);
        return _terms[id];
    }

    // --------------------------------------------------------------- purchase

    /**
     * Buy access to a corpus under a licence version. The corpus is named by a
     * root this log anchored, so the receipt is checkable against the log
     * rather than against our word for what was in it.
     */
    function purchase(
        uint256 termsId,
        uint256 anchorIndex,
        bytes32 corpusRoot,
        uint64 corpusSize,
        address token,
        uint256 amount
    ) external payable returns (uint256 receiptId) {
        if (termsId >= _terms.length) revert UnknownTerms(termsId);
        if (_terms[termsId].retired) revert TermsRetired(termsId);
        if (amount == 0) revert ZeroAmount();

        GraspLog.Anchor memory a = log.anchorAt(anchorIndex);
        if (a.root != corpusRoot || a.size != corpusSize) {
            revert CorpusNotAnchored(corpusRoot, anchorIndex);
        }

        if (token == address(0)) {
            if (msg.value != amount) revert WrongNativeValue(msg.value, amount);
            (bool ok, ) = treasury.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (msg.value != 0) revert NativeWithToken();
            if (!IERC20(token).transferFrom(msg.sender, treasury, amount)) {
                revert TransferFailed();
            }
        }

        receiptId = _receipts.length;
        _receipts.push(
            Receipt({
                buyer: msg.sender,
                termsId: termsId,
                corpusRoot: corpusRoot,
                corpusSize: corpusSize,
                anchorIndex: anchorIndex,
                token: token,
                amount: amount,
                at: uint64(block.timestamp),
                blockNumber: uint64(block.number)
            })
        );
        _byBuyer[msg.sender].push(receiptId);
        emit Purchased(receiptId, msg.sender, termsId, corpusRoot, corpusSize, token, amount);
    }

    function receiptCount() external view returns (uint256) {
        return _receipts.length;
    }

    function receiptAt(uint256 id) external view returns (Receipt memory) {
        return _receipts[id];
    }

    function receiptsOf(address buyer) external view returns (uint256[] memory) {
        return _byBuyer[buyer];
    }

    // ------------------------------------------------------------- stewardship

    function setTreasury(address to) external onlySteward {
        emit TreasuryChanged(treasury, to);
        treasury = to;
    }

    function transferSteward(address to) external onlySteward {
        steward = to;
    }
}
