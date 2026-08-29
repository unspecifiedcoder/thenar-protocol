// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {GraspMarket, IERC20} from "../src/GraspMarket.sol";
import {Vectors} from "./Vectors.sol";

contract MockUSD is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/** A treasury that refuses native transfers, to prove the failure is loud. */
contract Refuser {
    receive() external payable { revert("no"); }
}

contract GraspMarketTest is Test {
    GraspLog graspLog;
    GraspMarket market;
    MockUSD usd;
    address steward = address(this);
    address treasury = address(0x7EA);
    address buyer = address(0xB0B);

    function setUp() public {
        graspLog = new GraspLog(address(this));
        market = new GraspMarket(graspLog, treasury);
        usd = new MockUSD();
        graspLog.anchor(Vectors.ROOT_N, Vectors.N, bytes32(0));
        market.publishTerms(keccak256("licence-v1"), "https://thenar.io/terms/v1");
        vm.deal(buyer, 10 ether);
    }

    // ------------------------------------------------------------------ terms

    function test_termsArePublishedAndReadable() public view {
        GraspMarket.Terms memory t = market.termsAt(0);
        assertEq(t.documentHash, keccak256("licence-v1"));
        assertEq(t.uri, "https://thenar.io/terms/v1");
        assertFalse(t.retired);
        assertEq(market.termsCount(), 1);
    }

    function test_termsCannotBeEmpty() public {
        vm.expectRevert(GraspMarket.EmptyDocumentHash.selector);
        market.publishTerms(bytes32(0), "x");
    }

    function test_onlyTheStewardPublishesTerms() public {
        vm.prank(buyer);
        vm.expectRevert(GraspMarket.NotSteward.selector);
        market.publishTerms(keccak256("x"), "x");
    }

    function test_retiredTermsCannotBeBoughtButOldReceiptsStand() public {
        vm.prank(buyer);
        market.purchase{value: 1 ether}(0, 0, Vectors.ROOT_N, Vectors.N, address(0), 1 ether);

        market.retireTerms(0);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(GraspMarket.TermsRetired.selector, 0));
        market.purchase{value: 1 ether}(0, 0, Vectors.ROOT_N, Vectors.N, address(0), 1 ether);

        // The receipt already written is untouched — that is the whole point.
        GraspMarket.Receipt memory r = market.receiptAt(0);
        assertEq(r.termsId, 0);
        assertEq(r.amount, 1 ether);
    }

    // --------------------------------------------------------------- purchase

    function test_purchaseWithNativePaysTheTreasuryAndWritesAReceipt() public {
        uint256 before = treasury.balance;
        vm.prank(buyer);
        uint256 id = market.purchase{value: 2 ether}(0, 0, Vectors.ROOT_N, Vectors.N, address(0), 2 ether);

        assertEq(treasury.balance - before, 2 ether, "treasury paid exactly");
        GraspMarket.Receipt memory r = market.receiptAt(id);
        assertEq(r.buyer, buyer);
        assertEq(r.corpusRoot, Vectors.ROOT_N);
        assertEq(r.corpusSize, Vectors.N);
        assertEq(r.token, address(0));
        assertEq(r.blockNumber, uint64(block.number));
        assertEq(market.receiptsOf(buyer).length, 1);
    }

    function test_purchaseWithAnErc20() public {
        usd.mint(buyer, 500e6);
        vm.startPrank(buyer);
        usd.approve(address(market), 500e6);
        market.purchase(0, 0, Vectors.ROOT_N, Vectors.N, address(usd), 500e6);
        vm.stopPrank();
        assertEq(usd.balanceOf(treasury), 500e6);
        assertEq(usd.balanceOf(buyer), 0);
    }

    /** A corpus that was never anchored cannot be sold. */
    function test_purchaseRefusesACorpusTheLogNeverAnchored() public {
        bytes32 fake = keccak256("a-corpus-that-never-existed");
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(GraspMarket.CorpusNotAnchored.selector, fake, 0));
        market.purchase{value: 1 ether}(0, 0, fake, Vectors.N, address(0), 1 ether);
    }

    function test_purchaseRefusesAMismatchedSize() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(GraspMarket.CorpusNotAnchored.selector, Vectors.ROOT_N, 0));
        market.purchase{value: 1 ether}(0, 0, Vectors.ROOT_N, Vectors.N + 1, address(0), 1 ether);
    }

    function test_purchaseRefusesUnknownTerms() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(GraspMarket.UnknownTerms.selector, 9));
        market.purchase{value: 1 ether}(9, 0, Vectors.ROOT_N, Vectors.N, address(0), 1 ether);
    }

    function test_nativeValueMustMatchTheStatedAmount() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(GraspMarket.WrongNativeValue.selector, 1 ether, 2 ether));
        market.purchase{value: 1 ether}(0, 0, Vectors.ROOT_N, Vectors.N, address(0), 2 ether);
    }

    function test_tokenPurchaseRefusesStrayNative() public {
        usd.mint(buyer, 10e6);
        vm.startPrank(buyer);
        usd.approve(address(market), 10e6);
        vm.expectRevert(GraspMarket.NativeWithToken.selector);
        market.purchase{value: 1 wei}(0, 0, Vectors.ROOT_N, Vectors.N, address(usd), 10e6);
        vm.stopPrank();
    }

    function test_zeroAmountIsRefused() public {
        vm.prank(buyer);
        vm.expectRevert(GraspMarket.ZeroAmount.selector);
        market.purchase(0, 0, Vectors.ROOT_N, Vectors.N, address(0), 0);
    }

    /** A treasury that cannot receive must fail loudly, not swallow the sale. */
    function test_aRefusingTreasuryRevertsTheSale() public {
        Refuser r = new Refuser();
        market.setTreasury(address(r));
        vm.prank(buyer);
        vm.expectRevert(GraspMarket.TransferFailed.selector);
        market.purchase{value: 1 ether}(0, 0, Vectors.ROOT_N, Vectors.N, address(0), 1 ether);
    }

    function testFuzz_receiptAlwaysRecordsWhatWasPaid(uint96 amount) public {
        amount = uint96(bound(amount, 1, 5 ether));
        vm.deal(buyer, amount);
        vm.prank(buyer);
        uint256 id = market.purchase{value: amount}(0, 0, Vectors.ROOT_N, Vectors.N, address(0), amount);
        assertEq(market.receiptAt(id).amount, amount);
    }
}
