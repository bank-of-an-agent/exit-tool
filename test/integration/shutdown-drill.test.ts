/**
 * Phase 5 gate evidence: "Owner exit tool published and tested against a simulated bank shutdown."
 *
 * A local Anvil chain gets the canonical Safe v1.4.1 contracts (byte-identical to Base Sepolia, at
 * the same addresses), Agent Bank's own contracts and MockUSDC (from ../contracts/out), and an
 * Agent Bank-style account: a 1-of-1 Safe owned by a test key, with the Safe7579 adapter address
 * as module and fallback handler, a second module standing in for the bank's executor powers, a
 * transaction guard, funds, escrows, streams, vaults and agent spend keys. Then Agent Bank "shuts
 * down": its pause guardian pauses every contract, USDC freezes a counterparty, and no API,
 * co-signer, bundler or indexer exists. The owner runs `agentbank-exit` with only the RPC URL and
 * the owner key, and every recoverable unit must reach the owner's destination.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { getAddress, keccak256, parseEther, parseEventLogs, type Abi, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAFE_V141 } from "../../src/core/constants";
import { agentBankAbiSource } from "../../src/core/abis/index";
import { findAnvil } from "./anvil";
import { accounts, CONTRACTS_OUT, createSafe, ownerExec, runCli, SAFE_ARTIFACTS, send } from "./harness";
import {
  call,
  DAY,
  DESTINATION,
  escrowArt,
  haveAgentBank,
  read as readWith,
  setupDrill,
  shutDown as shutDownWith,
  streamsArt,
  travel as travelWith,
  vaultsArt,
  type Drill,
} from "./scenario";

const anvilAvailable = findAnvil() !== undefined;
if (!anvilAvailable) {
  console.warn("shutdown drill SKIPPED: anvil not found (install Foundry, set ANVIL_BIN, or provide nix).");
}
if (anvilAvailable && !haveAgentBank) {
  const message =
    `Agent Bank artifacts not found in ${CONTRACTS_OUT} (AgentEscrow, PaymentStreams, TimeLockVaults, MockUSDC): ` +
    "the escrow/stream/vault parts of the shutdown drill are SKIPPED and a plain ERC-20 stands in for USDC. " +
    "Run `forge build` in the contracts repository or set AGENTBANK_CONTRACTS_OUT.";
  if (process.env.REQUIRE_AGENTBANK_CONTRACTS === "1") throw new Error(message);
  console.warn(message);
}

let drill: Drill;
/** Incoming stream 3: what phase 1 collected (phase 2 must collect exactly the rest). */
let settledBeforePhase2 = 0n;
const usdc = (n: number | bigint): bigint => BigInt(n) * 10n ** BigInt(drill.decimals);
const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
  readWith<T>(drill, address, abi, functionName, args);
const travel = (seconds: bigint) => travelWith(drill, seconds);
const shutDown = () => shutDownWith(drill);
const lastId = (address: Address, abi: Abi, counter: string) => read<bigint>(address, abi, counter);

async function balanceOf(holder: Address): Promise<bigint> {
  return read<bigint>(drill.usdc, drill.usdcAbi, "balanceOf", [holder]);
}

async function nowTs(): Promise<bigint> {
  return (await drill.c.publicClient.getBlock({ blockTag: "latest" })).timestamp;
}

