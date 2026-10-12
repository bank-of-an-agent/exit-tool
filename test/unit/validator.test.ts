import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it } from "vitest";
import { ownableValidatorAbi, safe7579ValidatorsAbi } from "../../src/core/abis/index";
import { SAFE7579_ADAPTER, SENTINEL, ZERO_ADDRESS } from "../../src/core/constants";
import { ExitToolError } from "../../src/core/errors";
import { validatorFindings } from "../../src/core/inspect";
import { assertDestination, planExit, planSyncOwner } from "../../src/core/plan";
import { verifyPlanSteps, type TrustedPlanContext } from "../../src/core/planfile";
import { safeTxForCall } from "../../src/core/safe";
import type { MaterializedStep } from "../../src/core/simulate";
import {
  compareValidator,
  OWNABLE_VALIDATORS,
  OWNABLE_VALIDATOR_MAX_OWNERS,
  readOwnerValidators,
  syncOwnerCalls,
  type OwnerValidatorState,
} from "../../src/core/validator";
import { ACCOUNT, makeReport, OTHER, OWNER } from "./fixtures";

const VALIDATOR = OWNABLE_VALIDATORS[0]!.address;
const NEW_OWNER: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const DEST: Address = "0x00000000000000000000000000000000000000d5";
const POOL: Address[] = Array.from({ length: 8 }, (_, i) =>
  getAddress(keccak256(toHex(`owner ${i}`)).slice(0, 42)),
);

/**
 * The OwnableValidator (module release V1) owner bookkeeping for one account: a SentinelList with
 * head insertion, `removeOwner` refusing to go down to the threshold, `setThreshold` bounded by the
 * owner count, at most 32 owners. Mirrors the deployed contract's checks and revert reasons.
 */
class ValidatorModel {
  constructor(
    public owners: Address[],
    public threshold: bigint,
  ) {}

  apply(data: Hex): void {
    const d = decodeFunctionData({ abi: ownableValidatorAbi, data });
    switch (d.functionName) {
      case "addOwner": {
        const owner = d.args[0];
        if (owner === ZERO_ADDRESS) throw new Error("InvalidOwner");
        if (this.owners.length >= OWNABLE_VALIDATOR_MAX_OWNERS) throw new Error("MaxOwnersReached");
        if (this.owners.some((o) => o.toLowerCase() === owner.toLowerCase()))
          throw new Error("LinkedList_EntryAlreadyInList");
        this.owners.unshift(getAddress(owner));
        return;
      }
      case "removeOwner": {
        const [prev, owner] = d.args;
        if (BigInt(this.owners.length) === this.threshold) throw new Error("CannotRemoveOwner");
        const index = this.owners.findIndex((o) => o.toLowerCase() === owner.toLowerCase());
        const actualPrev = index === 0 ? SENTINEL : this.owners[index - 1];
        if (index < 0 || actualPrev?.toLowerCase() !== prev.toLowerCase())
          throw new Error("LinkedList_InvalidEntry");
        this.owners.splice(index, 1);
        return;
      }
      case "setThreshold": {
        const t = d.args[0];
        if (t === 0n || t > BigInt(this.owners.length)) throw new Error("InvalidThreshold");
        this.threshold = t;
        return;
      }
      default:
        throw new Error(`unexpected ${d.functionName}`);
    }
  }
}

function state(
  owners: readonly Address[],
  threshold: bigint,
  safe: { owners: readonly Address[]; threshold: bigint },
  installed: boolean | undefined = true,
): OwnerValidatorState {
  return compareValidator(
    {
      validator: VALIDATOR,
      label: OWNABLE_VALIDATORS[0]!.label,
      known: true,
      owners: [...owners],
      threshold,
      ...(installed !== undefined ? { installed } : {}),
    },
    safe,
  );
}

/** A tiny deterministic PRNG, so the property test is reproducible. */
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

