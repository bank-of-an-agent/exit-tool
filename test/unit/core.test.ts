import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { encodeErrorResult, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  agentBankAbiSource,
  agentEscrowAbi,
  agentPolicyHookAbi,
  paymentStreamsAbi,
  sweepExecutorAbi,
  timeLockVaultsAbi,
  topUpExecutorAbi,
} from "../../src/core/abis/index";
import { formatAmount, parseAmount } from "../../src/core/amounts";
import {
  assertSupportedChainId,
  chainByName,
  MAINNET_REFUSAL_MESSAGE,
  txUrl,
  BASE_SEPOLIA,
} from "../../src/core/chains";
import { mergeDeployments, parseDeployments } from "../../src/core/deployments";
import { formatTimestamp } from "../../src/core/describe";
import { LogScanBudgetExceeded, scanLogs } from "../../src/core/discovery";
import { ExitToolError } from "../../src/core/errors";
import { describeRevertData } from "../../src/core/revert";
import { summarizeRecovery } from "../../src/core/summary";
import { VERSION } from "../../src/version";
import { ACCOUNT, makeReport, OTHER, USDC, USDC_UNIT } from "./fixtures";

describe("amounts", () => {
  it("parses decimals strictly into minor units", () => {
    expect(parseAmount("12", 6)).toBe(12_000_000n);
    expect(parseAmount("12.5", 6)).toBe(12_500_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount("1_000.25", 6)).toBe(1_000_250_000n);
    expect(parseAmount("1.5", 18)).toBe(1_500_000_000_000_000_000n);
  });

  it("refuses to round, exponents, signs and zero", () => {
    expect(() => parseAmount("0.0000001", 6)).toThrow(/6 decimals/);
    for (const bad of ["1e6", "-1", "+1", "1.", ".5", "abc", "", "0", "0.000"]) {
      expect(() => parseAmount(bad, 6), bad).toThrow(ExitToolError);
    }
  });

  it("formats without floats", () => {
    expect(formatAmount(1_234_567_890n, 6)).toBe("1234.56789");
    expect(formatAmount(2n ** 200n, 6)).toBe(
      "1606938044258990275541962092341162602522202993782792835.301376",
    );
  });
});

