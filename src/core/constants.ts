import type { Address, Hex } from "viem";

/** Address(0). */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Head/tail marker of the Safe's module and owner linked lists. */
export const SENTINEL: Address = "0x0000000000000000000000000000000000000001";

/** Safe storage slot of the singleton (master copy) address in every SafeProxy. */
export const SINGLETON_SLOT: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** keccak256("fallback_manager.handler.address"): Safe FallbackManager storage slot. */
export const FALLBACK_HANDLER_SLOT: Hex =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";

/** keccak256("guard_manager.guard.address"): Safe GuardManager storage slot. */
export const GUARD_SLOT: Hex = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";

/**
 * Canonical Safe v1.4.1 deployments (identical addresses on every EVM chain that has them,
 * including Base Sepolia). Code hashes are those published in `@safe-global/safe-deployments`;
 * the test suite checks them against the bytecode it deploys on Anvil.
 */
export const SAFE_V141 = {
  safe: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  safeL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  compatibilityFallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
} as const satisfies Record<string, Address>;

/** Rhinestone Safe7579 adapter: the Safe module + fallback handler that runs ERC-7579 modules. */
export const SAFE7579_ADAPTER: Address = "0x7579EE8307284F293B1927136486880611F20002";

/** Canonical Multicall3 (used, when present, to enumerate escrows, streams and vaults cheaply). */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Safe `Enum.Operation`. The exit tool only ever produces CALL. */
export const OPERATION_CALL = 0;

/**
 * Simulation-only ERC-1271 stub, installed at an owner's address with an `eth_simulateV1` state
 * override so that a dry run can simulate owner-signed steps without the owner key. It answers the
 * Safe's legacy `isValidSignature(bytes,bytes)` (0x20c13b0b) with its magic value and everything
 * else (ERC-1271 `isValidSignature(bytes32,bytes)`, plain ETH transfers) with 0x1626ba7e.
 * It never leaves the simulation: real execution always uses real signatures.
 *
 *   PUSH1 0 CALLDATALOAD PUSH1 0xe0 SHR PUSH4 0x20c13b0b EQ PUSH1 0x1f JUMPI
 *   PUSH4 0x1626ba7e PUSH1 0xe0 SHL PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN
 *   JUMPDEST PUSH4 0x20c13b0b PUSH1 0xe0 SHL PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN
 */
export const SIMULATION_SIGNER_STUB_CODE: Hex =
  "0x60003560e01c6320c13b0b14601f57631626ba7e60e01b60005260206000f35b6320c13b0b60e01b60005260206000f3";

/**
 * Simulation-only helper installed with a state override: returns `address(arg).balance`, so a
 * simulated block can read ETH balances after earlier calls. `PUSH1 0 CALLDATALOAD BALANCE PUSH1 0
 * MSTORE PUSH1 0x20 PUSH1 0 RETURN`.
 */
export const SIMULATION_BALANCE_READER_CODE: Hex = "0x6000353160005260206000f3";

/** Scratch address where the simulation balance reader is installed. */
export const SIMULATION_BALANCE_READER: Address = "0x7e17000000000000000000000000000000b41a4c";

/** Sender used for simulated calls (any address works: owner authority comes from signatures). */
export const SIMULATION_SENDER: Address = "0x7e17000000000000000000000000000000005e4d";
