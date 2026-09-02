// oxlint-disable complexity, avoid-new, param-names
import { buildHashableResult, contentHashOf } from "../blockchain/blockchain";
import type { BlockchainClient, ChainRecord } from "../blockchain/blockchain";
import {
  PipelineBusyError,
  PipelineTimeoutError,
  PythonDisconnectedError,
} from "../bridge/python-bridge";
import type {
  PipelineCandidateResult,
  PythonPipelineResultMessage,
} from "../protocol/protocol";

export interface PipelineResponse {
  anchorStrategy: "embedding" | "none" | "search";
  blockchain: ChainRecord | null;
  blockchainError: string | null;
  cacheHit: boolean;
  duplicate: boolean;
  enginesUsed: string[];
  error: string | null;
  face: { bbox: Record<string, number>; confidence: number } | null;
  inputFaceHash: string | null;
  results: PipelineCandidateResult[];
  verified: boolean;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_WIDTH = 1280;
const PIPELINE_TIMEOUT_MS = 90_000;

export class PipelineRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PipelineRequestError";
    this.status = status;
  }
}

interface BridgeLike {
  runPipeline: (
    sessionId: string,
    image: {
      data: string;
      height: number;
      mimeType: "image/jpeg";
      width: number;
    },
    timeoutMs?: number
  ) => Promise<PythonPipelineResultMessage>;
  sendAdminMessage?: (payload: {
    files: { data: string; name: string }[];
    id: string;
    metadata: {
      color: string;
      email?: string;
      githubUsername?: string;
      id: string;
      linkedinId?: string;
      name: string;
      phoneNumber?: string;
      worksAt?: string;
    };
    type: "admin.upsert-identity";
  }) => Promise<{ changed: boolean; ok: boolean }>;
}

interface BlockchainLike {
  isConfigured: () => boolean;
  store: (
    result: Parameters<BlockchainClient["store"]>[0]
  ) => Promise<ChainRecord>;
  verify: (contentHash: string) => Promise<{ exists: boolean }>;
  verifyResult: (
    result: Parameters<BlockchainClient["verifyResult"]>[0],
    expectedHash: string
  ) => Promise<{ exists: boolean; hashMatch: boolean; verified: boolean }>;
}

const json = (body: PipelineResponse, status = 200): Response =>
  Response.json(body, { status });

export const parseIdentityFromFinding = (
  top: PipelineCandidateResult
): {
  color: string;
  id: string;
  linkedinId?: string;
  name: string;
} => {
  let name = "";
  let linkedinId: string | undefined;

  if (top.title) {
    const cleaned = top.title
      .replace(/\|.*$/iu, "")
      .replace(/-.*$/iu, "")
      .replace(/\bon linkedin.*$/iu, "")
      .replace(/\bprofile\b/iu, "")
      .trim();
    if (
      cleaned.length > 1 &&
      !cleaned.toLowerCase().includes("face embedding")
    ) {
      name = cleaned;
    }
  }

  if (top.url.includes("linkedin.com/in/")) {
    const match = top.url.match(/linkedin\.com\/in\/(?<id>[a-zA-Z0-9_-]+)/u);
    if (match?.groups?.["id"] !== undefined) {
      linkedinId = match.groups["id"];
      if (!name) {
        name = (match.groups?.["id"] ?? "")
          .replaceAll(/[-_]/gu, " ")
          .replaceAll(/\b\w/gu, (c) => c.toUpperCase());
      }
    }
  } else if (top.url.includes("linkedin.com/posts/")) {
    const match = top.url.match(
      /linkedin\.com\/posts\/(?<id>[a-zA-Z0-9_-]+?)_/u
    );
    if (match?.groups?.["id"] !== undefined) {
      linkedinId = match.groups["id"];
      if (!name) {
        name = (match.groups?.["id"] ?? "")
          .replaceAll(/[-_]/gu, " ")
          .replaceAll(/\b\w/gu, (c) => c.toUpperCase());
      }
    }
  }

  if (!name) {
    name = "identity";
  }

  const id =
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "") || "identity";

  return {
    color: "#3b82f6",
    id,
    ...(linkedinId ? { linkedinId } : {}),
    name,
  };
};

const parseMaxWidth = (): number => {
  const raw = Number(Bun.env["PIPELINE_MAX_WIDTH"]);
  return Number.isFinite(raw) && raw >= 320
    ? Math.floor(raw)
    : DEFAULT_MAX_WIDTH;
};

const RESIZE_TIMEOUT_MS = 5000;

