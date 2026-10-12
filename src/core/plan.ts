import { encodeFunctionData, getAddress, isAddressEqual, type Address, type Hex } from "viem";
import { agentEscrowAbi, erc20Abi, paymentStreamsAbi, safeAbi, timeLockVaultsAbi } from "./abis/index";
import { SAFE7579_ADAPTER, SENTINEL, ZERO_ADDRESS } from "./constants";
import { encodeMultiSend, MULTISEND_CALL_ONLY } from "./multisend";
import { formatTimestamp } from "./describe";
import { ExitToolError } from "./errors";
import type { AccountReport } from "./inspect";
import type { Call } from "./safe";

export type CommandName =
  | "withdraw"
  | "disable-modules"
  | "refund-escrows"
  | "cancel-streams"
  | "withdraw-vaults"
  | "sweep-spend-keys"
  | "exit";

/**
 * How a step's amount is determined. Everything except `fixed` is read from the chain right before
 * the step runs (and projected through a simulation of the earlier steps in a dry run), so "all"
 * really means everything that is there when the step executes.
 */
export type AmountSource =
  | { kind: "none" }
  | { kind: "fixed"; amount: bigint }
  | { kind: "erc20Balance"; token: Address; holder: Address }
  | { kind: "ethBalance"; holder: Address }
  | { kind: "sweepable"; token: Address; owner: Address; spender: Address }
  | { kind: "vaultBalance"; vaults: Address; id: bigint };

/** Parameters of an owner-signed early vault withdrawal (EIP-712 `EarlyWithdrawal`). */
export interface VaultSignatureRequest {
  vaults: Address;
  id: bigint;
  owner: Address;
}

export interface PlanStep {
  /** Stable id, e.g. `disable-module:0x…`, `cancel-stream:3`. */
  id: string;
  title: string;
  notes: string[];
  /**
   * `safe`: a Safe transaction (EIP-712 SafeTx signed by the owner, executed through
   * `execTransaction`, which bypasses ERC-4337, ERC-7579 modules and hooks).
   * `direct`: a plain transaction that anyone may send (the contract only ever pays the account).
   */
  via: "safe" | "direct";
  category: "revoke" | "recover" | "withdraw";
  /** Safe steps only: 0 = CALL (default); 1 = DELEGATECALL, used only for the canonical MultiSendCallOnly batch. */
  operation?: 0 | 1;
  amount: AmountSource;
  /** Present for early vault withdrawals: the call needs the vault owner's signature. */
  vaultSignature?: VaultSignatureRequest;
  /** For summaries: what moves where. */
  moves?: { token: Address | "ETH"; from: Address; to: Address };
  /** Inner call (safe) or the transaction itself (direct), given the resolved amount. */
  build: (amount: bigint, signed?: { signature: Hex; deadline: bigint }) => Call;
}

export interface Plan {
  command: CommandName;
  chainId: number;
  account: Address;
  destination?: Address;
  steps: PlanStep[];
  /** Positions the plan leaves alone, with the reason. */
  skipped: string[];
}

const call = (to: Address, data: Hex, value = 0n): Call => ({ to: getAddress(to), data, value });

function selfCall(account: Address, data: Hex): Call {
  return call(account, data);
}

// ---------------------------------------------------------------------------------------------
// Revoking agent and bank powers
// ---------------------------------------------------------------------------------------------

export interface RevokeOptions {
  keepGuard?: boolean;
  /**
   * Remove the modules and reset the fallback handler in ONE Safe transaction (a DELEGATECALL to the
   * canonical MultiSendCallOnly), so nothing can act between the individual removals. Defaults to
   * whether that contract was verified on this chain during inspection.
   */
  batch?: boolean;
  /** Also remove the guardian recovery module (kept by default: it is the owner's safety net). */
  includeRecovery?: boolean;
}

/** Whether the guardian recovery module stays enabled under these options. */
export function recoveryKept(report: AccountReport, options: RevokeOptions = {}): boolean {
  return Boolean(report.recovery) && !options.includeRecovery;
}

