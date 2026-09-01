import { describe, expect, test } from "bun:test";

import {
  handlePipelineRequest,
  PipelineRequestError,
} from "./pipeline-service";
import type { PythonPipelineResultMessage } from "./protocol";
import { PythonDisconnectedError } from "./python-bridge";

const buildForm = (bytes: Uint8Array): FormData => {
  const form = new FormData();
  form.append(
    "image",
    new File([bytes as unknown as BlobPart], "face.jpg", { type: "image/jpeg" })
  );
  return form;
};

/**
 * Minimal valid JPEG (1x1 white pixel) as raw bytes — used to reach the
 * bridge in happy-path tests without depending on sharp (which can hang
 * under Bun's native threadpool in some environments).
 */
const VALID_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08,
  0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a,
  0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d,
  0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22,
  0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34,
  0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0,
  0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4,
  0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
  0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01,
  0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13,
  0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
  0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a,
  0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
  0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
  0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84,
  0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3,
  0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00,
  0x00, 0x3f, 0x00, 0x7b, 0x94, 0x11, 0x00, 0x00, 0x00, 0x00, 0xff, 0xd9,
]);

/** 1x1 JPEG has no resize work; dimensions parsed from the SOF header. */
const validJpeg = async (): Promise<Uint8Array> => VALID_JPEG;

const OK_RESULT: PythonPipelineResultMessage = {
  anchorStrategy: "search",
  cacheHit: false,
  enginesUsed: ["google-vision"],
  face: { bbox: { height: 80, width: 70, x: 10, y: 20 }, confidence: 0.9 },
  inputFaceHash: "a".repeat(64),
  results: [
    {
      engine: "google-vision",
      fetchedAt: 1,
      finalScore: 1.1,
      imageUrl: null,
      multiSourceCount: 1,
      platform: "linkedin",
      similarity: 0.9,
      snippet: null,
      sourceStrategy: "google-vision",
      title: "t",
      url: "https://example.com/post",
    },
  ],
  sessionId: "s",
  type: "pipeline.result",
};

const okBridge = {
  runPipeline: async () => OK_RESULT,
};

const okChain = {
  isConfigured: () => true,
  store: async () => ({
    blockNumber: 1,
    contentHash: "h".repeat(64),
    explorerUrl: "https://x/tx/1",
    storedAt: 1,
    txHash: "0x1",
  }),
  verify: async () => ({ exists: true }),
  verifyResult: async () => ({ exists: true, hashMatch: true, verified: true }),
};

describe("handlePipelineRequest — request validation", () => {
  test("returns 400 when image field is missing", async () => {
    const res = await handlePipelineRequest(
      new Request("http://x/api/pipeline", {
        body: new FormData(),
        method: "POST",
      }),
      okBridge,
      okChain
    );
    expect(res.status).toBe(400);
  });

  test("returns 503 when Python is disconnected", async () => {
    const disconnectedBridge = {
      runPipeline: async () => {
        throw new PythonDisconnectedError();
      },
    };
    const res = await handlePipelineRequest(
      new Request("http://x/api/pipeline", {
        body: buildForm(await validJpeg()),
        method: "POST",
      }),
      disconnectedBridge,
      okChain
    );
    expect(res.status).toBe(503);
  });
});

describe("handlePipelineRequest — blockchain degradation", () => {
  test("returns 200 with blockchainError when chain not configured", async () => {
    const res = await handlePipelineRequest(
      new Request("http://x/api/pipeline", {
        body: buildForm(await validJpeg()),
        method: "POST",
      }),
      okBridge,
      { ...okChain, isConfigured: () => false }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      blockchainError: string | null;
      results: unknown[];
    };
    expect(body.blockchainError).toContain("not configured");
    expect(body.results).toHaveLength(1);
  });

  test("returns 200 with blockchainError when store throws", async () => {
    const res = await handlePipelineRequest(
      new Request("http://x/api/pipeline", {
        body: buildForm(await validJpeg()),
        method: "POST",
      }),
      okBridge,
      {
        ...okChain,
        store: async () => {
          throw new Error("RPC down");
        },
      }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blockchainError: string | null };
    expect(body.blockchainError).toBe("RPC down");
  });

  test("duplicate store with existing on-chain record is verified idempotently", async () => {
    const res = await handlePipelineRequest(
      new Request("http://x/api/pipeline", {
        body: buildForm(await validJpeg()),
        method: "POST",
      }),
      okBridge,
      {
        ...okChain,
        store: async () => {
          throw new Error("execution reverted: custom error AlreadyStored()");
        },
      }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      duplicate: boolean;
      verified: boolean;
    };
    expect(body.duplicate).toBe(true);
    expect(body.verified).toBe(true);
  });

  test("duplicate store with missing on-chain record is NOT verified", async () => {
    const res = await handlePipelineRequest(
      new Request("http://x/api/pipeline", {
        body: buildForm(await validJpeg()),
        method: "POST",
      }),
      okBridge,
      {
        ...okChain,
        store: async () => {
          throw new Error("AlreadyStored");
        },
        verify: async () => ({ exists: false }),
      }
    );
    const body = (await res.json()) as {
      blockchainError: string | null;
      duplicate: boolean;
      verified: boolean;
    };
    expect(body.duplicate).toBe(false);
    expect(body.verified).toBe(false);
    expect(body.blockchainError).toContain("already anchored");
  });

  test("failed verification surfaces blockchainError", async () => {
    const res = await handlePipelineRequest(
      new Request("http://x/api/pipeline", {
        body: buildForm(await validJpeg()),
        method: "POST",
      }),
      okBridge,
      {
        ...okChain,
        verifyResult: async () => ({
          exists: true,
          hashMatch: false,
          verified: false,
        }),
      }
    );
    const body = (await res.json()) as {
      blockchainError: string | null;
      verified: boolean;
    };
    expect(body.verified).toBe(false);
    expect(body.blockchainError).toContain("verification failed");
  });
});

describe("handlePipelineRequest — pipeline errors", () => {
  test("returns 422 when Python reports an error (e.g. no face)", async () => {
    const noFaceBridge = {
      runPipeline: async (): Promise<PythonPipelineResultMessage> => ({
        anchorStrategy: "none",
        cacheHit: false,
        enginesUsed: [],
        error: "NoFaceFoundError: no face detected",
        results: [],
        sessionId: "s",
        type: "pipeline.result",
      }),
    };
    const res = await handlePipelineRequest(
      new Request("http://x/api/pipeline", {
        body: buildForm(await validJpeg()),
        method: "POST",
      }),
      noFaceBridge,
      okChain
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("NoFaceFoundError");
  });
});

describe("PipelineRequestError", () => {
  test("carries status", () => {
    const err = new PipelineRequestError("nope", 409);
    expect(err.status).toBe(409);
    expect(err.message).toBe("nope");
  });
});