describe("validator owner sync planning", () => {
  it("rotates a 1-of-1 validator after a guardian recovery: addOwner(new), then removeOwner(new, old)", () => {
    const s = state([OWNER], 1n, { owners: [NEW_OWNER], threshold: 1n });
    expect(s).toMatchObject({ inSync: false, missing: [NEW_OWNER], stale: [OWNER] });
    const calls = syncOwnerCalls(s);
    expect(calls).toEqual([
      { fn: "addOwner", owner: NEW_OWNER },
      // addOwner inserts at the head, so the old owner now follows the new one.
      { fn: "removeOwner", prev: NEW_OWNER, owner: OWNER },
    ]);

    const report = makeReport({ ownerValidators: [s] });
    report.safe = { ...report.safe, owners: [NEW_OWNER] };
    const { steps, skipped, info } = planSyncOwner(report);
    expect(skipped).toEqual([]);
    // Sessions and executors are not the validator's business: the plan says so.
    expect(info).toHaveLength(1);
    expect(info[0]).toMatch(/session keys/);
    expect(steps.map((st) => st.id)).toEqual([
      `validator-add-owner:${VALIDATOR}:${NEW_OWNER}`,
      `validator-remove-owner:${VALIDATOR}:${OWNER}`,
    ]);
    for (const st of steps) {
      // Safe transactions (execTransaction, signed by the current Safe owner), CALLs to the validator.
      expect(st).toMatchObject({ via: "safe", category: "configure", amount: { kind: "none" } });
      expect(st.operation).toBeUndefined();
      expect(st.moves).toBeUndefined();
      const call = st.build(0n);
      expect(call.to).toBe(VALIDATOR);
      expect(call.value).toBe(0n);
    }
    expect(decodeFunctionData({ abi: ownableValidatorAbi, data: steps[0]!.build(0n).data })).toMatchObject({
      functionName: "addOwner",
      args: [NEW_OWNER],
    });
    expect(steps[0]!.build(0n).data).toBe(
      encodeFunctionData({ abi: ownableValidatorAbi, functionName: "addOwner", args: [NEW_OWNER] }),
    );
    expect(decodeFunctionData({ abi: ownableValidatorAbi, data: steps[1]!.build(0n).data })).toMatchObject({
      functionName: "removeOwner",
      args: [NEW_OWNER, OWNER],
    });
    expect(steps[1]!.title).toContain("not a Safe owner");

    // The same calls against the validator's own bookkeeping end on exactly the Safe's owner.
    const model = new ValidatorModel([OWNER], 1n);
    for (const st of steps) model.apply(st.build(0n).data);
    expect(model.owners).toEqual([NEW_OWNER]);
    expect(model.threshold).toBe(1n);
  });

  it("would fail if it removed before adding (why the order matters)", () => {
    const model = new ValidatorModel([OWNER], 1n);
    expect(() =>
      model.apply(
        encodeFunctionData({
          abi: ownableValidatorAbi,
          functionName: "removeOwner",
          args: [SENTINEL, OWNER],
        }),
      ),
    ).toThrow("CannotRemoveOwner");
  });

  it("lowers the threshold before removing, raises it to the Safe's, and keeps owners the Safe still has", () => {
    // 2-of-2 validator, Safe recovered to 1-of-1: removing would hit CannotRemoveOwner without setThreshold.
    const lower = state([POOL[0]!, POOL[1]!], 2n, { owners: [POOL[2]!], threshold: 1n });
    expect(syncOwnerCalls(lower).map((c) => c.fn)).toEqual([
      "addOwner",
      "setThreshold",
      "removeOwner",
      "removeOwner",
    ]);
    // 1-of-1 validator, Safe 2-of-3: the validator must not stay weaker than the Safe.
    const raise = state([POOL[0]!], 1n, { owners: [POOL[0]!, POOL[1]!, POOL[2]!], threshold: 2n });
    expect(syncOwnerCalls(raise)).toEqual([
      { fn: "addOwner", owner: POOL[1] },
      { fn: "addOwner", owner: POOL[2] },
      { fn: "setThreshold", threshold: 2n, previous: 1n },
    ]);
    // A stale owner in the middle of the list: prev is its predecessor.
    const middle = state([POOL[0]!, POOL[1]!, POOL[2]!], 1n, {
      owners: [POOL[0]!, POOL[2]!],
      threshold: 1n,
    });
    expect(syncOwnerCalls(middle)).toEqual([{ fn: "removeOwner", prev: POOL[0], owner: POOL[1] }]);
  });

  it("does nothing for a validator already equal to the Safe, and says so", () => {
    const s = state([OWNER], 1n, { owners: [OWNER], threshold: 1n });
    expect(s.inSync).toBe(true);
    expect(syncOwnerCalls(s)).toEqual([]);
    const { steps, skipped, info } = planSyncOwner(makeReport({ ownerValidators: [s] }));
    expect(steps).toEqual([]);
    expect(info).toEqual([]);
    expect(skipped[0]).toMatch(/already equal the Safe's owners/);
    // Same owners in another order are in sync; a different threshold is not.
    expect(state([POOL[1]!, POOL[0]!], 1n, { owners: [POOL[0]!, POOL[1]!], threshold: 1n }).inSync).toBe(
      true,
    );
    expect(state([POOL[1]!, POOL[0]!], 1n, { owners: [POOL[0]!, POOL[1]!], threshold: 2n }).inSync).toBe(
      false,
    );
  });

  it("always ends on exactly the Safe's owners and threshold, for any starting point (model check)", () => {
    const random = prng(0x5afe);
    const pick = (n: number): Address[] => {
      const shuffled = [...POOL].sort(() => random() - 0.5);
      return shuffled.slice(0, n);
    };
    for (let i = 0; i < 500; i++) {
      const vOwners = pick(1 + Math.floor(random() * 5));
      const vThreshold = BigInt(1 + Math.floor(random() * vOwners.length));
      const sOwners = pick(1 + Math.floor(random() * 4));
      const sThreshold = BigInt(1 + Math.floor(random() * sOwners.length));
      const s = state(vOwners, vThreshold, { owners: sOwners, threshold: sThreshold });
      const model = new ValidatorModel([...vOwners], vThreshold);
      for (const c of syncOwnerCalls(s)) {
        const data =
          c.fn === "addOwner"
            ? encodeFunctionData({ abi: ownableValidatorAbi, functionName: "addOwner", args: [c.owner] })
            : c.fn === "setThreshold"
              ? encodeFunctionData({
                  abi: ownableValidatorAbi,
                  functionName: "setThreshold",
                  args: [c.threshold],
                })
              : encodeFunctionData({
                  abi: ownableValidatorAbi,
                  functionName: "removeOwner",
                  args: [c.prev, c.owner],
                });
        model.apply(data);
      }
      expect(new Set(model.owners)).toEqual(new Set(sOwners));
      expect(model.owners).toHaveLength(sOwners.length);
      expect(model.threshold).toBe(sThreshold);
    }
  });

  it("refuses a sync that would exceed the validator's owner limit", () => {
    const many = Array.from({ length: 31 }, (_, i) => getAddress(keccak256(toHex(`v${i}`)).slice(0, 42)));
    const s = state(many, 1n, { owners: [POOL[0]!, POOL[1]!], threshold: 1n });
    expect(() => syncOwnerCalls(s)).toThrow(ExitToolError);
  });
});

describe("validator owners in inspect and exit", () => {
  const recovered = {
    owners: [NEW_OWNER],
    threshold: 1n,
    modules: [SAFE7579_ADAPTER],
    fallbackHandler: SAFE7579_ADAPTER,
  };

  it("is a danger while the adapter can still use the old key, info once it is disabled", () => {
    const s = state([OWNER], 1n, recovered);
    const [danger] = validatorFindings([s], recovered, ACCOUNT);
    expect(danger).toMatchObject({ severity: "danger", code: "validator_owners_differ" });
    expect(danger!.message).toMatch(/^Validator owners differ from Safe owners/);
    expect(danger!.message).toContain(`${OWNER} is not a Safe owner but can still authorize operations`);
    expect(danger!.message).toContain(`agentbank-exit sync-owner --account ${ACCOUNT}`);

    const [info] = validatorFindings([s], { ...recovered, modules: [] }, ACCOUNT);
    expect(info).toMatchObject({ severity: "info", code: "validator_owners_differ" });
    expect(info!.message).toContain("is not enabled");
    // The adapter still a module but no longer the fallback handler: ERC-4337 cannot reach it.
    const [noHandler] = validatorFindings([s], { ...recovered, fallbackHandler: ZERO_ADDRESS }, ACCOUNT);
    expect(noHandler).toMatchObject({ severity: "info" });
    expect(noHandler!.message).toContain("is not the fallback handler");
    // Not installed on the adapter: unreachable too.
    expect(validatorFindings([state([OWNER], 1n, recovered, false)], recovered, ACCOUNT)[0]!.severity).toBe(
      "info",
    );
    // Only the new owner missing (no stale key): the new owner cannot use owner operations.
    const missingOnly = state([OWNER], 1n, { owners: [OWNER, NEW_OWNER], threshold: 1n });
    const [warning] = validatorFindings([missingOnly], { ...recovered, owners: [OWNER, NEW_OWNER] }, ACCOUNT);
    expect(warning).toMatchObject({ severity: "warning" });
    expect(warning!.message).toContain(`${NEW_OWNER} cannot sign Agent Bank owner operations`);
    // In sync: nothing to report.
    expect(validatorFindings([state([NEW_OWNER], 1n, recovered)], recovered, ACCOUNT)).toEqual([]);
  });

  it("is an informational note of the exit, which changes nothing in the validator", () => {
    const s = state([OWNER], 1n, recovered);
    const report = makeReport({ ownerValidators: [s] });
    report.safe = { ...report.safe, owners: [NEW_OWNER] };
    const plan = planExit(report, { to: DEST });
    expect(plan.info).toHaveLength(1);
    expect(plan.info![0]).toMatch(/^Validator owners differ from Safe owners/);
    expect(plan.info![0]).toContain("it disables the Safe7579 adapter");
    // Already revoked: the note says so instead.
    const revoked = makeReport({ ownerValidators: [s] });
    revoked.safe = { ...revoked.safe, owners: [NEW_OWNER], modules: [] };
    expect(planExit(revoked, { to: DEST }).info![0]).toContain("the Safe7579 adapter is not enabled");
    expect(plan.steps.some((st) => st.category === "configure")).toBe(false);
    expect(plan.steps.some((st) => st.build(0n).to === VALIDATOR)).toBe(false);
    // In sync: no note.
    expect(
      planExit(makeReport({ ownerValidators: [state([OWNER], 1n, { owners: [OWNER], threshold: 1n })] }), {
        to: DEST,
      }).info,
    ).toEqual([]);
    // The validator is never a destination.
    expect(() => assertDestination(report, VALIDATOR)).toThrow(/not a wallet you control/);
  });
});

describe("validator calls in signed plan files", () => {
  const ATTACKER: Address = "0x00000000000000000000000000000000000bad00";
  const ctx: TrustedPlanContext = {
    account: ACCOUNT,
    contracts: {},
    compatibilityFallbackHandler: ZERO_ADDRESS,
    multiSendVerified: true,
    ownerValidators: [VALIDATOR],
    safe: { owners: [NEW_OWNER], threshold: 1n },
  };
  const step = (to: Address, data: Hex, value = 0n): MaterializedStep => {
    const call = { to, value, data };
    return {
      index: 1,
      id: "x",
      title: "Harmless",
      notes: ["trust me"],
      via: "safe",
      category: "configure",
      call,
      safeTx: safeTxForCall(call, 3n),
    };
  };
  const v = (fn: "addOwner" | "removeOwner" | "setThreshold" | "onInstall", args: unknown[]) =>
    encodeFunctionData({ abi: ownableValidatorAbi, functionName: fn, args } as never) as Hex;

  it("accepts exactly what sync-owner produces, with titles derived from the calldata", () => {
    const steps = [
      step(VALIDATOR, v("addOwner", [NEW_OWNER])),
      step(VALIDATOR, v("setThreshold", [1n])),
      step(VALIDATOR, v("removeOwner", [NEW_OWNER, OWNER])),
    ];
    verifyPlanSteps(steps, ctx);
    expect(steps.map((s) => s.title)).toEqual([
      `Add Safe owner ${NEW_OWNER} to the owners of validator ${VALIDATOR}`,
      `Set the threshold of validator ${VALIDATOR} to 1 (the Safe's)`,
      `Remove ${OWNER} (not a Safe owner) from the owners of validator ${VALIDATOR}`,
    ]);
  });

  it("refuses anything that does not move the validator towards the Safe's owners", () => {
    const bad: [string, MaterializedStep][] = [
      ["adding a key that is not a Safe owner", step(VALIDATOR, v("addOwner", [ATTACKER]))],
      ["removing a Safe owner", step(VALIDATOR, v("removeOwner", [SENTINEL, NEW_OWNER]))],
      ["another threshold", step(VALIDATOR, v("setThreshold", [2n]))],
      ["re-installing", step(VALIDATOR, v("onInstall", ["0x"]))],
      ["ETH along", step(VALIDATOR, v("addOwner", [NEW_OWNER]), 1n)],
      ["an untrusted validator", step(OTHER, v("addOwner", [NEW_OWNER]))],
    ];
    for (const [what, s] of bad) expect(() => verifyPlanSteps([s], ctx), what).toThrow(ExitToolError);
    // A validator the submit command does not know: refused, with the way to name it.
    expect(() => verifyPlanSteps([step(OTHER, v("addOwner", [NEW_OWNER]))], ctx)).toThrow(
      `pass --validator ${OTHER}`,
    );
    // Without the Safe's owners from the chain, nothing touching a validator is accepted.
    expect(() =>
      verifyPlanSteps([step(VALIDATOR, v("addOwner", [NEW_OWNER]))], { ...ctx, safe: undefined }),
    ).toThrow(ExitToolError);
  });
});

describe("reading validators", () => {
  /** A fake RPC for one account: an adapter list, and validators at given addresses with code. */
  function fakeClient(options: {
    code: Record<string, Hex>;
    initialized: Record<string, boolean>;
    owners: Record<string, Address[]>;
    thresholds: Record<string, bigint>;
    installed?: Address[];
  }): PublicClient {
    return {
      getCode: async ({ address }: { address: Address }) => options.code[address.toLowerCase()],
      readContract: async ({
        address,
        functionName,
        abi,
      }: {
        address: Address;
        functionName: string;
        abi: unknown;
      }) => {
        if (abi === safe7579ValidatorsAbi) {
          if (!options.installed) throw new Error("no adapter");
          return [options.installed, SENTINEL];
        }
        const key = address.toLowerCase();
        if (!(key in options.initialized)) throw new Error("execution reverted");
        if (functionName === "isInitialized") return options.initialized[key];
        if (functionName === "getOwners") return options.owners[key] ?? [];
        if (functionName === "threshold") return options.thresholds[key] ?? 0n;
        throw new Error(`unexpected ${functionName}`);
      },
    } as unknown as PublicClient;
  }

  it("never trusts code at a known address unless its hash matches the audited deployment", async () => {
    const key = VALIDATOR.toLowerCase();
    const client = fakeClient({
      code: { [key]: "0x6000" },
      initialized: { [key]: true },
      owners: { [key]: [OWNER] },
      thresholds: { [key]: 1n },
    });
    expect(await readOwnerValidators(client, ACCOUNT, { owners: [NEW_OWNER], threshold: 1n })).toEqual([]);
  });

  it("reads the validator named with --validator, and whether the adapter lists it", async () => {
    const custom: Address = "0x00000000000000000000000000000000000c0de0";
    const key = custom.toLowerCase();
    const client = fakeClient({
      code: { [key]: "0x6000" },
      initialized: { [key]: true },
      owners: { [key]: [OWNER] },
      thresholds: { [key]: 1n },
      installed: [custom],
    });
    const [s] = await readOwnerValidators(
      client,
      ACCOUNT,
      { owners: [NEW_OWNER], threshold: 1n },
      { validator: custom },
    );
    expect(s).toMatchObject({
      validator: getAddress(custom),
      known: false,
      installed: true,
      owners: [OWNER],
      missing: [NEW_OWNER],
      stale: [OWNER],
      inSync: false,
    });
    // Not initialized for the account: nothing to sync.
    const empty = fakeClient({
      code: { [key]: "0x6000" },
      initialized: { [key]: false },
      owners: {},
      thresholds: {},
    });
    expect(
      await readOwnerValidators(empty, ACCOUNT, { owners: [OWNER], threshold: 1n }, { validator: custom }),
    ).toEqual([]);
    // No code, or not an OwnableValidator at all: a clear error.
    await expect(
      readOwnerValidators(
        fakeClient({ code: {}, initialized: {}, owners: {}, thresholds: {} }),
        ACCOUNT,
        { owners: [OWNER], threshold: 1n },
        { validator: custom },
      ),
    ).rejects.toThrow(/no code/);
    await expect(
      readOwnerValidators(
        fakeClient({ code: { [key]: "0x6000" }, initialized: {}, owners: {}, thresholds: {} }),
        ACCOUNT,
        { owners: [OWNER], threshold: 1n },
        { validator: custom },
      ),
    ).rejects.toThrow(/not an OwnableValidator/);
  });
});
