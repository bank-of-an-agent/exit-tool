import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  concatHex,
  encodeAbiParameters,
  hashTypedData,
  hexToBytes,
  keccak256,
  numberToHex,
  pad,
  toEventSelector,
  toFunctionSelector,
  toHex,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { safeAbi } from "../../src/core/abis/index";
import {
  FALLBACK_HANDLER_SLOT,
  GUARD_SLOT,
  SIMULATION_BALANCE_READER_CODE,
  SIMULATION_SIGNER_STUB_CODE,
  ZERO_ADDRESS,
} from "../../src/core/constants";
import {
  encodeExecTransaction,
  hashSafeTx,
  normalizeEcdsaSignature,
  packSignatures,
  recoverSafeTxSigner,
  safeTxForCall,
  safeTxTypedData,
  safeTxTypedDataJson,
} from "../../src/core/safe";
import { simulatedSignatures } from "../../src/core/simulate";

const SAFE: Address = "0x1111111111111111111111111111111111111111";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("SafeTx hashing", () => {
  const tx = safeTxForCall(
    { to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", value: 0n, data: "0xa9059cbb" },
    42n,
  );

  it("uses CALL and no gas refund", () => {
    expect(tx).toMatchObject({
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
    });
  });

  it("matches the Safe v1.4.1 hashing scheme computed by hand", () => {
    // Safe.sol: SAFE_TX_TYPEHASH and DOMAIN_SEPARATOR_TYPEHASH constants.
    const SAFE_TX_TYPEHASH = keccak256(
      toHex(
        "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)",
      ),
    );
    expect(SAFE_TX_TYPEHASH).toBe("0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8");
    const DOMAIN_TYPEHASH = keccak256(toHex("EIP712Domain(uint256 chainId,address verifyingContract)"));
    expect(DOMAIN_TYPEHASH).toBe("0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218");
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [DOMAIN_TYPEHASH, 84532n, SAFE],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "uint8" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
        ],
        [
          SAFE_TX_TYPEHASH,
          tx.to,
          tx.value,
          keccak256(tx.data),
          tx.operation,
          0n,
          0n,
          0n,
          ZERO_ADDRESS,
          ZERO_ADDRESS,
          42n,
        ],
      ),
    );
    const expected = keccak256(concatHex(["0x1901", domainSeparator, structHash]));
    expect(hashSafeTx(84532, SAFE, tx)).toBe(expected);
  });

  it("produces wallet JSON (eth_signTypedData_v4) that hashes to the same SafeTx hash", () => {
    const json = safeTxTypedDataJson(84532, SAFE, tx);
    const { EIP712Domain, ...types } = json.types;
    expect(EIP712Domain).toEqual([
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
    const parsed = JSON.parse(JSON.stringify(json));
    expect(
      hashTypedData({ domain: parsed.domain, types, primaryType: "SafeTx", message: parsed.message }),
    ).toBe(hashSafeTx(84532, SAFE, tx));
  });

  it("recovers the owner from an EIP-712 signature, with v in either form", async () => {
    const owner = privateKeyToAccount(KEY);
    const sig = await owner.signTypedData(safeTxTypedData(84532, SAFE, tx));
    expect(await recoverSafeTxSigner(84532, SAFE, tx, sig)).toBe(owner.address);
    const v = Number.parseInt(sig.slice(130), 16);
    const lowV = `${sig.slice(0, 130)}${(v - 27).toString(16).padStart(2, "0")}` as Hex;
    expect(normalizeEcdsaSignature(lowV)).toBe(sig);
    expect(await recoverSafeTxSigner(84532, SAFE, tx, lowV)).toBe(owner.address);
  });

  it("rejects eth_sign-style and malformed signatures", () => {
    const sig = `0x${"11".repeat(64)}1f` as Hex; // v = 31: eth_sign flavour
    expect(() => normalizeEcdsaSignature(sig)).toThrow(/typed data/);
    expect(() => normalizeEcdsaSignature("0x1234")).toThrow(/65 bytes/);
  });
});