/** The note explaining a kept recovery module, if any. */
export function recoveryKeptNote(report: AccountReport, options: RevokeOptions = {}): string[] {
  if (!recoveryKept(report, options)) return [];
  const r = report.recovery!;
  return [
    `guardian recovery module ${r.module} kept (${r.threshold} of ${r.guardians.length} guardians, ${r.delayLabel} delay); pass --include-recovery to remove it`,
  ];
}

/**
 * Removes every Safe module (including the Safe7579 adapter), resets the fallback handler to the
 * plain CompatibilityFallbackHandler and removes the transaction guard. Afterwards only the owners
 * can move funds: no session key, co-signer, executor, hook or ERC-1271 validator is reachable.
 */
export function planRevoke(report: AccountReport, options: RevokeOptions = {}): PlanStep[] {
  const account = report.account;
  const steps: PlanStep[] = [];
  if (!options.keepGuard && !isAddressEqual(report.safe.guard, ZERO_ADDRESS)) {
    steps.push({
      id: `remove-guard:${report.safe.guard}`,
      title: `Remove transaction guard ${report.safe.guard}`,
      notes: ["setGuard(address(0)): a guard can veto owner transactions, so it goes first."],
      via: "safe",
      category: "revoke",
      amount: { kind: "none" },
      build: () =>
        selfCall(
          account,
          encodeFunctionData({ abi: safeAbi, functionName: "setGuard", args: [ZERO_ADDRESS] }),
        ),
    });
  }
  // The Safe keeps modules in a linked list: `disableModule(prev, module)` needs the module that
  // precedes it in the list as it will be at that moment (kept modules stay in place).
  const kept = recoveryKept(report, options) ? report.recovery!.module : undefined;
  const current = [...report.safe.modules];
  const removals: { id: string; title: string; note: string; call: Call }[] = [];
  for (const module of report.safe.modules) {
    if (kept && isAddressEqual(module, kept)) continue;
    const index = current.findIndex((m) => isAddressEqual(m, module));
    const prev = index <= 0 ? SENTINEL : current[index - 1]!;
    current.splice(index, 1);
    const label = report.labels[module.toLowerCase()];
    removals.push({
      id: `disable-module:${module}`,
      title: `Disable module ${module}${label ? ` (${label.split(" (")[0]})` : ""}`,
      note: `disableModule(prev = ${isAddressEqual(prev, SENTINEL) ? "SENTINEL" : prev}, module = ${module})`,
      call: selfCall(
        account,
        encodeFunctionData({ abi: safeAbi, functionName: "disableModule", args: [prev, module] }),
      ),
    });
  }
  // The plain handler when it is verified on this chain; otherwise remove the handler (address(0)).
  const handler = report.compatibilityFallbackHandler;
  if (!isAddressEqual(report.safe.fallbackHandler, handler)) {
    const removing = isAddressEqual(handler, ZERO_ADDRESS);
    removals.push({
      id: `set-fallback-handler:${handler}`,
      title: removing
        ? "Remove the fallback handler (no verified CompatibilityFallbackHandler on this chain)"
        : `Reset the fallback handler to the plain CompatibilityFallbackHandler ${handler}`,
      note: `setFallbackHandler(${handler}), was ${report.safe.fallbackHandler}`,
      call: selfCall(
        account,
        encodeFunctionData({ abi: safeAbi, functionName: "setFallbackHandler", args: [handler] }),
      ),
    });
  }
  const batch = options.batch ?? Boolean(report.multiSendCallOnly);
  if (batch && removals.length > 1) {
    const calls = removals.map((r) => r.call);
    steps.push({
      id: `revoke-batch:${removals.map((r) => r.id.split(":")[1]).join(",")}`,
      title: `Revoke every agent and bank power in one transaction (${removals.length} changes)`,
      notes: [
        ...removals.map((r) => r.title),
        "Atomic: a DELEGATECALL to the canonical Safe MultiSendCallOnly (code hash checked), which can only make these CALLs to the account itself. Nothing can act between the removals.",
      ],
      via: "safe",
      category: "revoke",
      operation: 1,
      amount: { kind: "none" },
      build: () => call(MULTISEND_CALL_ONLY, encodeMultiSend(calls)),
    });
  } else {
    for (const r of removals) {
      steps.push({
        id: r.id,
        title: r.title,
        notes: [r.note],
        via: "safe",
        category: "revoke",
        amount: { kind: "none" },
        build: () => r.call,
      });
    }
  }
  return steps;
}

