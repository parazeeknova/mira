import sharp from "sharp";

import { buildHashableResult, contentHashOf } from "./blockchain";
import type { BlockchainClient, ChainRecord } from "./blockchain";
import type {
  PipelineCandidateResult,
  PythonPipelineResultMessage,
} from "./protocol";
import {
  PipelineBusyError,
  PipelineTimeoutError,
  PythonDisconnectedError,
} from "./python-bridge";

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
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "PipelineRequestError";
  }
}

interface BridgeLike {
  runPipeline(
    sessionId: string,
    image: {
      data: string;
      height: number;
      mimeType: "image/jpeg";
      width: number;
    },
    timeoutMs?: number
  ): Promise<PythonPipelineResultMessage>;
}

interface BlockchainLike {
  isConfigured(): boolean;
  store(result: Parameters<BlockchainClient["store"]>[0]): Promise<ChainRecord>;
  verify(contentHash: string): Promise<{ exists: boolean }>;
  verifyResult(
    result: Parameters<BlockchainClient["verifyResult"]>[0],
    expectedHash: string
  ): Promise<{ exists: boolean; hashMatch: boolean; verified: boolean }>;
}

const json = (body: PipelineResponse, status = 200): Response =>
  Response.json(body, { status });

const parseMaxWidth = (): number => {
  const raw = Number(Bun.env["PIPELINE_MAX_WIDTH"]);
  return Number.isFinite(raw) && raw >= 320
    ? Math.floor(raw)
    : DEFAULT_MAX_WIDTH;
};

const resizeImage = async (
  bytes: ArrayBuffer
): Promise<{ data: string; height: number; width: number }> => {
  const maxWidth = parseMaxWidth();
  const resized = await sharp(Buffer.from(bytes))
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ mozjpeg: true, quality: 88 })
    .toBuffer();
  const meta = await sharp(resized).metadata();
  return {
    data: resized.toString("base64"),
    height: meta.height ?? 0,
    width: meta.width ?? 0,
  };
};

const isAlreadyStoredError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|AlreadyStored/i.test(message);
};

export const handlePipelineRequest = async (
  req: Request,
  bridge: BridgeLike,
  blockchain: BlockchainLike
): Promise<Response> => {
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
  } catch {
    return json(
      {
        anchorStrategy: "none",
        blockchain: null,
        blockchainError: null,
        cacheHit: false,
        duplicate: false,
        enginesUsed: [],
        error: "Image could not be decoded. JPEG/PNG/WebP are supported.",
        face: null,
        inputFaceHash: null,
        results: [],
        verified: false,
      },
      400
    );
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

  if (result.error !== undefined) {
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

  try {
    const record = await blockchain.store(hashable);
    response.blockchain = record;
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
    response.blockchainError =
      error instanceof Error ? error.message : "Blockchain store failed.";
  }

  return json(response);
};
