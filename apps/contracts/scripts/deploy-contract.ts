import { existsSync } from "node:fs";
import path from "node:path";

import { JsonRpcProvider, ContractFactory, Wallet } from "ethers";

interface Artifact {
  abi: unknown[];
  bytecode: string;
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeError: () => Error
): Promise<T> => {
  const { promise: timer, resolve: clearTimer } =
    Promise.withResolvers<undefined>();
  const timerId = setTimeout(() => clearTimer(), timeoutMs);
  try {
    const result = await Promise.race([
      promise,
      timer.then(() => {
        throw makeError();
      }),
    ]);
    return result;
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
};

const network = (() => {
  const i = process.argv.indexOf("--network");
  if (i !== -1) {
    return process.argv[i + 1] ?? "localhost";
  }
  return "localhost";
})();

const RPC: Record<string, string> = {
  hardhat: "http://127.0.0.1:8545",
  localhost: "http://127.0.0.1:8545",
};

const rpcUrl = RPC[network];
if (rpcUrl === undefined) {
  console.error(`Unsupported network "${network}". Use: localhost | hardhat`);
  process.exit(1);
}

const artifactPath = path.resolve(
  import.meta.dir,
  "../artifacts/contracts/FaceRecord.sol/FaceRecord.json"
);
if (!existsSync(artifactPath)) {
  console.error(
    "Artifact not found. Run: bunx hardhat compile (in apps/contracts)"
  );
  process.exit(1);
}
const artifact = JSON.parse(await Bun.file(artifactPath).text()) as Artifact;

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

const receipt = await withTimeout(
  tx.wait(1),
  deployTimeoutMs,
  () => new Error(`Deployment timed out after ${deployTimeoutMs}ms`)
);

if (!receipt || receipt.status !== 1) {
  console.error("Deployment transaction failed on-chain.");
  process.exit(1);
}

const address = await contract.getAddress();
console.log(`FaceRecord deployed at: ${address}`);
console.log(`tx: ${tx.hash}  block: ${receipt.blockNumber}`);

// Idempotently patch the gitignored root .env with the contract address.
const envPath = path.resolve(import.meta.dir, "../../../.env");
const line = `FACE_RECORD_CONTRACT_ADDR=${address}`;
let env = existsSync(envPath) ? await Bun.file(envPath).text() : "";
env = env.includes("FACE_RECORD_CONTRACT_ADDR=")
  ? env.replace(/^FACE_RECORD_CONTRACT_ADDR=.*$/mu, line)
  : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
await Bun.write(envPath, env);
console.log(`Patched .env → ${line}`);
