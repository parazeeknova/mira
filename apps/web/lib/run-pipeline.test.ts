import { describe, expect, test, afterEach } from "bun:test";

import type { PipelineImage } from "./protocol";
import {
  PipelineBusyError,
  PythonDisconnectedError,
  PipelineTimeoutError,
  PythonBridge,
} from "./python-bridge";

const IMG: PipelineImage = {
  data: "aGVsbG8=",
  height: 720,
  mimeType: "image/jpeg",
  width: 1280,
};

const REAL_WEBSOCKET = globalThis.WebSocket;

/**
 * Minimal stand-in for the upstream WebSocket. The bridge constructs it via
 * `new WebSocket(url)` inside ensureConnection(), so we stub the global
 * constructor — that way the bridge registers its listeners on OUR object.
 */
class FakeUpstream extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeUpstream.CONNECTING;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  /** Simulate the connection opening. */
  open(): void {
    this.readyState = FakeUpstream.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** Simulate the socket closing. */
  fireClose(): void {
    this.readyState = FakeUpstream.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  /** Simulate Python sending a message back. */
  emit(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const stubGlobalWebSocket = (): void => {
  (globalThis as unknown as Record<string, unknown>)["WebSocket"] =
    FakeUpstream;
};

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>)["WebSocket"] =
    REAL_WEBSOCKET;
});

/** Install fake + drive the bridge's own connection flow to OPEN. */
const connectFake = (bridge: PythonBridge): FakeUpstream => {
  stubGlobalWebSocket();
  (bridge as unknown as { ensureConnection(): void }).ensureConnection();
  const fake = (bridge as unknown as { upstream: FakeUpstream }).upstream;
  fake.open();
  return fake;
};

const rejectionOf = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};

const makeResult = (sessionId: string) => ({
  type: "pipeline.result",
  sessionId,
  results: [],
  anchorStrategy: "search",
  enginesUsed: ["google-vision"],
  cacheHit: false,
  inputFaceHash: "f".repeat(64),
});

describe("runPipeline", () => {
  test("rejects immediately when upstream is not open", async () => {
    stubGlobalWebSocket();
    const bridge = new PythonBridge("ws://127.0.0.1:1");
    // Upstream exists but stuck in CONNECTING → not open → immediate reject.
    (bridge as unknown as { ensureConnection(): void }).ensureConnection();
    const err = await rejectionOf(bridge.runPipeline("s1", IMG, 500));
    expect(err).toBeInstanceOf(PythonDisconnectedError);
  });

  test("sends pipeline.run message with session and image", async () => {
    const bridge = new PythonBridge("ws://127.0.0.1:1");
    const fake = connectFake(bridge);
    const pending = bridge.runPipeline("s1", IMG, 500);
    expect(fake.sent).toHaveLength(1);
    const sent = JSON.parse(fake.sent[0]!);
    expect(sent.type).toBe("pipeline.run");
    expect(sent.sessionId).toBe("s1");
    expect(sent.image).toEqual(IMG);
    fake.emit(JSON.stringify(makeResult("s1")));
    const result = (await pending) as unknown as {
      type: string;
      enginesUsed: string[];
    };
    expect(result.type).toBe("pipeline.result");
    expect(result.enginesUsed).toEqual(["google-vision"]);
  });

  test("rejects second concurrent run for the same session (busy guard)", async () => {
    const bridge = new PythonBridge("ws://127.0.0.1:1");
    connectFake(bridge);
    const first = bridge.runPipeline("s1", IMG, 500);
    const err = await rejectionOf(bridge.runPipeline("s1", IMG, 500));
    expect(err).toBeInstanceOf(PipelineBusyError);
    // Clean up the still-pending first request.
    const e1 = await rejectionOf(first);
    expect(e1).toBeInstanceOf(PipelineTimeoutError);
  });

  test("allows concurrent runs for different sessions", async () => {
    const bridge = new PythonBridge("ws://127.0.0.1:1");
    const fake = connectFake(bridge);
    const p1 = bridge.runPipeline("s1", IMG, 500);
    const p2 = bridge.runPipeline("s2", IMG, 500);
    fake.emit(JSON.stringify(makeResult("s2")));
    fake.emit(JSON.stringify(makeResult("s1")));
    const [r1, r2] = (await Promise.all([p1, p2])) as unknown as [
      { sessionId: string },
      { sessionId: string },
    ];
    expect(r1.sessionId).toBe("s1");
    expect(r2.sessionId).toBe("s2");
  });

  test("timeout rejects with PipelineTimeoutError", async () => {
    const bridge = new PythonBridge("ws://127.0.0.1:1");
    connectFake(bridge);
    const err = await rejectionOf(bridge.runPipeline("s1", IMG, 50));
    expect(err).toBeInstanceOf(PipelineTimeoutError);
  });

  test("WS close rejects pending request with PythonDisconnectedError", async () => {
    const bridge = new PythonBridge("ws://127.0.0.1:1");
    const fake = connectFake(bridge);
    const pending = bridge.runPipeline("s1", IMG, 5000);
    fake.fireClose();
    const err = await rejectionOf(pending);
    expect(err).toBeInstanceOf(PythonDisconnectedError);
  });

  test("result for unknown session is ignored without crashing", async () => {
    const bridge = new PythonBridge("ws://127.0.0.1:1");
    const fake = connectFake(bridge);
    const pending = bridge.runPipeline("s1", IMG, 500);
    fake.emit(JSON.stringify(makeResult("someone-else")));
    // Original request should still be pending; resolve it normally.
    fake.emit(JSON.stringify(makeResult("s1")));
    const result = (await pending) as unknown as { sessionId: string };
    expect(result.sessionId).toBe("s1");
  });
});
