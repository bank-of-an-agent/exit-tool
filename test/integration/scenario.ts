/**
 * The shutdown-drill scenario, shared by the integration test and `pnpm drill:demo`:
 * a local Anvil chain with the canonical Safe v1.4.1 contracts (byte-identical to Base Sepolia, at
 * the same addresses), Agent Bank's contracts and mocks (the artifacts vendored in
 * test/fixtures/agentbank-contracts, or $AGENTBANK_CONTRACTS_OUT), and an Agent Bank-style account
 * with escrows, streams, vaults, spend keys and treasury automation.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  maxUint256,
  parseEther,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { SAFE7579_ADAPTER, ZERO_ADDRESS } from "../../src/core/constants";
import { startAnvil, type AnvilInstance } from "./anvil";
import {
  accounts,
  agentBankArtifact,
  clients,
  createSafe,
  deploy,
  installSafeInfra,
  moduleExec,
  ownerExec,
  SAFE_ARTIFACTS,
  send,
  type Clients,
} from "./harness";

export const DAY = 86_400n;
/** Every Agent Bank contract the drill deploys (what scripts/vendor-contracts.sh vendors). */
export const AGENT_BANK_CONTRACTS = [
  "AgentEscrow",
  "PaymentStreams",
  "TimeLockVaults",
  "TopUpExecutor",
  "SweepExecutor",
  "AgentPolicyHook",
  "MockUSDC",
  "MockTreasuryFund",
  "MockValidationRegistry",
] as const;
export const escrowArt = agentBankArtifact("AgentEscrow");
export const streamsArt = agentBankArtifact("PaymentStreams");
export const vaultsArt = agentBankArtifact("TimeLockVaults");
export const usdcArt = agentBankArtifact("MockUSDC");
export const topUpArt = agentBankArtifact("TopUpExecutor");
export const sweepArt = agentBankArtifact("SweepExecutor");
export const fundArt = agentBankArtifact("MockTreasuryFund");
export const policyHookArt = agentBankArtifact("AgentPolicyHook");
export const registryArt = agentBankArtifact("MockValidationRegistry");
/** Contracts the drill would deploy but whose artifacts were not found. */
export const missingContracts = AGENT_BANK_CONTRACTS.filter((name) => !agentBankArtifact(name));
/** Treasury executors and the mock fund are optional parts of the scenario. */
export const haveExecutors = Boolean(topUpArt && sweepArt && fundArt);
/** Whether the Agent Bank artifacts the drill needs at minimum were found. */
export const haveAgentBank = Boolean(escrowArt && streamsArt && vaultsArt && usdcArt);

/** A fresh address nobody controls: the owner's cold wallet. */
export const DESTINATION = getAddress(keccak256(toHex("agentbank-exit drill destination")).slice(0, 42));

export interface Drill {
  anvil: AnvilInstance;
  c: Clients;
  safe: Address;
  usdc: Address;
  usdcAbi: Abi;
  decimals: number;
  guard: Address;
  /** Token units given to the account at setup. */
  minted: bigint;
  dir: string;
  deploymentsFile: string;
  ab?: {
    /** Treasury executors installed on the account, and the sweep fund whose shares it holds. */
    executors?: { topUp: Address; sweep: Address; fund: Address; fundAbi: Abi; shares: bigint };
    /** The AgentPolicyHook installed on the account (it limits agents, never the owner). */
    policyHook?: Address;
    escrow: Address;
    streams: Address;
    vaults: Address;
    escrowAbi: Abi;
    streamsAbi: Abi;
    vaultsAbi: Abi;
    ids: {
      escrowA: bigint; // expired after 2 days: refundable now
      escrowB: bigint; // expires after 30 days: pending
      escrowC: bigint; // disputed by the payee: refundable after expiry + 30 days
      escrowD: bigint; // already released to the payee: nothing to recover
      escrowE?: bigint; // incoming, approved by its ERC-8004 validator: anyone may release it to the account
      s1: bigint; // per-second stream the account pays
      s2: bigint; // daily stream to a payee USDC later freezes
      s3: bigint; // incoming stream (another agent pays the account)
      v1: bigint; // unlocks after 1 day
      v2: bigint; // locked for a year, owned by the owner key: early withdrawal
      v3: bigint; // locked 20 days, owned by another key: pending
    };
  };
}

export function call(abi: Abi, functionName: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({ abi, functionName, args: args as never });
}