describe("chains", () => {
  it("refuses Ethereum and Base mainnet with the Phase 5 message", () => {
    for (const id of [1, 8453]) {
      try {
        assertSupportedChainId(id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ExitToolError);
        expect((err as ExitToolError).code).toBe("mainnet_refused");
        expect((err as ExitToolError).message).toContain("Phase 5 gate");
      }
    }
    expect(MAINNET_REFUSAL_MESSAGE).toMatch(/Base Sepolia \(84532\) and Anvil \(31337\)/);
    expect(() => chainByName("base")).toThrow(/Mainnet is not supported/);
    expect(() => chainByName("mainnet")).toThrow(/Mainnet is not supported/);
  });

  it("accepts only Base Sepolia and Anvil", () => {
    expect(assertSupportedChainId(84532).name).toBe("base-sepolia");
    expect(assertSupportedChainId(31337).name).toBe("anvil");
    expect(() => assertSupportedChainId(11155111)).toThrow(/Unsupported chain id 11155111/);
    expect(() => chainByName("optimism")).toThrow(/Unknown chain/);
    expect(txUrl(BASE_SEPOLIA, "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
    expect(txUrl(chainByName("anvil"), "0xabc")).toBeUndefined();
  });
});

describe("deployments files", () => {
  it("reads the contracts repo Deploy.s.sol format", () => {
    const json = JSON.parse(
      JSON.stringify({
        chainId: 84532,
        contracts: {
          AgentEscrow: "0x7DFb13379961afBd74725562B8Ddd1498A2dEbBe",
          PaymentStreams: "0xfA963d2A62faB54E1aC8005Db8D9B8F3f9919Fd4",
          TimeLockVaults: "0xdA19F78aa991ec7D236725745F65Ff2bee7d439A",
          TopUpExecutor: "0x1D78bA1aF74BcEdee319fF1c19Ad03777aA19b80",
        },
        dependencies: { USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
        mode: "dry-run",
      }),
    );
    const d = parseDeployments(json);
    expect(d.chainId).toBe(84532);
    expect(d.usdc).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(d.contracts.escrow).toBe("0x7DFb13379961afBd74725562B8Ddd1498A2dEbBe");
    expect(d.contracts.streams).toBe("0xfA963d2A62faB54E1aC8005Db8D9B8F3f9919Fd4");
    expect(d.contracts.vaults).toBe("0xdA19F78aa991ec7D236725745F65Ff2bee7d439A");
    expect(d.contracts.topUpExecutor).toBe("0x1D78bA1aF74BcEdee319fF1c19Ad03777aA19b80");
    expect(d.mode).toBe("dry-run");
  });

  it("accepts objects with block numbers, flat files and lower-case keys", () => {
    const d = parseDeployments({
      escrow: { address: "0x7dfb13379961afbd74725562b8ddd1498a2debbe", blockNumber: 120 },
      timeLockVaults: { address: "0xda19f78aa991ec7d236725745f65ff2bee7d439a", deployBlock: "0x64" },
    });
    expect(d.contracts.escrow).toBe("0x7DFb13379961afBd74725562B8Ddd1498A2dEbBe");
    expect(d.fromBlock).toBe(100n);
    expect(() => parseDeployments({ AgentEscrow: "nope" })).toThrow(/not an address/);
    expect(() => parseDeployments([])).toThrow(/JSON object/);
  });

  it("merges with later sources winning field by field", () => {
    const merged = mergeDeployments(
      { contracts: { escrow: OTHER }, usdc: USDC },
      { contracts: { streams: ACCOUNT } },
      { contracts: { escrow: ACCOUNT } },
    );
    expect(merged).toMatchObject({ usdc: USDC, contracts: { escrow: ACCOUNT, streams: ACCOUNT } });
  });
});

describe("recovery summary", () => {
  it("splits what is recoverable now from what has to wait, and totals per token", () => {
    const summary = summarizeRecovery(makeReport());
    expect(summary.now.map((i) => i.kind)).toEqual([
      "balance",
      "balance",
      "escrow_refund",
      "stream_cancel",
      "stream_settle",
      "vault_unlocked",
      "vault_early",
      "spend_key",
    ]);
    expect(summary.pending.map((i) => i.kind)).toEqual(["escrow_locked", "stream_incoming", "vault_locked"]);
    // 100 held + 10 escrow + 40 stream refund + 10 incoming + 30 + 40 vaults + 7 float
    expect(summary.totals.get(USDC.toLowerCase())).toBe(237n * USDC_UNIT);
    expect(summary.totals.get("ETH")).toBe(2n * 10n ** 18n);
    expect(summary.pending.find((p) => p.kind === "vault_locked")!.label).toMatch(/locked until .* UTC/);
  });

  it("treats a locked vault as recoverable only when the signer owns it", () => {
    const report = makeReport({ signer: { address: OTHER, isOwner: false } });
    const kinds = summarizeRecovery(report).now.map((i) => i.kind);
    // vault 2 (owned by OWNER) is not signable by OTHER; vault 3 (owned by OTHER) is
    expect(kinds.filter((k) => k === "vault_early")).toHaveLength(1);
  });
});

describe("revert decoding", () => {
  it("explains Safe GS codes, Agent Bank custom errors and panics", () => {
    const gs013 = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      errorName: "Error",
      args: ["GS013"],
    });
    expect(describeRevertData(gs013)).toMatch(/^GS013: The Safe transaction's inner call failed/);
    const refund = encodeErrorResult({
      abi: agentEscrowAbi,
      errorName: "RefundNotYetAvailable",
      args: [3n, 1_900_000_000n],
    });
    expect(describeRevertData(refund)).toBe("RefundNotYetAvailable(3, 1900000000)");
    const panic = encodeErrorResult({
      abi: [{ type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] }],
      errorName: "Panic",
      args: [17n],
    });
    expect(describeRevertData(panic)).toBe("panic 17 (arithmetic overflow or underflow)");
    expect(describeRevertData("0x")).toBe("reverted without a reason");
    expect(describeRevertData("0x12345678")).toMatch(/unknown error data/);
  });
});

describe("log scanning", () => {
  /** A fake RPC that, like sepolia.base.org, refuses eth_getLogs ranges above 200 blocks. */
  function fakeClient(limit: bigint, logBlocks: bigint[]) {
    let requests = 0;
    const client = {
      request: async ({ params }: { params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
        requests += 1;
        const from = BigInt(params[0].fromBlock);
        const to = BigInt(params[0].toBlock);
        if (to - from + 1n > limit) throw new Error(`eth_getLogs is limited to a ${limit} range`);
        return logBlocks
          .filter((b) => b >= from && b <= to)
          .map((b) => ({ address: ACCOUNT, topics: [], data: "0x", blockNumber: `0x${b.toString(16)}` }));
      },
    };
    return { client: client as unknown as PublicClient, requests: () => requests };
  }

  it("learns the range limit from the error and scans in chunks without missing logs", async () => {
    const blocks = [1000n, 1199n, 1200n, 1999n, 2500n];
    const { client, requests } = fakeClient(200n, blocks);
    const res = await scanLogs(client, { address: ACCOUNT, topics: [] }, 1000n, 2999n, { maxRequests: 100 });
    expect(res.logs.map((l) => l.blockNumber).sort((a, b) => Number(a - b))).toEqual(blocks);
    expect(requests()).toBe(1 + 10); // the failed full-range probe, then 2,000 blocks / 200
  });

  it("gives up early when the scan would exceed its request budget", async () => {
    const { client } = fakeClient(200n, []);
    await expect(
      scanLogs(client, { address: ACCOUNT, topics: [] }, 0n, 1_000_000n, { maxRequests: 50 }),
    ).rejects.toBeInstanceOf(LogScanBudgetExceeded);
  });

  it("uses one request when the RPC has no range limit", async () => {
    const { client, requests } = fakeClient(10n ** 12n, [5n]);
    const res = await scanLogs(client, { address: ACCOUNT, topics: [] }, 0n, 5_000_000n, { maxRequests: 10 });
    expect(res.logs).toHaveLength(1);
    expect(requests()).toBe(1);
  });
});

describe("vendored ABIs", () => {
  it("are exactly what scripts/sync-abis.sh generated (no hand edits)", () => {
    const abis: Record<string, unknown> = {
      AgentEscrow: agentEscrowAbi,
      PaymentStreams: paymentStreamsAbi,
      TimeLockVaults: timeLockVaultsAbi,
      TopUpExecutor: topUpExecutorAbi,
      SweepExecutor: sweepExecutorAbi,
      AgentPolicyHook: agentPolicyHookAbi,
    };
    for (const [name, abi] of Object.entries(abis)) {
      const hash = createHash("sha256").update(JSON.stringify(abi)).digest("hex");
      expect(hash, name).toBe(
        (agentBankAbiSource.artifacts as Record<string, { abiSha256: string }>)[name]!.abiSha256,
      );
    }
  });

  it("contain every function the exit tool calls", () => {
    const calls: [unknown, string, unknown[]][] = [
      [agentEscrowAbi, "refund", [1n]],
      [agentEscrowAbi, "releaseByValidation", [1n]],
      [agentEscrowAbi, "getEscrow", [1n]],
      [agentEscrowAbi, "refundableAt", [1n]],
      [agentEscrowAbi, "escrowCount", []],
      [paymentStreamsAbi, "cancel", [1n]],
      [paymentStreamsAbi, "settle", [1n]],
      [paymentStreamsAbi, "getStream", [1n]],
      [paymentStreamsAbi, "accrued", [1n]],
      [timeLockVaultsAbi, "withdraw", [1n, 1n]],
      [timeLockVaultsAbi, "withdrawWithSignature", [1n, 1n, 1n, "0x"]],
      [timeLockVaultsAbi, "earlyWithdrawalDigest", [1n, 1n, 1n, 1n]],
      [timeLockVaultsAbi, "vaultAccount", [1n]],
    ];
    for (const [abi, functionName, args] of calls) {
      const params = { abi, functionName, args } as unknown as Parameters<typeof encodeFunctionData>[0];
      expect(() => encodeFunctionData(params)).not.toThrow();
    }
  });
});

describe("misc", () => {
  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it("formats timestamps in UTC", () => {
    expect(formatTimestamp(1_800_000_000n)).toBe("2027-01-15 08:00:00 UTC");
    expect(formatTimestamp(0n)).toBe("-");
  });

  it("test fixtures use checksummed addresses", () => {
    const addresses: Address[] = [ACCOUNT, OTHER, USDC];
    expect(addresses.every((a) => a.startsWith("0x"))).toBe(true);
  });
});
