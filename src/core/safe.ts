import {
  concatHex,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddressEqual,
  numberToHex,
  pad,
  recoverTypedDataAddress,
  size,
  slice,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { safeAbi } from "./abis/index";
import {
  FALLBACK_HANDLER_SLOT,
  GUARD_SLOT,
  OPERATION_CALL,
  SENTINEL,
  SINGLETON_SLOT,
  ZERO_ADDRESS,
} from "./constants";
import { ExitToolError } from "./errors";

/** A call made by the Safe (inner call of a Safe transaction) or sent directly by an EOA. */
export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

/** Safe v1.4.1 transaction (EIP-712 `SafeTx`). */
export interface SafeTx {
  to: Address;
  value: bigint;
  data: Hex;
  operation: number;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

export const SAFE_TX_TYPES = {
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
} as const;

/**
 * The SafeTx for one call: no gas refund (safeTxGas = baseGas = gasPrice = 0). With these values the
 * Safe reverts the whole transaction if the inner call fails (GS013) and never pays anyone from its
 * own balance: the executor pays the gas. The operation is CALL, except for the atomic revoke batch,
 * a DELEGATECALL to the canonical MultiSendCallOnly (which itself can only make CALLs).
 */
export function safeTxForCall(call: Call, nonce: bigint, operation: number = OPERATION_CALL): SafeTx {
  return {
    to: getAddress(call.to),
    value: call.value,
    data: call.data,
    operation,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  };
}

/** EIP-712 typed data of a SafeTx (domain: chainId + Safe address, as in Safe ≥ 1.3.0). */
export function safeTxTypedData(chainId: number, safe: Address, tx: SafeTx) {
  return {
    domain: { chainId, verifyingContract: getAddress(safe) },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx" as const,
    message: tx,
  };
}

/** The SafeTx hash the owner signs (equals `Safe.getTransactionHash(...)`). */
export function hashSafeTx(chainId: number, safe: Address, tx: SafeTx): Hex {
  return hashTypedData(safeTxTypedData(chainId, safe, tx));
}

/**
 * The same typed data as JSON for `eth_signTypedData_v4`, `cast wallet sign --data` and hardware
 * wallets: explicit `EIP712Domain`, integers as decimal strings.
 */
export function safeTxTypedDataJson(chainId: number, safe: Address, tx: SafeTx) {
  return {
    types: {
      EIP712Domain: [
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      SafeTx: SAFE_TX_TYPES.SafeTx,
    },
    primaryType: "SafeTx",
    domain: { chainId, verifyingContract: getAddress(safe) },
    message: {
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
    },
  };
}

/** Calldata of `execTransaction` for a signed SafeTx. */
export function encodeExecTransaction(tx: SafeTx, signatures: Hex): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "execTransaction",
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      signatures,
    ],
  });
}

/** One owner's signature over a SafeTx. */
export type OwnerSignature =
  | { signer: Address; kind: "ecdsa"; data: Hex }
  | { signer: Address; kind: "contract"; data: Hex }
  | { signer: Address; kind: "prevalidated" };

/**
 * Normalises a 65-byte ECDSA signature over an EIP-712 hash to the Safe's `v ∈ {27, 28}` form
 * (some wallets return `v ∈ {0, 1}`). `eth_sign`-style signatures (v > 30) are not accepted: the
 * exit tool always signs typed data.
 */
export function normalizeEcdsaSignature(signature: Hex): Hex {
  if (size(signature) !== 65) {
    throw new ExitToolError("invalid_argument", "A signature must be 65 bytes (r, s, v) in hex.");
  }
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v === 27 || v === 28) return signature;
  if (v === 0 || v === 1) return concatHex([slice(signature, 0, 64), numberToHex(v + 27, { size: 1 })]);
  throw new ExitToolError(
    "invalid_argument",
    `Unsupported signature v=${v}: sign the EIP-712 typed data (eth_signTypedData_v4), not a personal message.`,
  );
}

/**
 * Packs owner signatures in the Safe format: sorted by owner address, 65-byte static parts, then the
 * dynamic parts of contract signatures.
 */
