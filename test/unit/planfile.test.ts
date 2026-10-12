import { encodeFunctionData, getAddress, type Address } from "viem";
import { agentEscrowAbi, erc20Abi, paymentStreamsAbi, safeAbi } from "../../src/core/abis/index";
import { ExitToolError } from "../../src/core/errors";
import { encodeMultiSend, MULTISEND_CALL_ONLY } from "../../src/core/multisend";
import { describe, expect, it } from "vitest";
import { buildPlanFile, parsePlanFile, verifyPlanSteps } from "../../src/core/planfile";
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

  it("accept the revoke batch, and only the revoke batch, as a DELEGATECALL", () => {
    const revoke = encodeMultiSend([
      {
        to: ACCOUNT,
        value: 0n,
        data: encodeFunctionData({
          abi: safeAbi,
          functionName: "disableModule",
          args: ["0x0000000000000000000000000000000000000001", OWNER],
        }),
      },
      {
        to: ACCOUNT,
        value: 0n,
        data: encodeFunctionData({ abi: safeAbi, functionName: "setFallbackHandler", args: [OWNER] }),
      },
    ]);
    const withBatch = (data: `0x${string}`, to: Address = MULTISEND_CALL_ONLY) => {
      const call = { to, value: 0n, data };
      const safeTx = safeTxForCall(call, 7n, 1);
      return JSON.parse(
        JSON.stringify(
          buildPlanFile({
            chainId: 84532,
            account: ACCOUNT,
            command: "disable-modules",
            safe: { nonce: 7n, threshold: 1n, owners: [OWNER] },
            steps: [
              {
                index: 1,
                id: "revoke-batch:x",
                title: "Revoke",
                notes: [],
                via: "safe",
                category: "revoke",
                call,
                safeTx,
                safeTxHash: hashSafeTx(84532, ACCOUNT, safeTx),
              },
            ],
            notes: [],
          }),
        ),
      );
    };
    expect(parsePlanFile(withBatch(revoke), { chainId: 84532 }).steps[0]!.safeTx!.operation).toBe(1);
    const steal = encodeMultiSend([
      {
        to: USDC,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [DEST, 1n] }),
      },
    ]);
    expect(() => parsePlanFile(withBatch(steal), { chainId: 84532 })).toThrow(
      /only allowed for the revoke batch/,
    );
    expect(() => parsePlanFile(withBatch(revoke, DEST), { chainId: 84532 })).toThrow(
      /only allowed for the revoke batch/,
    );
  });

  it("refuse plans for another chain or account, and tampered transactions", () => {
    const json = JSON.parse(JSON.stringify(file()));
    expect(() => parsePlanFile(json, { chainId: 31337 })).toThrow(/chain 84532/);
    expect(() => parsePlanFile(json, { chainId: 84532, account: OWNER })).toThrow(/is for account/);

    const swapped = JSON.parse(JSON.stringify(file()));
    swapped.steps[1].safeTx.to = DEST; // the SafeTx no longer matches the displayed call
    expect(() => parsePlanFile(swapped, { chainId: 84532 })).toThrow(/does not match/);

    const delegate = JSON.parse(JSON.stringify(file()));
    delegate.steps[1].safeTx.operation = 1; // a DELEGATECALL to anything but the revoke batch
    expect(() => parsePlanFile(delegate, { chainId: 84532 })).toThrow(/only allowed for the revoke batch/);

    const elsewhere = JSON.parse(JSON.stringify(file()));
    elsewhere.steps[0].call.to = DEST; // signed for the vaults contract, sent somewhere else
    expect(() => parsePlanFile(elsewhere, { chainId: 84532 })).toThrow(/signed for/);

    const refund = JSON.parse(JSON.stringify(file()));
    refund.steps[1].safeTx.gasPrice = "1"; // the Safe would pay the executor
    expect(() => parsePlanFile(refund, { chainId: 84532 })).toThrow(/refund fields must all be zero/);

    const direct = JSON.parse(JSON.stringify(file()));
    direct.steps[0].call.data = "0xa9059cbb"; // a public step that is not a refund/settle/withdraw
    expect(() => parsePlanFile(direct, { chainId: 84532 })).toThrow(/may only refund, settle or withdraw/);

    const other = JSON.parse(JSON.stringify(file()));
    other.format = "something-else";
    expect(() => parsePlanFile(other, { chainId: 84532 })).toThrow(/Unsupported plan file format/);
  });
});

