// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The curator's register.
 *
 * A task is a distribution over scenes, authored off chain and published here
 * by its hash. What lives on chain is the commitment and the economics: who
 * designed it, what share of licence revenue they hold, and whether it is still
 * open for contributions.
 *
 * The spec itself stays off chain — it is a JSON document with pose ranges and
 * a success predicate, and putting that in calldata would cost more than it
 * proves. What matters is that the id is the canonical hash of the document, so
 * a curator cannot quietly widen a range after contributors have worked against
 * it: that would produce a different id and a different task.
 *
 * The curator share is the reason this register exists at all. Every competitor
 * in this market pays for capture; nobody pays for designing the task well,
 * which is odd, because task design is what separates a corpus that generalises
 * from one that does not.
 */
contract TaskRegistry {
    struct Task {
        bytes32 specHash;      // canonical hash of the TaskSpec document
        address curator;
        string uri;            // where the spec is published
        uint16 curatorBps;     // curator's share of licence revenue
        uint32 targetEpisodes; // what the curator calls a complete corpus
        uint64 publishedAt;
        bool open;             // accepting contributions
    }

    /** A curator may not take so much that contributing stops being worth it. */
    uint16 public constant MAX_CURATOR_BPS = 3000;

    address public steward;
    Task[] private _tasks;
    mapping(bytes32 => uint256) private _idOf;   // specHash -> index + 1
    mapping(address => uint256[]) private _byCurator;

    error NotSteward();
    error NotCurator();
    error UnknownTask(uint256 id);
    error AlreadyPublished(bytes32 specHash);
    error EmptySpecHash();
    error CuratorShareTooHigh(uint16 got, uint16 max);
    error ZeroTarget();

    event TaskPublished(
        uint256 indexed id,
        bytes32 indexed specHash,
        address indexed curator,
        uint16 curatorBps,
        uint32 targetEpisodes,
        string uri
    );
    event TaskClosed(uint256 indexed id);
    event TaskReopened(uint256 indexed id);
    event CuratorTransferred(uint256 indexed id, address indexed from, address indexed to);

    constructor() {
        steward = msg.sender;
    }

    /**
     * Publish a task. Anyone may curate: the register does not gatekeep, because
     * the acceptance pipeline and the market decide which tasks are worth
     * contributing to far better than a whitelist would.
     */
    function publish(
        bytes32 specHash,
        string calldata uri,
        uint16 curatorBps,
        uint32 targetEpisodes
    ) external returns (uint256 id) {
        if (specHash == bytes32(0)) revert EmptySpecHash();
        if (_idOf[specHash] != 0) revert AlreadyPublished(specHash);
        if (curatorBps > MAX_CURATOR_BPS) revert CuratorShareTooHigh(curatorBps, MAX_CURATOR_BPS);
        if (targetEpisodes == 0) revert ZeroTarget();

        id = _tasks.length;
        _tasks.push(
            Task({
                specHash: specHash,
                curator: msg.sender,
                uri: uri,
                curatorBps: curatorBps,
                targetEpisodes: targetEpisodes,
                publishedAt: uint64(block.timestamp),
                open: true
            })
        );
        _idOf[specHash] = id + 1;
        _byCurator[msg.sender].push(id);
        emit TaskPublished(id, specHash, msg.sender, curatorBps, targetEpisodes, uri);
    }

    function close(uint256 id) external {
        Task storage t = _at(id);
        if (msg.sender != t.curator && msg.sender != steward) revert NotCurator();
        t.open = false;
        emit TaskClosed(id);
    }

    function reopen(uint256 id) external {
        Task storage t = _at(id);
        if (msg.sender != t.curator && msg.sender != steward) revert NotCurator();
        t.open = true;
        emit TaskReopened(id);
    }

    /** A curator can hand a task on; the share follows the task, not the person. */
    function transferCurator(uint256 id, address to) external {
        Task storage t = _at(id);
        if (msg.sender != t.curator) revert NotCurator();
        emit CuratorTransferred(id, t.curator, to);
        t.curator = to;
        _byCurator[to].push(id);
    }

    function _at(uint256 id) private view returns (Task storage) {
        if (id >= _tasks.length) revert UnknownTask(id);
        return _tasks[id];
    }

    // ------------------------------------------------------------------ reads

    function taskCount() external view returns (uint256) {
        return _tasks.length;
    }

    function taskAt(uint256 id) external view returns (Task memory) {
        return _at(id);
    }

    /** Look a task up by the hash of its spec — the id a leaf actually carries. */
    function bySpecHash(bytes32 specHash) external view returns (bool found, uint256 id) {
        uint256 slot = _idOf[specHash];
        return slot == 0 ? (false, 0) : (true, slot - 1);
    }

    function tasksOf(address curator) external view returns (uint256[] memory) {
        return _byCurator[curator];
    }

    function transferSteward(address to) external {
        if (msg.sender != steward) revert NotSteward();
        steward = to;
    }
}
