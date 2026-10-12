import type { Address } from "viem";
import { SAFE_V141 } from "./constants";
import { ExitToolError } from "./errors";

/** Chains this version of the exit tool will talk to. */
export type ChainName = "base-sepolia" | "anvil";

export interface ChainConfig {
  name: ChainName;
  id: number;
  label: string;
  /** Used when no `--rpc-url` is given. Public endpoints are fine: the tool only reads and broadcasts. */
  defaultRpcUrl: string;
  /** Block explorer for transaction links (none for local chains). */
  explorer?: { name: string; url: string };
  /** USDC on this chain, when it is fixed (on Anvil it comes from a deployments file). */
  usdc?: Address;
  /** The plain Safe fallback handler that `disable-modules` restores. */
  compatibilityFallbackHandler: Address;
  /** Block before which no Agent Bank account or contract can exist (log scans start here). */
  agentBankGenesisBlock: bigint;
}

export const BASE_SEPOLIA: ChainConfig = {
  name: "base-sepolia",
  id: 84532,
  label: "Base Sepolia",
  defaultRpcUrl: "https://sepolia.base.org",
  explorer: { name: "Basescan", url: "https://sepolia.basescan.org" },
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  compatibilityFallbackHandler: SAFE_V141.compatibilityFallbackHandler,
  // Agent Bank started on Base Sepolia in October 2026 (the Phase 0 spike ran at block 47,990,000).
  agentBankGenesisBlock: 47_900_000n,
};

export const ANVIL: ChainConfig = {
  name: "anvil",
  id: 31337,
  label: "Anvil (local)",
  defaultRpcUrl: "http://127.0.0.1:8545",
  compatibilityFallbackHandler: SAFE_V141.compatibilityFallbackHandler,
  agentBankGenesisBlock: 0n,
};

export const CHAINS: readonly ChainConfig[] = [BASE_SEPOLIA, ANVIL];

/** Mainnets refused until the Phase 5 gate: Ethereum and Base. */
export const MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([1, 8453]);

export const MAINNET_REFUSAL_MESSAGE =
  "Mainnet is not supported yet. Mainnet support unlocks after Agent Bank's Phase 5 gate " +
  "(audits closed, exit tool verified against a simulated bank shutdown, legal sign-off, with a human present). " +
  "This version only works on Base Sepolia (84532) and Anvil (31337).";

/** Throws unless `chainId` is a chain this version supports. Mainnets get a specific message. */
export function assertSupportedChainId(chainId: number): ChainConfig {
  if (MAINNET_CHAIN_IDS.has(chainId)) {
    const which = chainId === 1 ? "Ethereum mainnet" : "Base mainnet";
    throw new ExitToolError(
      "mainnet_refused",
      `Refusing chain id ${chainId} (${which}). ${MAINNET_REFUSAL_MESSAGE}`,
    );
  }
  const chain = CHAINS.find((c) => c.id === chainId);
  if (!chain) {
    throw new ExitToolError(
      "unsupported_chain",
      `Unsupported chain id ${chainId}. This version only works on Base Sepolia (84532) and Anvil (31337).`,
    );
  }
  return chain;
}

/** Look up a chain by its CLI name. */
export function chainByName(name: string): ChainConfig {
  const chain = CHAINS.find((c) => c.name === name);
  if (!chain) {
    if (/^(base|mainnet|ethereum|base-mainnet)$/i.test(name)) {
      throw new ExitToolError("mainnet_refused", `Refusing chain "${name}". ${MAINNET_REFUSAL_MESSAGE}`);
    }
    throw new ExitToolError(
      "invalid_argument",
      `Unknown chain "${name}". Use one of: ${CHAINS.map((c) => c.name).join(", ")}.`,
    );
  }
  return chain;
}

/** Explorer link for a transaction, if the chain has an explorer. */
export function txUrl(chain: ChainConfig, hash: string): string | undefined {
  return chain.explorer ? `${chain.explorer.url}/tx/${hash}` : undefined;
}

/** Explorer link for an address, if the chain has an explorer. */
export function addressUrl(chain: ChainConfig, address: string): string | undefined {
  return chain.explorer ? `${chain.explorer.url}/address/${address}` : undefined;
}
