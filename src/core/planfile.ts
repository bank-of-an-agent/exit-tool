import {
  decodeFunctionData,
  formatEther,
  getAddress,
  isAddressEqual,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { agentEscrowAbi, erc20Abi, paymentStreamsAbi, safeAbi, timeLockVaultsAbi } from "./abis/index";
import type { AgentBankContracts } from "./deployments";
import { ZERO_ADDRESS } from "./constants";
import { ExitToolError } from "./errors";
import { decodeMultiSend, MULTISEND_CALL_ONLY } from "./multisend";
import { hashSafeTx, safeTxTypedDataJson, type SafeTx } from "./safe";
import type { MaterializedStep } from "./simulate";
import {
  earlyWithdrawalTypedDataJson,
  hashEarlyWithdrawal,
  type EarlyWithdrawal,
  type VaultDomain,
} from "./vaults";

export const PLAN_FORMAT = "agentbank-exit-plan/v1";

/** Every function a plan step may call, for decoding (shapes are checked in verifyPlanSteps). */
const PLAN_CALL_ABI = [
  ...safeAbi,
  ...erc20Abi,
  ...agentEscrowAbi,
  ...paymentStreamsAbi,
  ...timeLockVaultsAbi,
] as Abi;

/** disableModule, setFallbackHandler, setGuard: what the revoke batch may call on the account. */
const REVOKE_SELECTORS = new Set<string>([
  toFunctionSelector("disableModule(address,address)"),
  toFunctionSelector("setFallbackHandler(address)"),
  toFunctionSelector("setGuard(address)"),
]);

/** The public recovery calls a plan may contain (each can only pay the account). */
const PUBLIC_RECOVERY_SELECTORS = new Set<string>([
  toFunctionSelector("refund(uint256)"),
  toFunctionSelector("releaseByValidation(uint256)"),
  toFunctionSelector("settle(uint256)"),
  toFunctionSelector("withdraw(uint256,uint256)"),
  toFunctionSelector("withdrawWithSignature(uint256,uint256,uint256,bytes)"),
]);

/** One thing to sign on a hardware wallet. */
export interface SignPayload {
  /** Step index (1-based) the signature is for. */
  step: number;
  kind: "SafeTx" | "EarlyWithdrawal";
  /** The EIP-712 hash a correct signature recovers against. */
  hash: Hex;
  /** Who must sign: any Safe owner (SafeTx) or the vault owner (EarlyWithdrawal). */
  signer: Address | "owner";
  /** EIP-712 typed data for eth_signTypedData_v4 / `cast wallet sign --data`. */
  typedData: unknown;
}

/** A frozen plan for the signer-only flow: exact transactions, what to sign, nothing secret. */
export interface PlanFile {
  format: typeof PLAN_FORMAT;
  createdAt: string;
  chainId: number;
  account: Address;
  command: string;
  destination?: Address;
  /** Block the plan was made at: Safe executions of its steps can only appear after it. */
  block?: string;
  safe: { nonce: string; threshold: string; owners: Address[] };
  steps: unknown[];
  payloads: SignPayload[];
  /** What the plan leaves out (and why), and anything that still needs doing afterwards. */
  notes: string[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function serializeSafeTx(tx: SafeTx): Json {
  return {
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    operation: tx.operation,
    safeTxGas: tx.safeTxGas.toString(),
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: tx.nonce.toString(),
  };
}

function serializeStep(step: MaterializedStep): Json {
  const out: { [key: string]: Json } = {
    index: step.index,
    id: step.id,
    title: step.title,
    notes: step.notes,
    via: step.via,
    category: step.category,
    call: { to: step.call.to, value: step.call.value.toString(), data: step.call.data },
  };
  if (step.amount !== undefined) out.amount = step.amount.toString();
  if (step.skipped) out.skipped = step.skipped;
  if (step.moves) out.moves = { token: step.moves.token, from: step.moves.from, to: step.moves.to };
  if (step.safeTx) out.safeTx = serializeSafeTx(step.safeTx);
  if (step.safeTxHash) out.safeTxHash = step.safeTxHash;
  if (step.vault) {
    out.vault = {
      domain: { ...step.vault.domain },
      message: {
        vaultId: step.vault.message.vaultId.toString(),
        amount: step.vault.message.amount.toString(),
        nonce: step.vault.message.nonce.toString(),
        deadline: step.vault.message.deadline.toString(),
      },
      digest: step.vault.digest,
      owner: step.vault.owner,
    };
  }
  return out;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string")
    throw new ExitToolError("plan_mismatch", `Plan file: ${what} is missing or not a string.`);
  return v;
}
const big = (v: unknown, what: string): bigint => BigInt(str(v, what));
const hex = (v: unknown, what: string): Hex => {
  const s = str(v, what);
  if (!/^0x[0-9a-fA-F]*$/.test(s)) throw new ExitToolError("plan_mismatch", `Plan file: ${what} is not hex.`);
  return s as Hex;
};
const addr = (v: unknown, what: string): Address => getAddress(str(v, what));

function deserializeStep(raw: unknown): MaterializedStep {
  if (raw === null || typeof raw !== "object")
    throw new ExitToolError("plan_mismatch", "Plan file: bad step.");
  const r = raw as Record<string, unknown>;
  const call = r.call as Record<string, unknown>;
  const step: MaterializedStep = {
    index: Number(r.index),
    id: str(r.id, "step.id"),
    title: str(r.title, "step.title"),
    notes: Array.isArray(r.notes) ? r.notes.map(String) : [],
    via: r.via === "safe" ? "safe" : "direct",
    category: (["revoke", "recover", "withdraw"].includes(String(r.category))
      ? r.category
      : "recover") as MaterializedStep["category"],
    call: {
      to: addr(call?.to, "step.call.to"),
      value: big(call?.value, "step.call.value"),
      data: hex(call?.data, "step.call.data"),
    },
  };
  if (r.amount !== undefined) step.amount = big(r.amount, "step.amount");
  if (typeof r.skipped === "string") step.skipped = r.skipped;
  if (r.safeTx) {
    const t = r.safeTx as Record<string, unknown>;
    step.safeTx = {
      to: addr(t.to, "safeTx.to"),
      value: big(t.value, "safeTx.value"),
      data: hex(t.data, "safeTx.data"),
      operation: Number(t.operation),
      safeTxGas: big(t.safeTxGas, "safeTx.safeTxGas"),
      baseGas: big(t.baseGas, "safeTx.baseGas"),
      gasPrice: big(t.gasPrice, "safeTx.gasPrice"),
      gasToken: addr(t.gasToken, "safeTx.gasToken"),
      refundReceiver: addr(t.refundReceiver, "safeTx.refundReceiver"),
      nonce: big(t.nonce, "safeTx.nonce"),
    };
    if (step.safeTx.operation !== 0 && step.safeTx.operation !== 1) {
      throw new ExitToolError("plan_mismatch", "Plan file: operation must be 0 (CALL) or the revoke batch.");
    }
    const t2 = step.safeTx;
    if (
      t2.safeTxGas !== 0n ||
      t2.baseGas !== 0n ||
      t2.gasPrice !== 0n ||
      !isAddressEqual(t2.gasToken, ZERO_ADDRESS) ||
      !isAddressEqual(t2.refundReceiver, ZERO_ADDRESS)
    ) {
      throw new ExitToolError(
        "plan_mismatch",
        "Plan file: SafeTx gas refund fields must all be zero (the Safe never pays the executor).",
      );
    }
  }
  if (r.vault) {
    const v = r.vault as Record<string, unknown>;
    const d = v.domain as Record<string, unknown>;
    const m = v.message as Record<string, unknown>;
    const domain: VaultDomain = {
      name: str(d.name, "vault.domain.name"),
      version: str(d.version, "vault.domain.version"),
      chainId: Number(d.chainId),
      verifyingContract: addr(d.verifyingContract, "vault.domain.verifyingContract"),
    };
    const message: EarlyWithdrawal = {
      vaultId: big(m.vaultId, "vault.message.vaultId"),
      amount: big(m.amount, "vault.message.amount"),
      nonce: big(m.nonce, "vault.message.nonce"),
      deadline: big(m.deadline, "vault.message.deadline"),
    };
    step.vault = {
      domain,
      message,
      digest: hashEarlyWithdrawal(domain, message),
      owner: addr(v.owner, "vault.owner"),
    };
  }
  return step;
}

/** Builds the plan file (and the list of payloads to sign) from materialized steps. */
export function buildPlanFile(input: {
  chainId: number;
  account: Address;
  command: string;
  destination?: Address;
  safe: { nonce: bigint; threshold: bigint; owners: readonly Address[] };
  steps: readonly MaterializedStep[];
  notes: readonly string[];
  block?: bigint;
  now?: Date;
}): PlanFile {
  const payloads: SignPayload[] = [];
  for (const step of input.steps) {
    if (step.skipped) continue;
    if (step.vault) {
      payloads.push({
        step: step.index,
        kind: "EarlyWithdrawal",
        hash: step.vault.digest,
        signer: step.vault.owner,
        typedData: earlyWithdrawalTypedDataJson(step.vault.domain, step.vault.message),
      });
    }
    if (step.safeTx) {
      payloads.push({
        step: step.index,
        kind: "SafeTx",
        hash: hashSafeTx(input.chainId, input.account, step.safeTx),
        signer: "owner",
        typedData: safeTxTypedDataJson(input.chainId, input.account, step.safeTx),
      });
    }
  }
  return {
    format: PLAN_FORMAT,
    createdAt: (input.now ?? new Date()).toISOString(),
    chainId: input.chainId,
    account: input.account,
    command: input.command,
    ...(input.destination ? { destination: input.destination } : {}),
    ...(input.block !== undefined ? { block: input.block.toString() } : {}),
    safe: {
      nonce: input.safe.nonce.toString(),
      threshold: input.safe.threshold.toString(),
      owners: [...input.safe.owners],
    },
    steps: input.steps.map(serializeStep),
    payloads,
    notes: [...input.notes],
  };
}

/** Parses and checks a plan file: recomputes every hash from the stored transactions. */
export function parsePlanFile(
  json: unknown,
  expected: { chainId: number; account?: Address },
): {
  file: PlanFile;
  steps: MaterializedStep[];
} {
  if (json === null || typeof json !== "object")
    throw new ExitToolError("plan_mismatch", "Plan file is not a JSON object.");
  const file = json as PlanFile;
  if (file.format !== PLAN_FORMAT) {
    throw new ExitToolError(
      "plan_mismatch",
      `Unsupported plan file format ${String(file.format)} (expected ${PLAN_FORMAT}).`,
    );
  }
  if (file.chainId !== expected.chainId) {
    throw new ExitToolError(
      "chain_mismatch",
      `The plan is for chain ${file.chainId} but the RPC is chain ${expected.chainId}.`,
    );
  }
  const account = getAddress(file.account);
  if (expected.account && !isAddressEqual(expected.account, account)) {
    throw new ExitToolError("plan_mismatch", `The plan is for account ${account}, not ${expected.account}.`);
  }
  const steps = (Array.isArray(file.steps) ? file.steps : []).map(deserializeStep);
  for (const step of steps) {
    if (step.via === "safe" && !step.safeTx && !step.skipped) {
      throw new ExitToolError("plan_mismatch", `Plan step ${step.index} is a Safe step without a SafeTx.`);
    }
    if (step.safeTx) {
      step.safeTxHash = hashSafeTx(file.chainId, account, step.safeTx);
      // The SafeTx must be the step's call: the file cannot smuggle a different transaction.
      if (
        !isAddressEqual(step.safeTx.to, step.call.to) ||
        step.safeTx.value !== step.call.value ||
        step.safeTx.data.toLowerCase() !== step.call.data.toLowerCase()
      ) {
        throw new ExitToolError(
          "plan_mismatch",
          `Plan step ${step.index}: SafeTx does not match the step's call.`,
        );
      }
    }
    if (step.safeTx?.operation === 1) {
      // The only DELEGATECALL the tool produces: the atomic revoke batch through the canonical
      // MultiSendCallOnly, whose inner calls may only reconfigure the account itself.
      const inner = isAddressEqual(step.safeTx.to, MULTISEND_CALL_ONLY)
        ? decodeMultiSend(step.safeTx.data)
        : undefined;
      if (
        !inner ||
        !inner.every(
          (c) =>
            isAddressEqual(c.to, account) &&
            c.value === 0n &&
            REVOKE_SELECTORS.has(c.data.slice(0, 10).toLowerCase()),
        )
      ) {
        throw new ExitToolError(
          "plan_mismatch",
          `Plan step ${step.index}: a DELEGATECALL is only allowed for the revoke batch through MultiSendCallOnly.`,
        );
      }
    }
    if (step.via === "direct" && !step.skipped) {
      const selector = step.call.data.slice(0, 10).toLowerCase();
      if (step.call.value !== 0n || !PUBLIC_RECOVERY_SELECTORS.has(selector)) {
        throw new ExitToolError(
          "plan_mismatch",
          `Plan step ${step.index}: a public step may only refund, settle or withdraw to the account (got ${selector}).`,
        );
      }
    }
    if (step.vault && step.vault.domain.chainId !== file.chainId) {
      throw new ExitToolError(
        "plan_mismatch",
        `Plan step ${step.index}: vault signature domain is for another chain.`,
      );
    }
    if (step.vault && !isAddressEqual(step.vault.domain.verifyingContract, step.call.to)) {
      throw new ExitToolError(
        "plan_mismatch",
        `Plan step ${step.index}: the early withdrawal is signed for ${step.vault.domain.verifyingContract} but sent to ${step.call.to}.`,
      );
    }
  }
  return { file: { ...file, account }, steps };
}

/** What a plan may do, established at submit time from trusted sources (never from the plan file). */
export interface TrustedPlanContext {
  account: Address;
  /** The destination the user confirmed on the command line (`--to`); required to move funds out. */
  destination?: Address;
  /** Agent Bank contracts from the built-in config and the deployments file the user passed. */
  contracts: AgentBankContracts;
  /** The verified CompatibilityFallbackHandler, or address(0) when none is verified on this chain. */
  compatibilityFallbackHandler: Address;
  /** Whether the canonical MultiSendCallOnly code was verified on this chain. */
  multiSendVerified: boolean;
}

function decodeKnown(data: Hex): { functionName: string; args: readonly unknown[] } | undefined {
  try {
    const d = decodeFunctionData({ abi: PLAN_CALL_ABI, data });
    return { functionName: d.functionName, args: d.args ?? [] };
  } catch {
    return undefined;
  }
}

/** A self-call reconfiguring the account: only the revoke operations, with safe arguments. */
function describeSelfCall(call: { data: Hex; value: bigint }, ctx: TrustedPlanContext): string | undefined {
  if (call.value !== 0n) return undefined;
  const d = decodeKnown(call.data);
  if (!d) return undefined;
  if (d.functionName === "setGuard") {
    return isAddressEqual(d.args[0] as Address, ZERO_ADDRESS) ? "remove the transaction guard" : undefined;
  }
  if (d.functionName === "disableModule") return `disable module ${String(d.args[1])}`;
  if (d.functionName === "setFallbackHandler") {
    const handler = d.args[0] as Address;
    if (!isAddressEqual(handler, ctx.compatibilityFallbackHandler)) return undefined;
    return isAddressEqual(handler, ZERO_ADDRESS)
      ? "remove the fallback handler"
      : `set the fallback handler to the verified CompatibilityFallbackHandler ${handler}`;
  }
  return undefined;
}

/**
 * Checks every step of a plan file against the shapes the planner produces, using only trusted
 * inputs (the chain, the user's `--to`, the configured contracts), and replaces the file's titles
 * with descriptions derived from the calldata. A plan file is untrusted input: anything else is
 * refused before anything is signed or sent.
 */
export function verifyPlanSteps(steps: MaterializedStep[], ctx: TrustedPlanContext): void {
  const refuse = (step: MaterializedStep, why: string): never => {
    throw new ExitToolError(
      "plan_mismatch",
      `Plan step ${step.index} is not something this tool produces: ${why}.`,
    );
  };
  const toDestination = (step: MaterializedStep, to: Address): void => {
    if (!ctx.destination) {
      throw new ExitToolError("plan_mismatch", `Plan step ${step.index} sends funds to ${to}.`, {
        hint: `Confirm the destination with --to ${to} if (and only if) it is your address.`,
      });
    }
    if (!isAddressEqual(to, ctx.destination))
      refuse(step, `it sends funds to ${to}, not to --to ${ctx.destination}`);
  };
  for (const step of steps) {
    step.notes = [];
    if (step.skipped) continue;
    const call = step.call;
    if (step.via === "safe") {
      const tx = step.safeTx!;
      if (tx.operation === 1) {
        if (!ctx.multiSendVerified) refuse(step, "MultiSendCallOnly is not verified on this chain");
        const inner = decodeMultiSend(tx.data) ?? [];
        const parts = inner.map((c) =>
          isAddressEqual(c.to, ctx.account) ? describeSelfCall(c, ctx) : undefined,
        );
        if (parts.length === 0 || parts.some((p) => p === undefined))
          refuse(step, "the batch does more than revoke");
        step.title = `In one transaction: ${parts.join("; ")}`;
        continue;
      }
      if (isAddressEqual(call.to, ctx.account)) {
        const what = describeSelfCall(call, ctx);
        if (!what) refuse(step, "it changes the account's configuration in a way the exit never does");
        step.title = what!.charAt(0).toUpperCase() + what!.slice(1);
        continue;
      }
      if (call.data === "0x") {
        toDestination(step, call.to);
        step.title = `Send ${formatEther(call.value)} ETH to ${call.to}`;
        continue;
      }
      if (call.value !== 0n) refuse(step, "it sends ETH along with a contract call");
      const d = decodeKnown(call.data);
      if (d?.functionName === "transfer") {
        toDestination(step, d.args[0] as Address);
        step.title = `Transfer ${String(d.args[1])} units of token ${call.to} to ${String(d.args[0])}`;
        continue;
      }
      if (d?.functionName === "transferFrom") {
        if (!isAddressEqual(d.args[1] as Address, ctx.account))
          refuse(step, "it pulls tokens somewhere other than the account");
        step.title = `Pull ${String(d.args[2])} units of token ${call.to} from ${String(d.args[0])} into the account`;
        continue;
      }
      if (d?.functionName === "cancel") {
        if (!ctx.contracts.streams || !isAddressEqual(call.to, ctx.contracts.streams)) {
          refuse(
            step,
            `cancel() on ${call.to}, which is not the configured PaymentStreams (pass --deployments)`,
          );
        }
        step.title = `Cancel stream #${String(d.args[0])} (the payee keeps what it earned; the rest returns to the account)`;
        continue;
      }
      refuse(step, `unexpected Safe transaction to ${call.to}`);
    }
    // Public steps: only the recovery functions of the configured Agent Bank contracts, no value.
    if (call.value !== 0n) refuse(step, "a public step sends ETH");
    const d = decodeKnown(call.data);
    const expect = (contract: Address | undefined, name: string): void => {
      if (!contract || !isAddressEqual(call.to, contract)) {
        refuse(
          step,
          `${d?.functionName ?? "call"} on ${call.to}, which is not the configured ${name} (pass --deployments)`,
        );
      }
    };
    switch (d?.functionName) {
      case "refund":
        expect(ctx.contracts.escrow, "AgentEscrow");
        step.title = `Refund escrow #${String(d.args[0])} to its payer (the account)`;
        break;
      case "releaseByValidation":
        expect(ctx.contracts.escrow, "AgentEscrow");
        step.title = `Release escrow #${String(d.args[0])} to its payee (the account)`;
        break;
      case "settle":
        expect(ctx.contracts.streams, "PaymentStreams");
        step.title = `Settle stream #${String(d.args[0])} to its payee (the account)`;
        break;
      case "withdraw":
        expect(ctx.contracts.vaults, "TimeLockVaults");
        step.title = `Return ${String(d.args[1])} units from vault #${String(d.args[0])} to its account`;
        break;
      case "withdrawWithSignature":
        expect(ctx.contracts.vaults, "TimeLockVaults");
        step.title = `Early-withdraw ${String(d.args[1])} units from vault #${String(d.args[0])} to its account (owner-signed)`;
        break;
      default:
        refuse(step, `unexpected public call to ${call.to}`);
    }
  }
}
