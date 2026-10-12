/**
 * Opt-in (RUN_FORK_TESTS=1): the exit tool against a local Anvil FORK of Base Sepolia, so it meets
 * the real deployed contracts: canonical Safe v1.4.1, the real Safe7579 adapter code, Candide's
 * SocialRecoveryModule (72 h, guardian recovery per contracts ADR 0002), the canonical
 * MultiSendCallOnly and Circle's FiatToken USDC. Nothing is ever sent to Base Sepolia itself: the
 * fork is local and only reads public state through the RPC.
 *
 *   RUN_FORK_TESTS=1 [BASE_SEPOLIA_RPC_URL=…] [BASE_SEPOLIA_FORK_BLOCK=…] pnpm test:integration
 */
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_SEPOLIA } from "../../src/core/chains";
import { SAFE7579_ADAPTER, SAFE_V141 } from "../../src/core/constants";
import { CANDIDE_RECOVERY_MODULES, socialRecoveryModuleAbi } from "../../src/core/recovery";
import { findAnvil, startAnvil, type AnvilInstance } from "./anvil";
import {
  accounts,
  clients,
  createSafe,
  ownerExec,
  runCli,
  SAFE_ARTIFACTS,
  send,
  type Clients,
} from "./harness";

const enabled = process.env.RUN_FORK_TESTS === "1" && findAnvil() !== undefined;
if (process.env.RUN_FORK_TESTS !== "1") {
  console.warn(
    "Base Sepolia fork tests skipped (set RUN_FORK_TESTS=1 to run them; they need network access).",
  );
}

