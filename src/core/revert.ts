import { BaseError, decodeErrorResult, isHex, type Hex } from "viem";
import { knownErrorsAbi, SAFE_ERROR_CODES } from "./abis/index";

const PANIC_REASONS: Readonly<Record<string, string>> = {
  "1": "assertion failed",
  "17": "arithmetic overflow or underflow",
  "18": "division by zero",
  "33": "invalid enum value",
  "34": "invalid storage byte array",
  "49": "pop on empty array",
  "50": "array index out of bounds",
  "65": "out of memory",
  "81": "call to an uninitialized function",
};

function formatArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(formatArg).join(", ")}]`;
  return String(value);
}

/** Human description of raw revert data (`0x` → "reverted without a reason"). */
export function describeRevertData(data: Hex | undefined): string {
  if (data === undefined) return "reverted (no revert data available)";
  if (data === "0x") return "reverted without a reason";
  try {
    const decoded = decodeErrorResult({ abi: knownErrorsAbi, data });
    if (decoded.errorName === "Error") {
      const message = String(decoded.args?.[0] ?? "");
      const safe = SAFE_ERROR_CODES[message];
      return safe ? `${message}: ${safe}` : message;
    }
    if (decoded.errorName === "Panic") {
      const code = String(decoded.args?.[0] ?? "");
      return `panic ${code}${PANIC_REASONS[code] ? ` (${PANIC_REASONS[code]})` : ""}`;
    }
    const args = (decoded.args ?? []).map(formatArg).join(", ");
    return `${decoded.errorName}(${args})`;
  } catch {
    return `reverted with unknown error data ${data.length > 74 ? `${data.slice(0, 74)}…` : data}`;
  }
}

/** Finds raw revert data anywhere in a viem error's cause chain. */
export function extractRevertData(err: unknown): Hex | undefined {
  let found: Hex | undefined;
  const visit = (e: unknown, depth: number): void => {
    if (found !== undefined || depth > 12 || e === null || typeof e !== "object") return;
    const data = (e as { data?: unknown }).data;
    if (typeof data === "string" && isHex(data)) {
      found = data;
      return;
    }
    if (data && typeof data === "object") {
      const nested = (data as { data?: unknown }).data;
      if (typeof nested === "string" && isHex(nested)) {
        found = nested;
        return;
      }
    }
    visit((e as { cause?: unknown }).cause, depth + 1);
  };
  visit(err, 0);
  return found;
}

/** One-line description of any error, preferring decoded revert reasons over transport noise. */
export function describeError(err: unknown): string {
  const data = extractRevertData(err);
  if (data !== undefined && data !== "0x") return describeRevertData(data);
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}
