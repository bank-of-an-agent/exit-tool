import { getAddress, isAddressEqual, toFunctionSelector, type Address, type Hex } from "viem";
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