const RPC = process.env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA.defaultRpcUrl;
const FORK_BLOCK = process.env.BASE_SEPOLIA_FORK_BLOCK || "48000000";
const RECOVERY = CANDIDE_RECOVERY_MODULES[0]!.address; // 72 hours
const USDC = BASE_SEPOLIA.usdc!;
const DESTINATION = getAddress(keccak256(toHex("agentbank-exit fork destination")).slice(0, 42));
const NEW_OWNER = getAddress(keccak256(toHex("agentbank-exit fork recovery target")).slice(0, 42));
const ownerEnv = { OWNER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" };

const fiatTokenAbi = parseAbi([
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

describe.skipIf(!enabled)("Base Sepolia fork: real Safe7579, Candide recovery module and USDC", () => {
  let anvil: AnvilInstance;
  let c: Clients;
  let safe: Address;
  const base = () => ["--rpc-url", anvil.rpcUrl, "--chain", "base-sepolia", "--account", safe];

  beforeAll(async () => {
    anvil = await startAnvil(["--fork-url", RPC, "--fork-block-number", FORK_BLOCK]);
    c = clients(anvil.rpcUrl, 84532);

    // An Agent Bank-style account on the real contracts: 7579 adapter as module and fallback handler,
    // a bank-controlled module, and guardian recovery with 3 guardians (one of them the bank), threshold 2.
    safe = await createSafe(c, [accounts.owner.address], 1n, SAFE7579_ADAPTER, BigInt(Date.now()));
    const safeAbi = SAFE_ARTIFACTS.safeL2.abi;
    const call = (
      abi: typeof safeAbi | typeof socialRecoveryModuleAbi,
      functionName: string,
      args: unknown[],
    ) => encodeFunctionData({ abi, functionName, args } as never) as Hex;
    await ownerExec(c, safe, safe, call(safeAbi, "enableModule", [SAFE7579_ADAPTER]));
    await ownerExec(c, safe, safe, call(safeAbi, "enableModule", [RECOVERY]));
    await ownerExec(c, safe, safe, call(safeAbi, "enableModule", [accounts.bank.address]));
    await ownerExec(
      c,
      safe,
      RECOVERY,
      call(socialRecoveryModuleAbi, "addGuardianWithThreshold", [accounts.payee.address, 1n]),
    );
    await ownerExec(
      c,
      safe,
      RECOVERY,
      call(socialRecoveryModuleAbi, "addGuardianWithThreshold", [accounts.payee2.address, 2n]),
    );
    await ownerExec(
      c,
      safe,
      RECOVERY,
      call(socialRecoveryModuleAbi, "addGuardianWithThreshold", [accounts.guardian.address, 2n]),
    );

    // Real FiatToken USDC, minted the way Circle's minters do (impersonating the master minter).
    const masterMinter = (await c.publicClient.readContract({
      address: USDC,
      abi: fiatTokenAbi,
      functionName: "masterMinter",
    })) as Address;
    await c.test.setBalance({ address: masterMinter, value: parseEther("1") });
    await c.test.impersonateAccount({ address: masterMinter });
    const minter = accounts.relayer.address;
    const viaRpc = async (from: Address, to: Address, data: Hex) => {
      const hash = (await c.publicClient.request({
        method: "eth_sendTransaction" as never,
        params: [{ from, to, data }] as never,
      })) as Hex;
      await c.publicClient.waitForTransactionReceipt({ hash });
    };
    await viaRpc(
      masterMinter,
      USDC,
      encodeFunctionData({ abi: fiatTokenAbi, functionName: "configureMinter", args: [minter, 10n ** 12n] }),
    );
    await send(
      c,
      "relayer",
      USDC,
      encodeFunctionData({ abi: fiatTokenAbi, functionName: "mint", args: [safe, 500_000_000n] }),
    );
    await send(c, "deployer", safe, "0x", parseEther("1"));

    // Two guardians start a recovery: it becomes executable after 72 hours unless the owner cancels.
    const confirm = (execute: boolean) =>
      encodeFunctionData({
        abi: socialRecoveryModuleAbi,
        functionName: "confirmRecovery",
        args: [safe, [NEW_OWNER], 1n, execute],
      });
    await send(c, "payee", RECOVERY, confirm(false));
    await send(c, "payee2", RECOVERY, confirm(true));
  });

  afterAll(async () => {
    await anvil?.stop();
  });

  it("recognises the audited recovery module by address and code, with guardians and the pending recovery", async () => {
    const run = await runCli(["inspect", ...base(), "--json"]);
    expect(run.code, run.stderr + run.stdout).toBe(0);
    const report = run.json!.report as {
      recovery: { module: string; guardians: string[]; threshold: string; pending?: { newOwners: string[] } };
      findings: { code: string; severity: string }[];
      safe: { modules: string[] };
      multiSendCallOnly?: string;
    };
    expect(getAddress(report.recovery.module)).toBe(RECOVERY);
    expect(report.recovery.guardians.map((g) => getAddress(g))).toEqual(
      expect.arrayContaining([accounts.payee.address, accounts.payee2.address, accounts.guardian.address]),
    );
    expect(report.recovery.threshold).toBe("2");
    expect(report.recovery.pending!.newOwners.map((o) => getAddress(o))).toEqual([NEW_OWNER]);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining(["recovery_module", "recovery_pending", "fallback_7579", "module_enabled"]),
    );
    // The recovery module is not reported as a module that can move funds without the owner.
    expect(report.findings.filter((f) => f.code === "module_enabled")).toHaveLength(2);
    expect(getAddress(report.multiSendCallOnly!)).toBe(SAFE_V141.multiSendCallOnly);
  });

  it("disable-modules keeps the recovery module; exit empties the account; --include-recovery removes it", async () => {
    const revoke = await runCli(["disable-modules", ...base(), "--execute", "--yes", "--json"], ownerEnv);
    expect(revoke.code, revoke.stderr + revoke.stdout).toBe(0);
    const modules = async () =>
      (
        (await c.publicClient.readContract({
          address: safe,
          abi: SAFE_ARTIFACTS.safeL2.abi,
          functionName: "getModulesPaginated",
          args: ["0x0000000000000000000000000000000000000001", 10n],
        })) as [Address[], Address]
      )[0];
    expect(await modules()).toEqual([RECOVERY]);

    const exit = await runCli(
      ["exit", ...base(), "--to", DESTINATION, "--execute", "--yes", "--json"],
      ownerEnv,
    );
    expect(exit.code, exit.stderr + exit.stdout).toBe(0);
    expect(
      await c.publicClient.readContract({
        address: USDC,
        abi: fiatTokenAbi,
        functionName: "balanceOf",
        args: [DESTINATION],
      }),
    ).toBe(500_000_000n);
    expect(await c.publicClient.getBalance({ address: DESTINATION })).toBe(parseEther("1"));
    expect(await modules()).toEqual([RECOVERY]);

    const all = await runCli(
      ["disable-modules", ...base(), "--include-recovery", "--execute", "--yes"],
      ownerEnv,
    );
    expect(all.code, all.stderr + all.stdout).toBe(0);
    expect(await modules()).toEqual([]);
  });
});
