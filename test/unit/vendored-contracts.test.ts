import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentBankAbiSource } from "../../src/core/abis/index";

/**
 * The Agent Bank contract artifacts vendored for the shutdown drill (scripts/vendor-contracts.sh):
 * CI runs the drill from them, without access to the contracts repository, so they must be intact,
 * complete, and built from the same contracts commit as the ABIs the exit tool itself ships.
 */
const DIR = path.resolve(import.meta.dirname, "../fixtures/agentbank-contracts");
const DEPLOYED = [
  "AgentEscrow",
  "PaymentStreams",
  "TimeLockVaults",
  "TopUpExecutor",
  "SweepExecutor",
  "AgentPolicyHook",
  "MockUSDC",
  "MockTreasuryFund",
  "MockValidationRegistry",
];
const source = readFileSync(path.join(DIR, "SOURCE"), "utf8");
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

describe("vendored Agent Bank contract artifacts", () => {
  it("are exactly the contracts the drill deploys, each matching its checksum in SOURCE", () => {
    const listed = [...source.matchAll(/^([0-9a-f]{64}) {2}(\S+\.json)$/gm)].map((m) => [m[2]!, m[1]!]);
    expect(listed.map(([file]) => file).sort()).toEqual(DEPLOYED.map((n) => `${n}.json`).sort());
    expect(
      readdirSync(DIR)
        .filter((f) => f.endsWith(".json"))
        .sort(),
    ).toEqual(DEPLOYED.map((n) => `${n}.json`).sort());
    for (const [file, hash] of listed) {
      expect(sha256(readFileSync(path.join(DIR, file!))), `${file} was edited by hand`).toBe(hash);
    }
  });

  it("hold an ABI and linked creation bytecode, nothing else", () => {
    for (const name of DEPLOYED) {
      const json = JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as Record<
        string,
        unknown
      >;
      expect(Object.keys(json).sort()).toEqual(["abi", "bytecode", "contractName"]);
      expect(json.contractName).toBe(name);
      expect(Array.isArray(json.abi)).toBe(true);
      expect(json.bytecode).toMatch(/^0x(?:[0-9a-f]{2})+$/);
    }
  });

  it("come from a clean build of the same contracts commit as the exit tool's own ABIs", () => {
    const commit = /^commit: ([0-9a-f]{40})$/m.exec(source)?.[1];
    expect(commit, "SOURCE records the contracts commit").toBeDefined();
    expect(source).toMatch(/^uncommitted source changes: none$/m);
    expect(commit).toBe(agentBankAbiSource.commit);
    // The deployed interfaces are byte for byte the ABIs the tool calls (scripts/sync-abis.sh).
    for (const [name, { abiSha256 }] of Object.entries(
      agentBankAbiSource.artifacts as Record<string, { abiSha256: string }>,
    )) {
      const { abi } = JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as { abi: unknown };
      expect(
        sha256(JSON.stringify(abi)),
        `${name}: run scripts/sync-abis.sh and scripts/vendor-contracts.sh`,
      ).toBe(abiSha256);
    }
  });
});
