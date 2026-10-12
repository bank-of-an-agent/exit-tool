import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  isAddressEqual,
  pad,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
} from "viem";
import { erc20Abi, timeLockVaultsAbi } from "./abis/index";
import {
  SIMULATION_BALANCE_READER,
  SIMULATION_BALANCE_READER_CODE,
  SIMULATION_SENDER,
  SIMULATION_SIGNER_STUB_CODE,
} from "./constants";
import { ExitToolError } from "./errors";
import type { AccountReport } from "./inspect";
import type { AmountSource, Plan, PlanStep } from "./plan";
import { describeRevertData, extractRevertData } from "./revert";
import {
  encodeExecTransaction,
  hashSafeTx,
  packSignatures,
  safeTxForCall,
  type Call,
  type SafeTx,
} from "./safe";
import {
  readVaultDomain,
  verifyEarlyWithdrawalDigest,
  type EarlyWithdrawal,
  type VaultDomain,
} from "./vaults";

/** A plan step with its amount resolved and its exact transaction data. */
export interface MaterializedStep {
  index: number;
  id: string;
  title: string;
  notes: string[];
  via: PlanStep["via"];
  category: PlanStep["category"];
  amount?: bigint;
  moves?: PlanStep["moves"];
  /** Inner call (Safe steps) or the transaction itself (direct steps). */
  call: Call;
  safeTx?: SafeTx;
  safeTxHash?: Hex;
  /** Early vault withdrawal: what the vault owner signs. */
  vault?: { domain: VaultDomain; message: EarlyWithdrawal; digest: Hex; owner: Address };
  /** Set when the step has nothing to do (e.g. an empty balance). */
  skipped?: string;
}

export interface StepSimulation {
  index: number;
  status: "success" | "failure" | "skipped";
  gasUsed?: bigint;
  error?: string;
}

export type BalanceMap = Record<string, bigint>;

export interface SimulationResult {
  ok: boolean;
  method: "eth_simulateV1" | "eth_call";
  note?: string;
  steps: MaterializedStep[];
  results: StepSimulation[];
  gasTotal: bigint;
  /** Balances before and after the whole plan ("ETH" or lowercase token address), when simulated in one block. */
  balances?: {
    before: { account: BalanceMap; destination?: BalanceMap };
    after: { account: BalanceMap; destination?: BalanceMap };
  };
}

export interface MaterializeOptions {
  /**
   * Owners whose signatures the simulation stands in for (at least `threshold` of them). Real
   * signatures are only produced at execution time.
   */
  simulatedSigners: readonly Address[];
  /** Validity of early-withdrawal signatures, in seconds from the inspected block. */
  vaultSignatureTtl: bigint;
  /** Tokens whose balances to report after the simulation. */
  tokens: readonly Address[];
}

