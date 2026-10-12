import { decodeFunctionData, getAddress, maxUint256, type Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  agentEscrowAbi,
  erc20Abi,
  paymentStreamsAbi,
  safeAbi,
  timeLockVaultsAbi,
} from "../../src/core/abis/index";
import { SAFE7579_ADAPTER, SAFE_V141, SENTINEL, ZERO_ADDRESS } from "../../src/core/constants";
import {
  planCancelStreams,
  planExit,
  planRefundEscrows,
  planRevoke,
  planSettleIncoming,
  planSweepSpendKeys,
  planWithdrawStep,
  planWithdrawVaults,
} from "../../src/core/plan";
import {
  ACCOUNT,
  ESCROW,
  GUARD,
  makeReport,
  OTHER,
  OWNER,
  SPEND_KEY,
  STREAMS,
  USDC,
  USDC_UNIT,
  VAULTS,
} from "./fixtures";

const DEST: Address = "0x00000000000000000000000000000000000000d5";

describe("planRevoke", () => {
  it("removes the guard first, then every module from the head of the list, then resets the fallback handler", () => {
    const steps = planRevoke(makeReport());
    expect(steps.map((s) => s.id)).toEqual([
      `remove-guard:${GUARD}`,
      `disable-module:${OTHER}`,
      `disable-module:${SAFE7579_ADAPTER}`,
      `set-fallback-handler:${SAFE_V141.compatibilityFallbackHandler}`,
    ]);
    for (const step of steps) {
      expect(step.via).toBe("safe");
      expect(step.category).toBe("revoke");
      const call = step.build(0n);
      expect(call.to).toBe(ACCOUNT); // self-calls: only the Safe itself may change its configuration
      expect(call.value).toBe(0n);
    }
    const [guard, m1, m2, handler] = steps.map((s) =>
      decodeFunctionData({ abi: safeAbi, data: s.build(0n).data }),
    );
    expect(guard).toMatchObject({ functionName: "setGuard", args: [ZERO_ADDRESS] });
    // After removing the head, the next module becomes the head: prev is always the sentinel.
    expect(m1).toMatchObject({ functionName: "disableModule", args: [SENTINEL, OTHER] });
    expect(m2).toMatchObject({ functionName: "disableModule", args: [SENTINEL, SAFE7579_ADAPTER] });
    expect(handler).toMatchObject({
      functionName: "setFallbackHandler",
      args: [SAFE_V141.compatibilityFallbackHandler],
    });
  });

  it("keeps the guard with keepGuard and does nothing for a clean account", () => {
    expect(planRevoke(makeReport(), { keepGuard: true }).map((s) => s.id)[0]).toBe(`disable-module:${OTHER}`);
    const clean = makeReport();
    clean.safe = {
      ...clean.safe,
      modules: [],
      guard: ZERO_ADDRESS,
      fallbackHandler: SAFE_V141.compatibilityFallbackHandler,
    };
    expect(planRevoke(clean)).toEqual([]);
  });
});

describe("planWithdrawStep", () => {
  it("withdraws ETH as a plain value transfer from the Safe", () => {
    const step = planWithdrawStep(makeReport(), { to: DEST, token: "eth", amount: "all" });
    expect(step.amount).toEqual({ kind: "ethBalance", holder: ACCOUNT });
    expect(step.build(5n)).toEqual({ to: getAddress(DEST), data: "0x", value: 5n });
  });

  it("withdraws an ERC-20 with transfer(to, amount) on the token", () => {
    const step = planWithdrawStep(makeReport(), { to: DEST, token: USDC, amount: 12n });
    expect(step.amount).toEqual({ kind: "fixed", amount: 12n });
    const call = step.build(12n);
    expect(call.to).toBe(USDC);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data })).toMatchObject({
      functionName: "transfer",
      args: [getAddress(DEST), 12n],
    });
    expect(planWithdrawStep(makeReport(), { to: DEST, token: USDC, amount: "all" }).amount).toEqual({
      kind: "erc20Balance",
      token: USDC,
      holder: ACCOUNT,
    });
  });
});

