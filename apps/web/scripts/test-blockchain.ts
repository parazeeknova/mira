import { existsSync } from "node:fs";
import path from "node:path";

import {
  BlockchainClient,
  buildHashableResult,
} from "../src/blockchain/blockchain";

const envPath = path.resolve(import.meta.dir, "../../.env");
if (!existsSync(envPath)) {
  console.error("root .env not found. Run chain:deploy first.");
  process.exit(1);
}
const envText = await Bun.file(envPath).text();
for (const line of envText.split("\n")) {
  const m = line.match(/^(?<key>[A-Z_][A-Z0-9_]*)=(?<value>.*)$/u);
  const key = m?.groups?.["key"];
  const value = m?.groups?.["value"];
  if (key !== undefined && value !== undefined && !(key in process.env)) {
    process.env[key] = value.trim();
  }
}

// Point at the local node instead of a remote RPC.
process.env["AMOY_RPC_URL"] = "http://127.0.0.1:8545";

const client = new BlockchainClient(process.env);
if (!client.isConfigured()) {
  console.error("Blockchain client not configured. Run chain:deploy first.");
  process.exit(1);
}

const mock = buildHashableResult({
  engines: ["yandex", "google-vision", "google_lens"],
  inputFaceHash: "a".repeat(64),
  similarity: 0.7959,
  timestamp: Date.now(),
  url: "https://example.com/smoke-test-post",
});

console.log("1. storing...");
const record = await client.store(mock);
console.log(`   tx=${record.txHash} block=${record.blockNumber}`);
console.log(`   contentHash=${record.contentHash}`);

console.log("2. verifying on-chain...");
const v = await client.verify(record.contentHash);
console.log(`   exists=${v.exists} uri=${v.uri} submitter=${v.submitter}`);
if (!v.exists || v.uri !== mock.url) {
  console.error("FAIL: on-chain record mismatch.");
  process.exit(1);
}

console.log("3. verifyResult (tamper check)...");
const ok = await client.verifyResult(mock, record.contentHash);
console.log(`   verified=${ok.verified} hashMatch=${ok.hashMatch}`);
if (!ok.verified) {
  console.error("FAIL: verifyResult returned false.");
  process.exit(1);
}

console.log("4. tamper test (mutated similarity must fail)...");
const tampered = { ...mock, similarity: 0.1111 };
const bad = await client.verifyResult(tampered, record.contentHash);
console.log(`   verified=${bad.verified} hashMatch=${bad.hashMatch}`);
if (bad.verified || bad.hashMatch) {
  console.error("FAIL: tampered result passed verification.");
  process.exit(1);
}

console.log("5. duplicate store rejection...");
try {
  await client.store(mock);
  console.error("FAIL: duplicate store was accepted.");
  process.exit(1);
} catch (error) {
  console.log(
    `   rejected as expected: ${(error as Error).message.slice(0, 60)}...`
  );
}

console.log(
  "\nAll smoke tests passed: stored=true, verified=true, tamper-detected=true, duplicate-rejected=true"
);