describe("verifyPlanSteps (plan files are untrusted)", () => {
  const ESCROW: Address = "0x7DFb13379961afBd74725562B8Ddd1498A2dEbBe";
  const STREAMS: Address = "0xfA963d2A62faB54E1aC8005Db8D9B8F3f9919Fd4";
  const HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
  const ATTACKER: Address = "0x00000000000000000000000000000000000bad01";
  const ctx = {
    account: ACCOUNT,
    destination: DEST,
    contracts: { escrow: ESCROW, streams: STREAMS, vaults: VAULTS },
    compatibilityFallbackHandler: HANDLER,
    multiSendVerified: true,
  };
  const safeStep = (to: Address, data: `0x${string}`, value = 0n, operation = 0): MaterializedStep => {
    const call = { to, value, data };
    const safeTx = safeTxForCall(call, 1n, operation);
    return {
      index: 1,
      id: "x",
      title: "Totally harmless",
      notes: ["trust me"],
      via: "safe",
      category: "revoke",
      call,
      safeTx,
    };
  };
  const self = (fn: string, args: unknown[]) =>
    encodeFunctionData({ abi: safeAbi, functionName: fn, args } as never) as `0x${string}`;

  it("accepts the shapes the planner produces and derives titles from the calldata", () => {
    const steps = [
      safeStep(ACCOUNT, self("setGuard", ["0x0000000000000000000000000000000000000000"])),
      safeStep(
        MULTISEND_CALL_ONLY,
        encodeMultiSend([
          {
            to: ACCOUNT,
            value: 0n,
            data: self("disableModule", ["0x0000000000000000000000000000000000000001", ATTACKER]),
          },
          { to: ACCOUNT, value: 0n, data: self("setFallbackHandler", [HANDLER]) },
        ]),
        0n,
        1,
      ),
      safeStep(USDC, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [DEST, 5n] })),
      safeStep(DEST, "0x", 7n),
      safeStep(STREAMS, encodeFunctionData({ abi: paymentStreamsAbi, functionName: "cancel", args: [3n] })),
      {
        index: 6,
        id: "y",
        title: "x",
        notes: [],
        via: "direct",
        category: "recover",
        call: {
          to: ESCROW,
          value: 0n,
          data: encodeFunctionData({ abi: agentEscrowAbi, functionName: "refund", args: [2n] }),
        },
      } as MaterializedStep,
    ];
    verifyPlanSteps(steps, ctx);
    expect(steps.map((s) => s.title)).toEqual([
      "Remove the transaction guard",
      `In one transaction: disable module ${getAddress(ATTACKER)}; set the fallback handler to the verified CompatibilityFallbackHandler ${HANDLER}`,
      `Transfer 5 units of token ${USDC} to ${getAddress(DEST)}`,
      `Send 0.000000000000000007 ETH to ${DEST}`,
      "Cancel stream #3 (the payee keeps what it earned; the rest returns to the account)",
      "Refund escrow #2 to its payer (the account)",
    ]);
    expect(steps.every((s) => s.notes.length === 0)).toBe(true);
  });

  it("refuses everything else", () => {
    const bad: [string, MaterializedStep][] = [
      ["adding an owner", safeStep(ACCOUNT, self("setGuard", [ATTACKER]))],
      ["a malicious fallback handler", safeStep(ACCOUNT, self("setFallbackHandler", [ATTACKER]))],
      [
        "a batch with a malicious handler",
        safeStep(
          MULTISEND_CALL_ONLY,
          encodeMultiSend([{ to: ACCOUNT, value: 0n, data: self("setFallbackHandler", [ATTACKER]) }]),
          0n,
          1,
        ),
      ],
      [
        "a transfer elsewhere",
        safeStep(USDC, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ATTACKER, 5n] })),
      ],
      ["ETH elsewhere", safeStep(ATTACKER, "0x", 1n)],
      [
        "a pull to elsewhere",
        safeStep(
          USDC,
          encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [DEST, ATTACKER, 1n] }),
        ),
      ],
      [
        "cancel on another contract",
        safeStep(
          ATTACKER,
          encodeFunctionData({ abi: paymentStreamsAbi, functionName: "cancel", args: [3n] }),
        ),
      ],
      [
        "a public refund on another contract",
        {
          index: 1,
          id: "z",
          title: "x",
          notes: [],
          via: "direct",
          category: "recover",
          call: {
            to: ATTACKER,
            value: 0n,
            data: encodeFunctionData({ abi: agentEscrowAbi, functionName: "refund", args: [2n] }),
          },
        } as MaterializedStep,
      ],
    ];
    for (const [what, step] of bad) {
      expect(() => verifyPlanSteps([step], ctx), what).toThrow(ExitToolError);
    }
    // The Safe's own owner management is never part of a plan.
    const addOwner = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "addOwnerWithThreshold",
          stateMutability: "nonpayable",
          inputs: [
            { name: "o", type: "address" },
            { name: "t", type: "uint256" },
          ],
          outputs: [],
        },
      ],
      functionName: "addOwnerWithThreshold",
      args: [ATTACKER, 1n],
    });
    expect(() => verifyPlanSteps([safeStep(ACCOUNT, addOwner)], ctx)).toThrow(/configuration/);
    // Without a confirmed destination, a withdrawal is refused with a hint to pass --to.
    const transfer = safeStep(
      USDC,
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [DEST, 5n] }),
    );
    expect(() => verifyPlanSteps([transfer], { ...ctx, destination: undefined })).toThrow(/sends funds/);
    // An unverified MultiSendCallOnly is never delegatecalled.
    const batch = safeStep(
      MULTISEND_CALL_ONLY,
      encodeMultiSend([
        { to: ACCOUNT, value: 0n, data: self("setGuard", ["0x0000000000000000000000000000000000000000"]) },
      ]),
      0n,
      1,
    );
    expect(() => verifyPlanSteps([batch], { ...ctx, multiSendVerified: false })).toThrow(/not verified/);
  });
});
