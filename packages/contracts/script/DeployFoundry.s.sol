// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {TaskRegistry} from "../src/TaskRegistry.sol";
import {FoundryMarket} from "../src/FoundryMarket.sol";

/** The foundry layer, against the log that is already deployed. */
contract DeployFoundry is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);
        GraspLog log = GraspLog(vm.envAddress("GRASP_LOG"));

        vm.startBroadcast(pk);
        TaskRegistry registry = new TaskRegistry();
        FoundryMarket market = new FoundryMarket(log, registry, me);
        vm.stopBroadcast();

        console.log("TaskRegistry  ", address(registry));
        console.log("FoundryMarket ", address(market));
        console.log("using GraspLog", address(log));
    }
}
