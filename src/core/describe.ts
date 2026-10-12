import { decodeFunctionData, formatEther, type Abi, type Address, type Hex } from "viem";
import {
  agentEscrowAbi,
  erc20Abi,
  ownableValidatorAbi,
  paymentStreamsAbi,
  safeAbi,
  timeLockVaultsAbi,
} from "./abis/index";
import { decodeMultiSend, MULTISEND_CALL_ONLY } from "./multisend";
import type { Call } from "./safe";

const CALL_ABI = [
  ...safeAbi,
  ...erc20Abi,
  ...agentEscrowAbi,
  ...paymentStreamsAbi,
  ...timeLockVaultsAbi,
  ...ownableValidatorAbi,
] as Abi;

function formatArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string")
    return value.length > 70 ? `${value.slice(0, 66)}…(${(value.length - 2) / 2} bytes)` : value;
  if (Array.isArray(value)) return `[${value.map(formatArg).join(", ")}]`;
  return String(value);
}

/** `transfer(0xabc…, 1000000)`-style description of a call, or the raw selector when unknown. */
export function describeCall(call: Call): string {
  if (call.data === "0x") return call.value > 0n ? `send ${formatEther(call.value)} ETH` : "empty call";
  if (call.to.toLowerCase() === MULTISEND_CALL_ONLY.toLowerCase()) {
    const inner = decodeMultiSend(call.data);
    if (inner) return `multiSend[${inner.map((c) => `${c.to}.${describeCall(c)}`).join("; ")}]`;
  }
  try {
    const decoded = decodeFunctionData({ abi: CALL_ABI, data: call.data });
    const args = (decoded.args ?? []).map(formatArg).join(", ");
    return `${decoded.functionName}(${args})${call.value > 0n ? ` + ${formatEther(call.value)} ETH` : ""}`;
  } catch {
    return `call ${call.data.slice(0, 10)} (unknown function)`;
  }
}

/** UTC timestamp for unix seconds ("2026-10-11 20:01:28 UTC"). */
export function formatTimestamp(seconds: bigint): string {
  if (seconds <= 0n) return "-";
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms > 8.64e15) return `unix ${seconds}`;
  return `${new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "")} UTC`;
}

/** Short address for tables ("0x1234…abcd"). */
export function shortAddress(address: Address | Hex): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