export function packSignatures(signatures: readonly OwnerSignature[]): Hex {
  const sorted = [...signatures].sort((a, b) => {
    const x = BigInt(a.signer);
    const y = BigInt(b.signer);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  for (let i = 1; i < sorted.length; i++) {
    if (isAddressEqual(sorted[i - 1]!.signer, sorted[i]!.signer)) {
      throw new ExitToolError("invalid_argument", `Two signatures from the same owner ${sorted[i]!.signer}.`);
    }
  }
  const staticParts: Hex[] = [];
  const dynamicParts: Hex[] = [];
  let dynamicOffset = 65 * sorted.length;
  for (const sig of sorted) {
    if (sig.kind === "ecdsa") {
      staticParts.push(normalizeEcdsaSignature(sig.data));
    } else if (sig.kind === "prevalidated") {
      staticParts.push(concatHex([pad(sig.signer, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]));
    } else {
      staticParts.push(
        concatHex([pad(sig.signer, { size: 32 }), numberToHex(dynamicOffset, { size: 32 }), "0x00"]),
      );
      const part = concatHex([numberToHex(size(sig.data), { size: 32 }), sig.data]);
      dynamicParts.push(part);
      dynamicOffset += size(part);
    }
  }
  return concatHex([...staticParts, ...dynamicParts]);
}

/** Recovers the signer of an ECDSA signature over a SafeTx. */
export async function recoverSafeTxSigner(
  chainId: number,
  safe: Address,
  tx: SafeTx,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    ...safeTxTypedData(chainId, safe, tx),
    signature: normalizeEcdsaSignature(signature),
  });
}

/** On-chain configuration of a Safe account. */
export interface SafeState {
  address: Address;
  deployed: boolean;
  version?: string;
  singleton?: Address;
  owners: Address[];
  threshold: bigint;
  nonce: bigint;
  modules: Address[];
  fallbackHandler: Address;
  guard: Address;
}

function slotToAddress(word: Hex | undefined): Address {
  if (word === undefined || word === "0x") return ZERO_ADDRESS;
  return getAddress(slice(pad(word, { size: 32 }), 12, 32));
}

/**
 * Every enabled Safe module, following `getModulesPaginated` to the end. Handles both the v1.4.1
 * cursor (last module of the page) and the v1.3.0 cursor (first module of the next page).
 */
export async function listModules(client: PublicClient, safe: Address, pageSize = 50n): Promise<Address[]> {
  const out: Address[] = [];
  const seen = new Set<string>();
  const add = (m: Address): void => {
    const key = m.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(getAddress(m));
  };
  let start: Address = SENTINEL;
  for (let page = 0; page < 200; page++) {
    const [array, next] = await client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: "getModulesPaginated",
      args: [start, pageSize],
    });
    array.forEach(add);
    if (array.length === 0 || isAddressEqual(next, SENTINEL) || isAddressEqual(next, ZERO_ADDRESS))
      return out;
    add(next);
    start = next;
  }
  throw new ExitToolError(
    "rpc_error",
    `Safe ${safe} reports more than 10,000 modules; refusing to continue.`,
  );
}

/** Reads the Safe's configuration. `deployed: false` when there is no code at the address. */
export async function readSafeState(client: PublicClient, address: Address): Promise<SafeState> {
  const safe = getAddress(address);
  const code = await client.getCode({ address: safe });
  if (code === undefined || code === "0x") {
    return {
      address: safe,
      deployed: false,
      owners: [],
      threshold: 0n,
      nonce: 0n,
      modules: [],
      fallbackHandler: ZERO_ADDRESS,
      guard: ZERO_ADDRESS,
    };
  }
  let owners: readonly Address[];
  let threshold: bigint;
  let nonce: bigint;
  try {
    [owners, threshold, nonce] = await Promise.all([
      client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
      client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
      client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
    ]);
  } catch (cause) {
    throw new ExitToolError("not_a_safe", `${safe} has code but does not behave like a Safe account.`, {
      cause,
    });
  }
  const [version, singletonWord, handlerWord, guardWord, modules] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "VERSION" }).catch(() => undefined),
    client.getStorageAt({ address: safe, slot: SINGLETON_SLOT }),
    client.getStorageAt({ address: safe, slot: FALLBACK_HANDLER_SLOT }),
    client.getStorageAt({ address: safe, slot: GUARD_SLOT }),
    listModules(client, safe),
  ]);
  const state: SafeState = {
    address: safe,
    deployed: true,
    singleton: slotToAddress(singletonWord),
    owners: owners.map((o) => getAddress(o)),
    threshold,
    nonce,
    modules,
    fallbackHandler: slotToAddress(handlerWord),
    guard: slotToAddress(guardWord),
  };
  if (version !== undefined) state.version = version;
  return state;
}