/**
 * Best-effort downscale before shipping the image to Python. A timeout here
 * degrades to forwarding the original bytes (Python's PIL + InsightFace
 * handle arbitrary sizes; InsightFace resizes to 320px detector input
 * internally anyway).
 */
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

const resizeImage = async (
  bytes: ArrayBuffer
): Promise<{ data: string; height: number; width: number }> => {
  const maxWidth = parseMaxWidth();
  const input = Buffer.from(bytes);
  const img = new Bun.Image(input)
    .resize(maxWidth, maxWidth, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88 });
  const out = await withTimeout(
    img.bytes(),
    RESIZE_TIMEOUT_MS,
    () => new Error(`image resize timed out after ${RESIZE_TIMEOUT_MS}ms`)
  );
  const dims = await new Bun.Image(out).metadata();
  return {
    data: Buffer.from(out).toString("base64"),
    height: dims.height,
    width: dims.width,
  };
};

/** Fallback when sharp is unavailable/hung: forward original dimensions. */
const rawImagePayload = (
  bytes: ArrayBuffer
): { data: string; height: number; width: number } => {
  // JPEG SOF0/SOF2 scan for real dimensions (avoids decoding entirely).
  const view = new DataView(bytes);
  let offset = 2;
  let height = 0;
  let width = 0;
  while (offset + 9 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      break;
    }
    const marker = view.getUint8(offset + 1);
    const length = view.getUint16(offset + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      height = view.getUint16(offset + 5);
      width = view.getUint16(offset + 7);
      break;
    }
    offset += 2 + length;
  }
  return {
    data: Buffer.from(bytes).toString("base64"),
    height,
    width,
  };
};

const isAlreadyStoredError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|AlreadyStored/iu.test(message);
};

