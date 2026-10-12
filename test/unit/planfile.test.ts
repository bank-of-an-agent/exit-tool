import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { buildPlanFile, parsePlanFile } from "../../src/core/planfile";
import { hashSafeTx, safeTxForCall } from "../../src/core/safe";
import type { MaterializedStep } from "../../src/core/simulate";
import { hashEarlyWithdrawal } from "../../src/core/vaults";
import { ACCOUNT, OWNER, USDC, VAULTS } from "./fixtures";

const DEST: Address = "0x00000000000000000000000000000000000000d5";

function steps(): MaterializedStep[] {
  const call = { to: USDC, value: 0n, data: "0xa9059cbb00" as const };
  const safeTx = safeTxForCall(call, 7n);
  const domain = {
    name: "AgentBank TimeLockVaults",
    version: "1",
    chainId: 84532,
    verifyingContract: VAULTS,
  };
  const message = { vaultId: 2n, amount: 40n, nonce: 3n, deadline: 1_900_000_000n };
  return [
    {
      index: 1,
      id: "early-withdraw-vault:2",
      title: "Early-withdraw locked vault #2",
      notes: [],
      via: "direct",
      category: "recover",
      amount: 40n,
      call: { to: VAULTS, value: 0n, data: "0x73c172de" },
      vault: { domain, message, digest: hashEarlyWithdrawal(domain, message), owner: OWNER },
    },
    {
      index: 2,
      id: `withdraw:${USDC}`,
      title: "Withdraw all USDC",
      notes: [],
      via: "safe",
      category: "withdraw",
      amount: 5n,
      call,
      safeTx,
      safeTxHash: hashSafeTx(84532, ACCOUNT, safeTx),
    },
    {
      index: 3,
      id: "withdraw:ETH",
      title: "Withdraw all ETH",
      notes: [],
      via: "safe",
      category: "withdraw",
      amount: 0n,
      call: { to: DEST, value: 0n, data: "0x" },
      skipped: "nothing to move",
    },
  ];
}

function file() {
  return buildPlanFile({
    chainId: 84532,
    account: ACCOUNT,
    command: "exit",
    destination: DEST,
    safe: { nonce: 7n, threshold: 1n, owners: [OWNER] },
    steps: steps(),
    notes: ["left alone: escrow #9"],
    now: new Date("2026-10-11T00:00:00Z"),
  });
}

describe("signer-only plan files", () => {
  it("list one payload per signature needed, with hashes wallets will show", () => {
    const f = file();
    expect(f.payloads.map((p) => [p.step, p.kind, p.signer])).toEqual([
      [1, "EarlyWithdrawal", OWNER],
      [2, "SafeTx", "owner"],
    ]);
    expect(f.payloads[1]!.hash).toBe(steps()[1]!.safeTxHash);
    const typed = f.payloads[1]!.typedData as {
      types: { EIP712Domain: unknown[] };
      message: { nonce: string };
    };
    expect(typed.types.EIP712Domain).toHaveLength(2);
    expect(typed.message.nonce).toBe("7");
  });

  it("round-trip through JSON and recompute every hash", () => {
    const json = JSON.parse(JSON.stringify(file()));
    const { steps: parsed, file: f } = parsePlanFile(json, { chainId: 84532, account: ACCOUNT });
    expect(f.account).toBe(ACCOUNT);
    expect(parsed).toHaveLength(3);
    expect(parsed[1]!.safeTxHash).toBe(steps()[1]!.safeTxHash);
    expect(parsed[0]!.vault!.digest).toBe(steps()[0]!.vault!.digest);
    expect(parsed[2]!.skipped).toBe("nothing to move");
  });

  it("refuse plans for another chain or account, and tampered transactions", () => {
    const json = JSON.parse(JSON.stringify(file()));
    expect(() => parsePlanFile(json, { chainId: 31337 })).toThrow(/chain 84532/);
    expect(() => parsePlanFile(json, { chainId: 84532, account: OWNER })).toThrow(/is for account/);

    const swapped = JSON.parse(JSON.stringify(file()));
    swapped.steps[1].safeTx.to = DEST; // the SafeTx no longer matches the displayed call
    expect(() => parsePlanFile(swapped, { chainId: 84532 })).toThrow(/does not match/);

    const delegate = JSON.parse(JSON.stringify(file()));
    delegate.steps[1].safeTx.operation = 1; // DELEGATECALL is never produced by the tool
    expect(() => parsePlanFile(delegate, { chainId: 84532 })).toThrow(/operation must be 0/);

    const other = JSON.parse(JSON.stringify(file()));
    other.format = "something-else";
    expect(() => parsePlanFile(other, { chainId: 84532 })).toThrow(/Unsupported plan file format/);
  });
});
