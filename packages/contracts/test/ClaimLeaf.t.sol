// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClaimLeaf} from "../src/lib/ClaimLeaf.sol";
import {Vectors} from "./Vectors.sol";

contract ClaimLeafTest is Test {
    // Internal library calls compile to JUMP, not CALL, so a revert inside one
    // happens at the same depth as the cheatcode itself and vm.expectRevert
    // never sees it. These external wrappers give each call its own frame.
    function encodeExternal(ClaimLeaf.Claim memory c) external pure returns (bytes memory) {
        return ClaimLeaf.encode(c);
    }

    function hashPreimageExternal(bytes memory p) external pure returns (bytes32) {
        return ClaimLeaf.hashPreimage(p);
    }

    function factsExternal(bytes memory p)
        external
        pure
        returns (bytes32, bytes32, bytes32, bytes32, uint16, uint8, uint8, uint64)
    {
        return ClaimLeaf.facts(p);
    }

    function _claim(uint16 checkId, uint8 result, uint8 level, uint64 issuedAt)
        internal pure returns (ClaimLeaf.Claim memory c)
    {
        c.subjectLeaf = keccak256("subject-leaf");
        c.verifierKeyId = keccak256("verifier-key");
        c.detailHash = keccak256("detail");
        c.signatureHash = keccak256("signature");
        c.checkId = checkId;
        c.result = result;
        c.levelAsserted = level;
        c.issuedAt = issuedAt;
    }

    // --------------------------------------------------------- encode/hash

    function test_encodeIsExactly141Bytes() public pure {
        bytes memory out = ClaimLeaf.encode(_claim(3, 1, 2, 1787000100));
        assertEq(out.length, 141);
        assertEq(uint8(out[0]), 0x04);
    }

    function test_hashPrefixesWithTheLeafDomainByte() public pure {
        ClaimLeaf.Claim memory c = _claim(3, 1, 2, 1787000100);
        bytes memory pre = ClaimLeaf.encode(c);
        assertEq(ClaimLeaf.hash(c), keccak256(abi.encodePacked(bytes1(0x00), pre)));
        assertEq(ClaimLeaf.hash(c), ClaimLeaf.hashPreimage(pre));
    }

    // ------------------------------------------------------- hard offsets

    function test_offsetsMatchThePlanTable() public pure {
        ClaimLeaf.Claim memory c = _claim(3, 1, 2, 1787000100);
        bytes memory p = ClaimLeaf.encode(c);
        bytes32 word;
        // off 1..32 subjectLeaf
        assembly { word := mload(add(p, 33)) }
        assertEq(word, c.subjectLeaf, "subjectLeaf at offset 1");
        // off 33..64 verifierKeyId
        assembly { word := mload(add(p, 65)) }
        assertEq(word, c.verifierKeyId, "verifierKeyId at offset 33");
        // off 65..96 detailHash
        assembly { word := mload(add(p, 97)) }
        assertEq(word, c.detailHash, "detailHash at offset 65");
        // off 97..128 signatureHash
        assembly { word := mload(add(p, 129)) }
        assertEq(word, c.signatureHash, "signatureHash at offset 97");
        (,,,, uint16 checkId, uint8 result, uint8 level, uint64 issuedAt) = ClaimLeaf.facts(p);
        assertEq(checkId, c.checkId, "checkId at offset 129");
        assertEq(result, c.result, "result at offset 131");
        assertEq(level, c.levelAsserted, "levelAsserted at offset 132");
        assertEq(issuedAt, c.issuedAt, "issuedAt at offset 133");
    }

    // --------------------------------------------------- T-008 TS vectors

    /**
     * `ClaimLeaf.hashPreimage` on the T-008 vector's 0x04 preimage equals
     * the leaf hash the TypeScript reference (`packages/protocol/src/claim.ts`)
     * computed for the same fields — PLAN §5 I-5.
     */
    function test_vectorPreimageHashesToTheVectorLeaf() public pure {
        assertEq(Vectors.CLAIM_PREIMAGE.length, ClaimLeaf.PREIMAGE_BYTES);
        assertEq(ClaimLeaf.hashPreimage(Vectors.CLAIM_PREIMAGE), Vectors.CLAIM_LEAF);
    }

    // -------------------------------------------------------- rejections

    function test_rejectsResultAboveTwoOnEncode() public {
        vm.expectRevert(abi.encodeWithSelector(ClaimLeaf.ResultOutOfRange.selector, uint8(3)));
        this.encodeExternal(_claim(3, 3, 2, 1787000100));
    }

    function test_rejectsLevelAboveFourOnEncode() public {
        vm.expectRevert(abi.encodeWithSelector(ClaimLeaf.LevelOutOfRange.selector, uint8(5)));
        this.encodeExternal(_claim(3, 1, 5, 1787000100));
    }

    function test_rejectsZeroCheckIdOnEncode() public {
        vm.expectRevert(ClaimLeaf.CheckIdMustBeNonzero.selector);
        this.encodeExternal(_claim(0, 1, 2, 1787000100));
    }

    function test_rejectsZeroIssuedAtOnEncode() public {
        vm.expectRevert(ClaimLeaf.IssuedAtMustBeNonzero.selector);
        this.encodeExternal(_claim(3, 1, 2, 0));
    }

    function test_rejectsResultAboveTwoOnFacts() public {
        bytes memory p = ClaimLeaf.encode(_claim(3, 1, 2, 1787000100));
        p[131] = 0x03;
        vm.expectRevert(abi.encodeWithSelector(ClaimLeaf.ResultOutOfRange.selector, uint8(3)));
        this.factsExternal(p);
    }

    function test_rejectsLevelAboveFourOnFacts() public {
        bytes memory p = ClaimLeaf.encode(_claim(3, 1, 2, 1787000100));
        p[132] = 0x05;
        vm.expectRevert(abi.encodeWithSelector(ClaimLeaf.LevelOutOfRange.selector, uint8(5)));
        this.factsExternal(p);
    }

    function test_rejectsZeroCheckIdOnFacts() public {
        bytes memory p = ClaimLeaf.encode(_claim(3, 1, 2, 1787000100));
        p[129] = 0x00;
        p[130] = 0x00;
        vm.expectRevert(ClaimLeaf.CheckIdMustBeNonzero.selector);
        this.factsExternal(p);
    }

    function test_rejectsZeroIssuedAtOnFacts() public {
        bytes memory p = ClaimLeaf.encode(_claim(3, 1, 2, 1787000100));
        for (uint256 i = 133; i < 141; ++i) p[i] = 0x00;
        vm.expectRevert(ClaimLeaf.IssuedAtMustBeNonzero.selector);
        this.factsExternal(p);
    }

    function test_rejectsWrongLength() public {
        bytes memory bad = new bytes(140);
        vm.expectRevert(abi.encodeWithSelector(ClaimLeaf.WrongPreimageLength.selector, uint256(140)));
        this.hashPreimageExternal(bad);
    }

    function test_rejectsWrongVersion() public {
        bytes memory p = ClaimLeaf.encode(_claim(3, 1, 2, 1787000100));
        p[0] = 0x09;
        vm.expectRevert(abi.encodeWithSelector(ClaimLeaf.UnsupportedVersion.selector, uint8(9)));
        this.hashPreimageExternal(p);
    }

    function test_factsRejectsWrongLength() public {
        bytes memory bad = new bytes(142);
        vm.expectRevert(abi.encodeWithSelector(ClaimLeaf.WrongPreimageLength.selector, uint256(142)));
        this.factsExternal(bad);
    }

    function test_factsRejectsWrongVersion() public {
        bytes memory p = ClaimLeaf.encode(_claim(3, 1, 2, 1787000100));
        p[0] = 0x02;
        vm.expectRevert(abi.encodeWithSelector(ClaimLeaf.UnsupportedVersion.selector, uint8(2)));
        this.factsExternal(p);
    }

    // ------------------------------------------------------------- fuzz

    function testFuzz_roundTripsThroughFacts(
        bytes32 subjectLeaf, bytes32 verifierKeyId, bytes32 detailHash, bytes32 signatureHash,
        uint16 checkId, uint8 result, uint8 level, uint64 issuedAt
    ) public pure {
        checkId = uint16(bound(checkId, 1, type(uint16).max));
        result = uint8(bound(result, 0, 2));
        level = uint8(bound(level, 0, 4));
        issuedAt = uint64(bound(issuedAt, 1, type(uint64).max));

        ClaimLeaf.Claim memory c = _claim2(
            subjectLeaf, verifierKeyId, detailHash, signatureHash, checkId, result, level, issuedAt
        );
        bytes memory p = ClaimLeaf.encode(c);
        assertEq(p.length, 141);
        _assertFactsMatch(p, c);
    }

    function _claim2(
        bytes32 subjectLeaf, bytes32 verifierKeyId, bytes32 detailHash, bytes32 signatureHash,
        uint16 checkId, uint8 result, uint8 level, uint64 issuedAt
    ) internal pure returns (ClaimLeaf.Claim memory c) {
        c.subjectLeaf = subjectLeaf;
        c.verifierKeyId = verifierKeyId;
        c.detailHash = detailHash;
        c.signatureHash = signatureHash;
        c.checkId = checkId;
        c.result = result;
        c.levelAsserted = level;
        c.issuedAt = issuedAt;
    }

    function _assertFactsMatch(bytes memory p, ClaimLeaf.Claim memory c) internal pure {
        (bytes32 sl, bytes32 vk, bytes32 dh, bytes32 sh, uint16 ci, uint8 r, uint8 lv, uint64 ia) =
            ClaimLeaf.facts(p);
        assertEq(sl, c.subjectLeaf);
        assertEq(vk, c.verifierKeyId);
        assertEq(dh, c.detailHash);
        assertEq(sh, c.signatureHash);
        assertEq(ci, c.checkId);
        assertEq(r, c.result);
        assertEq(lv, c.levelAsserted);
        assertEq(ia, c.issuedAt);
        assertEq(ClaimLeaf.hash(c), ClaimLeaf.hashPreimage(p));
    }
}
