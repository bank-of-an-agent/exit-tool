import { readFile } from "node:fs/promises";
import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { BASE_SEPOLIA, assertSupportedChainId, chainByName, type ChainConfig } from "../core/chains";
import { mergeDeployments, parseDeployments, type Deployments } from "../core/deployments";
import { ExitToolError } from "../core/errors";
import { parseAddressOption, parseBigintOption, type Values } from "./args";
import type { Io } from "./io";

export interface Connection {
  client: PublicClient;
  chain: ChainConfig;
  viemChain: Chain;
  rpcUrl: string;
}

/** Hides credentials that some RPC URLs embed (API keys in the path or query, user:pass@). */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    if (local) return `${u.protocol}//${u.host}`;
    const hasSecretPath = u.pathname.split("/").some((part) => part.length >= 16);
    return `${u.protocol}//${u.host}${hasSecretPath || u.search ? "/…" : u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

/**
 * Connects to the RPC and checks which chain it serves before anything else. Mainnet is refused
 * by the RPC's own chain id, whatever --chain says.
 */
export async function connect(values: Values, io: Io): Promise<Connection> {
  const requested = values.chain !== undefined ? chainByName(values.chain) : undefined;
  const rpcUrl = values["rpc-url"] ?? io.env.AGENTBANK_RPC_URL ?? (requested ?? BASE_SEPOLIA).defaultRpcUrl;
  if (!/^https?:\/\//i.test(rpcUrl)) {
    throw new ExitToolError("invalid_argument", "--rpc-url must be an http(s) URL.");
  }
  const transport = http(rpcUrl, { retryCount: 2, timeout: 30_000 });
  const probe = createPublicClient({ transport });
  let chainId: number;
  try {
    chainId = await probe.getChainId();
  } catch (cause) {
    throw new ExitToolError("rpc_error", `Cannot reach the RPC at ${redactRpcUrl(rpcUrl)}.`, { cause });
  }
  const chain = assertSupportedChainId(chainId);
  if (requested && requested.id !== chainId) {
    throw new ExitToolError(
      "chain_mismatch",
      `--chain ${requested.name} expects chain id ${requested.id}, but the RPC serves chain id ${chainId}.`,
    );
  }
  const viemChain = defineChain({
    id: chain.id,
    name: chain.label,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain: viemChain, transport }) as PublicClient;
  return { client, chain, viemChain, rpcUrl };
}

/** Built-in addresses for the chain, then the deployments file, then individual flags (later wins). */
export async function resolveDeployments(values: Values, io: Io, chain: ChainConfig): Promise<Deployments> {
  const builtIn: Deployments = {
    contracts: {},
    compatibilityFallbackHandler: chain.compatibilityFallbackHandler,
    ...(chain.usdc ? { usdc: chain.usdc } : {}),
  };
  let fromFile: Deployments | undefined;
  const file = values.deployments ?? io.env.AGENTBANK_DEPLOYMENTS;
  if (file) {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(file, "utf8"));
    } catch (cause) {
      throw new ExitToolError("invalid_argument", `Cannot read deployments file ${file}.`, { cause });
    }
    fromFile = parseDeployments(json);
    if (fromFile.chainId !== undefined && fromFile.chainId !== chain.id) {
      throw new ExitToolError(
        "chain_mismatch",
        `Deployments file ${file} is for chain ${fromFile.chainId}, but the RPC serves chain ${chain.id}.`,
      );
    }
  }
  const flags: Deployments = { contracts: {} };
  const usdc = parseAddressOption("usdc", values.usdc);
  if (usdc) flags.usdc = usdc;
  const handler = parseAddressOption("fallback-handler", values["fallback-handler"]);
  if (handler) flags.compatibilityFallbackHandler = handler;
  const escrow = parseAddressOption("escrow", values.escrow);
  if (escrow) flags.contracts.escrow = escrow;
  const streams = parseAddressOption("streams", values.streams);
  if (streams) flags.contracts.streams = streams;
  const vaults = parseAddressOption("vaults", values.vaults);
  if (vaults) flags.contracts.vaults = vaults;
  const fromBlock = parseBigintOption("from-block", values["from-block"]);
  if (fromBlock !== undefined) flags.fromBlock = fromBlock;
  return mergeDeployments(builtIn, fromFile, flags);
}