export async function read<T>(
  drill: Pick<Drill, "c">,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  return (await drill.c.publicClient.readContract({ address, abi, functionName, args: args as never })) as T;
}

/** Moves Anvil's clock forward and mines a block so `latest` reflects it. */
export async function travel(drill: Pick<Drill, "c">, seconds: bigint): Promise<void> {
  await drill.c.test.increaseTime({ seconds: Number(seconds) });
  await drill.c.test.mine({ blocks: 1 });
}

export async function setupDrill(options: { anvilArgs?: string[]; port?: number } = {}): Promise<Drill> {
  const anvil = await startAnvil(options.anvilArgs ?? [], options.port);
  const c = clients(anvil.rpcUrl);
  await installSafeInfra(c);

  // Token: Agent Bank's MockUSDC (6 decimals, blacklist) or, without the contracts repo, a plain ERC-20.
  let token: Address;
  let usdcAbi: Abi;
  if (usdcArt) {
    const ctor = usdcArt.abi.find((x) => x.type === "constructor") as
      { inputs?: { type: string }[] } | undefined;
    token = await deploy(
      c,
      "deployer",
      usdcArt,
      (ctor?.inputs ?? []).map(() => accounts.deployer.address),
    );
    usdcAbi = usdcArt.abi;
  } else {
    token = await deploy(c, "deployer", SAFE_ARTIFACTS.testToken);
    usdcAbi = SAFE_ARTIFACTS.testToken.abi;
  }
  const decimals = Number(
    await c.publicClient.readContract({ address: token, abi: usdcAbi, functionName: "decimals" }),
  );
  const guard = await deploy(c, "deployer", SAFE_ARTIFACTS.debugGuard);

  // The account, configured like an Agent Bank account: Safe7579 adapter as module and fallback
  // handler; a second module standing in for the bank's executor powers; a transaction guard.
  const safe = await createSafe(c, [accounts.owner.address], 1n, SAFE7579_ADAPTER, 1n);
  const safeAbi = SAFE_ARTIFACTS.safeL2.abi;
  await ownerExec(c, safe, safe, call(safeAbi, "enableModule", [SAFE7579_ADAPTER]));
  await ownerExec(c, safe, safe, call(safeAbi, "enableModule", [accounts.bank.address]));
  await ownerExec(c, safe, safe, call(safeAbi, "setGuard", [guard]));
  await send(c, "deployer", safe, "0x", parseEther("2"));
  let minted: bigint;
  if (usdcArt) {
    minted = 10_000n * 10n ** BigInt(decimals);
    await send(c, "deployer", token, call(usdcAbi, "mint", [safe, minted]));
  } else {
    // The stand-in token mints a fixed supply to its deployer.
    minted = (await c.publicClient.readContract({
      address: token,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [accounts.deployer.address],
    })) as bigint;
    await send(c, "deployer", token, call(usdcAbi, "transfer", [safe, minted]));
  }

  const dir = mkdtempSync(path.join(tmpdir(), "agentbank-exit-drill-"));
  const deploymentsFile = path.join(dir, "deployments.json");
  const result: Drill = {
    anvil,
    c,
    safe,
    usdc: token,
    usdcAbi,
    decimals,
    guard,
    minted,
    dir,
    deploymentsFile,
  };

  if (!haveAgentBank) {
    writeFileSync(
      deploymentsFile,
      JSON.stringify({ chainId: 31337, dependencies: { USDC: token } }, null, 2),
    );
    return result;
  }

  // Agent Bank contracts with a pause guardian (the bank's last act before shutting down is to pause them).
  const guardian = accounts.guardian.address;
  // An ERC-8004 validation registry, so escrows can be released by a validator's approval.
  const registry = registryArt ? await deploy(c, "deployer", registryArt) : undefined;
  const escrow = await deploy(c, "deployer", escrowArt!, [guardian, registry ?? ZERO_ADDRESS]);
  const streams = await deploy(c, "deployer", streamsArt!, [guardian]);
  const vaults = await deploy(c, "deployer", vaultsArt!, [guardian]);
  const topUp = haveExecutors ? await deploy(c, "deployer", topUpArt!) : undefined;
  const sweep = haveExecutors ? await deploy(c, "deployer", sweepArt!) : undefined;
  const fund = haveExecutors
    ? await deploy(c, "deployer", fundArt!, [token, accounts.deployer.address])
    : undefined;
  const policyHook = policyHookArt ? await deploy(c, "deployer", policyHookArt) : undefined;
  writeFileSync(
    deploymentsFile,
    JSON.stringify(
      {
        chainId: 31337,
        contracts: {
          AgentEscrow: escrow,
          PaymentStreams: streams,
          TimeLockVaults: vaults,
          ...(topUp && sweep ? { TopUpExecutor: topUp, SweepExecutor: sweep } : {}),
          ...(policyHook ? { AgentPolicyHook: policyHook } : {}),
        },
        dependencies: {
          USDC: token,
          ...(fund ? { MockTreasuryFund: fund } : {}),
          ...(registry ? { MockValidationRegistry: registry } : {}),
        },
        mode: "broadcast",
      },
      null,
      2,
    ),
  );
  const escrowAbi = escrowArt!.abi;
  const streamsAbi = streamsArt!.abi;
  const vaultsAbi = vaultsArt!.abi;
  const u = (n: number): bigint => BigInt(n) * 10n ** BigInt(decimals);

  // Agent activity, executed through a module exactly as the Safe7579 adapter executes agent sessions.
  const agent = (to: Address, data: Hex) => moduleExec(c, "bank", safe, to, data);
  const t0 = (await c.publicClient.getBlock({ blockTag: "latest" })).timestamp;
  const lock = async (payee: Address, amount: bigint, expiresAt: bigint, arbiter: Address) => {
    await agent(token, call(usdcAbi, "approve", [escrow, amount]));
    await agent(
      escrow,
      call(escrowAbi, "lock", [
        token,
        payee,
        amount,
        expiresAt,
        arbiter,
        ZERO_ADDRESS,
        `0x${"0".repeat(64)}`,
        0,
        keccak256(toHex("terms")),
      ]),
    );
    return read<bigint>(result, escrow, escrowAbi, "escrowCount");
  };
  const escrowA = await lock(accounts.payee.address, u(100), t0 + 3_600n, ZERO_ADDRESS);
  const escrowB = await lock(accounts.payee2.address, u(50), t0 + 30n * DAY, ZERO_ADDRESS);
  const escrowC = await lock(accounts.payee.address, u(25), t0 + 7_200n, accounts.relayer.address);
  await send(c, "payee", escrow, call(escrowAbi, "dispute", [escrowC]));
  const escrowD = await lock(accounts.payee.address, u(10), t0 + 3_600n, ZERO_ADDRESS);
  await agent(escrow, call(escrowAbi, "release", [escrowD]));

  // Another agent pays the account through an escrow released by its ERC-8004 validator's approval:
  // once the validator approves, anyone may release it, and only to the account.
  let escrowE: bigint | undefined;
  if (registry) {
    const validator = accounts.relayer.address;
    const requestHash = keccak256(toHex("agentbank-exit drill: validated delivery"));
    await send(
      c,
      "otherAgent",
      registry,
      call(registryArt!.abi, "validationRequest", [validator, 1n, "drill://request", requestHash]),
    );
    await send(c, "deployer", token, call(usdcAbi, "mint", [accounts.otherAgent.address, u(15)]));
    await send(c, "otherAgent", token, call(usdcAbi, "approve", [escrow, u(15)]));
    await send(
      c,
      "otherAgent",
      escrow,
      call(escrowAbi, "lock", [
        token,
        safe,
        u(15),
        t0 + 30n * DAY,
        ZERO_ADDRESS,
        validator,
        requestHash,
        80,
        keccak256(toHex("terms E")),
      ]),
    );
    escrowE = await read<bigint>(result, escrow, escrowAbi, "escrowCount");
    await send(
      c,
      "relayer",
      registry,
      call(registryArt!.abi, "validationResponse", [
        requestHash,
        100,
        "drill://approved",
        keccak256(toHex("approved")),
        "delivery",
      ]),
    );
  }

  const stream = async (payee: Address, deposit: bigint, rate: bigint, interval: bigint) => {
    await agent(token, call(usdcAbi, "approve", [streams, deposit]));
    await agent(streams, call(streamsAbi, "createStream", [token, payee, deposit, rate, interval, 0n, 0n]));
    return read<bigint>(result, streams, streamsAbi, "streamCount");
  };
  const s1 = await stream(accounts.payee.address, u(1000), u(1) / 1000n, 1n); // 0.001 USDC per second
  const s2 = await stream(accounts.payee2.address, u(200), u(10), DAY); // 10 USDC per day
  // Another agent streams to the account.
  await send(c, "deployer", token, call(usdcAbi, "mint", [accounts.otherAgent.address, u(100)]));
  await send(c, "otherAgent", token, call(usdcAbi, "approve", [streams, u(100)]));
  await send(
    c,
    "otherAgent",
    streams,
    call(streamsAbi, "createStream", [token, safe, u(100), u(1) / 2000n, 1n, 0n, 0n]),
  );
  const s3 = await read<bigint>(result, streams, streamsAbi, "streamCount");

  const vault = async (unlockIn: bigint, owner: Address, amount: bigint) => {
    await agent(vaults, call(vaultsAbi, "createVault", [token, t0 + unlockIn, owner]));
    const id = await read<bigint>(result, vaults, vaultsAbi, "vaultCount");
    await agent(token, call(usdcAbi, "approve", [vaults, amount]));
    await agent(vaults, call(vaultsAbi, "deposit", [id, amount]));
    return id;
  };
  const v1 = await vault(DAY, accounts.owner.address, u(300));
  const v2 = await vault(365n * DAY, accounts.owner.address, u(500));
  const v3 = await vault(20n * DAY, accounts.guardian.address, u(40));

  // Agent spend keys (ADR 0001): floats outside the account, recoverable through a permit allowance.
  await send(c, "deployer", token, call(usdcAbi, "mint", [accounts.spendKey.address, u(25)]));
  await send(c, "spendKey", token, call(usdcAbi, "approve", [safe, maxUint256]));
  await send(c, "deployer", token, call(usdcAbi, "mint", [accounts.spendKey2.address, u(5)]));

  // Treasury automation, installed the way the Safe7579 adapter installs executors (the account calls
  // onInstall): an auto top-up rule set and a treasury sweep into a tokenized fund, with fund shares.
  let executors: NonNullable<Drill["ab"]>["executors"];
  if (topUp && sweep && fund) {
    await agent(topUp, call(topUpArt!.abi, "onInstall", ["0x"]));
    const sweepConfig = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "fund", type: "address" },
            { name: "asset", type: "address" },
            { name: "maxSavingsBps", type: "uint16" },
            { name: "liquidFloor", type: "uint256" },
            { name: "sweepThreshold", type: "uint256" },
          ],
        },
      ],
      [{ fund, asset: token, maxSavingsBps: 5_000, liquidFloor: u(1_000), sweepThreshold: u(100) }],
    );
    await agent(sweep, call(sweepArt!.abi, "onInstall", [sweepConfig]));
    await send(c, "deployer", token, call(usdcAbi, "mint", [safe, u(60)]));
    await agent(token, call(usdcAbi, "approve", [fund, u(60)]));
    await agent(fund, call(fundArt!.abi, "deposit", [u(60), safe]));
    const shares = await read<bigint>(result, fund, fundArt!.abi, "balanceOf", [safe]);
    executors = { topUp, sweep, fund, fundAbi: fundArt!.abi, shares };
  }
  // Agent Bank's policy hook, installed the same way: it limits agent operations, not the owner's.
  if (policyHook) await agent(policyHook, call(policyHookArt!.abi, "onInstall", ["0x"]));

  result.ab = {
    ...(executors ? { executors } : {}),
    ...(policyHook ? { policyHook } : {}),
    escrow,
    streams,
    vaults,
    escrowAbi,
    streamsAbi,
    vaultsAbi,
    ids: {
      escrowA,
      escrowB,
      escrowC,
      escrowD,
      ...(escrowE !== undefined ? { escrowE } : {}),
      s1,
      s2,
      s3,
      v1,
      v2,
      v3,
    },
  };
  return result;
}

/** Agent Bank shuts down: contracts paused (inflows only), a counterparty frozen by USDC, no services. */
export async function shutDown(drill: Drill): Promise<void> {
  const ab = drill.ab!;
  await send(drill.c, "guardian", ab.escrow, call(ab.escrowAbi, "pause"));
  await send(drill.c, "guardian", ab.streams, call(ab.streamsAbi, "pause"));
  await send(drill.c, "guardian", ab.vaults, call(ab.vaultsAbi, "pause"));
  await send(drill.c, "deployer", drill.usdc, call(drill.usdcAbi, "blacklist", [accounts.payee2.address]));
}