export const handlePipelineRequest = async (
  req: Request,
  bridge: BridgeLike,
  blockchain: BlockchainLike
): Promise<Response> => {
  const t0 = Date.now();
  console.log("[pipeline] ▶ POST /api/pipeline");
  let imageBytes: ArrayBuffer;
  try {
    const form = await req.formData();
    const file = form.get("image");
    if (!(file instanceof File) || file.size === 0) {
      throw new PipelineRequestError(
        "Multipart field 'image' with a non-empty file is required.",
        400
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new PipelineRequestError(
        `Image exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit.`,
        400
      );
    }
    imageBytes = await file.arrayBuffer();
  } catch (error) {
    if (error instanceof PipelineRequestError) {
      return json(
        {
          anchorStrategy: "none",
          blockchain: null,
          blockchainError: null,
          cacheHit: false,
          duplicate: false,
          enginesUsed: [],
          error: error.message,
          face: null,
          inputFaceHash: null,
          results: [],
          verified: false,
        },
        error.status
      );
    }
    return json(
      {
        anchorStrategy: "none",
        blockchain: null,
        blockchainError: null,
        cacheHit: false,
        duplicate: false,
        enginesUsed: [],
        error: "Invalid multipart/form-data request.",
        face: null,
        inputFaceHash: null,
        results: [],
        verified: false,
      },
      400
    );
  }

  let image: {
    data: string;
    height: number;
    mimeType: "image/jpeg";
    width: number;
  };
  try {
    image = {
      mimeType: "image/jpeg" as const,
      ...(await resizeImage(imageBytes)),
    };
  } catch (resizeError) {
    // Graceful degradation: sharp failed or timed out — forward the original
    // bytes with header-parsed dimensions. Python re-validates the image and
    // returns a clean 422 if it is genuinely undecodable.
    console.warn(
      "[pipeline] resize failed (sharp hang/error) — forwarding raw bytes:",
      resizeError instanceof Error ? resizeError.message : resizeError
    );
    image = { mimeType: "image/jpeg", ...rawImagePayload(imageBytes) };
  }

  const sessionId = crypto.randomUUID();

  let result: PythonPipelineResultMessage;
  try {
    result = await bridge.runPipeline(sessionId, image, PIPELINE_TIMEOUT_MS);
  } catch (error) {
    const toErrorResponse = (message: string, status: number): Response =>
      json(
        {
          anchorStrategy: "none",
          blockchain: null,
          blockchainError: null,
          cacheHit: false,
          duplicate: false,
          enginesUsed: [],
          error: message,
          face: null,
          inputFaceHash: null,
          results: [],
          verified: false,
        },
        status
      );
    if (error instanceof PythonDisconnectedError) {
      return toErrorResponse("Python service unavailable.", 503);
    }
    if (error instanceof PipelineBusyError) {
      return toErrorResponse("A pipeline run is already in progress.", 409);
    }
    if (error instanceof PipelineTimeoutError) {
      return toErrorResponse("Pipeline timed out before completion.", 504);
    }
    return toErrorResponse(
      error instanceof Error ? error.message : "Pipeline run failed.",
      500
    );
  }

  console.log(
    `[pipeline] python result: strategy=${result.anchorStrategy} cacheHit=${result.cacheHit} results=${result.results.length} engines=[${result.enginesUsed.join(",")}]`
  );

  if (result.error !== undefined) {
    console.warn(
      `[pipeline] ■ 422 python error: ${result.error} (+${Date.now() - t0}ms)`
    );
    return json(
      {
        anchorStrategy: result.anchorStrategy,
        blockchain: null,
        blockchainError: null,
        cacheHit: result.cacheHit,
        duplicate: false,
        enginesUsed: result.enginesUsed,
        error: result.error,
        face: result.face ?? null,
        inputFaceHash: result.inputFaceHash ?? null,
        results: [],
        verified: false,
      },
      422
    );
  }

  const top = result.results[0] ?? null;
  const inputFaceHash = result.inputFaceHash ?? null;

  if (top && result.anchorStrategy !== "embedding") {
    try {
      const identityMeta = parseIdentityFromFinding(top);
      if (typeof bridge.sendAdminMessage === "function") {
        console.log(
          `[pipeline] 👤 auto-enrolling found identity into live tracker: ${identityMeta.name} (${identityMeta.id})`
        );
        void bridge.sendAdminMessage({
          files: [
            {
              data: image.data,
              name: "scan_face.jpg",
            },
          ],
          id: identityMeta.id,
          metadata: identityMeta,
          type: "admin.upsert-identity",
        });
      }
    } catch (enrollError) {
      console.warn("[pipeline] 👤 auto-enrollment failed:", enrollError);
    }
  }

  const response: PipelineResponse = {
    anchorStrategy: result.anchorStrategy,
    blockchain: null,
    blockchainError: null,
    cacheHit: result.cacheHit,
    duplicate: false,
    enginesUsed: result.enginesUsed,
    error: null,
    face: result.face ?? null,
    inputFaceHash,
    results: result.results,
    verified: false,
  };

  // Blockchain anchoring is independently degradable: failures never fail a
  // scan that produced results — they surface as blockchainError instead.
  if (!blockchain.isConfigured()) {
    response.blockchainError = "Blockchain client is not configured.";
    return json(response);
  }
  if (!top || !inputFaceHash) {
    response.blockchainError = "No anchorable result was produced.";
    return json(response);
  }

  const hashable = buildHashableResult({
    engines: result.enginesUsed,
    inputFaceHash,
    similarity: top.similarity ?? 0,
    timestamp: Date.now(),
    url: top.url,
  });

  console.log(
    `[pipeline] ⛓️ anchoring: url=${top.url.slice(0, 60)} sim=${(top.similarity ?? 0).toFixed(3)} faceHash=${inputFaceHash.slice(0, 12)}…`
  );
  try {
    const record = await blockchain.store(hashable);
    response.blockchain = record;
    console.log(
      `[pipeline] ⛓️ stored: tx=${record.txHash.slice(0, 14)}… block=${record.blockNumber}`
    );
    const check = await blockchain.verifyResult(hashable, record.contentHash);
    response.verified = check.verified;
    if (!check.verified) {
      response.blockchainError = "On-chain verification failed.";
    }
  } catch (error) {
    // The contract enforces one record per hash. A duplicate means this exact
    // result was anchored before — treat it as previously verified instead of
    // an error, keeping repeat scans idempotent (no gas, no new tx).
    if (isAlreadyStoredError(error)) {
      console.log("[pipeline] ⛓️ already stored — verifying existing record");
      const recomputedHash = await contentHashOf(hashable);
      try {
        const existing = await blockchain.verify(recomputedHash);
        if (existing.exists) {
          response.duplicate = true;
          response.verified = true;
          response.blockchain = {
            blockNumber: 0,
            contentHash: recomputedHash,
            explorerUrl: "",
            storedAt: 0,
            txHash: "",
          };
          return json(response);
        }
      } catch {
        // Fall through to generic degradation below.
      }
      response.blockchainError = "Result was already anchored previously.";
      return json(response);
    }
    console.warn(
      `[pipeline] ⛓️ store FAILED:`,
      error instanceof Error ? error.message : error
    );
    response.blockchainError =
      error instanceof Error ? error.message : "Blockchain store failed.";
  }

  console.log(
    `[pipeline] ■ DONE: verified=${response.verified} results=${response.results.length} (+${Date.now() - t0}ms)`
  );
  return json(response);
};
