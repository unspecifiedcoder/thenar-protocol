// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GraspLog} from "../src/GraspLog.sol";
import {LeafVerifier} from "../src/LeafVerifier.sol";
import {LicenceRegistry} from "../src/LicenceRegistry.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/**
 * Deploys the GraspLog stack to one chain. `ROLE` (env, `primary` |
 * `mirror`, default `primary`) picks how much: the primary chain deploys
 * `GraspLog` + `LeafVerifier` + `LicenceRegistry` (D-9 — the registry is
 * primary-chain only); a mirror deploys `GraspLog` + `LeafVerifier` only,
 * byte-identical to the primary's.
 *
 * Addresses are printed as `CHAIN_<id>_<FIELD>=value` lines — the format
 * `services/log/src/chains.ts` parses from `.env.contracts` (T-007) — so a
 * wrapper (`scripts/deploy-chain.sh`, T-009) can append this run's output
 * straight into that file.
 */
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);
        address relayer = vm.envOr("ANCHOR_RELAYER", me);
        address treasury = vm.envOr("TREASURY", me);
        address safe = vm.envOr("SAFE_ADDRESS", address(0));
        bool deployMockUsdc = vm.envOr("DEPLOY_MOCK_USDC", false);

        string memory role = vm.envOr("ROLE", string("primary"));
        bool isPrimary = _isRole(role, "primary");
        require(isPrimary || _isRole(role, "mirror"), "ROLE must be \"primary\" or \"mirror\"");

        vm.startBroadcast(pk);

        GraspLog log = new GraspLog(relayer);
        LeafVerifier verifier = new LeafVerifier(log);
        LicenceRegistry registry;
        if (isPrimary) {
            registry = new LicenceRegistry(log, verifier, treasury);
        }

        if (safe != address(0)) {
            log.transferAnchorer(safe);
        }

        MockERC20 mockUsdc;
        if (isPrimary && deployMockUsdc) {
            mockUsdc = new MockERC20("Mock USDC", "mUSDC", 6);
        }

        vm.stopBroadcast();

        console.log("role            ", role);
        console.log("GraspLog        ", address(log));
        console.log("LeafVerifier    ", address(verifier));
        if (isPrimary) {
            console.log("LicenceRegistry ", address(registry));
        }
        console.log("anchorer        ", relayer);
        console.log("treasury        ", treasury);
        if (safe != address(0)) {
            console.log("pending anchorer", safe);
        }
        if (isPrimary && deployMockUsdc) {
            console.log("MockERC20 (USDC)", address(mockUsdc));
        }

        // Machine-parseable block — a wrapper appends these lines to
        // `.env.contracts` verbatim (RPC and NAME are added by the wrapper,
        // which is the one that knows which URL it was pointed at).
        string memory prefix = string.concat("CHAIN_", vm.toString(block.chainid), "_");
        console.log(string.concat(prefix, "ROLE=", role));
        console.log(string.concat(prefix, "LOG=", vm.toString(address(log))));
        console.log(string.concat(prefix, "VERIFIER=", vm.toString(address(verifier))));
        if (isPrimary) {
            console.log(string.concat(prefix, "REGISTRY=", vm.toString(address(registry))));
        }
        console.log(string.concat(prefix, "FROM_BLOCK=", vm.toString(block.number)));
    }

    function _isRole(string memory role, string memory want) private pure returns (bool) {
        return keccak256(bytes(role)) == keccak256(bytes(want));
    }
}
