import { createCipheriv, pbkdf2Sync, randomBytes, scryptSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAddressOption, parseCliArgs } from "../../src/cli/args";
import { redactRpcUrl } from "../../src/cli/context";
import type { Io } from "../../src/cli/io";
import { ownerKeySource } from "../../src/cli/keys";
import { decryptKeystore, keystoreAddress } from "../../src/cli/keystore";
import { main } from "../../src/cli/main";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function io(env: Record<string, string> = {}): { io: Io; out: () => string; err: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let o = "";
  let e = "";
  stdout.on("data", (d: Buffer) => (o += d.toString()));
  stderr.on("data", (d: Buffer) => (e += d.toString()));
  return {
    io: { stdout, stderr, stdin: new PassThrough() as unknown as Io["stdin"], env, interactive: false },
    out: () => o,
    err: () => e,
  };
}

/** A JSON-RPC endpoint that only answers eth_chainId, with a configurable chain id. */
function fakeRpc(chainId: number): Promise<{ url: string; server: Server; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      hits += 1;
      const msg = JSON.parse(body) as { id: number; method: string };
      res.setHeader("content-type", "application/json");
      if (msg.method === "eth_chainId") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: `0x${chainId.toString(16)}` }));
      } else {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "not in this test" },
          }),
        );
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server, hits: () => hits });
    }),
  );
}

describe("mainnet is refused", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  for (const [chainId, name] of [
    [8453, "Base mainnet"],
    [1, "Ethereum mainnet"],
  ] as const) {
    it(`refuses an RPC that serves chain ${chainId} (${name}), whatever --chain says`, async () => {
      const rpc = await fakeRpc(chainId);
      servers.push(rpc.server);
      for (const args of [
        ["inspect", "--rpc-url", rpc.url, "--account", "0x1111111111111111111111111111111111111111"],
        [
          "exit",
          "--rpc-url",
          rpc.url,
          "--account",
          "0x1111111111111111111111111111111111111111",
          "--to",
          "0x2222222222222222222222222222222222222222",
          "--execute",
          "--yes",
        ],
      ]) {
        const t = io({ OWNER_PRIVATE_KEY: KEY });
        const code = await main([...args, "--json"], t.io);
        expect(code).toBe(1);
        const doc = JSON.parse(t.out()) as { error: { code: string; message: string } };
        expect(doc.error.code).toBe("mainnet_refused");
        expect(doc.error.message).toContain(name);
        expect(doc.error.message).toContain("Phase 5 gate");
      }
      expect(rpc.hits()).toBe(2); // only eth_chainId was ever asked
    });
  }

  it("refuses --chain base before connecting anywhere", async () => {
    const t = io();
    const code = await main(
      ["inspect", "--chain", "base", "--account", "0x1111111111111111111111111111111111111111"],
      t.io,
    );
    expect(code).toBe(1);
    expect(t.err()).toMatch(/Mainnet is not supported yet/);
  });

  it("refuses an unknown chain", async () => {
    const rpc = await fakeRpc(10);
    servers.push(rpc.server);
    const t = io();
    expect(
      await main(
        ["inspect", "--rpc-url", rpc.url, "--account", "0x1111111111111111111111111111111111111111"],
        t.io,
      ),
    ).toBe(1);
    expect(t.err()).toMatch(/Unsupported chain id 10/);
  });
});

