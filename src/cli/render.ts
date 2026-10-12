import { formatEther, isAddressEqual, type Address } from "viem";
import { formatAmount } from "../core/amounts";
import { addressUrl, txUrl, type ChainConfig } from "../core/chains";
import { ZERO_ADDRESS } from "../core/constants";
import { describeCall, formatTimestamp } from "../core/describe";
import type { ExecutedStep } from "../core/execute";
import type { AccountReport } from "../core/inspect";
import type { SimulationResult } from "../core/simulate";
import type { RecoverySummary } from "../core/summary";

/** "120.5 USDC" for a token address (or "ETH"), using the report's token metadata. */
export function tokenAmount(
  report: Pick<AccountReport, "tokens">,
  token: Address | "ETH",
  amount: bigint,
): string {
  if (token === "ETH") return `${formatEther(amount)} ETH`;
  const info = report.tokens[token.toLowerCase()];
  return info ? `${formatAmount(amount, info.decimals)} ${info.symbol}` : `${amount} units of ${token}`;
}

function label(report: AccountReport, address: Address): string {
  const l = report.labels[address.toLowerCase()];
  return l ? `${address} (${l})` : address;
}

export function renderReport(report: AccountReport, summary: RecoverySummary, chain: ChainConfig): string[] {
  const out: string[] = [];
  const s = report.safe;
  out.push(
    `Chain       ${report.chain.label} (chain id ${report.chain.id}), block ${report.block.number} at ${formatTimestamp(report.block.timestamp)}`,
  );
  out.push(
    `Account     ${report.account}${addressUrl(chain, report.account) ? `  ${addressUrl(chain, report.account)}` : ""}`,
  );
  if (!s.deployed) {
    out.push("            NOT DEPLOYED (no contract code at this address)");
  } else {
    out.push(
      `Safe        version ${s.version ?? "unknown"}, implementation ${s.singleton ? label(report, s.singleton) : "unknown"}`,
    );
    out.push(
      `Owners      ${s.threshold} of ${s.owners.length}: ${s.owners.map((o) => (report.signer && isAddressEqual(o, report.signer.address) ? `${o} (your key)` : o)).join(", ")}`,
    );
    out.push(`Nonce       ${s.nonce}`);
    out.push(`Modules     ${s.modules.length === 0 ? "none" : label(report, s.modules[0]!)}`);
    for (const m of s.modules.slice(1)) out.push(`            ${label(report, m)}`);
    out.push(
      `Fallback    ${isAddressEqual(s.fallbackHandler, ZERO_ADDRESS) ? "none" : label(report, s.fallbackHandler)}`,
    );
    out.push(`Guard       ${isAddressEqual(s.guard, ZERO_ADDRESS) ? "none" : s.guard}`);
  }
  if (report.signer && !report.signer.isOwner)
    out.push(`Your key    ${report.signer.address} is NOT an owner`);
  out.push("");
  out.push("Balances held by the account");
  out.push(`  ${formatEther(report.eth)} ETH`);
  for (const [key, info] of Object.entries(report.tokens)) {
    out.push(
      `  ${formatAmount(report.balances[key] ?? 0n, info.decimals)} ${info.symbol}  (${info.address})`,
    );
  }
  if (!report.usdc) out.push("  (no USDC address configured for this chain: pass --usdc or --deployments)");

  out.push("");
  if (!report.agentBankConfigured) {
    out.push(
      "Agent Bank positions: not checked (no AgentEscrow/PaymentStreams/TimeLockVaults addresses configured;",
    );
    out.push("  pass --deployments <file> or --escrow/--streams/--vaults).");
  } else if (report.discovery) {
    const d = report.discovery.positions;
    const how =
      d.method === "events"
        ? `from contract events, blocks ${d.fromBlock}–${d.toBlock} (${d.requests} eth_getLogs requests)`
        : `by enumerating the contracts (${d.notes.join("; ")})`;
    out.push(`Agent Bank positions (found ${how})`);
    if (report.escrows.length + report.streams.length + report.vaults.length === 0) out.push("  none");
    for (const e of report.escrows) {
      const when =
        e.status === "Active" || e.status === "Disputed"
          ? e.role === "payer"
            ? e.refundableNow
              ? "refundable now"
              : `refundable from ${formatTimestamp(e.refundableAt)}`
            : e.releasableNow
              ? "releasable now (validator approved)"
              : "awaiting release by the payer/arbiter/validator"
          : "closed";
      out.push(
        `  escrow #${e.id}  ${e.role === "payer" ? `you pay ${e.payee}` : `${e.payer} pays you`}  ${tokenAmount(report, e.token, e.amount)}  ${e.status}, expires ${formatTimestamp(e.expiresAt)}: ${when}`,
      );
    }
    for (const st of report.streams) {
      const base = `  stream #${st.id}  ${st.role === "payer" ? `you pay ${st.payee}` : `${st.payer} pays you`}  deposit ${tokenAmount(report, st.token, st.deposit)}, accrued ${tokenAmount(report, st.token, st.accrued)}, paid ${tokenAmount(report, st.token, st.paid)}`;
      out.push(
        `${base}${st.canceled ? ", canceled" : st.role === "payer" ? `: cancel now returns ~${tokenAmount(report, st.token, st.refundIfCanceled)}` : `: ${tokenAmount(report, st.token, st.settleable)} settleable now`}`,
      );
    }
    for (const v of report.vaults) {
      out.push(
        `  vault #${v.id}  ${tokenAmount(report, v.token, v.balance)}  ${v.unlocked ? "unlocked" : `locked until ${formatTimestamp(v.unlockAt)}`}, owner ${v.owner}`,
      );
    }
    for (const k of report.spendKeys) {
      out.push(
        `  spend key ${k.address}  float ${tokenAmount(report, k.token, k.balance)}, allowance to the account ${k.allowance === 2n ** 256n - 1n ? "unlimited" : tokenAmount(report, k.token, k.allowance)}`,
      );
    }
  }

  if (report.findings.length > 0) {
    out.push("");
    out.push("Findings");
    for (const f of report.findings)
      out.push(`  ${f.severity === "danger" ? "!!" : f.severity === "warning" ? "! " : "- "} ${f.message}`);
  }

  out.push("");
  out.push("What you can recover now");
  if (summary.now.length === 0) out.push("  nothing");
  for (const item of summary.now) {
    out.push(
      `  • ${item.approximate ? "~" : ""}${tokenAmount(report, item.token, item.amount)}: ${item.label}`,
    );
  }
  if (summary.totals.size > 0) {
    const totals = [...summary.totals.entries()].map(([key, amount]) =>
      tokenAmount(report, key === "ETH" ? "ETH" : (report.tokens[key]?.address ?? (key as Address)), amount),
    );
    out.push(`  Total: ${totals.join(" + ")}`);
  }
  if (summary.pending.length > 0) {
    out.push("");
    out.push("Not recoverable yet");
    for (const item of summary.pending) {
      out.push(
        `  • ${tokenAmount(report, item.token, item.amount)}: ${item.label}${item.availableAt ? ` (${formatTimestamp(item.availableAt)})` : ""}`,
      );
    }
  }
  return out;
}

