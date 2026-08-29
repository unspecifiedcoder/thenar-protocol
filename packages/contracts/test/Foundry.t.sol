// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {TaskRegistry} from "../src/TaskRegistry.sol";
import {FoundryMarket} from "../src/FoundryMarket.sol";
import {EpisodeLeaf} from "../src/lib/EpisodeLeaf.sol";
import {Vectors} from "./Vectors.sol";

contract Refuser {
    receive() external payable { revert("no"); }
}

contract FoundryTest is Test {
    GraspLog graspLog;
    TaskRegistry registry;
    FoundryMarket market;

    address curator = address(0xC0);
    address treasury = address(0x7EA);
    address buyer = address(0xB0B);
    address alice = address(0xA1);
    address bob = address(0xB2);
    address carol = address(0xC3);

    bytes32 constant SPEC = keccak256("taskspec-v1");

    function setUp() public {
        graspLog = new GraspLog(address(this));
        registry = new TaskRegistry();
        market = new FoundryMarket(graspLog, registry, treasury);
        graspLog.anchor(Vectors.ROOT_N, Vectors.N, bytes32(0));
        market.publishTerms(keccak256("licence-v1"), "https://thenar.io/terms/v1");
        vm.deal(buyer, 100 ether);
    }

    function _publish(uint16 bps) internal returns (uint256 id) {
        vm.prank(curator);
        id = registry.publish(SPEC, "https://thenar.io/tasks/1", bps, 500);
    }

    function _seal(uint256 taskId, uint128 price) internal returns (uint256) {
        address[] memory who = new address[](3);
        who[0] = alice; who[1] = bob; who[2] = carol;
        uint256[] memory w = new uint256[](3);
        w[0] = 9000; w[1] = 6000; w[2] = 3000; // quality-weighted, not per-episode
        return market.sealCorpus(taskId, 0, Vectors.ROOT_N, Vectors.N, who, w, price, address(0));
    }

    // ------------------------------------------------------------ episode leaf

    function test_episodePreimageIsExactly197Bytes() public pure {
        EpisodeLeaf.Episode memory e;
        e.qualityScore = 8000;
        assertEq(EpisodeLeaf.encode(e).length, 197);
        assertEq(EpisodeLeaf.PREIMAGE_BYTES, 197);
    }

    function test_episodeLeafCarriesTheTask() public pure {
        EpisodeLeaf.Episode memory e;
        e.taskId = SPEC;
        e.qualityScore = 5000;
        assertEq(EpisodeLeaf.taskIdOf(EpisodeLeaf.encode(e)), SPEC);
    }

    function test_episodeRefusesAScoreAbove100Percent() public {
        EpisodeLeaf.Episode memory e;
        e.qualityScore = 10001;
        vm.expectRevert(abi.encodeWithSelector(EpisodeLeaf.ScoreOutOfRange.selector, uint16(10001)));
        this.callEncode(e);
    }

    function callEncode(EpisodeLeaf.Episode memory e) external pure returns (bytes memory) {
        return EpisodeLeaf.encode(e);
    }

    function test_episodeRefusesTheOldLeafVersion() public {
        bytes memory old = new bytes(197);
        old[0] = 0x01; // the capture-leaf version
        vm.expectRevert(abi.encodeWithSelector(EpisodeLeaf.UnsupportedVersion.selector, uint8(1)));
        this.callHash(old);
    }

    function callHash(bytes calldata p) external pure returns (bytes32) {
        return EpisodeLeaf.hashPreimage(p);
    }

    // -------------------------------------------------------------- registry

    function test_anyoneMayCurate() public {
        uint256 id = _publish(1000);
        TaskRegistry.Task memory t = registry.taskAt(id);
        assertEq(t.curator, curator);
        assertEq(t.curatorBps, 1000);
        assertTrue(t.open);
    }

    function test_theSameSpecCannotBePublishedTwice() public {
        _publish(1000);
        vm.prank(address(0xDEAD));
        vm.expectRevert(abi.encodeWithSelector(TaskRegistry.AlreadyPublished.selector, SPEC));
        registry.publish(SPEC, "x", 500, 100);
    }

    function test_curatorShareIsCapped() public {
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(
            TaskRegistry.CuratorShareTooHigh.selector, uint16(3001), uint16(3000)));
        registry.publish(SPEC, "x", 3001, 100);
    }

    function test_aTaskIsFoundByItsSpecHash() public {
        uint256 id = _publish(1000);
        (bool found, uint256 got) = registry.bySpecHash(SPEC);
        assertTrue(found);
        assertEq(got, id);
        (bool missing, ) = registry.bySpecHash(keccak256("never"));
        assertFalse(missing);
    }

    function test_onlyTheCuratorClosesTheirTask() public {
        uint256 id = _publish(1000);
        vm.prank(address(0xDEAD));
        vm.expectRevert(TaskRegistry.NotCurator.selector);
        registry.close(id);
        vm.prank(curator);
        registry.close(id);
        assertFalse(registry.taskAt(id).open);
    }

    // ---------------------------------------------------------------- corpus

    function test_corpusMustMatchAnAnchoredRoot() public {
        uint256 t = _publish(1000);
        address[] memory who = new address[](1); who[0] = alice;
        uint256[] memory w = new uint256[](1); w[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(
            FoundryMarket.CorpusNotAnchored.selector, keccak256("nope"), uint256(0)));
        market.sealCorpus(t, 0, keccak256("nope"), Vectors.N, who, w, 1 ether, address(0));
    }

    function test_corpusRefusesMismatchedCapTableLengths() public {
        uint256 t = _publish(1000);
        address[] memory who = new address[](2); who[0] = alice; who[1] = bob;
        uint256[] memory w = new uint256[](1); w[0] = 1;
        vm.expectRevert(FoundryMarket.LengthMismatch.selector);
        market.sealCorpus(t, 0, Vectors.ROOT_N, Vectors.N, who, w, 1 ether, address(0));
    }

    function test_corpusRefusesAllZeroWeights() public {
        uint256 t = _publish(1000);
        address[] memory who = new address[](2); who[0] = alice; who[1] = bob;
        uint256[] memory w = new uint256[](2); w[0] = 0; w[1] = 0;
        vm.expectRevert(FoundryMarket.ZeroWeight.selector);
        market.sealCorpus(t, 0, Vectors.ROOT_N, Vectors.N, who, w, 1 ether, address(0));
    }

    function test_corpusRefusesAnUnpublishedTask() public {
        address[] memory who = new address[](1); who[0] = alice;
        uint256[] memory w = new uint256[](1); w[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(TaskRegistry.UnknownTask.selector, uint256(7)));
        market.sealCorpus(7, 0, Vectors.ROOT_N, Vectors.N, who, w, 1 ether, address(0));
    }

    // -------------------------------------------------------------- licensing

    function test_aLicencePaysCuratorContributorsAndProtocol() public {
        uint256 t = _publish(1000);            // curator takes 10%
        uint256 c = _seal(t, 10 ether);

        uint256 cur0 = curator.balance;
        uint256 tre0 = treasury.balance;
        uint256 a0 = alice.balance; uint256 b0 = bob.balance; uint256 d0 = carol.balance;

        vm.prank(buyer);
        market.license{value: 10 ether}(c, 0);

        uint256 protocol = (10 ether * 250) / 10_000;   // 0.25
        uint256 toCurator = (10 ether * 1000) / 10_000; // 1.0
        uint256 pool = 10 ether - protocol - toCurator; // 8.75

        assertEq(curator.balance - cur0, toCurator, "curator share");
        // 9000 / 18000 = half the pool, 6000 = a third, 3000 = a sixth
        assertEq(alice.balance - a0, (pool * 9000) / 18000, "alice");
        assertEq(bob.balance - b0, (pool * 6000) / 18000, "bob");
        assertEq(carol.balance - d0, (pool * 3000) / 18000, "carol");
        // Every wei must leave the contract.
        assertEq(address(market).balance, 0, "nothing stranded");
        assertGe(treasury.balance - tre0, protocol, "protocol plus dust");
    }

    function test_everyWeiIsAccountedForAcrossAwkwardSplits() public {
        uint256 t = _publish(777);
        address[] memory who = new address[](3);
        who[0] = alice; who[1] = bob; who[2] = carol;
        uint256[] memory w = new uint256[](3);
        w[0] = 1; w[1] = 1; w[2] = 1; // 1/3 each — guaranteed integer dust
        uint256 c = market.sealCorpus(t, 0, Vectors.ROOT_N, Vectors.N, who, w, 1_000_000_007, address(0));

        vm.prank(buyer);
        market.license{value: 1_000_000_007}(c, 0);
        assertEq(address(market).balance, 0, "dust must ride out, not stick");
    }

    function test_weightingIsByQualityNotEpisodeCount() public {
        uint256 t = _publish(0);
        address[] memory who = new address[](2); who[0] = alice; who[1] = bob;
        uint256[] memory w = new uint256[](2);
        w[0] = 9000; w[1] = 1000;  // alice: fewer but better episodes
        uint256 c = market.sealCorpus(t, 0, Vectors.ROOT_N, Vectors.N, who, w, 10 ether, address(0));

        uint256 a0 = alice.balance; uint256 b0 = bob.balance;
        vm.prank(buyer);
        market.license{value: 10 ether}(c, 0);
        assertEq((alice.balance - a0) / (bob.balance - b0), 9, "nine to one, by quality");
    }

    function test_aRefusingContributorIsCreditedNotAllowedToBlockTheSale() public {
        Refuser r = new Refuser();
        uint256 t = _publish(0);
        address[] memory who = new address[](2); who[0] = address(r); who[1] = bob;
        uint256[] memory w = new uint256[](2); w[0] = 1; w[1] = 1;
        uint256 c = market.sealCorpus(t, 0, Vectors.ROOT_N, Vectors.N, who, w, 4 ether, address(0));

        vm.prank(buyer);
        market.license{value: 4 ether}(c, 0);          // must not revert

        uint256 owed = market.credited(address(r));
        assertGt(owed, 0, "the refuser is owed, not paid");
        assertEq(address(market).balance, owed, "held for them exactly");
    }

    function test_aClosedCorpusCannotBeLicensed() public {
        uint256 t = _publish(1000);
        uint256 c = _seal(t, 1 ether);
        market.closeCorpus(c);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(FoundryMarket.CorpusClosed.selector, c));
        market.license{value: 1 ether}(c, 0);
    }

    function test_licenceRefusesTheWrongPrice() public {
        uint256 t = _publish(1000);
        uint256 c = _seal(t, 5 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(
            FoundryMarket.WrongNativeValue.selector, uint256(1 ether), uint256(5 ether)));
        market.license{value: 1 ether}(c, 0);
    }

    function test_receiptRecordsTheSale() public {
        uint256 t = _publish(1000);
        uint256 c = _seal(t, 2 ether);
        vm.prank(buyer);
        uint256 rid = market.license{value: 2 ether}(c, 0);
        FoundryMarket.Receipt memory r = market.receiptAt(rid);
        assertEq(r.buyer, buyer);
        assertEq(r.corpusRoot, Vectors.ROOT_N);
        assertEq(r.amount, 2 ether);
        assertEq(r.blockNumber, uint64(block.number));
    }

    function testFuzz_theSplitNeverStrandsValue(uint96 price, uint16 bps) public {
        price = uint96(bound(price, 1000, 50 ether));
        bps = uint16(bound(bps, 0, 3000));
        vm.prank(curator);
        uint256 t = registry.publish(keccak256(abi.encode(price, bps)), "u", bps, 10);
        uint256 c = _seal(t, price);
        vm.deal(buyer, price);
        vm.prank(buyer);
        market.license{value: price}(c, 0);
        assertEq(address(market).balance, 0);
    }
}
