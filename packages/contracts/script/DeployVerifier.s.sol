// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {LeafVerifier} from "../src/LeafVerifier.sol";

contract DeployVerifier is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        GraspLog log = GraspLog(vm.envAddress("GRASP_LOG"));
        vm.startBroadcast(pk);
        LeafVerifier v = new LeafVerifier(log);
        vm.stopBroadcast();
        console.log("LeafVerifier ", address(v));
    }
}