describe("signature packing", () => {
  const a: Address = "0x00000000000000000000000000000000000000aa";
  const b: Address = "0x00000000000000000000000000000000000000bb";
  const ecdsa = `0x${"22".repeat(64)}1b` as Hex;

  it("sorts by owner address and lays out contract signatures after the static parts", () => {
    const packed = packSignatures([
      { signer: b, kind: "contract", data: "0xdeadbeef" },
      { signer: a, kind: "ecdsa", data: ecdsa },
    ]);
    const bytes = hexToBytes(packed);
    expect(bytes.length).toBe(65 * 2 + 32 + 4);
    expect(toHex(bytes.slice(0, 65))).toBe(ecdsa); // a < b: a first
    expect(toHex(bytes.slice(65, 97))).toBe(pad(b, { size: 32 }));
    expect(toHex(bytes.slice(97, 129))).toBe(numberToHex(130, { size: 32 })); // offset of b's data
    expect(bytes[129]).toBe(0); // v = 0: contract signature
    expect(toHex(bytes.slice(130, 162))).toBe(numberToHex(4, { size: 32 }));
    expect(toHex(bytes.slice(162))).toBe("0xdeadbeef");
  });

  it("encodes pre-validated signatures and refuses duplicate owners", () => {
    const packed = packSignatures([{ signer: a, kind: "prevalidated" }]);
    expect(packed).toBe(concatHex([pad(a, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]));
    expect(() =>
      packSignatures([
        { signer: a, kind: "ecdsa", data: ecdsa },
        { signer: a, kind: "prevalidated" },
      ]),
    ).toThrow(/same owner/);
  });

  it("simulation placeholders are contract signatures (v = 0) for each simulated owner", () => {
    const packed = hexToBytes(simulatedSignatures([b, a]));
    expect(packed.length).toBe(65 * 2 + 32 * 2);
    expect(packed[64]).toBe(0);
    expect(packed[129]).toBe(0);
  });

  it("encodes execTransaction with the SafeTx fields and signatures", () => {
    const tx = safeTxForCall({ to: a, value: 1n, data: "0x" }, 0n);
    const data = encodeExecTransaction(tx, packSignatures([{ signer: a, kind: "ecdsa", data: ecdsa }]));
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector(
        "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
      ),
    );
  });
});

describe("constants", () => {
  it("storage slots are the Safe's keccak slots", () => {
    expect(FALLBACK_HANDLER_SLOT).toBe(keccak256(toHex("fallback_manager.handler.address")));
    expect(GUARD_SLOT).toBe(keccak256(toHex("guard_manager.guard.address")));
  });

  it("the simulation stub jumps to a JUMPDEST and the balance reader is the documented program", () => {
    const code = hexToBytes(SIMULATION_SIGNER_STUB_CODE);
    const jumpTarget = code[13]!; // PUSH1 <target> before JUMPI
    expect(code[jumpTarget]).toBe(0x5b);
    expect(SIMULATION_BALANCE_READER_CODE).toBe("0x6000353160005260206000f3");
  });
});

describe("minimal Safe ABI", () => {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("@safe-global/safe-contracts/package.json"));
  const artifact = JSON.parse(
    readFileSync(path.join(root, "build/artifacts/contracts/SafeL2.sol/SafeL2.json"), "utf8"),
  ) as { abi: Abi };

  it("every function and event matches the canonical Safe v1.4.1 artifact", () => {
    const full = artifact.abi;
    for (const item of safeAbi) {
      if (item.type === "function") {
        const sig = toFunctionSelector(item as AbiFunction);
        expect(
          full.some((x) => x.type === "function" && toFunctionSelector(x) === sig),
          item.name,
        ).toBe(true);
      } else if (item.type === "event") {
        const match = full.find((x): x is AbiEvent => x.type === "event" && x.name === item.name);
        expect(match, item.name).toBeDefined();
        expect(toEventSelector(item as AbiEvent)).toBe(toEventSelector(match!));
        expect(item.inputs.map((i) => i.indexed)).toEqual(match!.inputs.map((i) => i.indexed));
      }
    }
  });
});
