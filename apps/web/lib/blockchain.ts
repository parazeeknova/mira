import {
  Contract,
  ContractTransactionResponse,
  JsonRpcProvider,
  Wallet,
} from "ethers";

/**
 * Canonical, deterministic JSON serialization (sorted object keys, no
 * whitespace). Two structurally equal objects always serialize to the same
 * string regardless of key insertion order — the foundation of the
 * content-hash scheme. Arrays keep their order (order is meaningful).
 */
export const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** SHA-256 hex digest of a UTF-8 string via WebCrypto (native in Bun). */
export const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * The exact payload hashed and anchored on-chain. Field set is locked by the
 * architecture spec: engines (sorted), inputFaceHash, similarity, timestamp,
 * url. Changing the set changes every future hash — do not add fields lightly.
 */
export interface HashableResult {
  engines: string[];
  inputFaceHash: string;
  similarity: number;
  timestamp: number;
  url: string;
}

export interface ChainRecord {
  blockNumber: number;
  contentHash: string;
  explorerUrl: string;
  storedAt: number;
  txHash: string;
}

export interface VerifyResult {
  exists: boolean;
  submitter: string | null;
  timestamp: number;
  uri: string | null;
}

export class BlockchainNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `Blockchain client not configured. Missing env: ${missing.join(", ")}`
    );
    this.name = "BlockchainNotConfiguredError";
  }
}

export class TransactionTimeoutError extends Error {
  constructor(txHash: string, timeoutMs: number) {
    super(`Transaction ${txHash} not confirmed within ${timeoutMs}ms.`);
    this.name = "TransactionTimeoutError";
  }
}

const RPC_TIMEOUT_MS = 15_000;
const TX_WAIT_TIMEOUT_MS = 90_000;
const EXPLORER_TX_BASE = "https://amoy.polygonscan.com/tx";

/** Race a promise against a timeout; rejects with the given error factory. */
const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeError: () => Error
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
};

export const buildHashableResult = (
  result: Omit<HashableResult, "engines"> & { engines: string[] }
): HashableResult => ({
  ...result,
  engines: [...result.engines].toSorted(),
});

export const contentHashOf = async (result: HashableResult): Promise<string> =>
  sha256Hex(canonicalize(result));

export class BlockchainClient {
  private contract: Contract | null = null;
  private readonly env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = Bun.env) {
    this.env = env;
  }

  /** True when all required env vars are present. */
  isConfigured(): boolean {
    return this.requiredEnv().every((k) => {
      const v = this.env[k];
      return typeof v === "string" && v.trim().length > 0;
    });
  }

  private requiredEnv(): string[] {
    return ["AMOY_RPC_URL", "WALLET_PRIVATE_KEY", "FACE_RECORD_CONTRACT_ADDR"];
  }

  private missingEnv(): string[] {
    return this.requiredEnv().filter((k) => {
      const v = this.env[k];
      return typeof v !== "string" || v.trim().length === 0;
    });
  }

  private getContract(): Contract {
    if (this.contract !== null) {
      return this.contract;
    }

    const missing = this.missingEnv();
    if (missing.length > 0) {
      throw new BlockchainNotConfiguredError(missing);
    }

    const provider = new JsonRpcProvider(this.env["AMOY_RPC_URL"], undefined, {
      staticNetwork: true,
    });
    const signer = new Wallet(this.env["WALLET_PRIVATE_KEY"]!, provider);
    this.contract = new Contract(
      this.env["FACE_RECORD_CONTRACT_ADDR"]!,
      [
        "function store(bytes32 contentHash, string uri) external",
        "function verify(bytes32 contentHash) view returns (bool exists, string uri, uint64 timestamp, address submitter)",
        "function recordCount() view returns (uint256)",
        "event RecordStored(bytes32 indexed contentHash, string uri, uint64 timestamp, address indexed submitter)",
      ],
      signer
    );
    return this.contract;
  }

  /**
   * Anchor a result on-chain. Canonical hash is computed locally; the same
   * hash can only ever be stored once (contract enforces immutability).
   */
  async store(result: HashableResult): Promise<ChainRecord> {
    const contract = this.getContract();
    const contentHash = await contentHashOf(result);
    const bytes32 = `0x${contentHash}` as const;

    const storeFn = contract["store"] as (
      contentHash: string,
      uri: string
    ) => Promise<ContractTransactionResponse>;
    const tx = await withTimeout(
      storeFn(bytes32, result.url),
      RPC_TIMEOUT_MS,
      () => new Error(`store() RPC timed out after ${RPC_TIMEOUT_MS}ms`)
    );

    const receipt = await withTimeout(
      tx.wait(1),
      TX_WAIT_TIMEOUT_MS,
      () => new TransactionTimeoutError(tx.hash, TX_WAIT_TIMEOUT_MS)
    );

    if (receipt === null || receipt.status !== 1) {
      throw new Error(`store transaction reverted (tx ${tx.hash})`);
    }

    return {
      blockNumber: receipt.blockNumber,
      contentHash,
      explorerUrl: `${EXPLORER_TX_BASE}/${tx.hash}`,
      storedAt: Date.now(),
      txHash: tx.hash,
    };
  }

  /** Read back an on-chain record. Pure `eth_call` — no gas, no state change. */
  async verify(contentHash: string): Promise<VerifyResult> {
    const contract = this.getContract();
    const bytes32 = `0x${contentHash.replace(/^0x/, "")}` as const;

    const verifyFn = contract["verify"] as (
      contentHash: string
    ) => Promise<[boolean, string, bigint, string]>;
    const [exists, uri, timestamp, submitter] = await withTimeout(
      verifyFn(bytes32),
      RPC_TIMEOUT_MS,
      () => new Error(`verify() RPC timed out after ${RPC_TIMEOUT_MS}ms`)
    );

    return {
      exists: Boolean(exists),
      submitter: exists ? (submitter as string) : null,
      timestamp: Number(timestamp),
      uri: exists ? (uri as string) : null,
    };
  }

  /**
   * Full tamper check: recompute the hash from the result object, then confirm
   * the on-chain record exists for that hash. `hashMatch` catches any mutation
   * of the result between anchoring and verification.
   */
  async verifyResult(
    result: HashableResult,
    expectedHash: string
  ): Promise<{ exists: boolean; hashMatch: boolean; verified: boolean }> {
    const recomputed = await contentHashOf(result);
    const hashMatch = recomputed === expectedHash;
    const onChain = await this.verify(expectedHash);
    return {
      exists: onChain.exists,
      hashMatch,
      verified: onChain.exists && hashMatch,
    };
  }
}
