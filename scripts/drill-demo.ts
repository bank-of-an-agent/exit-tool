/**
 * Shutdown-drill demo for humans: starts a local Anvil chain with an Agent Bank account in the
 * state the integration test uses (escrows, streams, vaults, spend keys, modules, a guard), lets two
 * days pass, then "shuts Agent Bank down" (contracts paused, a payee frozen by USDC, no services).
 * It prints the commands to inspect and exit with `agentbank-exit`, and keeps Anvil running until
 * Ctrl-C.
 *
 *   pnpm drill:demo [--port 8546]
 *
 * Needs anvil (Foundry). The Agent Bank contracts come from the artifacts vendored in
 * test/fixtures/agentbank-contracts, or from a Foundry build named by AGENTBANK_CONTRACTS_OUT. Local
 * chain only; the keys printed are Anvil's public development keys.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { CONTRACTS_SOURCE, DEV_KEYS, accounts } from "../test/integration/harness";
import { DAY, DESTINATION, haveAgentBank, setupDrill, shutDown, travel } from "../test/integration/scenario";

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 8546;

if (!haveAgentBank) {
  console.error(
    `The Agent Bank contract artifacts were not found in ${CONTRACTS_SOURCE}: restore test/fixtures/agentbank-contracts (scripts/vendor-contracts.sh) or point AGENTBANK_CONTRACTS_OUT at a Foundry build.`,
  );
  process.exit(1);
}

const drill = await setupDrill({ port });
await travel(drill, 2n * DAY);
await shutDown(drill);

const base = `--rpc-url ${drill.anvil.rpcUrl} --account ${drill.safe} --deployments ${drill.deploymentsFile}`;
const info = {
  rpcUrl: drill.anvil.rpcUrl,
  chainId: 31337,
  account: drill.safe,
  owner: accounts.owner.address,
  destination: DESTINATION,
  deploymentsFile: drill.deploymentsFile,
};
writeFileSync(path.join(drill.dir, "demo.json"), `${JSON.stringify(info, null, 2)}\n`);

console.log(`
Agent Bank has shut down (local Anvil at ${drill.anvil.rpcUrl}, chain id 31337).
Its contracts are paused, a payee is frozen by USDC, and there is no API, co-signer or indexer.

Account (Safe):   ${drill.safe}
Owner key:        ${accounts.owner.address}   (Anvil development key #1: ${DEV_KEYS.owner})
Deployments file: ${drill.deploymentsFile}
Details:          ${path.join(drill.dir, "demo.json")}

Try:
  node dist/cli.js inspect ${base}
  node dist/cli.js exit ${base} --to ${DESTINATION}
  OWNER_PRIVATE_KEY=${DEV_KEYS.owner} node dist/cli.js exit ${base} --to ${DESTINATION} --execute

Web page: serve web/ (python3 -m http.server -d web 8080), add this network to a test wallet
(RPC ${drill.anvil.rpcUrl}, chain id 31337) with the development key above, open
http://127.0.0.1:8080/ and paste the deployments file into "Advanced".

Ctrl-C stops Anvil.`);

const stop = async () => {
  await drill.anvil.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
setInterval(() => undefined, 1 << 30);
