// Deploys FaceRecord to a local network (hardhat in-process or localhost node).
// Usage:
//   bun scripts/deploy-contract.ts --network hardhat   (in-process, ephemeral)
//   bun scripts/deploy-contract.ts --network localhost (needs `bun run chain:node`)
// Never targets a public network; no real funds involved.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { JsonRpcProvider, ContractFactory, Wallet } from "ethers";

interface Artifact {
  abi: unknown[];
  bytecode: string;
}

const network = (() => {
  const i = process.argv.indexOf("--network");
  return i !== -1 ? (process.argv[i + 1] ?? "localhost") : "localhost";
})();

const RPC: Record<string, string> = {
  localhost: "http://127.0.0.1:8545",
  hardhat: "http://127.0.0.1:8545",
};

const rpcUrl = RPC[network];
if (!rpcUrl) {
  console.error(`Unsupported network "${network}". Use: localhost | hardhat`);
  process.exit(1);
}

const artifactPath = resolve(import.meta.dir, "../contracts/artifacts/contracts/FaceRecord.sol/FaceRecord.json");
if (!existsSync(artifactPath)) {
  console.error("Artifact not found. Run: cd contracts && bunx --node hardhat compile");
  process.exit(1);
}
const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Artifact;

// Local nodes expose prefunded unlocked accounts; a PK is optional.
const pk = process.env.WALLET_PRIVATE_KEY;
const provider = new JsonRpcProvider(rpcUrl);
const signer = pk ? new Wallet(pk, provider) : await provider.getSigner();

const deployTimeoutMs = 60_000;
const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);

console.log(`Deploying FaceRecord to ${network} (${rpcUrl})...`);
const contract = await factory.deploy();
const tx = contract.deploymentTransaction();
if (!tx) {
  console.error("Deployment transaction missing.");
  process.exit(1);
}

const receipt = await Promise.race([
  tx.wait(1),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Deployment timed out after ${deployTimeoutMs}ms`)), deployTimeoutMs)
  ),
]);

if (!receipt || receipt.status !== 1) {
  console.error("Deployment transaction failed on-chain.");
  process.exit(1);
}

const address = await contract.getAddress();
console.log(`FaceRecord deployed at: ${address}`);
console.log(`tx: ${tx.hash}  block: ${receipt.blockNumber}`);

// Idempotently patch apps/web/.env with the contract address.
const envPath = resolve(import.meta.dir, "../apps/web/.env");
const line = `FACE_RECORD_CONTRACT_ADDR=${address}`;
let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
env = env.includes("FACE_RECORD_CONTRACT_ADDR=")
  ? env.replace(/^FACE_RECORD_CONTRACT_ADDR=.*$/m, line)
  : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
writeFileSync(envPath, env);
console.log(`Patched apps/web/.env → ${line}`);
