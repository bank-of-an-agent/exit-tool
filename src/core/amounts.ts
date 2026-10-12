import { formatUnits } from "viem";
import { ExitToolError } from "./errors";

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a human decimal amount ("12", "12.5", "0.000001") into integer minor units.
 * Strict: no rounding, no exponents, no signs, no floats. More fractional digits than the token has
 * is an error (silently rounding money is a bug).
 */
export function parseAmount(input: string, decimals: number): bigint {
  const text = input.trim().replaceAll("_", "");
  const match = DECIMAL.exec(text);
  if (!match) {
    throw new ExitToolError(
      "invalid_argument",
      `Invalid amount "${input}": use a plain decimal such as 12 or 12.5 (or "all").`,
    );
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new ExitToolError(
      "invalid_argument",
      `Invalid amount "${input}": this token has ${decimals} decimals, the amount has ${fraction.length}.`,
    );
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units === 0n)
    throw new ExitToolError("invalid_argument", `Invalid amount "${input}": must be greater than 0.`);
  return units;
}

/** Formats integer minor units as a decimal string ("1234.5"). */
export function formatAmount(units: bigint, decimals: number): string {
  return formatUnits(units, decimals);
}

/** Formats an amount with its symbol ("1234.5 USDC"). */
export function formatToken(units: bigint, token: { decimals: number; symbol: string }): string {
  return `${formatAmount(units, token.decimals)} ${token.symbol}`;
}

/** Sums a list of bigints. */
export function sum(values: readonly bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}