/**
 * Refuses destinations that cannot be the owner's wallet: zero, the account itself, its modules,
 * the tokens and the Agent Bank contracts.
 */
export function assertDestination(report: AccountReport, to: Address): Address {
  const destination = getAddress(to);
  if (isAddressEqual(destination, ZERO_ADDRESS)) {
    throw new ExitToolError("invalid_argument", "The destination cannot be the zero address.");
  }
  if (isAddressEqual(destination, report.account)) {
    throw new ExitToolError("invalid_argument", "The destination is the account itself.");
  }
  const forbidden = [
    SAFE7579_ADAPTER,
    ...report.safe.modules,
    ...Object.values(report.contracts).filter((a): a is Address => Boolean(a)),
    ...Object.values(report.tokens).map((t) => t.address),
  ];
  if (forbidden.some((a) => isAddressEqual(a, destination))) {
    throw new ExitToolError(
      "invalid_argument",
      `The destination ${destination} is a module, token or Agent Bank contract, not a wallet you control.`,
    );
  }
  return destination;
}

// ---------------------------------------------------------------------------------------------
// Withdrawals from the account
// ---------------------------------------------------------------------------------------------

export interface WithdrawOptions {
  to: Address;
  /** "eth" or an ERC-20 address. */
  token: "eth" | Address;
  amount: bigint | "all";
  symbol?: string;
}

export function planWithdrawStep(report: AccountReport, options: WithdrawOptions): PlanStep {
  const account = report.account;
  const to = getAddress(options.to);
  const amount: AmountSource =
    options.amount === "all"
      ? options.token === "eth"
        ? { kind: "ethBalance", holder: account }
        : { kind: "erc20Balance", token: options.token, holder: account }
      : { kind: "fixed", amount: options.amount };
  if (options.token === "eth") {
    return {
      id: "withdraw:ETH",
      title: `Withdraw ${options.amount === "all" ? "all ETH" : "ETH"} to ${to}`,
      notes: [],
      via: "safe",
      category: "withdraw",
      amount,
      moves: { token: "ETH", from: account, to },
      build: (value) => call(to, "0x", value),
    };
  }
  const token = getAddress(options.token);
  const symbol = options.symbol ?? report.tokens[token.toLowerCase()]?.symbol ?? token;
  return {
    id: `withdraw:${token}`,
    title: `Withdraw ${options.amount === "all" ? `all ${symbol}` : symbol} to ${to}`,
    notes: [],
    via: "safe",
    category: "withdraw",
    amount,
    moves: { token, from: account, to },
    build: (value) =>
      call(token, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, value] })),
  };
}

// ---------------------------------------------------------------------------------------------
// Recovering funds from Agent Bank contracts back into the account
// ---------------------------------------------------------------------------------------------

export interface Selection {
  /** Only these ids (all eligible ones when undefined). */
  ids?: readonly bigint[];
}

const selected = (ids: readonly bigint[] | undefined, id: bigint): boolean =>
  ids === undefined || ids.some((x) => x === id);

function requireContract(address: Address | undefined, name: string): Address {
  if (!address) {
    throw new ExitToolError("missing_config", `The ${name} address is not configured for this chain.`, {
      hint: "Pass --deployments <file> (or the individual --escrow/--streams/--vaults flags).",
    });
  }
  return address;
}