interface SimCall {
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * The owners a simulation stands in for: the signer first (when it is an owner), then other owners
 * up to the threshold.
 */
export function pickSimulationSigners(report: AccountReport, signer: Address | undefined): Address[] {
  const owners = report.safe.owners;
  const out: Address[] = [];
  if (signer && owners.some((o) => isAddressEqual(o, signer))) out.push(getAddress(signer));
  for (const o of owners) {
    if (BigInt(out.length) >= report.safe.threshold) break;
    if (!out.some((x) => isAddressEqual(x, o))) out.push(o);
  }
  return out;
}

/** State overrides that let a dry run stand in for the owners' signatures (simulation only). */
export function simulationOverrides(signers: readonly Address[]): StateOverride {
  const overrides: StateOverride = signers.map((address) => ({ address, code: SIMULATION_SIGNER_STUB_CODE }));
  overrides.push({ address: SIMULATION_BALANCE_READER, code: SIMULATION_BALANCE_READER_CODE });
  return overrides;
}

/** Contract-signature placeholders (v = 0) that the simulation stub accepts. */
export function simulatedSignatures(signers: readonly Address[]): Hex {
  return packSignatures(signers.map((signer) => ({ signer, kind: "contract" as const, data: "0x" })));
}

/**
 * Whether an RPC error means "this node does not implement the method" (so a fallback is right),
 * as opposed to any other failure (which must surface). Judged by JSON-RPC error codes and the
 * node's own message only, never by viem's full message (which quotes the request).
 */
export function isUnsupportedMethodError(err: unknown): boolean {
  let unsupported = false;
  const visit = (e: unknown, depth: number): void => {
    if (unsupported || depth > 12 || e === null || typeof e !== "object") return;
    const code = (e as { code?: unknown }).code;
    if (code === -32601 || code === -32004) unsupported = true;
    const details = (e as { details?: unknown }).details;
    if (
      typeof details === "string" &&
      /method not found|not supported|does not exist|not available|unknown method|unsupported method/i.test(
        details,
      )
    ) {
      unsupported = true;
    }
    visit((e as { cause?: unknown }).cause, depth + 1);
  };
  visit(err, 0);
  return unsupported;
}

/** Reads used to resolve amounts, either live or projected through earlier simulated calls. */
interface Reader {
  call(to: Address, data: Hex): Promise<Hex>;
  ethBalance(holder: Address): Promise<bigint>;
}

function liveReader(client: PublicClient, blockNumber?: bigint): Reader {
  const at = blockNumber !== undefined ? { blockNumber } : {};
  return {
    call: async (to, data) => (await client.call({ to, data, ...at })).data ?? "0x",
    ethBalance: (holder) => client.getBalance({ address: holder, ...at }),
  };
}

function projectedReader(
  client: PublicClient,
  prior: readonly SimCall[],
  overrides: StateOverride,
  blockNumber: bigint,
): Reader {
  const read = async (to: Address, data: Hex): Promise<Hex> => {
    const [block] = await client.simulateBlocks({
      blockNumber,
      blocks: [{ calls: [...prior, { account: SIMULATION_SENDER, to, data }], stateOverrides: overrides }],
      validation: false,
    });
    const last = block?.calls[block.calls.length - 1];
    if (!last || last.status !== "success") {
      throw new ExitToolError(
        "simulation_failed",
        `Projected read failed: ${describeRevertData(last?.data)}`,
      );
    }
    return last.data;
  };
  return {
    call: read,
    ethBalance: async (holder) =>
      hexToBigInt(await read(SIMULATION_BALANCE_READER, pad(holder, { size: 32 }))),
  };
}

/** Resolves an amount source with a reader (live chain state or a projection). */
export async function resolveAmount(source: AmountSource, reader: Reader): Promise<bigint | undefined> {
  switch (source.kind) {
    case "none":
      return undefined;
    case "fixed":
      return source.amount;
    case "ethBalance":
      return reader.ethBalance(source.holder);
    case "erc20Balance": {
      const data = await reader.call(
        source.token,
        encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [source.holder] }),
      );
      return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data });
    }
    case "sweepable": {
      const [balance, allowance] = await Promise.all([
        reader
          .call(
            source.token,
            encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [source.owner] }),
          )
          .then((data) => decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data })),
        reader
          .call(
            source.token,
            encodeFunctionData({
              abi: erc20Abi,
              functionName: "allowance",
              args: [source.owner, source.spender],
            }),
          )
          .then((data) => decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data })),
      ]);
      return balance < allowance ? balance : allowance;
    }
    case "vaultBalance": {
      const data = await reader.call(
        source.vaults,
        encodeFunctionData({ abi: timeLockVaultsAbi, functionName: "getVault", args: [source.id] }),
      );
      return decodeFunctionResult({ abi: timeLockVaultsAbi, functionName: "getVault", data }).balance;
    }
  }
}

export { liveReader };
export type { Reader };

/**
 * Turns a plan into exact transactions, resolving "all"-style amounts by simulating the earlier
 * steps first (eth_simulateV1), then simulates the whole sequence in one simulated block. Owner
 * signatures are stood in for by a simulation-only ERC-1271 stub (see constants.ts); no key is
 * needed and nothing is signed or sent.
 */
