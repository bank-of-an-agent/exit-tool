import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseEventLogs,
  publicActions,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { main } from "../../src/cli/main";
import type { Io } from "../../src/cli/io";
import { SAFE7579_ADAPTER, SAFE_V141, ZERO_ADDRESS } from "../../src/core/constants";
import { packSignatures, encodeExecTransaction, type SafeTx } from "../../src/core/safe";
import { describeError } from "../../src/core/revert";

// Well-known Anvil development keys (public; never used outside local chains).
export const DEV_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  bank: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  payee: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  payee2: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  spendKey: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  guardian: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  relayer: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  otherAgent: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  spendKey2: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
} as const satisfies Record<string, Hex>;

export type Role = keyof typeof DEV_KEYS;
export const accounts = Object.fromEntries(
  Object.entries(DEV_KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]),
) as Record<Role, PrivateKeyAccount>;

// ------------------------------------------------------------------------------------------------
// Artifacts
// ------------------------------------------------------------------------------------------------

interface Artifact {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
}

const require = createRequire(import.meta.url);
const safeRoot = path.dirname(require.resolve("@safe-global/safe-contracts/package.json"));

export function safeArtifact(rel: string): Artifact {
  const json = JSON.parse(readFileSync(path.join(safeRoot, "build/artifacts/contracts", rel), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode, deployedBytecode: json.deployedBytecode };
}

export const SAFE_ARTIFACTS = {
  safe: safeArtifact("Safe.sol/Safe.json"),
  safeL2: safeArtifact("SafeL2.sol/SafeL2.json"),
  proxyFactory: safeArtifact("proxies/SafeProxyFactory.sol/SafeProxyFactory.json"),
  compatibilityFallbackHandler: safeArtifact(
    "handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json",
  ),
  multiSendCallOnly: safeArtifact("libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json"),
  debugGuard: safeArtifact("examples/guards/DebugTransactionGuard.sol/DebugTransactionGuard.json"),
  testToken: safeArtifact("test/ERC20Token.sol/ERC20Token.json"),
};

/** What a deployment needs: the interface and the creation bytecode. */
export type DeployableArtifact = Pick<Artifact, "abi" | "bytecode">;

/**
 * The Agent Bank contract artifacts vendored by scripts/vendor-contracts.sh (ABI and creation
 * bytecode of every contract the drill deploys; SOURCE records the contracts commit). The drill
 * uses them unless $AGENTBANK_CONTRACTS_OUT names a Foundry out/ directory to use instead.
 */
export const VENDORED_CONTRACTS = path.resolve(import.meta.dirname, "../fixtures/agentbank-contracts");
export const CONTRACTS_OUT = process.env.AGENTBANK_CONTRACTS_OUT || undefined;
/** Where the Agent Bank artifacts come from, for messages. */
export const CONTRACTS_SOURCE = CONTRACTS_OUT ?? VENDORED_CONTRACTS;

/** The contracts commit the vendored artifacts were built from (undefined with AGENTBANK_CONTRACTS_OUT). */
export function vendoredContractsCommit(): string | undefined {
  if (CONTRACTS_OUT) return undefined;
  const file = path.join(VENDORED_CONTRACTS, "SOURCE");
  if (!existsSync(file)) return undefined;
  return /^commit: ([0-9a-f]{40})$/m.exec(readFileSync(file, "utf8"))?.[1];
}

export function agentBankArtifact(name: string): DeployableArtifact | undefined {
  const file = CONTRACTS_OUT
    ? path.join(CONTRACTS_OUT, `${name}.sol`, `${name}.json`)
    : path.join(VENDORED_CONTRACTS, `${name}.json`);
  if (!existsSync(file)) return undefined;
  const json = JSON.parse(readFileSync(file, "utf8"));
  const bytecode = json.bytecode?.object ?? json.bytecode;
  if (!Array.isArray(json.abi) || typeof bytecode !== "string" || bytecode.length < 4) return undefined;
  return { abi: json.abi, bytecode: bytecode as Hex };
}

// ------------------------------------------------------------------------------------------------
// Clients
// ------------------------------------------------------------------------------------------------

export function clients(rpcUrl: string, chainId = 31337) {
  const chain = defineChain({
    id: chainId,
    name: chainId === 31337 ? "Anvil" : `Anvil fork of ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl);
  const pollingInterval = 50;
  const publicClient = createPublicClient({ chain, transport, pollingInterval }) as PublicClient;
  const test = createTestClient({ chain, transport, mode: "anvil", pollingInterval }).extend(publicActions);
  const wallet = (role: Role) =>
    createWalletClient({ chain, transport, account: accounts[role], pollingInterval });
  return { chain, publicClient, test, wallet };
}

export type Clients = ReturnType<typeof clients>;

export async function send(
  c: Clients,
  role: Role,
  to: Address,
  data: Hex,
  value = 0n,
  gas?: bigint,
): Promise<Hex> {
  const hash = await c.wallet(role).sendTransaction({
    to,
    data,
    value,
    account: accounts[role],
    chain: c.chain,
    ...(gas !== undefined ? { gas } : {}),
  });
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return hash;
}

export async function deploy(
  c: Clients,
  role: Role,
  artifact: DeployableArtifact,
  args: readonly unknown[] = [],
): Promise<Address> {
  const hash = await c.wallet(role).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: args as never,
    account: accounts[role],
    chain: c.chain,
  });
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deployment failed");
  return getAddress(receipt.contractAddress);
}

/** Installs the canonical Safe v1.4.1 contracts at their canonical addresses (byte-identical code). */
export async function installSafeInfra(c: Clients): Promise<void> {
  const install: [Address, Hex][] = [
    [SAFE_V141.safe, SAFE_ARTIFACTS.safe.deployedBytecode],
    [SAFE_V141.safeL2, SAFE_ARTIFACTS.safeL2.deployedBytecode],
    [SAFE_V141.proxyFactory, SAFE_ARTIFACTS.proxyFactory.deployedBytecode],
    [SAFE_V141.compatibilityFallbackHandler, SAFE_ARTIFACTS.compatibilityFallbackHandler.deployedBytecode],
    [SAFE_V141.multiSendCallOnly, SAFE_ARTIFACTS.multiSendCallOnly.deployedBytecode],
  ];
  for (const [address, code] of install) await c.test.setCode({ address, bytecode: code });
  // The singletons' constructors set threshold = 1 so that nobody can set them up directly.
  for (const singleton of [SAFE_V141.safe, SAFE_V141.safeL2]) {
    await c.test.setStorageAt({ address: singleton, index: 4, value: `0x${"0".repeat(63)}1` });
  }
}

/** Creates a Safe proxy (SafeL2 singleton, like the Safe7579 launchpad) with the given owners. */
export async function createSafe(
  c: Clients,
  owners: readonly Address[],
  threshold: bigint,
  fallbackHandler: Address,
  salt: bigint,
): Promise<Address> {
  const initializer = encodeFunctionData({
    abi: SAFE_ARTIFACTS.safeL2.abi,
    functionName: "setup",
    args: [owners, threshold, ZERO_ADDRESS, "0x", fallbackHandler, ZERO_ADDRESS, 0n, ZERO_ADDRESS],
  });
  const hash = await send(
    c,
    "deployer",
    SAFE_V141.proxyFactory,
    encodeFunctionData({
      abi: SAFE_ARTIFACTS.proxyFactory.abi,
      functionName: "createProxyWithNonce",
      args: [SAFE_V141.safeL2, initializer, salt],
    }),
  );
  const receipt = await c.publicClient.getTransactionReceipt({ hash });
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: SAFE_ARTIFACTS.proxyFactory.abi, data: log.data, topics: log.topics });
      if (ev.eventName === "ProxyCreation")
        return getAddress((ev.args as unknown as { proxy: Address }).proxy);
    } catch {
      // other events
    }
  }
  throw new Error("no ProxyCreation event");
}

/** Owner-signed execTransaction (test setup only: enabling modules, setting a guard, …). */
export async function ownerExec(
  c: Clients,
  safe: Address,
  to: Address,
  data: Hex,
  value = 0n,
): Promise<void> {
  const nonce = (await c.publicClient.readContract({
    address: safe,
    abi: SAFE_ARTIFACTS.safeL2.abi,
    functionName: "nonce",
  })) as bigint;
  const tx: SafeTx = {
    to,
    value,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  };
  const signature = await accounts.owner.signTypedData({
    domain: { chainId: c.chain.id, verifyingContract: safe },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    message: tx,
  });
  await send(
    c,
    "owner",
    safe,
    encodeExecTransaction(
      tx,
      packSignatures([{ signer: accounts.owner.address, kind: "ecdsa", data: signature }]),
    ),
  );
}

/**
 * What an ERC-7579 executor or an agent session does through the Safe7579 adapter, reduced to its
 * essence: a Safe module calling execTransactionFromModule. Reverts if the inner call fails.
 */
export async function moduleExec(
  c: Clients,
  module: Role,
  safe: Address,
  to: Address,
  data: Hex,
): Promise<void> {
  const hash = await send(
    c,
    module,
    safe,
    encodeFunctionData({
      abi: SAFE_ARTIFACTS.safeL2.abi,
      functionName: "execTransactionFromModule",
      args: [to, 0n, data, 0],
    }),
    0n,
    // execTransactionFromModule does not revert when the inner call fails, so a gas estimate can
    // starve the inner call: give it plenty.
    3_000_000n,
  );
  const receipt = await c.publicClient.getTransactionReceipt({ hash });
  const events = parseEventLogs({ abi: SAFE_ARTIFACTS.safeL2.abi, logs: receipt.logs, strict: false });
  if (events.some((e) => e.eventName === "ExecutionFromModuleFailure")) {
    // Replay the inner call from the Safe to get the revert reason.
    let reason = "unknown";
    try {
      await c.publicClient.call({ account: safe, to, data });
    } catch (err) {
      reason = describeError(err);
    }
    throw new Error(`module call to ${to} failed inside the Safe: ${reason}`);
  }
}

export { SAFE7579_ADAPTER };

// ------------------------------------------------------------------------------------------------
// Running the CLI in-process
// ------------------------------------------------------------------------------------------------

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout when --json was passed. */
  json: Record<string, unknown> | undefined;
  /** Every URL the CLI fetched (the exit tool must only talk to the RPC). */
  urls: string[];
}

/** Runs `agentbank-exit` in-process with its own environment, capturing output and network access. */
export async function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (d: Buffer) => (out += d.toString()));
  stderr.on("data", (d: Buffer) => (err += d.toString()));
  const io: Io = {
    stdout,
    stderr,
    stdin: new PassThrough() as unknown as Io["stdin"],
    env: { ...env },
    interactive: false,
  };
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return realFetch(input, init);
  }) as typeof fetch;
  let code: number;
  try {
    code = await main(args, io);
  } finally {
    globalThis.fetch = realFetch;
  }
  let json: Record<string, unknown> | undefined;
  if (args.includes("--json")) {
    try {
      json = JSON.parse(out) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
  }
  return { code, stdout: out, stderr: err, json, urls };
}