/** Refunds expired (or dispute-timed-out) escrows the account paid into. Anyone may trigger them. */
export function planRefundEscrows(
  report: AccountReport,
  selection: Selection = {},
): { steps: PlanStep[]; skipped: string[] } {
  const steps: PlanStep[] = [];
  const skipped: string[] = [];
  for (const e of report.escrows) {
    if (e.role !== "payer" || !selected(selection.ids, e.id)) continue;
    if (e.status !== "Active" && e.status !== "Disputed") continue;
    if (!e.refundableNow) {
      skipped.push(
        `escrow #${e.id}: ${e.status === "Disputed" ? "disputed" : "not expired"}; refundable from ${formatTimestamp(e.refundableAt)}`,
      );
      continue;
    }
    const escrow = requireContract(report.contracts.escrow, "AgentEscrow");
    steps.push({
      id: `refund-escrow:${e.id}`,
      title: `Refund escrow #${e.id} (${e.status === "Disputed" ? "dispute timed out" : "expired"}) to the account`,
      notes: [
        `AgentEscrow.refund(${e.id}): anyone may call it; the funds can only go to the payer (the account).`,
      ],
      via: "direct",
      category: "recover",
      amount: { kind: "none" },
      moves: { token: e.token, from: escrow, to: report.account },
      build: () =>
        call(escrow, encodeFunctionData({ abi: agentEscrowAbi, functionName: "refund", args: [e.id] })),
    });
  }
  if (selection.ids) {
    for (const id of selection.ids) {
      if (!report.escrows.some((e) => e.id === id && e.role === "payer"))
        skipped.push(`escrow #${id}: not an escrow paid by this account`);
    }
  }
  return { steps, skipped };
}

/** Releases incoming escrows whose ERC-8004 validator approved the work (anyone may trigger it). */
export function planReleaseIncoming(report: AccountReport): PlanStep[] {
  return report.escrows
    .filter((e) => e.role === "payee" && e.releasableNow)
    .map((e) => {
      const escrow = requireContract(report.contracts.escrow, "AgentEscrow");
      return {
        id: `release-escrow:${e.id}`,
        title: `Release incoming escrow #${e.id} (validator approved) to the account`,
        notes: [
          `AgentEscrow.releaseByValidation(${e.id}): anyone may call it; pays the payee (the account).`,
        ],
        via: "direct" as const,
        category: "recover" as const,
        amount: { kind: "none" as const },
        moves: { token: e.token, from: escrow, to: report.account },
        build: () =>
          call(
            escrow,
            encodeFunctionData({ abi: agentEscrowAbi, functionName: "releaseByValidation", args: [e.id] }),
          ),
      };
    });
}

/** Cancels streams the account pays: the payee is paid what it earned, the rest returns to the account. */
export function planCancelStreams(
  report: AccountReport,
  selection: Selection = {},
): { steps: PlanStep[]; skipped: string[] } {
  const steps: PlanStep[] = [];
  const skipped: string[] = [];
  for (const s of report.streams) {
    if (s.role !== "payer" || !selected(selection.ids, s.id)) continue;
    if (s.canceled) continue;
    if (s.refundIfCanceled === 0n) {
      skipped.push(`stream #${s.id}: fully accrued to the payee; cancelling would return nothing`);
      continue;
    }
    const streams = requireContract(report.contracts.streams, "PaymentStreams");
    steps.push({
      id: `cancel-stream:${s.id}`,
      title: `Cancel stream #${s.id} to ${s.payee}`,
      notes: [
        `PaymentStreams.cancel(${s.id}) must come from the payer, so it is a Safe transaction.`,
        "The payee receives what it has earned; the unearned rest returns to the account.",
      ],
      via: "safe",
      category: "recover",
      amount: { kind: "none" },
      moves: { token: s.token, from: streams, to: report.account },
      build: () =>
        call(streams, encodeFunctionData({ abi: paymentStreamsAbi, functionName: "cancel", args: [s.id] })),
    });
  }
  if (selection.ids) {
    for (const id of selection.ids) {
      if (!report.streams.some((s) => s.id === id && s.role === "payer"))
        skipped.push(`stream #${id}: not a stream paid by this account`);
    }
  }
  return { steps, skipped };
}

