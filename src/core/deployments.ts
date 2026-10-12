import { getAddress, isAddress, type Address } from "viem";
import { ExitToolError } from "./errors";

/** Agent Bank singleton contracts the exit tool recovers funds from (or reports on). */
export interface AgentBankContracts {
  escrow?: Address;
  streams?: Address;
  vaults?: Address;
  topUpExecutor?: Address;
  sweepExecutor?: Address;
  policyHook?: Address;
}

/** Addresses for one chain, from a deployments file and/or command-line flags. */
export interface Deployments {
  chainId?: number;
  usdc?: Address;
  compatibilityFallbackHandler?: Address;
  contracts: AgentBankContracts;
  /** Earliest block of any Agent Bank contract: event scans never need to look further back. */
  fromBlock?: bigint;
}

const KEYS: Record<string, keyof AgentBankContracts | "usdc" | "compatibilityFallbackHandler"> = {
  agentescrow: "escrow",
  escrow: "escrow",
  paymentstreams: "streams",
  streams: "streams",
  timelockvaults: "vaults",
  timelockvault: "vaults",
  vaults: "vaults",
  topupexecutor: "topUpExecutor",
  sweepexecutor: "sweepExecutor",
  agentpolicyhook: "policyHook",
  policyhook: "policyHook",
  usdc: "usdc",
  mockusdc: "usdc",
  compatibilityfallbackhandler: "compatibilityFallbackHandler",
  fallbackhandler: "compatibilityFallbackHandler",
};

const BLOCK_KEYS = ["blockNumber", "deployBlock", "deploymentBlock", "startBlock", "block"];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toBlock(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value);
  return undefined;
}

function toAddress(value: unknown, where: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new ExitToolError("invalid_argument", `Deployments file: ${where} is not an address.`);
  }
  return getAddress(value);
}

/**
 * Parses a deployments file. Accepts the shapes a Foundry deploy script typically writes:
 * `{ "AgentEscrow": "0x…" }`, `{ "contracts": { "AgentEscrow": { "address": "0x…", "blockNumber": 1 } } }`,
 * with optional `chainId` and `fromBlock`. Unknown keys are ignored.
 */
export function parseDeployments(json: unknown): Deployments {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new ExitToolError("invalid_argument", "Deployments file must be a JSON object.");
  }
  const root = json as Record<string, unknown>;
  const out: Deployments = { contracts: {} };
  const blocks: bigint[] = [];

  const chainId = root.chainId ?? root.chain_id ?? root.chainID;
  if (typeof chainId === "number" || typeof chainId === "string") {
    const id = Number(chainId);
    if (Number.isSafeInteger(id) && id > 0) out.chainId = id;
  }
  for (const key of ["fromBlock", "startBlock", "deployBlock", "deploymentBlock"]) {
    const block = toBlock(root[key]);
    if (block !== undefined) blocks.push(block);
  }

  const containers = [root, root.contracts, root.addresses, root.deployments].filter(
    (c): c is Record<string, unknown> => c !== null && typeof c === "object" && !Array.isArray(c),
  );
  for (const container of containers) {
    for (const [rawKey, value] of Object.entries(container)) {
      const target = KEYS[normalizeKey(rawKey)];
      if (!target) continue;
      let address: Address;
      if (typeof value === "string") {
        address = toAddress(value, rawKey);
      } else if (value !== null && typeof value === "object") {
        const entry = value as Record<string, unknown>;
        address = toAddress(entry.address ?? entry.addr, `${rawKey}.address`);
        for (const bk of BLOCK_KEYS) {
          const block = toBlock(entry[bk]);
          if (block !== undefined) blocks.push(block);
        }
      } else {
        continue;
      }
      if (target === "usdc") out.usdc = address;
      else if (target === "compatibilityFallbackHandler") out.compatibilityFallbackHandler = address;
      else out.contracts[target] = address;
    }
  }
  if (blocks.length > 0) out.fromBlock = blocks.reduce((a, b) => (b < a ? b : a));
  return out;
}

/** Merges deployments: later entries win field by field. */
export function mergeDeployments(...items: (Deployments | undefined)[]): Deployments {
  const out: Deployments = { contracts: {} };
  for (const item of items) {
    if (!item) continue;
    if (item.chainId !== undefined) out.chainId = item.chainId;
    if (item.usdc !== undefined) out.usdc = item.usdc;
    if (item.compatibilityFallbackHandler !== undefined) {
      out.compatibilityFallbackHandler = item.compatibilityFallbackHandler;
    }
    if (item.fromBlock !== undefined) out.fromBlock = item.fromBlock;
    for (const [k, v] of Object.entries(item.contracts) as [
      keyof AgentBankContracts,
      Address | undefined,
    ][]) {
      if (v !== undefined) out.contracts[k] = v;
    }
  }
  return out;
}
