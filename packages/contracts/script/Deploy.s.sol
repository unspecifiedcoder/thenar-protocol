// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {GraspMarket} from "../src/GraspMarket.sol";

contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);

        GraspLog log = new GraspLog(me);
        GraspMarket market = new GraspMarket(log, me);

        vm.stopBroadcast();

        console.log("GraspLog    ", address(log));
        console.log("GraspMarket ", address(market));
        console.log("anchorer    ", me);
    }
}
