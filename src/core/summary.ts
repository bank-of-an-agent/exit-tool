import { isAddressEqual, type Address } from "viem";
import { formatTimestamp } from "./describe";
import type { AccountReport } from "./inspect";

/** Value the owner can bring back to their destination now. */
export interface RecoveryItem {
  kind:
    | "balance"
    | "escrow_refund"
    | "escrow_release"
    | "stream_cancel"
    | "stream_settle"
    | "vault_unlocked"
    | "vault_early"
    | "spend_key";
  /** Token address, or "ETH". */
  token: Address | "ETH";
  amount: bigint;
  label: string;
  /** Amount changes with time (stream accrual). */
  approximate?: boolean;
}

/** Value that is the account's (or may become it) but cannot be recovered right now. */
export interface PendingItem {
  kind:
    | "escrow_locked"
    | "escrow_disputed"
    | "escrow_incoming"
    | "stream_incoming"
    | "vault_locked"
    | "spend_key_excess";
  token: Address | "ETH";
  amount: bigint;
  label: string;
  /** Unix time from which it becomes recoverable, if known. */
  availableAt?: bigint;
}

export interface RecoverySummary {
  now: RecoveryItem[];
  pending: PendingItem[];
  /** Totals of `now` per token ("ETH" or lowercase token address). */
  totals: Map<string, bigint>;
}

/**
 * Plain accounting of what an exit would recover now and what stays behind (and why), from an
 * inspection report. Amounts are as of the inspected block.
 */
export function summarizeRecovery(report: AccountReport): RecoverySummary {
  const now: RecoveryItem[] = [];
  const pending: PendingItem[] = [];
  const signer = report.signer?.address;
  const isOwnerKey = (a: Address): boolean =>
    signer ? isAddressEqual(a, signer) : report.safe.owners.some((o) => isAddressEqual(o, a));

  if (report.eth > 0n)
    now.push({ kind: "balance", token: "ETH", amount: report.eth, label: "held by the account" });
  for (const [key, balance] of Object.entries(report.balances)) {
    if (balance > 0n) {
      now.push({
        kind: "balance",
        token: report.tokens[key]!.address,
        amount: balance,
        label: "held by the account",
      });
    }
  }

  for (const e of report.escrows) {
    const open = e.status === "Active" || e.status === "Disputed";
    if (!open) continue;
    if (e.role === "payer") {
      if (e.refundableNow) {
        now.push({
          kind: "escrow_refund",
          token: e.token,
          amount: e.amount,
          label: `escrow #${e.id} (expired; anyone can trigger the refund)`,
        });
      } else if (e.status === "Disputed") {
        pending.push({
          kind: "escrow_disputed",
          token: e.token,
          amount: e.amount,
          label: `escrow #${e.id} is disputed: the arbiter decides; if it stays silent, anyone can refund you from ${formatTimestamp(e.refundableAt)}`,
          availableAt: e.refundableAt,
        });
      } else {
        pending.push({
          kind: "escrow_locked",
          token: e.token,
          amount: e.amount,
          label: `escrow #${e.id} to ${e.payee} has not expired: refundable from ${formatTimestamp(e.refundableAt)} (or earlier if the payee refunds)`,
          availableAt: e.refundableAt,
        });
      }
    } else if (e.releasableNow) {
      now.push({
        kind: "escrow_release",
        token: e.token,
        amount: e.amount,
        label: `incoming escrow #${e.id} (validator approved; anyone can release it to you)`,
      });
    } else {
      pending.push({
        kind: "escrow_incoming",
        token: e.token,
        amount: e.amount,
        label: `incoming escrow #${e.id} from ${e.payer}: paid to you only when the payer, arbiter or validator releases it`,
      });
    }
  }

  for (const s of report.streams) {
    if (s.role === "payer") {
      if (!s.canceled && s.refundIfCanceled > 0n) {
        now.push({
          kind: "stream_cancel",
          token: s.token,
          amount: s.refundIfCanceled,
          approximate: true,
          label: `cancel stream #${s.id} to ${s.payee} (the payee keeps what it has earned; the refund shrinks as the stream accrues)`,
        });
      }
    } else {
      if (s.settleable > 0n) {
        now.push({
          kind: "stream_settle",
          token: s.token,
          amount: s.settleable,
          approximate: true,
          label: `earned from incoming stream #${s.id} (anyone can settle it to you)`,
        });
      }
      const remaining = s.canceled ? 0n : s.deposit - s.accrued;
      if (remaining > 0n) {
        pending.push({
          kind: "stream_incoming",
          token: s.token,
          amount: remaining,
          label: `incoming stream #${s.id} from ${s.payer} keeps paying you as it accrues`,
        });
      }
    }
  }

  for (const v of report.vaults) {
    if (v.balance === 0n) continue;
    if (v.unlocked) {
      now.push({
        kind: "vault_unlocked",
        token: v.token,
        amount: v.balance,
        label: `vault #${v.id} (unlocked; anyone can return it to the account)`,
      });
    } else if (isOwnerKey(v.owner)) {
      now.push({
        kind: "vault_early",
        token: v.token,
        amount: v.balance,
        label: `vault #${v.id} (locked; early withdrawal back to the account with your owner signature)`,
      });
    } else {
      pending.push({
        kind: "vault_locked",
        token: v.token,
        amount: v.balance,
        label: `vault #${v.id} is locked until ${formatTimestamp(v.unlockAt)} and owned by ${v.owner}: after that anyone can return it to the account`,
        availableAt: v.unlockAt,
      });
    }
  }

  for (const k of report.spendKeys) {
    if (k.sweepable > 0n) {
      now.push({
        kind: "spend_key",
        token: k.token,
        amount: k.sweepable,
        label: `float of agent spend key ${k.address} (pulled back with its permit allowance)`,
      });
    }
    if (k.balance > k.allowance) {
      pending.push({
        kind: "spend_key_excess",
        token: k.token,
        amount: k.balance - k.allowance,
        label: `part of spend key ${k.address}'s float above its allowance to the account: only the agent runtime holding that key can move it`,
      });
    }
  }

  const totals = new Map<string, bigint>();
  for (const item of now) {
    const key = item.token === "ETH" ? "ETH" : item.token.toLowerCase();
    totals.set(key, (totals.get(key) ?? 0n) + item.amount);
  }
  return { now, pending, totals };
}
