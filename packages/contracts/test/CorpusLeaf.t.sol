// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CorpusLeaf} from "../src/lib/CorpusLeaf.sol";

contract CorpusLeafTest is Test {
    // Internal library calls compile to JUMP, not CALL, so a revert inside one
    // happens at the same depth as the cheatcode itself and vm.expectRevert
    // never sees it. These external wrappers give each call its own frame.
    function encodeExternal(CorpusLeaf.Corpus memory c) external pure returns (bytes memory) {
        return CorpusLeaf.encode(c);
    }

    function hashPreimageExternal(bytes memory p) external pure returns (bytes32) {
        return CorpusLeaf.hashPreimage(p);
    }

    function factsExternal(bytes memory p)
        external
        pure
        returns (bytes32, bytes32, bytes32, bytes32, uint64, uint64)
    {
        return CorpusLeaf.facts(p);
    }

    function _corpus(uint64 episodeCount, uint64 sealedAt) internal pure returns (CorpusLeaf.Corpus memory c) {
        c.corpusManifestHash = keccak256("corpus-manifest");
        c.corpusRoot = keccak256("corpus-root");
        c.termsHash = keccak256("terms-v1");
        c.taskId = keccak256("task-mug-shelf");
        c.episodeCount = episodeCount;
        c.sealedAt = sealedAt;
    }

    // --------------------------------------------------------- encode/hash

    function test_encodeIsExactly145Bytes() public pure {
        bytes memory out = CorpusLeaf.encode(_corpus(1, 1787000000));
        assertEq(out.length, 145);
        assertEq(uint8(out[0]), 0x03);
    }

    function test_hashPrefixesWithTheLeafDomainByte() public pure {
        CorpusLeaf.Corpus memory c = _corpus(42, 1787000000);
        bytes memory pre = CorpusLeaf.encode(c);
        assertEq(CorpusLeaf.hash(c), keccak256(abi.encodePacked(bytes1(0x00), pre)));
        assertEq(CorpusLeaf.hash(c), CorpusLeaf.hashPreimage(pre));
    }

    // ------------------------------------------------------- hard offsets

    function test_offsetsMatchThePlanTable() public pure {
        CorpusLeaf.Corpus memory c = _corpus(42, 1787000000);
        bytes memory p = CorpusLeaf.encode(c);
        // off 1..32  corpusManifestHash
        bytes32 word;
        assembly { word := mload(add(p, 33)) }
        assertEq(word, c.corpusManifestHash, "corpusManifestHash at offset 1");
        // off 33..64 corpusRoot
        assembly { word := mload(add(p, 65)) }
        assertEq(word, c.corpusRoot, "corpusRoot at offset 33");
        // off 65..96 termsHash
        assembly { word := mload(add(p, 97)) }
        assertEq(word, c.termsHash, "termsHash at offset 65");
        // off 97..128 taskId
        assembly { word := mload(add(p, 129)) }
        assertEq(word, c.taskId, "taskId at offset 97");
        // off 129..136 episodeCount, off 137..144 sealedAt
        (,,,, uint64 episodeCount, uint64 sealedAt) = CorpusLeaf.facts(p);
        assertEq(episodeCount, c.episodeCount, "episodeCount at offset 129");
        assertEq(sealedAt, c.sealedAt, "sealedAt at offset 137");
    }

    // -------------------------------------------------------- rejections

    function test_rejectsZeroEpisodeCountOnEncode() public {
        vm.expectRevert(CorpusLeaf.EmptyCorpus.selector);
        this.encodeExternal(_corpus(0, 1787000000));
    }

    function test_rejectsZeroEpisodeCountOnFacts() public {
        CorpusLeaf.Corpus memory c = _corpus(1, 1787000000);
        bytes memory p = CorpusLeaf.encode(c);
        p[136] = 0x00; // zero out the low byte of episodeCount, leaving it 0
        vm.expectRevert(CorpusLeaf.EmptyCorpus.selector);
        this.factsExternal(p);
    }

    function test_rejectsWrongLength() public {
        bytes memory bad = new bytes(144);
        vm.expectRevert(abi.encodeWithSelector(CorpusLeaf.WrongPreimageLength.selector, uint256(144)));
        this.hashPreimageExternal(bad);
    }

    function test_rejectsWrongVersion() public {
        bytes memory p = CorpusLeaf.encode(_corpus(1, 1787000000));
        p[0] = 0x09;
        vm.expectRevert(abi.encodeWithSelector(CorpusLeaf.UnsupportedVersion.selector, uint8(9)));
        this.hashPreimageExternal(p);
    }

    function test_factsRejectsWrongLength() public {
        bytes memory bad = new bytes(146);
        vm.expectRevert(abi.encodeWithSelector(CorpusLeaf.WrongPreimageLength.selector, uint256(146)));
        this.factsExternal(bad);
    }

    function test_factsRejectsWrongVersion() public {
        bytes memory p = CorpusLeaf.encode(_corpus(1, 1787000000));
        p[0] = 0x02;
        vm.expectRevert(abi.encodeWithSelector(CorpusLeaf.UnsupportedVersion.selector, uint8(2)));
        this.factsExternal(p);
    }

    // ------------------------------------------------------------- fuzz

    function testFuzz_roundTripsThroughFacts(
        bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, bytes32 taskId,
        uint64 episodeCount, uint64 sealedAt
    ) public pure {
        episodeCount = uint64(bound(episodeCount, 1, type(uint64).max));
        CorpusLeaf.Corpus memory c;
        c.corpusManifestHash = manifestHash;
        c.corpusRoot = corpusRoot;
        c.termsHash = termsHash;
        c.taskId = taskId;
        c.episodeCount = episodeCount;
        c.sealedAt = sealedAt;

        bytes memory p = CorpusLeaf.encode(c);
        assertEq(p.length, 145);
        (bytes32 mh, bytes32 cr, bytes32 th, bytes32 ti, uint64 ec, uint64 sa) = CorpusLeaf.facts(p);
        assertEq(mh, manifestHash);
        assertEq(cr, corpusRoot);
        assertEq(th, termsHash);
        assertEq(ti, taskId);
        assertEq(ec, episodeCount);
        assertEq(sa, sealedAt);
        assertEq(CorpusLeaf.hash(c), CorpusLeaf.hashPreimage(p));
    }
}
