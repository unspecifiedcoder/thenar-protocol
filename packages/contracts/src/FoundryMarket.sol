// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GraspLog} from "./GraspLog.sol";
import {TaskRegistry} from "./TaskRegistry.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * Licence a corpus, and pay everyone who made it, in one transaction.
 *
 * Three parties are owed by a sale: the curator who designed the task, the
 * contributors who produced the episodes, and the protocol. Splitting that off
 * chain would make the split our word again, which is the exact thing the log
 * exists to stop being.
 *
 * Contributors are weighted by the quality their episodes scored, not by count,
 * so a corpus cannot be farmed by submitting many poor demonstrations. The
 * weights are set by the acceptance pipeline when the corpus is closed and are
 * frozen at that point — a cap table that can move after a sale is not a cap
 * table.
 *
 * A payee that refuses transfers is credited rather than reverting the sale:
 * one contributor with a hostile fallback should not be able to block a corpus
 * from ever being licensed. They can pull the balance later.
 */
contract FoundryMarket {
    struct Terms {
        bytes32 documentHash;
        string uri;
        uint64 publishedAt;
        bool retired;
    }

    struct Corpus {
        uint256 taskId;         // TaskRegistry id
        uint256 anchorIndex;    // the anchor whose root covers it
        bytes32 corpusRoot;
        uint64 corpusSize;
        uint128 price;
        address token;          // address(0) = native
        bool open;              // available to licence
        uint64 sealedAt;
        address[] contributors;
        uint256[] weights;      // quality-weighted, sums to weightTotal
        uint256 weightTotal;
    }

    struct Receipt {
        address buyer;
        uint256 corpusId;
        uint256 termsId;
        bytes32 corpusRoot;
        uint256 amount;
        address token;
        uint64 at;
        uint64 blockNumber;
    }

    uint16 public constant PROTOCOL_BPS = 250; // 2.5%
    uint256 public constant MAX_CONTRIBUTORS = 512;

    GraspLog public immutable log;
    TaskRegistry public immutable tasks;
    address public treasury;
    address public steward;

    Terms[] private _terms;
    Corpus[] private _corpora;
    Receipt[] private _receipts;
    mapping(address => uint256) public credited; // owed to a refusing payee

    error NotSteward();
    error UnknownTerms(uint256 id);
    error TermsRetired(uint256 id);
    error UnknownCorpus(uint256 id);
    error CorpusClosed(uint256 id);
    error CorpusNotAnchored(bytes32 root, uint256 anchorIndex);
    error LengthMismatch();
    error NoContributors();
    error TooManyContributors(uint256 got);
    error ZeroWeight();
    error ZeroPrice();
    error WrongNativeValue(uint256 sent, uint256 want);
    error NativeWithToken();
    error TransferFailed();
    error EmptyDocumentHash();
    error NothingCredited();

    event TermsPublished(uint256 indexed id, bytes32 indexed documentHash, string uri);
    event CorpusSealed(
        uint256 indexed corpusId,
        uint256 indexed taskId,
        bytes32 indexed corpusRoot,
        uint64 corpusSize,
        uint256 contributors,
        uint128 price
    );
    event Licensed(
        uint256 indexed receiptId,
        uint256 indexed corpusId,
        address indexed buyer,
        uint256 amount,
        uint256 toCurator,
        uint256 toContributors,
        uint256 toProtocol
    );
    event ContributorPaid(uint256 indexed corpusId, address indexed who, uint256 amount);
    event Credited(address indexed who, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount);

    constructor(GraspLog log_, TaskRegistry tasks_, address treasury_) {
        log = log_;
        tasks = tasks_;
        treasury = treasury_ == address(0) ? msg.sender : treasury_;
        steward = msg.sender;
    }

    modifier onlySteward() {
        if (msg.sender != steward) revert NotSteward();
        _;
    }

    // ------------------------------------------------------------------ terms

    function publishTerms(bytes32 documentHash, string calldata uri)
        external onlySteward returns (uint256 id)
    {
        if (documentHash == bytes32(0)) revert EmptyDocumentHash();
        id = _terms.length;
        _terms.push(Terms(documentHash, uri, uint64(block.timestamp), false));
        emit TermsPublished(id, documentHash, uri);
    }

    function retireTerms(uint256 id) external onlySteward {
        if (id >= _terms.length) revert UnknownTerms(id);
        _terms[id].retired = true;
    }

    // ----------------------------------------------------------------- corpus

    /**
     * Freeze a corpus and its cap table. The root must be one the log actually
     * anchored, so a corpus cannot be sealed over a tree that was never
     * published.
     */
    function sealCorpus(
        uint256 taskId,
        uint256 anchorIndex,
        bytes32 corpusRoot,
        uint64 corpusSize,
        address[] calldata contributors,
        uint256[] calldata weights,
        uint128 price,
        address token
    ) external onlySteward returns (uint256 corpusId) {
        if (contributors.length != weights.length) revert LengthMismatch();
        if (contributors.length == 0) revert NoContributors();
        if (contributors.length > MAX_CONTRIBUTORS) revert TooManyContributors(contributors.length);
        if (price == 0) revert ZeroPrice();
        tasks.taskAt(taskId); // reverts UnknownTask if it was never published

        GraspLog.Anchor memory a = log.anchorAt(anchorIndex);
        if (a.root != corpusRoot || a.size != corpusSize) {
            revert CorpusNotAnchored(corpusRoot, anchorIndex);
        }

        uint256 total;
        for (uint256 i; i < weights.length; ++i) total += weights[i];
        if (total == 0) revert ZeroWeight();

        corpusId = _corpora.length;
        _corpora.push();
        Corpus storage c = _corpora[corpusId];
        c.taskId = taskId;
        c.anchorIndex = anchorIndex;
        c.corpusRoot = corpusRoot;
        c.corpusSize = corpusSize;
        c.price = price;
        c.token = token;
        c.open = true;
        c.sealedAt = uint64(block.timestamp);
        c.contributors = contributors;
        c.weights = weights;
        c.weightTotal = total;

        emit CorpusSealed(corpusId, taskId, corpusRoot, corpusSize, contributors.length, price);
    }

    function closeCorpus(uint256 corpusId) external onlySteward {
        _corpus(corpusId).open = false;
    }

    // --------------------------------------------------------------- licensing

    /** Buy a licence. Curator, contributors and protocol are all paid here. */
    function license(uint256 corpusId, uint256 termsId)
        external payable returns (uint256 receiptId)
    {
        if (termsId >= _terms.length) revert UnknownTerms(termsId);
        if (_terms[termsId].retired) revert TermsRetired(termsId);
        Corpus storage c = _corpus(corpusId);
        if (!c.open) revert CorpusClosed(corpusId);

        uint256 amount = c.price;
        address token = c.token;
        if (token == address(0)) {
            if (msg.value != amount) revert WrongNativeValue(msg.value, amount);
        } else {
            if (msg.value != 0) revert NativeWithToken();
            if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) {
                revert TransferFailed();
            }
        }

        TaskRegistry.Task memory t = tasks.taskAt(c.taskId);
        uint256 toProtocol = (amount * PROTOCOL_BPS) / 10_000;
        uint256 toCurator = (amount * t.curatorBps) / 10_000;
        uint256 pool = amount - toProtocol - toCurator;

        uint256 handed;
        uint256 n = c.contributors.length;
        for (uint256 i; i < n; ++i) {
            uint256 cut = (pool * c.weights[i]) / c.weightTotal;
            if (cut == 0) continue;
            handed += cut;
            emit ContributorPaid(corpusId, c.contributors[i], cut);
            _pay(c.contributors[i], cut, token);
        }

        if (toCurator > 0) _pay(t.curator, toCurator, token);
        // Integer division leaves dust; it rides out with the protocol fee.
        _pay(treasury, toProtocol + (pool - handed), token);

        receiptId = _receipts.length;
        _receipts.push(
            Receipt({
                buyer: msg.sender,
                corpusId: corpusId,
                termsId: termsId,
                corpusRoot: c.corpusRoot,
                amount: amount,
                token: token,
                at: uint64(block.timestamp),
                blockNumber: uint64(block.number)
            })
        );
        emit Licensed(receiptId, corpusId, msg.sender, amount, toCurator, handed, toProtocol);
    }

    /**
     * Pay, or credit if the payee refuses. One hostile fallback should not be
     * able to stop a corpus from ever being licensed.
     */
    function _pay(address to, uint256 amount, address token) private {
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount, gas: 30000}("");
            if (!ok) {
                credited[to] += amount;
                emit Credited(to, amount);
            }
        } else {
            (bool ok, bytes memory data) = token.call(
                abi.encodeWithSelector(0xa9059cbb, to, amount) // transfer(address,uint256)
            );
            if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
                credited[to] += amount;
                emit Credited(to, amount);
            }
        }
    }

    /** Pull whatever a failed transfer left owed. Native only. */
    function withdraw() external {
        uint256 owed = credited[msg.sender];
        if (owed == 0) revert NothingCredited();
        credited[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: owed}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, owed);
    }

    // ------------------------------------------------------------------ reads

    function _corpus(uint256 id) private view returns (Corpus storage) {
        if (id >= _corpora.length) revert UnknownCorpus(id);
        return _corpora[id];
    }

    function termsCount() external view returns (uint256) { return _terms.length; }
    function termsAt(uint256 id) external view returns (Terms memory) {
        if (id >= _terms.length) revert UnknownTerms(id);
        return _terms[id];
    }
    function corpusCount() external view returns (uint256) { return _corpora.length; }
    function corpusAt(uint256 id) external view returns (
        uint256 taskId, bytes32 corpusRoot, uint64 corpusSize, uint128 price,
        address token, bool open, uint256 contributors
    ) {
        Corpus storage c = _corpus(id);
        return (c.taskId, c.corpusRoot, c.corpusSize, c.price, c.token, c.open, c.contributors.length);
    }
    function capTable(uint256 id) external view returns (address[] memory, uint256[] memory, uint256) {
        Corpus storage c = _corpus(id);
        return (c.contributors, c.weights, c.weightTotal);
    }
    function receiptCount() external view returns (uint256) { return _receipts.length; }
    function receiptAt(uint256 id) external view returns (Receipt memory) { return _receipts[id]; }

    function setTreasury(address to) external onlySteward { treasury = to; }
    function transferSteward(address to) external onlySteward { steward = to; }
}