export function renderSimulation(
  report: AccountReport,
  sim: SimulationResult,
  header: string,
  options: { gasPrice?: bigint; payer?: { address: Address; balance: bigint } } = {},
): string[] {
  const out: string[] = [header, ""];
  const results = new Map(sim.results.map((r) => [r.index, r]));
  for (const step of sim.steps) {
    const r = results.get(step.index);
    const status = step.skipped
      ? `skipped (${step.skipped})`
      : r?.status === "success"
        ? `simulated OK${r.gasUsed ? ` (${r.gasUsed} gas)` : ""}`
        : r?.status === "failure"
          ? `SIMULATION FAILED: ${r.error ?? "unknown error"}`
          : "not simulated";
    const via = step.via === "safe" ? "Safe tx, owner-signed" : "direct call, anyone may send";
    out.push(`${String(step.index).padStart(2)}. ${step.title}`);
    out.push(`    ${via}; ${status}`);
    if (step.amount !== undefined && step.moves) {
      out.push(`    amount: ${tokenAmount(report, step.moves.token, step.amount)}`);
    }
    if (!step.skipped) {
      out.push(`    call: ${step.call.to}.${describeCall(step.call)}`);
      out.push(
        `    calldata: ${step.call.data}${step.call.value > 0n ? `  value: ${step.call.value} wei` : ""}`,
      );
      if (step.safeTx && step.safeTxHash)
        out.push(`    SafeTx nonce ${step.safeTx.nonce}, hash ${step.safeTxHash}`);
      if (step.vault)
        out.push(
          `    EarlyWithdrawal nonce ${step.vault.message.nonce}, deadline ${formatTimestamp(step.vault.message.deadline)}, digest ${step.vault.digest}`,
        );
    }
    for (const note of step.notes) out.push(`    · ${note}`);
  }
  out.push("");
  if (sim.note) out.push(`Note: ${sim.note}`);
  if (sim.balances) {
    const name = (key: string): Address | "ETH" =>
      key === "ETH" ? "ETH" : (report.tokens[key]?.address ?? (key as Address));
    const { before, after } = sim.balances;
    const accountLine = Object.keys(after.account)
      .map(
        (key) =>
          `${tokenAmount(report, name(key), before.account[key] ?? 0n)} → ${tokenAmount(report, name(key), after.account[key] ?? 0n)}`,
      )
      .join("; ");
    out.push(`Simulated result: the account goes from ${accountLine || "-"}`);
    if (after.destination && before.destination) {
      const gains = Object.keys(after.destination)
        .map((key) => {
          const delta = (after.destination![key] ?? 0n) - (before.destination![key] ?? 0n);
          return delta === 0n
            ? undefined
            : `${delta > 0n ? "+" : "-"}${tokenAmount(report, name(key), delta > 0n ? delta : -delta)}`;
        })
        .filter(Boolean);
      out.push(
        `                  the destination receives ${gains.length > 0 ? gains.join(", ") : "nothing"}`,
      );
    }
  }
  const count = sim.steps.filter((s) => !s.skipped).length;
  let gasLine = `Transactions: ${count}; estimated gas ${sim.gasTotal}`;
  if (options.gasPrice !== undefined)
    gasLine += ` (≈ ${formatEther(sim.gasTotal * options.gasPrice)} ETH at the current gas price)`;
  out.push(gasLine);
  if (options.payer) {
    out.push(
      `Gas is paid by ${options.payer.address} (balance ${formatEther(options.payer.balance)} ETH), not by the account.`,
    );
  }
  return out;
}

export function renderExecution(results: readonly ExecutedStep[], chain: ChainConfig): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (r.status === "skipped") {
      out.push(`${String(r.index).padStart(2)}. skipped: ${r.title} (${r.reason ?? ""})`);
      continue;
    }
    const url = r.hash ? txUrl(chain, r.hash) : undefined;
    out.push(`${String(r.index).padStart(2)}. done: ${r.title}`);
    out.push(`    tx ${r.hash}${url ? `  ${url}` : ""} (block ${r.blockNumber}, gas ${r.gasUsed})`);
  }
  return out;
}
