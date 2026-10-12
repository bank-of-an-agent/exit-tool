import { createDecipheriv, pbkdf2, scrypt, type BinaryLike } from "node:crypto";
import { promisify } from "node:util";
import { bytesToHex, getAddress, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { ExitToolError } from "../core/errors";

const scryptAsync = promisify(scrypt) as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const pbkdf2Async = promisify(pbkdf2);

/** Web3 Secret Storage v3 (geth, `cast wallet new`/`import`, MetaMask exports). */
interface KeystoreV3 {
  version: 3;
  address?: string;
  crypto?: KeystoreCrypto;
  Crypto?: KeystoreCrypto;
}

interface KeystoreCrypto {
  cipher: string;
  ciphertext: string;
  cipherparams: { iv: string };
  kdf: "scrypt" | "pbkdf2";
  kdfparams: {
    dklen: number;
    salt: string;
    n?: number;
    r?: number;
    p?: number;
    c?: number;
    prf?: string;
  };
  mac: string;
}

const strip = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h);

function parse(json: unknown): KeystoreV3 & { crypto: KeystoreCrypto } {
  const k = json as KeystoreV3;
  const crypto = k?.crypto ?? k?.Crypto;
  if (!k || k.version !== 3 || !crypto) {
    throw new ExitToolError("invalid_key", "The keystore is not a version 3 encrypted JSON keystore.");
  }
  if (crypto.cipher !== "aes-128-ctr") {
    throw new ExitToolError(
      "invalid_key",
      `Unsupported keystore cipher ${crypto.cipher} (expected aes-128-ctr).`,
    );
  }
  return { ...k, crypto };
}

/** The address recorded (unencrypted) in a keystore, if any: lets a dry run show the signer without the passphrase. */
export function keystoreAddress(json: unknown): Address | undefined {
  const k = parse(json);
  if (!k.address) return undefined;
  try {
    return getAddress(k.address.startsWith("0x") ? k.address : `0x${k.address}`);
  } catch {
    return undefined;
  }
}

/** Decrypts a v3 keystore. The private key is returned to the caller and never logged. */
export async function decryptKeystore(json: unknown, password: string): Promise<Hex> {
  const k = parse(json);
  const { kdf, kdfparams } = k.crypto;
  const salt = Buffer.from(strip(kdfparams.salt), "hex");
  if (!Number.isInteger(kdfparams.dklen) || kdfparams.dklen < 32) {
    throw new ExitToolError("invalid_key", "Keystore key length must be at least 32 bytes.");
  }
  const derive = async (secret: string): Promise<Buffer> => {
    if (kdf === "scrypt") {
      const { n, r, p, dklen } = kdfparams;
      if (!n || !r || !p)
        throw new ExitToolError("invalid_key", "Keystore scrypt parameters are incomplete.");
      return scryptAsync(secret, salt, dklen, { N: n, r, p, maxmem: 256 * n * r + 64 * 1024 * 1024 });
    }
    if (kdf === "pbkdf2") {
      if (kdfparams.prf !== "hmac-sha256" || !kdfparams.c) {
        throw new ExitToolError("invalid_key", "Unsupported keystore pbkdf2 parameters.");
      }
      return pbkdf2Async(secret, salt, kdfparams.c, kdfparams.dklen, "sha256");
    }
    throw new ExitToolError("invalid_key", `Unsupported keystore KDF ${String(kdf)}.`);
  };
  const ciphertext = Buffer.from(strip(k.crypto.ciphertext), "hex");
  const macMatches = (d: Buffer): boolean =>
    strip(keccak256(new Uint8Array(Buffer.concat([d.subarray(16, 32), ciphertext])))).toLowerCase() ===
    strip(k.crypto.mac).toLowerCase();
  // geth and Foundry use the passphrase bytes as typed; ethers normalises to NFKC first. Try both.
  let derived = await derive(password);
  if (!macMatches(derived) && password.normalize("NFKC") !== password) {
    derived.fill(0);
    derived = await derive(password.normalize("NFKC"));
  }
  if (!macMatches(derived)) {
    derived.fill(0);
    throw new ExitToolError("invalid_key", "Wrong keystore passphrase (MAC mismatch).");
  }
  const decipher = createDecipheriv(
    "aes-128-ctr",
    derived.subarray(0, 16),
    Buffer.from(strip(k.crypto.cipherparams.iv), "hex"),
  );
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (key.length !== 32)
    throw new ExitToolError("invalid_key", "The keystore does not contain a 32-byte private key.");
  const hex = bytesToHex(new Uint8Array(key));
  key.fill(0);
  derived.fill(0);
  // Round-trip through hexToBytes to make sure it is well formed.
  hexToBytes(hex);
  return hex;
}