export async function materializeAndSimulate(
  client: PublicClient,
  report: AccountReport,
  plan: Plan,
  options: MaterializeOptions,
): Promise<SimulationResult> {
  // Vault owners sign early withdrawals; stand in for them too (they are usually the owner key).
  const vaultOwners = plan.steps.flatMap((s) => (s.vaultSignature ? [s.vaultSignature.owner] : []));
  const stubbed = [
    ...new Map([...options.simulatedSigners, ...vaultOwners].map((a) => [a.toLowerCase(), a])).values(),
  ];
  const overrides = simulationOverrides(stubbed);
  const signatures = simulatedSignatures(options.simulatedSigners);
  const account = report.account;
  // Every read and simulation runs on top of the same block (the one inspected), so amounts that
  // depend on time (stream accrual) are consistent between the projection and the final simulation.
  const baseBlock = report.block.number;

  let method: SimulationResult["method"] = "eth_simulateV1";
  let note: string | undefined;
  try {
    await client.simulateBlocks({
      blockNumber: baseBlock,
      blocks: [
        { calls: [{ account: SIMULATION_SENDER, to: account, data: "0x" }], stateOverrides: overrides },
      ],
      validation: false,
    });
  } catch (err) {
    if (!isUnsupportedMethodError(err)) throw err;
    method = "eth_call";
    note =
      "This RPC does not support eth_simulateV1: each step was simulated on its own against the current state, and amounts that depend on earlier steps are shown as of now. Execution re-checks every step right before sending it.";
  }

  const steps: MaterializedStep[] = [];
  const prior: SimCall[] = [];
  let safeNonce = report.safe.nonce;
  const vaultNonces = new Map<string, bigint>(report.vaults.map((v) => [v.id.toString(), v.nonce]));
  const domains = new Map<string, VaultDomain>();

  for (const [i, step] of plan.steps.entries()) {
    const reader =
      method === "eth_simulateV1" && prior.length > 0
        ? projectedReader(client, prior, overrides, baseBlock)
        : liveReader(client, baseBlock);
    const amount = await resolveAmount(step.amount, reader);
    const base = {
      index: i + 1,
      id: step.id,
      title: step.title,
      notes: step.notes,
      via: step.via,
      category: step.category,
      ...(amount !== undefined ? { amount } : {}),
      ...(step.moves ? { moves: step.moves } : {}),
    };
    if (amount !== undefined && amount === 0n) {
      steps.push({ ...base, call: step.build(0n), skipped: "nothing to move" });
      continue;
    }
    let vault: MaterializedStep["vault"];
    let call: Call;
    if (step.vaultSignature) {
      const req = step.vaultSignature;
      let domain = domains.get(req.vaults.toLowerCase());
      if (!domain) {
        domain = await readVaultDomain(client, req.vaults, plan.chainId);
        domains.set(req.vaults.toLowerCase(), domain);
      }
      const nonce = vaultNonces.get(req.id.toString()) ?? 0n;
      vaultNonces.set(req.id.toString(), nonce + 1n);
      const message: EarlyWithdrawal = {
        vaultId: req.id,
        amount: amount ?? 0n,
        nonce,
        deadline: report.block.timestamp + options.vaultSignatureTtl,
      };
      const digest = await verifyEarlyWithdrawalDigest(client, domain, message);
      vault = { domain, message, digest, owner: req.owner };
      call = step.build(amount ?? 0n, { signature: "0x", deadline: message.deadline });
    } else {
      call = step.build(amount ?? 0n);
    }
    const materialized: MaterializedStep = { ...base, call, ...(vault ? { vault } : {}) };
    if (step.via === "safe") {
      const safeTx = safeTxForCall(call, safeNonce, step.operation ?? 0);
      safeNonce += 1n;
      materialized.safeTx = safeTx;
      materialized.safeTxHash = hashSafeTx(plan.chainId, account, safeTx);
      prior.push({
        account: SIMULATION_SENDER,
        to: account,
        data: encodeExecTransaction(safeTx, signatures),
        value: 0n,
      });
    } else {
      prior.push({ account: SIMULATION_SENDER, to: call.to, data: call.data, value: call.value });
    }
    steps.push(materialized);
  }

  // Simulate the whole sequence (or each step on its own without eth_simulateV1).
  const active = steps.filter((s) => !s.skipped);
  const results: StepSimulation[] = steps
    .filter((s) => s.skipped)
    .map((s) => ({ index: s.index, status: "skipped" as const }));
  const tokenReads = options.tokens.flatMap((token) => {
    const holders: Address[] = [account, ...(plan.destination ? [plan.destination] : [])];
    return holders.map((holder) => ({
      key: token.toLowerCase(),
      holder,
      call: {
        account: SIMULATION_SENDER,
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
      },
    }));
  });
  const ethReads = [account, ...(plan.destination ? [plan.destination] : [])].map((holder) => ({
    key: "ETH",
    holder,
    call: { account: SIMULATION_SENDER, to: SIMULATION_BALANCE_READER, data: pad(holder, { size: 32 }) },
  }));
  const reads = [...tokenReads, ...ethReads];

  let balances: SimulationResult["balances"];
  if (method === "eth_simulateV1") {
    // Read balances before and after the steps, in the same simulated block.
    const [block] = await client.simulateBlocks({
      blockNumber: baseBlock,
      blocks: [
        {
          calls: [...reads.map((r) => r.call), ...prior, ...reads.map((r) => r.call)],
          stateOverrides: overrides,
        },
      ],
      validation: false,
    });
    const calls = block?.calls ?? [];
    active.forEach((s, j) => {
      const r = calls[reads.length + j];
      if (!r) return;
      results.push({
        index: s.index,
        status: r.status,
        gasUsed: r.gasUsed,
        ...(r.status === "failure" ? { error: describeRevertData(r.data) } : {}),
      });
    });
    const collect = (offset: number): { account: BalanceMap; destination?: BalanceMap } => {
      const accountMap: BalanceMap = {};
      const destinationMap: BalanceMap = {};
      reads.forEach((r, j) => {
        const res = calls[offset + j];
        if (!res || res.status !== "success") return;
        const value = hexToBigInt(res.data);
        if (isAddressEqual(r.holder, account)) accountMap[r.key] = value;
        else destinationMap[r.key] = value;
      });
      return { account: accountMap, ...(plan.destination ? { destination: destinationMap } : {}) };
    };
    balances = { before: collect(0), after: collect(reads.length + active.length) };
  } else {
    for (const s of active) {
      const sim = prior[active.indexOf(s)]!;
      try {
        await client.call({
          account: sim.account,
          to: sim.to,
          data: sim.data,
          value: sim.value,
          stateOverride: overrides,
          blockNumber: baseBlock,
        });
        const gas = await client
          .estimateGas({
            account: sim.account,
            to: sim.to,
            data: sim.data,
            value: sim.value,
            stateOverride: overrides,
            blockNumber: baseBlock,
          })
          .catch(() => undefined);
        results.push({ index: s.index, status: "success", ...(gas !== undefined ? { gasUsed: gas } : {}) });
      } catch (err) {
        results.push({
          index: s.index,
          status: "failure",
          error: describeRevertData(extractRevertData(err)),
        });
      }
    }
  }

  // Explain Safe-level failures (GS013 hides the inner revert) by replaying the inner call from the Safe.
  if (method === "eth_simulateV1") {
    for (const r of results) {
      if (r.status !== "failure") continue;
      const s = steps.find((x) => x.index === r.index);
      if (!s || s.via !== "safe" || s.safeTx?.operation !== 0 || !r.error?.startsWith("GS013")) continue;
      const before = prior.slice(0, active.indexOf(s));
      try {
        const [block] = await client.simulateBlocks({
          blockNumber: baseBlock,
          blocks: [
            {
              calls: [...before, { account, to: s.call.to, data: s.call.data, value: s.call.value }],
              stateOverrides: overrides,
            },
          ],
          validation: false,
        });
        const inner = block?.calls[block.calls.length - 1];
        if (inner && inner.status === "failure")
          r.error = `${r.error}; inner call: ${describeRevertData(inner.data)}`;
      } catch {
        // keep the outer reason
      }
    }
  }

  // A step the RPC returned no result for was not simulated: never count it as a success.
  for (const s of active) {
    if (!results.some((r) => r.index === s.index)) {
      results.push({
        index: s.index,
        status: "failure",
        error: "the RPC returned no simulation result for this step",
      });
    }
  }
  results.sort((a, b) => a.index - b.index);
  const gasTotal = results.reduce((acc, r) => acc + (r.gasUsed ?? 0n), 0n);
  return {
    ok: results.every((r) => r.status !== "failure"),
    method,
    ...(note ? { note } : {}),
    steps,
    results,
    gasTotal,
    ...(balances ? { balances } : {}),
  };
}