/** Settles what incoming streams owe the account (anyone may call `settle`). */
export function planSettleIncoming(report: AccountReport): PlanStep[] {
  return report.streams
    .filter((s) => s.role === "payee" && s.settleable > 0n)
    .map((s) => {
      const streams = requireContract(report.contracts.streams, "PaymentStreams");
      return {
        id: `settle-stream:${s.id}`,
        title: `Collect what incoming stream #${s.id} owes the account`,
        notes: [`PaymentStreams.settle(${s.id}): anyone may call it; pays the payee (the account).`],
        via: "direct" as const,
        category: "recover" as const,
        amount: { kind: "none" as const },
        moves: { token: s.token, from: streams, to: report.account },
        build: () =>
          call(streams, encodeFunctionData({ abi: paymentStreamsAbi, functionName: "settle", args: [s.id] })),
      };
    });
}

export interface VaultOptions extends Selection {
  /** Leave locked vaults alone (no early withdrawals). */
  unlockedOnly?: boolean;
  /** The owner key that will sign early withdrawals (defaults to the vault owner when it is a Safe owner). */
  signer?: Address;
}

/**
 * Returns vault balances to the account: unlocked vaults with `withdraw` (anyone), locked ones with
 * `withdrawWithSignature` and the vault owner's EIP-712 `EarlyWithdrawal` signature.
 */
export function planWithdrawVaults(
  report: AccountReport,
  options: VaultOptions = {},
): { steps: PlanStep[]; skipped: string[] } {
  const steps: PlanStep[] = [];
  const skipped: string[] = [];
  const isSigner = (owner: Address): boolean =>
    options.signer
      ? isAddressEqual(owner, options.signer)
      : report.safe.owners.some((o) => isAddressEqual(o, owner));
  for (const v of report.vaults) {
    if (!selected(options.ids, v.id) || v.balance === 0n) continue;
    const vaults = requireContract(report.contracts.vaults, "TimeLockVaults");
    if (v.unlocked) {
      steps.push({
        id: `withdraw-vault:${v.id}`,
        title: `Return unlocked vault #${v.id} to the account`,
        notes: [
          `TimeLockVaults.withdraw(${v.id}, balance): anyone may call it after unlock; funds only go to the account.`,
        ],
        via: "direct",
        category: "recover",
        amount: { kind: "vaultBalance", vaults, id: v.id },
        moves: { token: v.token, from: vaults, to: report.account },
        build: (amount) =>
          call(
            vaults,
            encodeFunctionData({ abi: timeLockVaultsAbi, functionName: "withdraw", args: [v.id, amount] }),
          ),
      });
      continue;
    }
    if (options.unlockedOnly) {
      skipped.push(`vault #${v.id}: locked until ${formatTimestamp(v.unlockAt)} (--unlocked-only)`);
      continue;
    }
    if (!isSigner(v.owner)) {
      skipped.push(
        `vault #${v.id}: locked until ${formatTimestamp(v.unlockAt)}; only its owner ${v.owner} can sign an early withdrawal`,
      );
      continue;
    }
    steps.push({
      id: `early-withdraw-vault:${v.id}`,
      title: `Early-withdraw locked vault #${v.id} to the account (owner-signed)`,
      notes: [
        `TimeLockVaults.withdrawWithSignature(${v.id}, balance, deadline, sig): the vault owner signs an EIP-712 EarlyWithdrawal; funds only go to the account.`,
        `The vault was locked until ${formatTimestamp(v.unlockAt)}.`,
      ],
      via: "direct",
      category: "recover",
      amount: { kind: "vaultBalance", vaults, id: v.id },
      vaultSignature: { vaults, id: v.id, owner: v.owner },
      moves: { token: v.token, from: vaults, to: report.account },
      build: (amount, signed) =>
        call(
          vaults,
          encodeFunctionData({
            abi: timeLockVaultsAbi,
            functionName: "withdrawWithSignature",
            args: [v.id, amount, signed?.deadline ?? 0n, signed?.signature ?? "0x"],
          }),
        ),
    });
  }
  return { steps, skipped };
}

