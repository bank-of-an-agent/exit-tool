import { readFile } from "node:fs/promises";
import type { Address, Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExitToolError } from "../core/errors";
import { promptHidden, type Io } from "./io";
import { decryptKeystore, keystoreAddress } from "./keystore";

/**
 * A key the CLI can use, loaded lazily: dry runs only need the address (taken from the environment
 * key or from the keystore's unencrypted `address` field), the secret is only decrypted to execute.
 * Keys are never printed, logged or included in error messages.
 */
export interface KeySource {
  kind: "env" | "keystore";
  /** Human description without secrets ("OWNER_PRIVATE_KEY", "keystore ./owner.json"). */
  label: string;
  address?: Address;
  load(): Promise<LocalAccount>;
}

const PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

function accountFromKey(raw: string, label: string): LocalAccount {
  const trimmed = raw.trim();
  if (!PRIVATE_KEY.test(trimmed)) {
    throw new ExitToolError("invalid_key", `${label} is not a 32-byte hex private key.`);
  }
  try {
    return privateKeyToAccount((trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex);
  } catch {
    // Never surface the library's message: it could echo the input.
    throw new ExitToolError("invalid_key", `${label} is not a valid secp256k1 private key.`);
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new ExitToolError("invalid_key", `Cannot read keystore ${path}.`, { cause });
  }
}

async function keystoreSource(io: Io, path: string, passwordFile: string | undefined): Promise<KeySource> {
  const json = await readJson(path);
  const address = keystoreAddress(json);
  return {
    kind: "keystore",
    label: `keystore ${path}`,
    ...(address ? { address } : {}),
    load: async () => {
      let password: string;
      if (passwordFile) {
        password = (await readFile(passwordFile, "utf8")).replace(/\r?\n$/, "");
      } else {
        try {
          password = await promptHidden(io, `Passphrase for ${path}: `);
        } catch (cause) {
          throw new ExitToolError("missing_key", "Cannot read the keystore passphrase.", {
            cause,
            hint: "Run in a terminal, or pass --password-file <file> for scripts.",
          });
        }
      }
      const key = await decryptKeystore(json, password);
      const account = accountFromKey(key, `keystore ${path}`);
      if (address && account.address.toLowerCase() !== address.toLowerCase()) {
        throw new ExitToolError(
          "invalid_key",
          `Keystore ${path} decrypts to a different address than it declares.`,
        );
      }
      return account;
    },
  };
}

/** The owner key: `OWNER_PRIVATE_KEY` or `--keystore` (exactly one), or none for read-only/signer-only use. */
export async function ownerKeySource(
  io: Io,
  options: { keystore?: string; passwordFile?: string },
): Promise<KeySource | undefined> {
  const envKey = io.env.OWNER_PRIVATE_KEY;
  if (envKey && options.keystore) {
    throw new ExitToolError("invalid_argument", "Use either OWNER_PRIVATE_KEY or --keystore, not both.");
  }
  if (envKey) {
    const account = accountFromKey(envKey, "OWNER_PRIVATE_KEY");
    return { kind: "env", label: "OWNER_PRIVATE_KEY", address: account.address, load: async () => account };
  }
  if (options.keystore) return keystoreSource(io, options.keystore, options.passwordFile);
  return undefined;
}

/**
 * The key that sends (and pays gas for) transactions in the signer-only flow: `SENDER_PRIVATE_KEY`
 * or `--sender-keystore`. It needs no power over the account: owner signatures authorise everything.
 */
export async function senderKeySource(
  io: Io,
  options: { senderKeystore?: string; senderPasswordFile?: string },
): Promise<KeySource | undefined> {
  const envKey = io.env.SENDER_PRIVATE_KEY;
  if (envKey && options.senderKeystore) {
    throw new ExitToolError(
      "invalid_argument",
      "Use either SENDER_PRIVATE_KEY or --sender-keystore, not both.",
    );
  }
  if (envKey) {
    const account = accountFromKey(envKey, "SENDER_PRIVATE_KEY");
    return { kind: "env", label: "SENDER_PRIVATE_KEY", address: account.address, load: async () => account };
  }
  if (options.senderKeystore) {
    return keystoreSource(io, options.senderKeystore, options.senderPasswordFile);
  }
  return undefined;
}