describe("argument parsing", () => {
  it("knows its commands and rejects options a command does not take", () => {
    expect(parseCliArgs([]).command).toBe("help");
    expect(parseCliArgs(["inspect", "--account", "0x1"]).command).toBe("inspect");
    expect(() => parseCliArgs(["inspect", "--to", "0x1"])).toThrow(/not an option of "inspect"/);
    expect(() => parseCliArgs(["withdraw", "--bogus"])).toThrow();
    expect(() => parseCliArgs(["frobnicate"])).toThrow(/Unknown command/);
    expect(
      parseCliArgs(["exit", "--extra-token", "0x1", "--extra-token", "0x2"]).values["extra-token"],
    ).toEqual(["0x1", "0x2"]);
  });

  it("validates addresses, including mixed-case checksums", () => {
    expect(parseAddressOption("to", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8")).toBe(
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    expect(parseAddressOption("to", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe(
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    expect(() => parseAddressOption("to", "0x70997970C51812dc3A010C7d01b50e0d17dc79c8")).toThrow(/checksum/);
    expect(() => parseAddressOption("to", "0x1234")).toThrow(/must be an address/);
  });

  it("prints help and version without touching the network", async () => {
    const t = io();
    expect(await main(["help"], t.io)).toBe(0);
    expect(t.out()).toMatch(/agentbank-exit — withdraw everything/);
    const v = io();
    expect(await main(["--version"], v.io)).toBe(0);
    expect(v.out().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns exit code 2 for usage errors", async () => {
    const t = io();
    expect(await main(["inspect", "--to", "0x1"], t.io)).toBe(2);
  });

  it("redacts credentials embedded in RPC URLs", () => {
    expect(redactRpcUrl("https://base-sepolia.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz")).toBe(
      "https://base-sepolia.g.alchemy.com/…",
    );
    expect(redactRpcUrl("https://rpc.example.com/?apikey=secret")).toBe("https://rpc.example.com/…");
    expect(redactRpcUrl("https://user:pass@rpc.example.com")).toBe("https://rpc.example.com");
    expect(redactRpcUrl("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545");
    expect(redactRpcUrl("https://sepolia.base.org")).toBe("https://sepolia.base.org");
  });
});

describe("keys", () => {
  it("reads OWNER_PRIVATE_KEY without ever echoing it", async () => {
    const source = await ownerKeySource(io({ OWNER_PRIVATE_KEY: KEY }).io, {});
    expect(source?.address).toBe(privateKeyToAccount(KEY).address);
    const bad = "0x" + "zz".repeat(32);
    await expect(ownerKeySource(io({ OWNER_PRIVATE_KEY: bad }).io, {})).rejects.toThrow(
      /not a 32-byte hex private key/,
    );
    try {
      await ownerKeySource(io({ OWNER_PRIVATE_KEY: `${KEY.slice(0, -2)}` }).io, {});
    } catch (err) {
      expect(String(err)).not.toContain(KEY.slice(2, 20));
    }
    // An out-of-range scalar: valid hex, invalid key.
    const tooBig = `0x${"ff".repeat(32)}`;
    await expect(ownerKeySource(io({ OWNER_PRIVATE_KEY: tooBig }).io, {})).rejects.toThrow(
      /not a valid secp256k1 private key/,
    );
  });

  it("refuses two owner key sources at once", async () => {
    await expect(ownerKeySource(io({ OWNER_PRIVATE_KEY: KEY }).io, { keystore: "x.json" })).rejects.toThrow(
      /not both/,
    );
  });
});

describe("keystores", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentbank-exit-ks-"));
  const account = privateKeyToAccount(KEY);
  let scryptKs: unknown;
  let pbkdf2Ks: unknown;

  function encrypt(kdf: "scrypt" | "pbkdf2", password: string) {
    const salt = randomBytes(32);
    const iv = randomBytes(16);
    const derived =
      kdf === "scrypt"
        ? scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 })
        : pbkdf2Sync(password, salt, 1000, 32, "sha256");
    const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(KEY.slice(2), "hex")), cipher.final()]);
    const mac = keccak256(new Uint8Array(Buffer.concat([derived.subarray(16, 32), ciphertext]))).slice(2);
    return {
      version: 3,
      address: account.address.slice(2).toLowerCase(),
      crypto: {
        cipher: "aes-128-ctr",
        ciphertext: ciphertext.toString("hex"),
        cipherparams: { iv: iv.toString("hex") },
        kdf,
        kdfparams:
          kdf === "scrypt"
            ? { dklen: 32, salt: salt.toString("hex"), n: 1024, r: 8, p: 1 }
            : { dklen: 32, salt: salt.toString("hex"), c: 1000, prf: "hmac-sha256" },
        mac,
      },
    };
  }

  beforeAll(() => {
    scryptKs = encrypt("scrypt", "pw");
    pbkdf2Ks = encrypt("pbkdf2", "pw");
  });

  it("decrypts scrypt and pbkdf2 keystores and checks the MAC", async () => {
    expect(await decryptKeystore(scryptKs, "pw")).toBe(KEY);
    expect(await decryptKeystore(pbkdf2Ks, "pw")).toBe(KEY);
    await expect(decryptKeystore(scryptKs, "wrong")).rejects.toThrow(/Wrong keystore passphrase/);
    expect(keystoreAddress(scryptKs)).toBe(account.address);
    expect(() => keystoreAddress({ version: 1 })).toThrow(/version 3/);
  });

  it("loads lazily: the address is known before the passphrase is read", async () => {
    const file = path.join(dir, "ks.json");
    const pw = path.join(dir, "pw.txt");
    writeFileSync(file, JSON.stringify(scryptKs));
    writeFileSync(pw, "pw\n");
    const source = await ownerKeySource(io().io, { keystore: file, passwordFile: pw });
    expect(source?.address).toBe(account.address);
    expect((await source!.load()).address).toBe(account.address);
    // No TTY and no password file: a clear error instead of a hang.
    const noPw = await ownerKeySource(io().io, { keystore: file });
    await expect(noPw!.load()).rejects.toThrow(/passphrase/);
  });
});