const cliBase = () => [
  "--rpc-url",
  drill.anvil.rpcUrl,
  "--chain",
  "anvil",
  "--account",
  drill.safe,
  "--deployments",
  drill.deploymentsFile,
];
const ownerEnv = { OWNER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" };

/** Can the bank's module still move funds? (eth_call of execTransactionFromModule from the module.) */
async function moduleCanMoveFunds(): Promise<boolean> {
  try {
    await drill.c.publicClient.call({
      account: accounts.bank.address,
      to: drill.safe,
      data: call(SAFE_ARTIFACTS.safeL2.abi, "execTransactionFromModule", [
        drill.usdc,
        0n,
        call(drill.usdcAbi, "transfer", [accounts.bank.address, 1n]),
        0,
      ]),
    });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!anvilAvailable)("shutdown drill on Anvil", () => {
  const summary: string[] = [];

  beforeAll(async () => {
    drill = await setupDrill();
  });

  afterAll(async () => {
    await drill?.anvil.stop();
    if (summary.length > 0) console.log(["", "Shutdown drill summary", ...summary].join("\n"));
  });

  it("deploys byte-identical canonical Safe v1.4.1 contracts", async () => {
    const expected: Record<string, Hex> = {
      [SAFE_V141.safe]: "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4",
      [SAFE_V141.safeL2]: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
      [SAFE_V141.proxyFactory]: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
      [SAFE_V141.compatibilityFallbackHandler]:
        "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
    };
    // Code hashes read from Base Sepolia (block 47,998,096) and published in @safe-global/safe-deployments.
    for (const [address, hash] of Object.entries(expected)) {
      const code = await drill.c.publicClient.getCode({ address: address as Address });
      expect(keccak256(code!)).toBe(hash);
    }
  });

  it.skipIf(!haveAgentBank)("vendored ABIs match the contracts build used for the drill", () => {
    for (const [name, art] of [
      ["AgentEscrow", escrowArt],
      ["PaymentStreams", streamsArt],
      ["TimeLockVaults", vaultsArt],
    ] as const) {
      const vendored = (agentBankAbiSource.artifacts as Record<string, { abiSha256: string }>)[name]!
        .abiSha256;
      const actual = createHashHex(JSON.stringify(art!.abi));
      expect(actual, `${name} ABI drifted: run scripts/sync-abis.sh`).toBe(vendored);
    }
  });

  it.skipIf(!haveAgentBank)("inspect finds every position and reports what is recoverable", async () => {
    await travel(2n * DAY);
    await shutDown();
    expect(await moduleCanMoveFunds()).toBe(true); // before the exit the bank's module still has power

    const run = await runCli(
      ["inspect", ...cliBase(), "--spend-key", accounts.spendKey2.address, "--json"],
      ownerEnv,
    );
    expect(run.code, run.stderr).toBe(0);
    const report = run.json!.report as Record<string, unknown>;
    const ids = drill.ab!.ids;
    const escrows = report.escrows as { id: string; role: string; status: string; refundableNow: boolean }[];
    expect(escrows.map((e) => e.id).sort()).toEqual(
      [ids.escrowA, ids.escrowB, ids.escrowC, ids.escrowD].map(String).sort(),
    );
    expect(escrows.find((e) => e.id === String(ids.escrowA))!.refundableNow).toBe(true);
    expect(escrows.find((e) => e.id === String(ids.escrowB))!.refundableNow).toBe(false);
    expect(escrows.find((e) => e.id === String(ids.escrowC))!.status).toBe("Disputed");
    const streams = report.streams as { id: string; role: string }[];
    expect(streams.map((s) => `${s.id}:${s.role}`).sort()).toEqual(
      [`${ids.s1}:payer`, `${ids.s2}:payer`, `${ids.s3}:payee`].sort(),
    );
    const vaults = report.vaults as { id: string; unlocked: boolean }[];
    expect(vaults.map((v) => v.id).sort()).toEqual([ids.v1, ids.v2, ids.v3].map(String).sort());
    const spendKeys = report.spendKeys as { address: string; sweepable: string }[];
    expect(spendKeys.find((k) => getAddress(k.address) === accounts.spendKey.address)!.sweepable).toBe(
      String(usdc(25)),
    );
    expect(spendKeys.find((k) => getAddress(k.address) === accounts.spendKey2.address)!.sweepable).toBe("0");
    const discovery = report.discovery as { positions: { method: string } };
    expect(discovery.positions.method).toBe("events");
    expect(origins(run.urls)).toEqual([new URL(drill.anvil.rpcUrl).origin]);

    const executors = drill.ab!.executors;
    if (executors) {
      // Treasury automation is reported (and goes away with the adapter); fund shares are found.
      const codes = (report.findings as { code: string }[]).map((f) => f.code);
      expect(codes).toEqual(expect.arrayContaining(["topup_executor", "sweep_executor"]));
      const fundShares = report.fundShares as { fund: { address: string }; balance: string };
      expect(getAddress(fundShares.fund.address)).toBe(executors.fund);
      expect(fundShares.balance).toBe(String(executors.shares));
    }
    const recovery = run.json!.recovery as { now: { kind: string }[]; pending: { kind: string }[] };
    expect(recovery.now.map((r) => r.kind).sort()).toEqual(
      [
        "balance",
        "balance",
        "escrow_refund",
        "stream_cancel",
        "stream_cancel",
        "stream_settle",
        "vault_unlocked",
        "vault_early",
        "spend_key",
      ].sort(),
    );
    expect(recovery.pending.map((r) => r.kind).sort()).toEqual(
      ["escrow_locked", "escrow_disputed", "vault_locked", "spend_key_excess", "stream_incoming"].sort(),
    );

    const textArgs = ["inspect", ...cliBase(), "--spend-key", accounts.spendKey2.address];
    transcript("01-inspect", await runCli(textArgs, ownerEnv), textArgs);

    // The same positions are found without events (enumeration fallback for RPCs that limit eth_getLogs).
    const enumerated = await runCli(
      ["inspect", ...cliBase(), "--discovery", "enumerate", "--json"],
      ownerEnv,
    );
    expect(enumerated.code, enumerated.stderr).toBe(0);
    const er = enumerated.json!.report as {
      escrows: unknown[];
      streams: unknown[];
      vaults: unknown[];
      discovery: { positions: { method: string } };
    };
    expect(er.discovery.positions.method).toBe("enumeration");
    expect([er.escrows.length, er.streams.length, er.vaults.length]).toEqual([4, 3, 3]);
    summary.push(
      `inspect: 4 escrows, 3 streams, 3 vaults, 2 spend keys found from events and by enumeration; only ${drill.anvil.rpcUrl} contacted` +
        (executors ? "; TopUpExecutor and SweepExecutor installs reported, treasury-fund shares found" : ""),
    );
  });

  it("the dry run simulates every step and changes nothing", async () => {
    const before = {
      nonce: await read<bigint>(drill.safe, SAFE_ARTIFACTS.safeL2.abi, "nonce"),
      usdc: await balanceOf(drill.safe),
      eth: await drill.c.publicClient.getBalance({ address: drill.safe }),
    };
    const run = await runCli(["exit", ...cliBase(), "--to", DESTINATION, "--json"], {}); // no key at all
    expect(run.code, run.stderr + run.stdout).toBe(0);
    const sim = run.json!.simulation as { ok: boolean; method: string; results: { status: string }[] };
    expect(sim.ok).toBe(true);
    expect(sim.method).toBe("eth_simulateV1");
    expect(sim.results.every((r) => r.status !== "failure")).toBe(true);
    expect(await read<bigint>(drill.safe, SAFE_ARTIFACTS.safeL2.abi, "nonce")).toBe(before.nonce);
    expect(await balanceOf(drill.safe)).toBe(before.usdc);
    expect(await drill.c.publicClient.getBalance({ address: drill.safe })).toBe(before.eth);
    expect(await balanceOf(DESTINATION)).toBe(0n);
    expect(origins(run.urls)).toEqual([new URL(drill.anvil.rpcUrl).origin]);
    const steps = (run.json!.plan as { steps: { id: string }[] }).steps.map((s) => s.id.split(":")[0]);
    const textArgs = ["exit", ...cliBase(), "--to", DESTINATION];
    transcript("02-exit-dry-run", await runCli(textArgs, {}), textArgs);
    summary.push(
      `dry run (no key): ${steps.length} steps simulated in one eth_simulateV1 block, state unchanged`,
    );
  });

  it.skipIf(!haveAgentBank)(
    "works through a restricted public-style RPC (no eth_simulateV1, tiny eth_getLogs ranges)",
    async () => {
      const proxy = await restrictedRpc(drill.anvil.rpcUrl, 10n);
      try {
        const base = [
          "--rpc-url",
          proxy.url,
          "--chain",
          "anvil",
          "--account",
          drill.safe,
          "--deployments",
          drill.deploymentsFile,
        ];
        // Event scans are chunked to the 10-block limit the RPC announces.
        const chunked = await runCli(["inspect", ...base, "--json"]);
        expect(chunked.code, chunked.stderr).toBe(0);
        const d1 = (
          chunked.json!.report as { discovery: { positions: { method: string; requests: number } } }
        ).discovery;
        expect(d1.positions.method).toBe("events");
        expect(d1.positions.requests).toBeGreaterThan(4);
        // With a request budget too small for the scan, positions are found by enumeration instead.
        const enumerated = await runCli(["inspect", ...base, "--max-log-requests", "3", "--json"]);
        expect(enumerated.code, enumerated.stderr).toBe(0);
        const r2 = enumerated.json!.report as {
          escrows: unknown[];
          streams: unknown[];
          vaults: unknown[];
          discovery: { positions: { method: string } };
        };
        expect(r2.discovery.positions.method).toBe("enumeration");
        expect([r2.escrows.length, r2.streams.length, r2.vaults.length]).toEqual([4, 3, 3]);
        // Without eth_simulateV1 every step is still simulated (each against the current state).
        const dry = await runCli(["exit", ...base, "--to", DESTINATION, "--json"]);
        expect(dry.code, dry.stderr + dry.stdout).toBe(0);
        const sim = dry.json!.simulation as { ok: boolean; method: string };
        expect(sim).toMatchObject({ ok: true, method: "eth_call" });
        expect(proxy.refused()).toBeGreaterThan(0);
        summary.push(
          "restricted RPC (no eth_simulateV1, 10-block eth_getLogs): chunked event scan, enumeration fallback and per-step simulation all work",
        );
      } finally {
        proxy.close();
      }
    },
  );

  it("refuses to broadcast without confirmation and refuses mainnet-like misuse", async () => {
    const run = await runCli(
      ["withdraw", ...cliBase(), "--to", DESTINATION, "--token", "eth", "--amount", "0.1", "--execute"],
      ownerEnv,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/--yes/);
    const wrongChain = await runCli([
      "inspect",
      "--rpc-url",
      drill.anvil.rpcUrl,
      "--chain",
      "base-sepolia",
      "--account",
      drill.safe,
    ]);
    expect(wrongChain.code).toBe(1);
    expect(wrongChain.stderr).toMatch(/expects chain id 84532/);
  });

  it("exit --execute returns every recoverable unit to the destination", async () => {
    const ab = drill.ab;
    // Fund shares from the treasury sweep are transferable tokens: include them explicitly.
    const fundArgs = ab?.executors ? ["--extra-token", ab.executors.fund] : [];
    const execArgs = ["exit", ...cliBase(), "--to", DESTINATION, ...fundArgs, "--execute", "--yes"];
    const run = await runCli([...execArgs, "--json"], ownerEnv);
    transcript("03-exit-execute", run, execArgs);
    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect(origins(run.urls)).toEqual([new URL(drill.anvil.rpcUrl).origin]);
    const executed = run.json!.execution as { status: string; hash?: Hex; id: string }[];
    expect(executed.length).toBeGreaterThan(0);
    // The guard goes first on its own; then ONE transaction removes both modules and the 7579
    // fallback handler, so nothing can act between the removals.
    expect(executed.slice(0, 2).map((e) => e.id.split(":")[0])).toEqual(["remove-guard", "revoke-batch"]);

    // The account is empty and every agent/bank power is gone.
    expect(await balanceOf(drill.safe)).toBe(0n);
    expect(await drill.c.publicClient.getBalance({ address: drill.safe })).toBe(0n);
    expect(await drill.c.publicClient.getBalance({ address: DESTINATION })).toBe(parseEther("2"));
    const [modules] = await read<[Address[], Address]>(
      drill.safe,
      SAFE_ARTIFACTS.safeL2.abi,
      "getModulesPaginated",
      ["0x0000000000000000000000000000000000000001", 10n],
    );
    expect(modules).toEqual([]);
    const handler = await drill.c.publicClient.getStorageAt({
      address: drill.safe,
      slot: "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5",
    });
    expect(getAddress(`0x${handler!.slice(26)}`)).toBe(SAFE_V141.compatibilityFallbackHandler);
    const guard = await drill.c.publicClient.getStorageAt({
      address: drill.safe,
      slot: "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8",
    });
    expect(BigInt(guard!)).toBe(0n);
    expect(await moduleCanMoveFunds()).toBe(false);

    if (!ab) {
      expect(await balanceOf(DESTINATION)).toBe(drill.minted);
      summary.push(
        "exit (no Agent Bank artifacts): ETH and token balances withdrawn, modules/guard/fallback revoked",
      );
      return;
    }

    // Conservation: everything the account owned and could get back now is at the destination.
    const receipts = await Promise.all(
      executed
        .filter((e) => e.hash)
        .map((e) => drill.c.publicClient.getTransactionReceipt({ hash: e.hash! })),
    );
    const logs = receipts.flatMap((r) => r.logs);
    const streamEvents = parseEventLogs({ abi: ab.streamsAbi, logs, strict: false });
    const canceled = streamEvents.filter((e) => e.eventName === "StreamCanceled") as unknown as {
      args: { id: bigint; payeeAmount: bigint; refundAmount: bigint };
    }[];
    const settledToAccount = (
      streamEvents.filter((e) => e.eventName === "StreamSettled") as unknown as {
        args: { id: bigint; payee: Address; amount: bigint };
      }[]
    )
      .filter((e) => getAddress(e.args.payee) === drill.safe)
      .reduce((a, e) => a + e.args.amount, 0n);
    const s1 = canceled.find((e) => e.args.id === ab.ids.s1)!.args;
    const s2 = canceled.find((e) => e.args.id === ab.ids.s2)!.args;
    expect(s2.payeeAmount).toBe(0n); // payee2 is frozen by USDC: its share is deferred, the refund still happened
    expect(s2.refundAmount).toBe(usdc(180));

    const expected =
      usdc(10_000) - // minted to the account
      usdc(10) - // escrow D, released to the payee before the shutdown
      (usdc(1000) - s1.refundAmount) - // stream 1: what the payee had earned
      usdc(20) - // stream 2: earned by the (frozen) payee, kept for it
      usdc(50) - // escrow B: not expired yet
      usdc(25) - // escrow C: disputed, refundable after expiry + 30 days
      usdc(40) + // vault 3: locked, owned by another key
      settledToAccount + // incoming stream 3
      usdc(25); // spend-key float pulled back with its allowance
    expect(await balanceOf(DESTINATION)).toBe(expected);
    settledBeforePhase2 = settledToAccount;
    expect(await read<bigint>(drill.usdc, drill.usdcAbi, "balanceOf", [accounts.spendKey.address])).toBe(0n);
    expect(await balanceOf(ab.escrow)).toBe(usdc(75));
    expect(await balanceOf(ab.vaults)).toBe(usdc(40));
    if (ab.executors) {
      const { fund, fundAbi, shares } = ab.executors;
      expect(await read<bigint>(fund, fundAbi, "balanceOf", [DESTINATION])).toBe(shares);
      expect(await read<bigint>(fund, fundAbi, "balanceOf", [drill.safe])).toBe(0n);
    }

    summary.push(
      `exit phase 1: ${executed.filter((e) => e.status === "confirmed").length} transactions; destination received ` +
        `${Number(expected / 10n ** BigInt(drill.decimals - 2)) / 100} USDC + 2 ETH${ab.executors ? " + all treasury-fund shares (--extra-token)" : ""}; account left with 0; modules, guard and 7579 fallback removed; ` +
        `bank module can no longer move funds; pending: escrow B (day 30), disputed escrow C (expiry + 30 d), vault 3 (day 20), spend key 2 (no allowance)`,
    );
  });

  it.skipIf(!haveAgentBank)(
    "once the locks expire, exit again recovers the rest (hardware-wallet owner)",
    async () => {
      // This time the owner key lives on a hardware wallet: --signer-only, sign, submit via a relayer.
      const ab = drill.ab!;
      const destBefore = await balanceOf(DESTINATION);
      await travel(31n * DAY);
      const relayerEnv = {
        SENDER_PRIVATE_KEY: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
      };

      // Round 1: recover into the account. Escrow refunds, vault withdrawals and stream settlements
      // are public calls (no signature); the final withdrawal is deferred to round 2.
      const plan1 = path.join(drill.dir, "phase2-recover", "plan.json");
      const p1 = await runCli([
        "exit",
        ...cliBase(),
        "--to",
        DESTINATION,
        "--signer-only",
        "--plan-file",
        plan1,
        "--json",
      ]);
      expect(p1.code, p1.stderr + p1.stdout).toBe(0);
      const signerOnly1 = p1.json!.signerOnly as { payloads: unknown[]; deferred: string[] };
      expect(signerOnly1.payloads).toEqual([]);
      expect(signerOnly1.deferred.length).toBe(1);
      const steps1 = (p1.json!.plan as { steps: { id: string; skipped?: string }[] }).steps
        .filter((s) => !s.skipped)
        .map((s) => s.id.split(":")[0]);
      expect(steps1.sort()).toEqual(
        ["refund-escrow", "refund-escrow", "settle-stream", "withdraw-vault"].sort(),
      );
      const s1 = await runCli(
        ["submit", "--rpc-url", drill.anvil.rpcUrl, "--plan-file", plan1, "--execute", "--yes", "--json"],
        relayerEnv,
      );
      expect(s1.code, s1.stderr + s1.stdout).toBe(0);

      // Round 2: sign the withdrawal of everything that came back.
      const plan2 = path.join(drill.dir, "phase2-withdraw", "plan.json");
      const p2 = await runCli([
        "withdraw",
        ...cliBase(),
        "--to",
        DESTINATION,
        "--token",
        "usdc",
        "--amount",
        "all",
        "--signer-only",
        "--plan-file",
        plan2,
        "--json",
      ]);
      expect(p2.code, p2.stderr + p2.stdout).toBe(0);
      const payloads = (p2.json!.signerOnly as { payloads: { typedData: unknown }[] }).payloads;
      const sig = (await drill.c.publicClient.request({
        method: "eth_signTypedData_v4" as never,
        params: [accounts.owner.address, JSON.stringify(payloads[0]!.typedData)] as never,
      })) as Hex;
      const s2 = await runCli(
        [
          "submit",
          "--rpc-url",
          drill.anvil.rpcUrl,
          "--plan-file",
          plan2,
          "--signature",
          sig,
          "--execute",
          "--yes",
        ],
        relayerEnv,
      );
      expect(s2.code, s2.stderr + s2.stdout).toBe(0);

      const gained = (await balanceOf(DESTINATION)) - destBefore;
      // escrow B + escrow C + vault 3 + the rest of incoming stream 3 (fully accrued by now)
      const s3 = await read<{ deposit: bigint; paid: bigint }>(ab.streams, ab.streamsAbi, "getStream", [
        ab.ids.s3,
      ]);
      expect(s3.paid).toBe(s3.deposit);
      expect(gained).toBe(usdc(50 + 25 + 40) + (s3.deposit - settledBeforePhase2));
      expect(await balanceOf(ab.escrow)).toBe(0n);
      expect(await balanceOf(ab.vaults)).toBe(0n);
      expect(await balanceOf(drill.safe)).toBe(0n);
      // What is left in the streams contract belongs to the frozen payee (its deferred 20 USDC).
      expect(await balanceOf(ab.streams)).toBe(usdc(20));
      expect(await read<bigint>(ab.streams, ab.streamsAbi, "outstanding", [ab.ids.s2])).toBe(usdc(20));
      summary.push(
        `exit phase 2 (+31 days, hardware-wallet owner via --signer-only + submit by a relayer): +${Number(gained / 10n ** BigInt(drill.decimals - 2)) / 100} USDC; ` +
          "the escrow and vault contracts hold nothing of the account; the streams contract holds only the frozen payee's 20 USDC",
      );
    },
  );

  it.skipIf(!haveAgentBank)(
    "hardware-wallet flow: --signer-only payloads, signatures back, submit by a relayer",
    async () => {
      const ab = drill.ab!;
      // New funds arrive, and a fresh vault is created and funded through the owner's own path.
      await send(drill.c, "deployer", drill.usdc, call(drill.usdcAbi, "mint", [drill.safe, usdc(7)]));
      await send(drill.c, "guardian", ab.vaults, call(ab.vaultsAbi, "unpause"));
      const unlockAt = (await nowTs()) + 30n * DAY;
      await ownerExec(
        drill.c,
        drill.safe,
        ab.vaults,
        call(ab.vaultsAbi, "createVault", [drill.usdc, unlockAt, accounts.owner.address]),
      );
      const vaultId = await lastId(ab.vaults, ab.vaultsAbi, "vaultCount");
      await ownerExec(drill.c, drill.safe, drill.usdc, call(drill.usdcAbi, "approve", [ab.vaults, usdc(3)]));
      await ownerExec(drill.c, drill.safe, ab.vaults, call(ab.vaultsAbi, "deposit", [vaultId, usdc(3)]));
      const destBefore = await balanceOf(DESTINATION);

      // 1) Early vault withdrawal: EIP-712 EarlyWithdrawal signed on the "hardware wallet".
      const planFile = path.join(drill.dir, "vault-plan", "plan.json");
      const plan = await runCli([
        "withdraw-vaults",
        ...cliBase(),
        "--signer-only",
        "--plan-file",
        planFile,
        "--json",
      ]);
      expect(plan.code, plan.stderr + plan.stdout).toBe(0);
      const payloads = (plan.json!.signerOnly as { payloads: { kind: string; typedData: unknown }[] })
        .payloads;
      expect(payloads.map((p) => p.kind)).toEqual(["EarlyWithdrawal"]);
      // The owner's wallet signs the JSON exactly as a wallet would (eth_signTypedData_v4 on Anvil's unlocked account).
      const sign = (typedData: unknown) =>
        drill.c.publicClient.request({
          method: "eth_signTypedData_v4" as never,
          params: [accounts.owner.address, JSON.stringify(typedData)] as never,
        }) as Promise<Hex>;
      const vaultSig = await sign(payloads[0]!.typedData);
      const submitted = await runCli(
        [
          "submit",
          "--rpc-url",
          drill.anvil.rpcUrl,
          "--plan-file",
          planFile,
          "--signature",
          vaultSig,
          "--execute",
          "--yes",
          "--json",
        ],
        { SENDER_PRIVATE_KEY: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" },
      );
      expect(submitted.code, submitted.stderr + submitted.stdout).toBe(0);
      expect((await read<{ balance: bigint }>(ab.vaults, ab.vaultsAbi, "getVault", [vaultId])).balance).toBe(
        0n,
      );

      // 2) Withdraw: a SafeTx signed on the "hardware wallet", sent by an unrelated relayer key.
      const planFile2 = path.join(drill.dir, "withdraw-plan", "plan.json");
      const plan2 = await runCli([
        "withdraw",
        ...cliBase(),
        "--to",
        DESTINATION,
        "--token",
        "usdc",
        "--amount",
        "all",
        "--signer-only",
        "--plan-file",
        planFile2,
        "--json",
      ]);
      expect(plan2.code, plan2.stderr + plan2.stdout).toBe(0);
      const payloads2 = (plan2.json!.signerOnly as { payloads: { kind: string; typedData: unknown }[] })
        .payloads;
      expect(payloads2.map((p) => p.kind)).toEqual(["SafeTx"]);
      const sig = await sign(payloads2[0]!.typedData);
      // Without --execute, submit prints ready-to-send transactions for any wallet.
      const dry = await runCli([
        "submit",
        "--rpc-url",
        drill.anvil.rpcUrl,
        "--plan-file",
        planFile2,
        "--signature",
        sig,
        "--json",
      ]);
      expect(dry.code, dry.stderr).toBe(0);
      expect((dry.json!.transactions as unknown[]).length).toBe(1);
      // A wrong signature is rejected before anything is sent.
      const wrong = await accounts.payee.signMessage({ message: "not a SafeTx" });
      const bad = await runCli(
        [
          "submit",
          "--rpc-url",
          drill.anvil.rpcUrl,
          "--plan-file",
          planFile2,
          "--signature",
          wrong,
          "--execute",
          "--yes",
        ],
        {
          SENDER_PRIVATE_KEY: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
        },
      );
      expect(bad.code).toBe(1);
      const sent = await runCli(
        [
          "submit",
          "--rpc-url",
          drill.anvil.rpcUrl,
          "--plan-file",
          planFile2,
          "--signature",
          sig,
          "--execute",
          "--yes",
          "--json",
        ],
        { SENDER_PRIVATE_KEY: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" },
      );
      expect(sent.code, sent.stderr + sent.stdout).toBe(0);
      // 7 minted: 3 went into the vault and came back early, then everything was withdrawn.
      expect((await balanceOf(DESTINATION)) - destBefore).toBe(usdc(7));
      expect(await balanceOf(drill.safe)).toBe(0n);
      // Submitting the same plan again is harmless: the nonce is used, the step is skipped.
      const again = await runCli(
        [
          "submit",
          "--rpc-url",
          drill.anvil.rpcUrl,
          "--plan-file",
          planFile2,
          "--signature",
          sig,
          "--execute",
          "--yes",
        ],
        { SENDER_PRIVATE_KEY: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" },
      );
      expect(again.code, again.stderr + again.stdout).toBe(0); // the used nonce is detected: nothing to send
      expect(again.stdout).toMatch(/already/i);
      summary.push(
        "signer-only: EarlyWithdrawal and SafeTx signed via eth_signTypedData_v4, submitted by an unrelated relayer key; wrong signature refused",
      );
    },
  );

  it("multi-owner Safe (2 of 3): signatures from two owners, packed in owner order", async () => {
    const owners = [accounts.owner.address, accounts.payee.address, accounts.payee2.address];
    const multisig = await createSafe(drill.c, owners, 2n, SAFE_V141.compatibilityFallbackHandler, 99n);
    await send(drill.c, "deployer", multisig, "0x", parseEther("1"));
    const base = [
      "--rpc-url",
      drill.anvil.rpcUrl,
      "--chain",
      "anvil",
      "--account",
      multisig,
      "--deployments",
      drill.deploymentsFile,
    ];
    // A hot key alone cannot execute a 2-of-3 Safe.
    const hot = await runCli(
      ["withdraw", ...base, "--to", DESTINATION, "--token", "eth", "--amount", "all", "--execute", "--yes"],
      ownerEnv,
    );
    expect(hot.code).toBe(1);
    expect(hot.stderr).toMatch(/needs 2 owner signatures/);

    const planFile = path.join(drill.dir, "multisig", "plan.json");
    const plan = await runCli([
      "withdraw",
      ...base,
      "--to",
      DESTINATION,
      "--token",
      "eth",
      "--amount",
      "all",
      "--signer-only",
      "--signer",
      accounts.payee.address,
      "--plan-file",
      planFile,
      "--json",
    ]);
    expect(plan.code, plan.stderr + plan.stdout).toBe(0);
    const typedData = (plan.json!.signerOnly as { payloads: { typedData: unknown }[] }).payloads[0]!
      .typedData;
    const signWith = (who: Address) =>
      drill.c.publicClient.request({
        method: "eth_signTypedData_v4" as never,
        params: [who, JSON.stringify(typedData)] as never,
      }) as Promise<Hex>;
    const relayerEnv = {
      SENDER_PRIVATE_KEY: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    };
    const one = await runCli(
      [
        "submit",
        "--rpc-url",
        drill.anvil.rpcUrl,
        "--plan-file",
        planFile,
        "--signature",
        await signWith(accounts.payee2.address),
        "--execute",
        "--yes",
      ],
      relayerEnv,
    );
    expect(one.code).toBe(1);
    expect(one.stderr).toMatch(/needs 2 owner signature/);
    const before = await drill.c.publicClient.getBalance({ address: DESTINATION });
    const two = await runCli(
      [
        "submit",
        "--rpc-url",
        drill.anvil.rpcUrl,
        "--plan-file",
        planFile,
        // deliberately in the "wrong" order: the tool sorts signatures by owner address
        "--signature",
        await signWith(accounts.payee2.address),
        "--signature",
        await signWith(accounts.payee.address),
        "--execute",
        "--yes",
      ],
      relayerEnv,
    );
    expect(two.code, two.stderr + two.stdout).toBe(0);
    expect((await drill.c.publicClient.getBalance({ address: DESTINATION })) - before).toBe(parseEther("1"));
    summary.push("2-of-3 Safe: one signature refused, two signatures (any order) executed by a relayer");
  });

  it("keystore flow: encrypted JSON keystore with a passphrase file", async () => {
    await send(drill.c, "deployer", drill.safe, "0x", parseEther("0.5"));
    const keystore = encryptKeystore(
      ownerEnv.OWNER_PRIVATE_KEY as Hex,
      "correct horse battery staple",
      accounts.owner.address,
    );
    const ksFile = path.join(drill.dir, "owner.keystore.json");
    const pwFile = path.join(drill.dir, "owner.password");
    writeFileSync(ksFile, JSON.stringify(keystore));
    writeFileSync(pwFile, "correct horse battery staple\n");
    const before = await drill.c.publicClient.getBalance({ address: DESTINATION });
    const run = await runCli([
      "withdraw",
      ...cliBase(),
      "--to",
      DESTINATION,
      "--token",
      "eth",
      "--amount",
      "all",
      "--keystore",
      ksFile,
      "--password-file",
      pwFile,
      "--execute",
      "--yes",
      "--json",
    ]);
    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect((await drill.c.publicClient.getBalance({ address: DESTINATION })) - before).toBe(
      parseEther("0.5"),
    );
    expect(run.stdout + run.stderr).not.toContain(ownerEnv.OWNER_PRIVATE_KEY.slice(2));
    const wrongPw = path.join(drill.dir, "wrong.password");
    writeFileSync(wrongPw, "nope");
    await send(drill.c, "deployer", drill.safe, "0x", parseEther("0.1"));
    const bad = await runCli([
      "withdraw",
      ...cliBase(),
      "--to",
      DESTINATION,
      "--token",
      "eth",
      "--amount",
      "all",
      "--keystore",
      ksFile,
      "--password-file",
      wrongPw,
      "--execute",
      "--yes",
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/passphrase/);
    summary.push(
      "keystore: v3 keystore decrypted with a passphrase file; wrong passphrase refused; key never printed",
    );
  });
});

/** With DRILL_TRANSCRIPT_DIR set, keeps the human-readable CLI output of the drill (for docs/shutdown-drill.md). */
function transcript(name: string, run: { stdout: string; stderr: string }, args: string[]): void {
  const dir = process.env.DRILL_TRANSCRIPT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const cmd = `$ agentbank-exit ${args.join(" ")}`;
  writeFileSync(path.join(dir, `${name}.txt`), `${cmd}\n${run.stderr}${run.stdout}`);
}

/**
 * A JSON-RPC proxy in front of Anvil that behaves like a restrictive public endpoint: no
 * eth_simulateV1, and eth_getLogs limited to `maxRange` blocks (with the error text Base Sepolia's
 * public RPC uses).
 */
async function restrictedRpc(upstream: string, maxRange: bigint) {
  let refused = 0;
  type Req = { id: number; method: string; params?: unknown[] };
  const handle = async (req: Req): Promise<unknown> => {
    if (req.method === "eth_simulateV1") {
      refused += 1;
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "the method eth_simulateV1 does not exist/is not available" },
      };
    }
    if (req.method === "eth_getLogs") {
      const f = (req.params?.[0] ?? {}) as { fromBlock?: string; toBlock?: string };
      const latest = BigInt(await drill.c.publicClient.getBlockNumber());
      const from = f.fromBlock && f.fromBlock.startsWith("0x") ? BigInt(f.fromBlock) : 0n;
      const to = f.toBlock && f.toBlock.startsWith("0x") ? BigInt(f.toBlock) : latest;
      if (to - from + 1n > maxRange) {
        refused += 1;
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32614, message: `eth_getLogs is limited to a ${maxRange} range` },
        };
      }
    }
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    return res.json();
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (c: Buffer) => (body += c.toString()));
    request.on("end", () => {
      const parsed = JSON.parse(body) as Req | Req[];
      const work = Array.isArray(parsed) ? Promise.all(parsed.map(handle)) : handle(parsed);
      void work.then((out) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(out));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, refused: () => refused, close: () => server.close() };
}

/** Distinct origins a CLI run contacted. */
function origins(urls: string[]): string[] {
  return [...new Set(urls.map((u) => new URL(u).origin))];
}

function createHashHex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Minimal Web3 Secret Storage v3 encryption (scrypt, cheap parameters for tests). */
function encryptKeystore(privateKey: Hex, password: string, address: Address) {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const n = 1024;
  const derived = scryptSync(password, salt, 32, { N: n, r: 8, p: 1 });
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()]);
  const mac = keccak256(new Uint8Array(Buffer.concat([derived.subarray(16, 32), ciphertext]))).slice(2);
  return {
    version: 3,
    id: "00000000-0000-4000-8000-000000000000",
    address: address.slice(2).toLowerCase(),
    crypto: {
      cipher: "aes-128-ctr",
      ciphertext: ciphertext.toString("hex"),
      cipherparams: { iv: iv.toString("hex") },
      kdf: "scrypt",
      kdfparams: { dklen: 32, salt: salt.toString("hex"), n, r: 8, p: 1 },
      mac,
    },
  };
}