describe("recovery planning", () => {
  it("refunds only expired escrows the account paid", () => {
    const { steps, skipped } = planRefundEscrows(makeReport());
    expect(steps.map((s) => s.id)).toEqual(["refund-escrow:1"]);
    expect(steps[0]!.via).toBe("direct");
    const call = steps[0]!.build(0n);
    expect(call.to).toBe(ESCROW);
    expect(decodeFunctionData({ abi: agentEscrowAbi, data: call.data })).toMatchObject({
      functionName: "refund",
      args: [1n],
    });
    expect(skipped.join("\n")).toMatch(/escrow #2: not expired; refundable from/);
    expect(planRefundEscrows(makeReport(), { ids: [2n, 9n] }).skipped.join("\n")).toMatch(
      /#9: not an escrow paid by this account/,
    );
  });

  it("cancels streams the account pays when that returns something, via the Safe", () => {
    const { steps, skipped } = planCancelStreams(makeReport());
    expect(steps.map((s) => s.id)).toEqual(["cancel-stream:1"]);
    expect(steps[0]!.via).toBe("safe"); // cancel must come from the payer
    expect(decodeFunctionData({ abi: paymentStreamsAbi, data: steps[0]!.build(0n).data })).toMatchObject({
      functionName: "cancel",
      args: [1n],
    });
    expect(skipped.join("\n")).toMatch(/stream #2: fully accrued/);
  });

  it("collects incoming streams with a public settle", () => {
    const steps = planSettleIncoming(makeReport());
    expect(steps.map((s) => [s.id, s.via])).toEqual([["settle-stream:3", "direct"]]);
    expect(steps[0]!.build(0n).to).toBe(STREAMS);
  });

  it("returns unlocked vaults publicly and locked ones with the owner's signature only", () => {
    const { steps, skipped } = planWithdrawVaults(makeReport(), { signer: OWNER });
    expect(steps.map((s) => s.id)).toEqual(["withdraw-vault:1", "early-withdraw-vault:2"]);
    expect(steps[0]!.amount).toEqual({ kind: "vaultBalance", vaults: VAULTS, id: 1n });
    expect(decodeFunctionData({ abi: timeLockVaultsAbi, data: steps[0]!.build(30n).data })).toMatchObject({
      functionName: "withdraw",
      args: [1n, 30n],
    });
    expect(steps[1]!.vaultSignature).toEqual({ vaults: VAULTS, id: 2n, owner: OWNER });
    expect(
      decodeFunctionData({
        abi: timeLockVaultsAbi,
        data: steps[1]!.build(40n, { signature: "0xabcd", deadline: 99n }).data,
      }),
    ).toMatchObject({ functionName: "withdrawWithSignature", args: [2n, 40n, 99n, "0xabcd"] });
    expect(skipped.join("\n")).toMatch(/vault #3: locked until .* only its owner/);
    expect(planWithdrawVaults(makeReport(), { unlockedOnly: true }).steps.map((s) => s.id)).toEqual([
      "withdraw-vault:1",
    ]);
  });

  it("pulls spend-key floats back with transferFrom, amount read at execution", () => {
    const { steps } = planSweepSpendKeys(makeReport());
    expect(steps).toHaveLength(1);
    expect(steps[0]!.amount).toEqual({ kind: "sweepable", token: USDC, owner: SPEND_KEY, spender: ACCOUNT });
    expect(decodeFunctionData({ abi: erc20Abi, data: steps[0]!.build(7n).data })).toMatchObject({
      functionName: "transferFrom",
      args: [SPEND_KEY, ACCOUNT, 7n],
    });
    const noAllowance = makeReport({
      spendKeys: [{ address: SPEND_KEY, token: USDC, balance: 5n, allowance: 0n, sweepable: 0n }],
    });
    expect(planSweepSpendKeys(noAllowance).skipped.join("")).toMatch(/no allowance/);
  });
});

describe("planExit", () => {
  it("revokes first, recovers into the account, then withdraws every token and ETH", () => {
    const plan = planExit(makeReport(), { to: DEST, signer: OWNER });
    const ids = plan.steps.map((s) => s.id.split(":")[0]);
    expect(ids).toEqual([
      "remove-guard",
      "disable-module",
      "disable-module",
      "set-fallback-handler",
      "cancel-stream",
      "refund-escrow",
      "settle-stream",
      "withdraw-vault",
      "early-withdraw-vault",
      "sweep-spend-key",
      "withdraw",
      "withdraw",
    ]);
    const categories = plan.steps.map((s) => s.category);
    expect(categories.lastIndexOf("revoke")).toBeLessThan(categories.indexOf("recover"));
    expect(categories.lastIndexOf("recover")).toBeLessThan(categories.indexOf("withdraw"));
    expect(plan.steps.at(-2)!.amount).toEqual({ kind: "erc20Balance", token: USDC, holder: ACCOUNT });
    expect(plan.steps.at(-1)!.amount).toEqual({ kind: "ethBalance", holder: ACCOUNT });
    expect(plan.destination).toBe(getAddress(DEST));
    // Every recovery step only ever pays the account; only the final withdrawals pay the destination.
    for (const step of plan.steps) {
      if (step.moves && step.category !== "withdraw") expect(step.moves.to).toBe(ACCOUNT);
      if (step.category === "withdraw") expect(step.moves!.to).toBe(getAddress(DEST));
    }
  });

  it("honours the opt-outs and extra tokens", () => {
    const extra: Address = "0x00000000000000000000000000000000000000E1";
    const plan = planExit(makeReport(), {
      to: DEST,
      keepGuard: true,
      unlockedOnly: true,
      skipSpendKeys: true,
      extraTokens: [extra],
    });
    const ids = plan.steps.map((s) => s.id);
    expect(ids).not.toContain(`remove-guard:${GUARD}`);
    expect(ids.some((id) => id.startsWith("early-withdraw-vault"))).toBe(false);
    expect(ids.some((id) => id.startsWith("sweep-spend-key"))).toBe(false);
    expect(ids).toContain(`withdraw:${getAddress(extra)}`);
    expect(maxUint256).toBeGreaterThan(0n);
    expect(USDC_UNIT).toBe(1_000_000n);
  });
});
