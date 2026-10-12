import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  parseEventLogs,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { safeAbi, timeLockVaultsAbi } from "./abis/index";
import { ExitToolError } from "./errors";
import type { Plan } from "./plan";
import { describeError } from "./revert";
import {
  encodeExecTransaction,
  hashSafeTx,
  normalizeEcdsaSignature,
  packSignatures,
  safeTxForCall,
  safeTxTypedData,
  type Call,
  type OwnerSignature,
  type SafeTx,
} from "./safe";
import { liveReader, resolveAmount, type MaterializedStep } from "./simulate";
import {
  earlyWithdrawalTypedData,
  readVaultDomain,
  verifyEarlyWithdrawalDigest,
  type EarlyWithdrawal,
  type VaultDomain,
} from "./vaults";

/** Something that can sign EIP-712 typed data as one address (a local key, a wallet). */
export interface TypedDataSigner {
  address: Address;
  signTypedData(typedData: {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

/** Something that can send a transaction and pays its gas (the owner EOA, or any funded wallet). */
export interface TransactionSender {
  address: Address;
  sendTransaction(tx: { to: Address; data: Hex; value: bigint; gas: bigint }): Promise<Hex>;
}

export type ProgressEvent =
  | { type: "start"; index: number; total: number; title: string }
  | { type: "skipped"; index: number; title: string; reason: string }
  | { type: "sent"; index: number; title: string; hash: Hex }
  | { type: "confirmed"; index: number; title: string; hash: Hex; gasUsed: bigint; blockNumber: bigint };

export interface ExecutedStep {
  index: number;
  id: string;
  title: string;
  status: "confirmed" | "skipped";
  hash?: Hex;
  gasUsed?: bigint;
  blockNumber?: bigint;
  amount?: bigint;
  safeTxHash?: Hex;
  reason?: string;
}

export interface ExecuteOptions {
  chainId: number;
  account: Address;
  owners: readonly Address[];
  threshold: bigint;
  /** Local keys that sign SafeTxs and early withdrawals. */
  signers: readonly TypedDataSigner[];
  /** Signatures collected elsewhere (hardware wallets, other owners), matched to payloads by hash. */
  signatures?: readonly Hex[];
  sender: TransactionSender;
  /** Validity of early-withdrawal signatures created during execution, in seconds. */
  vaultSignatureTtl?: bigint;
  onProgress?: (event: ProgressEvent) => void;
  receiptTimeoutMs?: number;
}

interface Prepared {
  to: Address;
  data: Hex;
  value: bigint;
  safeTxHash?: Hex;
}

/** Collects at least `threshold` owner signatures for a SafeTx from local signers and supplied signatures. */
async function collectSafeSignatures(tx: SafeTx, options: ExecuteOptions): Promise<Hex> {
  const typedData = safeTxTypedData(options.chainId, options.account, tx);
  const collected = new Map<string, OwnerSignature>();
  const isOwner = (a: Address): boolean => options.owners.some((o) => isAddressEqual(o, a));
  for (const signer of options.signers) {
    if (!isOwner(signer.address) || collected.has(signer.address.toLowerCase())) continue;
    if (BigInt(collected.size) >= options.threshold) break;
    const signature = await signer.signTypedData(typedData as never);
    collected.set(signer.address.toLowerCase(), { signer: signer.address, kind: "ecdsa", data: signature });
  }
  for (const raw of options.signatures ?? []) {
    if (BigInt(collected.size) >= options.threshold) break;
    let signature: Hex;
    try {
      signature = normalizeEcdsaSignature(raw);
    } catch {
      continue;
    }
    const recovered = await recoverTypedDataAddress({ ...typedData, signature }).catch(() => undefined);
    if (!recovered || !isOwner(recovered) || collected.has(recovered.toLowerCase())) continue;
    collected.set(recovered.toLowerCase(), { signer: recovered, kind: "ecdsa", data: signature });
  }
  if (BigInt(collected.size) < options.threshold) {
    throw new ExitToolError(
      "signature_mismatch",
      `Safe transaction ${hashSafeTx(options.chainId, options.account, tx)} (nonce ${tx.nonce}) needs ${options.threshold} owner signature(s); found ${collected.size}.`,
      { hint: "Sign the SafeTx payloads printed by --signer-only and pass each signature with --signature." },
    );
  }
  return packSignatures([...collected.values()]);
}

/** Signs (or finds a supplied signature for) an early-withdrawal message by the vault owner. */
async function vaultOwnerSignature(
  domain: VaultDomain,
  message: EarlyWithdrawal,
  owner: Address,
  options: ExecuteOptions,
): Promise<Hex> {
  const typedData = earlyWithdrawalTypedData(domain, message);
  const local = options.signers.find((s) => isAddressEqual(s.address, owner));
  if (local) return local.signTypedData(typedData as never);
  for (const raw of options.signatures ?? []) {
    let signature: Hex;
    try {
      signature = normalizeEcdsaSignature(raw);
    } catch {
      continue;
    }
    const recovered = await recoverTypedDataAddress({ ...typedData, signature }).catch(() => undefined);
    if (recovered && isAddressEqual(recovered, owner)) return signature;
  }
  throw new ExitToolError(
    "signature_mismatch",
    `Early withdrawal from vault #${message.vaultId} needs a signature from its owner ${owner}.`,
  );
}

/** Pre-flight (eth_call + gas estimate), send, wait, verify. */
async function broadcast(
  client: PublicClient,
  prepared: Prepared,
  step: { index: number; title: string },
  options: ExecuteOptions,
): Promise<{ hash: Hex; gasUsed: bigint; blockNumber: bigint }> {
  const request = {
    account: options.sender.address,
    to: prepared.to,
    data: prepared.data,
    value: prepared.value,
  };
  try {
    await client.call(request);
  } catch (err) {
    throw new ExitToolError(
      "execution_failed",
      `Step ${step.index} (${step.title}) would fail: ${describeError(err)}. Nothing was sent for this step.`,
      { cause: err },
    );
  }
  let gas: bigint;
  try {
    gas = ((await client.estimateGas(request)) * 125n) / 100n;
  } catch (err) {
    throw new ExitToolError(
      "execution_failed",
      `Step ${step.index}: gas estimation failed: ${describeError(err)}`,
      { cause: err },
    );
  }
  let hash: Hex;
  try {
    hash = await options.sender.sendTransaction({
      to: prepared.to,
      data: prepared.data,
      value: prepared.value,
      gas,
    });
  } catch (err) {
    const message = describeError(err);
    const code = /insufficient funds/i.test(message) ? "insufficient_gas_funds" : "execution_failed";
    throw new ExitToolError(code, `Step ${step.index} (${step.title}) could not be sent: ${message}`, {
      cause: err,
      ...(code === "insufficient_gas_funds"
        ? {
            hint: `The sender ${options.sender.address} pays the gas: send it a little ETH and run the command again.`,
          }
        : {}),
    });
  }
  options.onProgress?.({ type: "sent", index: step.index, title: step.title, hash });
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: options.receiptTimeoutMs ?? 180_000,
  });
  if (receipt.status !== "success") {
    throw new ExitToolError(
      "execution_failed",
      `Step ${step.index} (${step.title}) reverted on-chain in transaction ${hash}.`,
    );
  }
  if (prepared.safeTxHash) {
    const events = parseEventLogs({ abi: safeAbi, logs: receipt.logs, strict: false }).filter((l) =>
      isAddressEqual(l.address, options.account),
    );
    const failure = events.find((e) => e.eventName === "ExecutionFailure");
    const success = events.find(
      (e) =>
        e.eventName === "ExecutionSuccess" &&
        (e.args as { txHash?: Hex } | undefined)?.txHash?.toLowerCase() ===
          prepared.safeTxHash!.toLowerCase(),
    );
    if (failure || !success) {
      throw new ExitToolError(
        "execution_failed",
        `Step ${step.index}: the Safe did not report ExecutionSuccess in ${hash}.`,
      );
    }
  }
  return { hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
}

/**
 * Executes a plan step by step against the live chain. Each step's amount is read right before it
 * runs (so "all" includes what earlier steps returned to the account), then it is signed, checked
 * with eth_call, sent, and confirmed before the next one starts.
 */
export async function executePlan(
  client: PublicClient,
  plan: Plan,
  options: ExecuteOptions,
): Promise<ExecutedStep[]> {
  const out: ExecutedStep[] = [];
  const reader = liveReader(client);
  const total = plan.steps.length;
  for (const [i, step] of plan.steps.entries()) {
    const index = i + 1;
    options.onProgress?.({ type: "start", index, total, title: step.title });
    const amount = await resolveAmount(step.amount, reader);
    if (amount !== undefined && amount === 0n) {
      options.onProgress?.({ type: "skipped", index, title: step.title, reason: "nothing to move" });
      out.push({ index, id: step.id, title: step.title, status: "skipped", reason: "nothing to move" });
      continue;
    }
    let call: Call;
    if (step.vaultSignature) {
      const req = step.vaultSignature;
      const [vault, domain, latest] = await Promise.all([
        client.readContract({
          address: req.vaults,
          abi: timeLockVaultsAbi,
          functionName: "getVault",
          args: [req.id],
        }),
        readVaultDomain(client, req.vaults),
        client.getBlock({ blockTag: "latest" }),
      ]);
      const message: EarlyWithdrawal = {
        vaultId: req.id,
        amount: amount ?? 0n,
        nonce: BigInt(vault.nonce),
        deadline: latest.timestamp + (options.vaultSignatureTtl ?? 3600n),
      };
      await verifyEarlyWithdrawalDigest(client, domain, message);
      const signature = await vaultOwnerSignature(domain, message, getAddress(vault.owner), options);
      call = step.build(message.amount, { signature, deadline: message.deadline });
    } else {
      call = step.build(amount ?? 0n);
    }
    let prepared: Prepared;
    if (step.via === "safe") {
      const nonce = await client.readContract({
        address: options.account,
        abi: safeAbi,
        functionName: "nonce",
      });
      const tx = safeTxForCall(call, nonce);
      const signatures = await collectSafeSignatures(tx, options);
      prepared = {
        to: options.account,
        data: encodeExecTransaction(tx, signatures),
        value: 0n,
        safeTxHash: hashSafeTx(options.chainId, options.account, tx),
      };
    } else {
      prepared = { to: call.to, data: call.data, value: call.value };
    }
    const result = await broadcast(client, prepared, { index, title: step.title }, options);
    options.onProgress?.({ type: "confirmed", index, title: step.title, ...result });
    out.push({
      index,
      id: step.id,
      title: step.title,
      status: "confirmed",
      ...result,
      ...(amount !== undefined ? { amount } : {}),
      ...(prepared.safeTxHash ? { safeTxHash: prepared.safeTxHash } : {}),
    });
  }
  return out;
}

/**
 * Executes already-materialized steps (a signer-only plan file) with the signatures collected for
 * them. Safe steps whose nonce was already used are skipped (re-running a partly executed plan is
 * safe); anything else that no longer matches the chain fails its pre-flight check before sending.
 */
export async function executeMaterialized(
  client: PublicClient,
  steps: readonly MaterializedStep[],
  options: ExecuteOptions,
): Promise<ExecutedStep[]> {
  const out: ExecutedStep[] = [];
  const active = steps.filter((s) => !s.skipped);
  for (const step of active) {
    options.onProgress?.({ type: "start", index: step.index, total: steps.length, title: step.title });
    let prepared: Prepared;
    if (step.via === "safe") {
      const tx = step.safeTx;
      if (!tx) throw new ExitToolError("plan_mismatch", `Plan step ${step.index} has no SafeTx.`);
      const nonce = await client.readContract({
        address: options.account,
        abi: safeAbi,
        functionName: "nonce",
      });
      if (nonce > tx.nonce) {
        const reason = `Safe nonce ${tx.nonce} already used (the step ran before, or another transaction replaced it)`;
        options.onProgress?.({ type: "skipped", index: step.index, title: step.title, reason });
        out.push({ index: step.index, id: step.id, title: step.title, status: "skipped", reason });
        continue;
      }
      if (nonce < tx.nonce) {
        throw new ExitToolError(
          "plan_mismatch",
          `Step ${step.index} uses Safe nonce ${tx.nonce} but the Safe is at nonce ${nonce}: run the earlier steps first.`,
        );
      }
      const signatures = await collectSafeSignatures(tx, options);
      prepared = {
        to: options.account,
        data: encodeExecTransaction(tx, signatures),
        value: 0n,
        safeTxHash: hashSafeTx(options.chainId, options.account, tx),
      };
    } else if (step.vault) {
      const signature = await vaultOwnerSignature(
        step.vault.domain,
        step.vault.message,
        step.vault.owner,
        options,
      );
      prepared = {
        to: step.call.to,
        data: encodeFunctionData({
          abi: timeLockVaultsAbi,
          functionName: "withdrawWithSignature",
          args: [
            step.vault.message.vaultId,
            step.vault.message.amount,
            step.vault.message.deadline,
            signature,
          ],
        }),
        value: 0n,
      };
    } else {
      prepared = { to: step.call.to, data: step.call.data, value: step.call.value };
    }
    const result = await broadcast(client, prepared, step, options);
    options.onProgress?.({ type: "confirmed", index: step.index, title: step.title, ...result });
    out.push({
      index: step.index,
      id: step.id,
      title: step.title,
      status: "confirmed",
      ...result,
      ...(step.amount !== undefined ? { amount: step.amount } : {}),
      ...(prepared.safeTxHash ? { safeTxHash: prepared.safeTxHash } : {}),
    });
  }
  return out;
}
