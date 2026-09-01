import { describe, expect, test } from "bun:test";

import sharp from "sharp";

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

/** Tiny valid JPEG used to reach the bridge in happy-path tests. */
const validJpeg = async (): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp({
      create: { channels: 3, height: 64, width: 64, background: "grey" },
    })
      .jpeg()
      .toBuffer()
  );

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

const baseResponse = await handlePipelineRequest(
  new Request("http://x/api/pipeline", {
    // Garbage bytes: a valid form whose body is not a decodable image.
    body: buildForm(new TextEncoder().encode("this is not an image")),
    method: "POST",
  }),
  okBridge,
  okChain
);

// NOTE: the request above has an invalid JPEG body; sharp will fail to decode
// it. All happy-path tests use injected fake bridges instead of real decoding,
// so we only assert the decode-failure path here.
describe("handlePipelineRequest — request validation", () => {
  test("returns 400 for undecodable image", async () => {
    expect(baseResponse.status).toBe(400);
    const body = (await baseResponse.json()) as { error: string };
    expect(body.error).toContain("could not be decoded");
  });

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
