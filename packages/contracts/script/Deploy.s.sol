// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {LeafVerifier} from "../src/LeafVerifier.sol";
import {LicenceRegistry} from "../src/LicenceRegistry.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/**
 * Deploys the whole primary-chain stack in one run: the log, its verifier,
 * and the registry (D-9 — `LicenceRegistry` is primary-chain only). Mirror
 * chains deploy `GraspLog` + `LeafVerifier` only, via a separate run of the
 * same two contracts.
 */
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);
        address relayer = vm.envOr("ANCHOR_RELAYER", me);
        address treasury = vm.envOr("TREASURY", me);
        address safe = vm.envOr("SAFE_ADDRESS", address(0));
        bool deployMockUsdc = vm.envOr("DEPLOY_MOCK_USDC", false);

        vm.startBroadcast(pk);

        GraspLog log = new GraspLog(relayer);
        LeafVerifier verifier = new LeafVerifier(log);
        LicenceRegistry registry = new LicenceRegistry(log, verifier, treasury);

        if (safe != address(0)) {
            log.transferAnchorer(safe);
        }

        MockERC20 mockUsdc;
        if (deployMockUsdc) {
            mockUsdc = new MockERC20("Mock USDC", "mUSDC", 6);
        }

        vm.stopBroadcast();

        console.log("GraspLog        ", address(log));
        console.log("LeafVerifier    ", address(verifier));
        console.log("LicenceRegistry ", address(registry));
        console.log("anchorer        ", relayer);
        console.log("treasury        ", treasury);
        if (safe != address(0)) {
            console.log("pending anchorer", safe);
        }
        if (deployMockUsdc) {
            console.log("MockERC20 (USDC)", address(mockUsdc));
        }
    }
}
