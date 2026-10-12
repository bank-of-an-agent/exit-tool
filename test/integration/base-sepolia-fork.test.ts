/**
 * Opt-in (RUN_FORK_TESTS=1): the exit tool against a local Anvil FORK of Base Sepolia, so it meets
 * the real deployed contracts: canonical Safe v1.4.1, the real Safe7579 adapter code, Candide's
 * SocialRecoveryModule (72 h, guardian recovery per contracts ADR 0002), Rhinestone's
 * OwnableValidator (module release V1), the canonical MultiSendCallOnly and Circle's FiatToken USDC.
 * Nothing is ever sent to Base Sepolia itself: the fork is local and only reads public state through
 * the RPC.
 *
 *   RUN_FORK_TESTS=1 [BASE_SEPOLIA_RPC_URL=…] [BASE_SEPOLIA_FORK_BLOCK=…] pnpm test:integration
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseEther,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_SEPOLIA } from "../../src/core/chains";
import { SAFE7579_ADAPTER, SAFE_V141 } from "../../src/core/constants";
import { CANDIDE_RECOVERY_MODULES, socialRecoveryModuleAbi } from "../../src/core/recovery";
import { ownableValidatorAbi } from "../../src/core/abis/index";
import { OWNABLE_VALIDATORS } from "../../src/core/validator";
import { findAnvil, startAnvil, type AnvilInstance } from "./anvil";
import {
  accounts,
  clients,
  createSafe,
  DEV_KEYS,
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

const VALIDATOR = OWNABLE_VALIDATORS[0]!.address; // Rhinestone OwnableValidator, module release V1
const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"; // ERC-4337 v0.7

/** Safe7579 adapter setup and ERC-4337 validation (selectors checked against the deployed adapter). */
const safe7579Abi = parseAbi([
  "struct ModuleInit { address module; bytes initData; }",
  "function initializeAccountWithValidators(ModuleInit[] validators)",
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function validateUserOp(PackedUserOperation userOp, bytes32 userOpHash, uint256 missingAccountFunds) returns (uint256 validationData)",
]);
const finalizeRecoveryAbi = parseAbi(["function finalizeRecovery(address wallet)"]);

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
  it("sync-owner: after a guardian recovery the OwnableValidator follows the Safe's new owner", async () => {
    // The owner lost their key; guardians recover the account to a new one (Anvil dev key #8 here).
    const newKey = accounts.otherAgent;
    const account = await createSafe(
      c,
      [accounts.owner.address],
      1n,
      SAFE7579_ADAPTER,
      BigInt(Date.now()) + 7n,
    );
    const args = () => ["--rpc-url", anvil.rpcUrl, "--chain", "base-sepolia", "--account", account];
    const safeAbi = SAFE_ARTIFACTS.safeL2.abi;
    const exec = (to: Address, data: Hex) => ownerExec(c, account, to, data);
    await exec(
      account,
      encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [SAFE7579_ADAPTER] }),
    );
    // What the Safe7579 launchpad does for an Agent Bank account: the adapter lists the OwnableValidator
    // (initializeAccountWithValidators only records it) and the account installs it with
    // {threshold 1, owners [owner]}.
    const initData = encodeAbiParameters(parseAbiParameters("uint256, address[]"), [
      1n,
      [accounts.owner.address],
    ]);
    await exec(
      account,
      encodeFunctionData({
        abi: safe7579Abi,
        functionName: "initializeAccountWithValidators",
        args: [[{ module: VALIDATOR, initData }]],
      }),
    );
    await exec(
      VALIDATOR,
      encodeFunctionData({ abi: ownableValidatorAbi, functionName: "onInstall", args: [initData] }),
    );
    await exec(account, encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [RECOVERY] }));
    for (const [guardian, threshold] of [
      [accounts.payee.address, 1n],
      [accounts.payee2.address, 2n],
    ] as const) {
      await exec(
        RECOVERY,
        encodeFunctionData({
          abi: socialRecoveryModuleAbi,
          functionName: "addGuardianWithThreshold",
          args: [guardian, threshold],
        }),
      );
    }
    const validatorOwners = () =>
      c.publicClient.readContract({
        address: VALIDATOR,
        abi: ownableValidatorAbi,
        functionName: "getOwners",
        args: [account],
      });
    expect(await validatorOwners()).toEqual([accounts.owner.address]);

    // An ERC-4337 owner operation as the EntryPoint validates it: through the account, the Safe7579
    // adapter and the validator selected by the nonce key. 0 means the signature is valid.
    const ownerOpValid = async (signer: PrivateKeyAccount): Promise<boolean> => {
      const userOpHash = keccak256(toHex(`agentbank-exit sync-owner ${signer.address}`));
      const userOp = {
        sender: account,
        nonce: hexToBigInt(VALIDATOR) << 96n,
        initCode: "0x" as Hex,
        callData: "0x" as Hex,
        accountGasLimits: zeroHash,
        preVerificationGas: 0n,
        gasFees: zeroHash,
        paymasterAndData: "0x" as Hex,
        signature: await signer.signMessage({ message: { raw: userOpHash } }),
      };
      const { data } = await c.publicClient.call({
        account: ENTRY_POINT,
        to: account,
        data: encodeFunctionData({
          abi: safe7579Abi,
          functionName: "validateUserOp",
          args: [userOp, userOpHash, 0n],
        }),
      });
      return hexToBigInt(data!) === 0n;
    };
    expect(await ownerOpValid(accounts.owner)).toBe(true);
    expect(await ownerOpValid(newKey)).toBe(false);

    // Two guardians recover the Safe to the new key; after 72 hours anyone finalizes it.
    for (const [role, execute] of [
      ["payee", false],
      ["payee2", true],
    ] as const) {
      await send(
        c,
        role,
        RECOVERY,
        encodeFunctionData({
          abi: socialRecoveryModuleAbi,
          functionName: "confirmRecovery",
          args: [account, [newKey.address], 1n, execute],
        }),
      );
    }
    await c.test.increaseTime({ seconds: 3 * 86_400 + 60 });
    await c.test.mine({ blocks: 1 });
    await send(
      c,
      "relayer",
      RECOVERY,
      encodeFunctionData({ abi: finalizeRecoveryAbi, functionName: "finalizeRecovery", args: [account] }),
    );
    expect(
      await c.publicClient.readContract({ address: account, abi: safeAbi, functionName: "getOwners" }),
    ).toEqual([newKey.address]);
    // The Safe changed hands, the validator did not: the lost key still passes owner operations.
    expect(await validatorOwners()).toEqual([accounts.owner.address]);
    expect(await ownerOpValid(accounts.owner)).toBe(true);
    expect(await ownerOpValid(newKey)).toBe(false);

    const inspect = await runCli(["inspect", ...args(), "--json"]);
    expect(inspect.code, inspect.stderr + inspect.stdout).toBe(0);
    const report = inspect.json!.report as {
      ownerValidators: { validator: string; owners: string[]; installed: boolean; inSync: boolean }[];
      findings: { code: string; severity: string; message: string }[];
    };
    expect(report.ownerValidators).toHaveLength(1);
    expect(report.ownerValidators[0]).toMatchObject({
      validator: VALIDATOR,
      owners: [accounts.owner.address],
      installed: true,
      inSync: false,
    });
    const differ = report.findings.find((f) => f.code === "validator_owners_differ");
    expect(differ?.severity).toBe("danger");
    expect(differ?.message).toMatch(/^Validator owners differ from Safe owners/);
    const text = await runCli(["inspect", ...args()]);
    expect(text.stdout).toContain("Validator owners differ from Safe owners");
    expect(text.stdout).toContain(`agentbank-exit sync-owner --account ${account}`);

    // The exit reports it as an informational step and does not touch the validator.
    const exitPlan = await runCli(["exit", ...args(), "--to", DESTINATION, "--json"]);
    expect(exitPlan.code, exitPlan.stderr + exitPlan.stdout).toBe(0);
    const plan = exitPlan.json!.plan as { info: string[]; steps: { call: { to: string } }[] };
    expect(plan.info).toHaveLength(1);
    expect(plan.info[0]).toMatch(/^Validator owners differ from Safe owners/);
    expect(plan.steps.some((st) => getAddress(st.call.to) === VALIDATOR)).toBe(false);

    // The lost key cannot run the sync: only the Safe's current owner signs it.
    const stale = await runCli(["sync-owner", ...args(), "--execute", "--yes", "--json"], {
      OWNER_PRIVATE_KEY: DEV_KEYS.owner,
    });
    expect(stale.code).toBe(1);
    expect((stale.json!.error as { code: string }).code).toBe("not_an_owner");

    // Dry run: addOwner(new), then removeOwner(prev = new, old), simulated as Safe transactions.
    const dry = await runCli(["sync-owner", ...args(), "--json"]);
    expect(dry.code, dry.stderr + dry.stdout).toBe(0);
    const drySteps = (dry.json!.plan as { steps: { call: { to: string; data: string } }[] }).steps;
    expect(drySteps.map((st) => getAddress(st.call.to))).toEqual([VALIDATOR, VALIDATOR]);
    expect(drySteps.map((st) => st.call.data)).toEqual([
      encodeFunctionData({ abi: ownableValidatorAbi, functionName: "addOwner", args: [newKey.address] }),
      encodeFunctionData({
        abi: ownableValidatorAbi,
        functionName: "removeOwner",
        args: [newKey.address, accounts.owner.address],
      }),
    ]);
    expect((dry.json!.simulation as { ok: boolean }).ok).toBe(true);
    expect(await validatorOwners()).toEqual([accounts.owner.address]); // a dry run changes nothing

    // Hardware-wallet path: two SafeTx payloads signed by the new key; submit checks the plan file
    // (validator recognised by its code hash, Safe owners read from the chain) and simulates it.
    const planFile = path.join(mkdtempSync(path.join(tmpdir(), "agentbank-exit-sync-")), "plan.json");
    const signerOnly = await runCli([
      "sync-owner",
      ...args(),
      "--signer-only",
      "--plan-file",
      planFile,
      "--json",
    ]);
    expect(signerOnly.code, signerOnly.stderr + signerOnly.stdout).toBe(0);
    const payloads = (signerOnly.json!.signerOnly as { payloads: { kind: string; typedData: unknown }[] })
      .payloads;
    expect(payloads.map((p) => p.kind)).toEqual(["SafeTx", "SafeTx"]);
    const signatures: string[] = [];
    for (const p of payloads) {
      signatures.push(
        (await c.publicClient.request({
          method: "eth_signTypedData_v4" as never,
          params: [newKey.address, JSON.stringify(p.typedData)] as never,
        })) as string,
      );
    }
    const submitted = await runCli([
      "submit",
      ...args(),
      "--plan-file",
      planFile,
      ...signatures.flatMap((sig) => ["--signature", sig]),
    ]);
    expect(submitted.code, submitted.stderr + submitted.stdout).toBe(0);
    expect(submitted.stdout).toContain(
      `Add Safe owner ${newKey.address} to the owners of validator ${VALIDATOR}`,
    );
    expect(submitted.stdout).toContain(
      `Remove ${accounts.owner.address} (not a Safe owner) from the owners of validator ${VALIDATOR}`,
    );
    expect(submitted.stdout).toContain("Ready. Send these transactions");

    const run = await runCli(["sync-owner", ...args(), "--execute", "--yes", "--json"], {
      OWNER_PRIVATE_KEY: DEV_KEYS.otherAgent,
    });
    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect((run.json!.execution as { status: string }[]).map((e) => e.status)).toEqual([
      "confirmed",
      "confirmed",
    ]);
    expect(await validatorOwners()).toEqual([newKey.address]);
    expect(
      await c.publicClient.readContract({
        address: VALIDATOR,
        abi: ownableValidatorAbi,
        functionName: "threshold",
        args: [account],
      }),
    ).toBe(1n);
    // Owner operations now need the new key; the lost one is refused.
    expect(await ownerOpValid(newKey)).toBe(true);
    expect(await ownerOpValid(accounts.owner)).toBe(false);

    const after = await runCli(["inspect", ...args(), "--json"]);
    const afterReport = after.json!.report as typeof report;
    expect(afterReport.ownerValidators[0]!.inSync).toBe(true);
    expect(afterReport.findings.some((f) => f.code === "validator_owners_differ")).toBe(false);
    const again = await runCli(["sync-owner", ...args()]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Nothing to do.");
  });
});
