import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ownableValidatorAbi, safe7579ValidatorsAbi } from "./abis/index";
import { SENTINEL } from "./constants";
import { ExitToolError } from "./errors";

/**
 * Agent Bank owner operations (ERC-4337, through the Safe7579 adapter) are validated by Rhinestone's
 * OwnableValidator, which keeps its own owner list and threshold per account, separately from the
 * Safe's owners. A guardian recovery replaces the Safe's owners only: the validator still lists the
 * old key, which can then still authorize operations through the adapter, while the new owner cannot.
 * `sync-owner` makes the validator match the Safe again over the Safe-native `execTransaction` path
 * (the validator keys its storage by `msg.sender`, which is then the account).
 *
 * Known deployments, recognised by address AND runtime code hash (read on Base Sepolia):
 * Agent Bank uses the module release V1 one; `--validator` names any other.
 */
export const OWNABLE_VALIDATORS: readonly { address: Address; label: string; codeHash: Hex }[] = [
  {
    address: "0x000000000013fdB5234E4E3162a810F54d9f7E98",
    label: "Rhinestone OwnableValidator (module release V1)",
    codeHash: "0x4194d92c6d0b18f35a865f2796c3a0b85b9af299c8110214dfae3f69bee60d11",
  },
  {
    address: "0x2483DA3A338895199E5e538530213157e931Bf06",
    label: "Rhinestone OwnableValidator (beta release)",
    codeHash: "0xd9ad90a204447aec1a1528d764e1d80212c8011dc0125b3995875e58ec9a43bf",
  },
];

/** OwnableValidator's per-account owner limit (`MAX_OWNERS`). */
export const OWNABLE_VALIDATOR_MAX_OWNERS = 32;

export interface OwnerValidatorState {
  validator: Address;
  label: string;
  /** A known deployment (address and code hash match), as opposed to one named with --validator. */
  known: boolean;
  /** The validator's owners for the account, in its list order (most recently added first). */
  owners: Address[];
  threshold: bigint;
  /** Whether the Safe7579 adapter lists it as an installed validator (absent when it cannot be asked). */
  installed?: boolean;
  /** Safe owners the validator lacks. */
  missing: Address[];
  /** Validator owners that are not Safe owners (any more). */
  stale: Address[];
  /** The Safe's threshold, which the validator's should equal. */
  safeThreshold: bigint;
  /** Same owners and the same threshold as the Safe. */
  inSync: boolean;
}

/** Compares a validator's owners and threshold with the Safe's. */
export function compareValidator(
  base: Pick<OwnerValidatorState, "validator" | "label" | "known" | "owners" | "threshold" | "installed">,
  safe: { owners: readonly Address[]; threshold: bigint },
): OwnerValidatorState {
  const owners = base.owners.map((o) => getAddress(o));
  const missing = safe.owners
    .filter((o) => !owners.some((v) => isAddressEqual(v, o)))
    .map((o) => getAddress(o));
  const stale = owners.filter((v) => !safe.owners.some((o) => isAddressEqual(o, v)));
  return {
    ...base,
    validator: getAddress(base.validator),
    owners,
    missing,
    stale,
    safeThreshold: safe.threshold,
    inSync: missing.length === 0 && stale.length === 0 && base.threshold === safe.threshold,
  };
}

