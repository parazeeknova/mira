// Generates a fresh burner wallet for local/testchain use.
// Usage: bun scripts/gen-wallet.ts
import { Wallet } from "ethers";

const wallet = Wallet.createRandom();

console.log("address:     ", wallet.address);
console.log("private key: ", wallet.privateKey);
console.log();
console.log("Local node (hardhat): prefunded accounts are available automatically;");
console.log("this burner is only needed if you wire a public testnet later.");
console.log("Amoy faucet (if needed): https://faucet.polygon.technology/");
console.log();
console.log("To use: set WALLET_PRIVATE_KEY in apps/web/.env (local node) — never commit it.");