/** Pulls agent spend-key floats back into the account with their permit allowances (ADR 0001). */
export function planSweepSpendKeys(report: AccountReport): { steps: PlanStep[]; skipped: string[] } {
  const steps: PlanStep[] = [];
  const skipped: string[] = [];
  for (const k of report.spendKeys) {
    if (k.sweepable === 0n) {
      if (k.balance > 0n)
        skipped.push(
          `spend key ${k.address}: no allowance to the account; only the agent runtime can move its float`,
        );
      continue;
    }
    const symbol = report.tokens[k.token.toLowerCase()]?.symbol ?? "tokens";
    steps.push({
      id: `sweep-spend-key:${k.address}`,
      title: `Pull ${symbol} float of spend key ${k.address} back into the account`,
      notes: [
        `${symbol}.transferFrom(${k.address}, account, min(balance, allowance)), using the permit allowance the key granted the account.`,
      ],
      via: "safe",
      category: "recover",
      amount: { kind: "sweepable", token: k.token, owner: k.address, spender: report.account },
      moves: { token: k.token, from: k.address, to: report.account },
      build: (amount) =>
        call(
          k.token,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "transferFrom",
            args: [k.address, report.account, amount],
          }),
        ),
    });
  }
  return { steps, skipped };
}

// ---------------------------------------------------------------------------------------------
// Full exit
// ---------------------------------------------------------------------------------------------

export interface ExitOptions {
  to: Address;
  keepGuard?: boolean;
  unlockedOnly?: boolean;
  skipSpendKeys?: boolean;
  /** Extra ERC-20 tokens to sweep from the account (USDC and position tokens are always included). */
  extraTokens?: readonly Address[];
  signer?: Address;
  /** See RevokeOptions.batch. */
  batch?: boolean;
  /** See RevokeOptions.includeRecovery. */
  includeRecovery?: boolean;
}

/**
 * The full exit, in a safe order:
 * 1. revoke: guard, every module (incl. the Safe7579 adapter), fallback handler: from here on no
 *    agent session, co-signer, executor or hook can act, so nothing can race the exit;
 * 2. recover into the account: cancel streams, refund escrows, collect incoming streams and
 *    escrows, return vaults (early with the owner's signature), pull spend-key floats;
 * 3. withdraw every token and all ETH to the destination (amounts read when each step runs).
 */
export function planExit(report: AccountReport, options: ExitOptions): Plan {
  const to = getAddress(options.to);
  const steps: PlanStep[] = [];
  const skipped: string[] = [];
  const revokeOptions: RevokeOptions = {
    keepGuard: options.keepGuard ?? false,
    includeRecovery: options.includeRecovery ?? false,
    ...(options.batch !== undefined ? { batch: options.batch } : {}),
  };
  steps.push(...planRevoke(report, revokeOptions));
  skipped.push(...recoveryKeptNote(report, revokeOptions));
  const streams = planCancelStreams(report);
  const escrows = planRefundEscrows(report);
  const vaults = planWithdrawVaults(report, {
    unlockedOnly: options.unlockedOnly ?? false,
    ...(options.signer ? { signer: options.signer } : {}),
  });
  steps.push(
    ...streams.steps,
    ...escrows.steps,
    ...planReleaseIncoming(report),
    ...planSettleIncoming(report),
    ...vaults.steps,
  );
  skipped.push(...streams.skipped, ...escrows.skipped, ...vaults.skipped);
  if (!options.skipSpendKeys) {
    const keys = planSweepSpendKeys(report);
    steps.push(...keys.steps);
    skipped.push(...keys.skipped);
  }
  const tokens = new Map<string, Address>();
  for (const info of Object.values(report.tokens)) tokens.set(info.address.toLowerCase(), info.address);
  for (const t of options.extraTokens ?? []) tokens.set(t.toLowerCase(), getAddress(t));
  for (const token of tokens.values()) {
    steps.push(planWithdrawStep(report, { to, token, amount: "all" }));
  }
  steps.push(planWithdrawStep(report, { to, token: "eth", amount: "all" }));
  return {
    command: "exit",
    chainId: report.chain.id,
    account: report.account,
    destination: to,
    steps,
    skipped,
  };
}