/** Validators the Safe7579 adapter lists as installed for `account` (undefined if it cannot be asked). */
export async function installedValidators(
  client: PublicClient,
  account: Address,
  blockNumber?: bigint,
): Promise<Address[] | undefined> {
  try {
    const [validators] = await client.readContract({
      address: account,
      abi: safe7579ValidatorsAbi,
      functionName: "getValidatorsPaginated",
      args: [SENTINEL, 64n],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return validators.map((v) => getAddress(v));
  } catch {
    // Not answered: the adapter is not the fallback handler (any more), or the RPC failed.
    return undefined;
  }
}

/**
 * The account's OwnableValidator(s) compared with the Safe's owners: the one named with `--validator`,
 * otherwise every known deployment (address and code hash) that holds owners for the account.
 */
export async function readOwnerValidators(
  client: PublicClient,
  account: Address,
  safe: { owners: readonly Address[]; threshold: bigint },
  options: { validator?: Address; blockNumber?: bigint } = {},
): Promise<OwnerValidatorState[]> {
  const at = options.blockNumber !== undefined ? { blockNumber: options.blockNumber } : {};
  const installed = await installedValidators(client, account, options.blockNumber);
  const read = async (validator: Address, label: string, known: boolean): Promise<OwnerValidatorState> => {
    const [owners, threshold] = await Promise.all([
      client.readContract({
        address: validator,
        abi: ownableValidatorAbi,
        functionName: "getOwners",
        args: [account],
        ...at,
      }),
      client.readContract({
        address: validator,
        abi: ownableValidatorAbi,
        functionName: "threshold",
        args: [account],
        ...at,
      }),
    ]);
    return compareValidator(
      {
        validator,
        label,
        known,
        owners: [...owners],
        threshold,
        ...(installed ? { installed: installed.some((v) => isAddressEqual(v, validator)) } : {}),
      },
      safe,
    );
  };
  const isInitialized = (validator: Address) =>
    client.readContract({
      address: validator,
      abi: ownableValidatorAbi,
      functionName: "isInitialized",
      args: [account],
      ...at,
    });

  if (options.validator) {
    const validator = getAddress(options.validator);
    const code = await client.getCode({ address: validator, ...at });
    if (!code || code === "0x") {
      throw new ExitToolError("invalid_argument", `--validator ${validator} has no code on this chain.`);
    }
    const known = OWNABLE_VALIDATORS.find(
      (k) => isAddressEqual(k.address, validator) && keccak256(code) === k.codeHash,
    );
    let initialized: boolean;
    try {
      initialized = await isInitialized(validator);
    } catch (cause) {
      throw new ExitToolError(
        "invalid_argument",
        `--validator ${validator} does not answer isInitialized(account): it is not an OwnableValidator.`,
        { cause },
      );
    }
    return initialized ? [await read(validator, known?.label ?? "OwnableValidator", Boolean(known))] : [];
  }

  const out: OwnerValidatorState[] = [];
  for (const known of OWNABLE_VALIDATORS) {
    const code = await client.getCode({ address: known.address, ...at });
    if (!code || code === "0x" || keccak256(code) !== known.codeHash) continue;
    // The code is the audited deployment, so an error here is the RPC's: let it surface rather
    // than silently report no validator.
    if (!(await isInitialized(known.address))) continue;
    out.push(await read(known.address, known.label, true));
  }
  return out;
}

/** One OwnableValidator call made by the account. */
export type ValidatorCall =
  | { fn: "addOwner"; owner: Address }
  | { fn: "setThreshold"; threshold: bigint; previous: bigint }
  | { fn: "removeOwner"; prev: Address; owner: Address };

/**
 * The calls that make a validator's owners and threshold equal the Safe's, in order:
 * 1. `addOwner(o)` for every Safe owner it lacks (inserted at the head of its list), so the owner
 *    count never falls to the threshold while removing (V1 reverts with `CannotRemoveOwner()` then);
 * 2. `setThreshold(safe threshold)` if it differs (valid: the count is now at least the Safe's owners);
 * 3. `removeOwner(prev, o)` for every owner the Safe no longer has, with `prev` its predecessor in the
 *    list as it is at that moment (the sentinel for the head).
 */
export function syncOwnerCalls(state: OwnerValidatorState): ValidatorCall[] {
  if (state.owners.length + state.missing.length > OWNABLE_VALIDATOR_MAX_OWNERS) {
    throw new ExitToolError(
      "invalid_argument",
      `The validator ${state.validator} would need more than ${OWNABLE_VALIDATOR_MAX_OWNERS} owners while syncing (its limit).`,
    );
  }
  const list = [...state.owners];
  const calls: ValidatorCall[] = [];
  for (const owner of state.missing) {
    calls.push({ fn: "addOwner", owner });
    list.unshift(owner);
  }
  if (state.threshold !== state.safeThreshold) {
    calls.push({ fn: "setThreshold", threshold: state.safeThreshold, previous: state.threshold });
  }
  for (const owner of state.stale) {
    const index = list.findIndex((o) => isAddressEqual(o, owner));
    const prev = index === 0 ? SENTINEL : list[index - 1]!;
    list.splice(index, 1);
    calls.push({ fn: "removeOwner", prev, owner });
  }
  return calls;
}

export function encodeValidatorCall(c: ValidatorCall): Hex {
  switch (c.fn) {
    case "addOwner":
      return encodeFunctionData({ abi: ownableValidatorAbi, functionName: "addOwner", args: [c.owner] });
    case "setThreshold":
      return encodeFunctionData({
        abi: ownableValidatorAbi,
        functionName: "setThreshold",
        args: [c.threshold],
      });
    case "removeOwner":
      return encodeFunctionData({
        abi: ownableValidatorAbi,
        functionName: "removeOwner",
        args: [c.prev, c.owner],
      });
  }
}
