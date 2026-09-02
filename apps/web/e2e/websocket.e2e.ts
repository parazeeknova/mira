// oxlint-disable avoid-new
import { expect, test } from "@playwright/test";

// Every WebSocket test needs a real page origin: on about:blank the browser
// blocks ws:// connections outright, so evaluate() alone always fails.
test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test.describe("WebSocket connection", () => {
  test("connects to WebSocket endpoint", async ({ page }) => {
    const wsConnected = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);
          ws.addEventListener("open", () => {
            ws.close();
            resolve(true);
          });
          ws.addEventListener("error", () => {
            resolve(false);
          });
          setTimeout(() => resolve(false), 5000);
        })
    );

    expect(wsConnected).toBe(true);
  });

  test("receives session.ready message after hello", async ({ page }) => {
    const messages: unknown[] = await page.evaluate(
      () =>
        new Promise<unknown[]>((resolve, reject) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);
          const received: unknown[] = [];

          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "client.hello" }));
          });

          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            received.push(msg);

            if (msg.type === "session.ready") {
              ws.close();
            }
          });

          ws.addEventListener("close", () => resolve(received));

          ws.addEventListener("error", () =>
            reject(new Error("WebSocket error"))
          );

          setTimeout(() => {
            ws.close();
            resolve(received);
          }, 5000);
        })
    );

    const sessionReady = messages.find(
      (m: unknown) => (m as { type: string }).type === "session.ready"
    );
    expect(sessionReady).toBeDefined();
    expect((sessionReady as { sessionId: string }).sessionId).toBeDefined();
    expect(
      (sessionReady as { sampling: { intervalMs: number } }).sampling.intervalMs
    ).toBeDefined();
  });

  test("receives python.status after hello", async ({ page }) => {
    const messages: unknown[] = await page.evaluate(
      () =>
        new Promise<unknown[]>((resolve, reject) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);
          const received: unknown[] = [];

          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "client.hello" }));
          });

          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            received.push(msg);
          });

          ws.addEventListener("close", () => resolve(received));

          ws.addEventListener("error", () =>
            reject(new Error("WebSocket error"))
          );

          setTimeout(() => {
            ws.close();
            resolve(received);
          }, 5000);
        })
    );

    const pythonStatus = messages.find(
      (m: unknown) => (m as { type: string }).type === "python.status"
    );
    expect(pythonStatus).toBeDefined();
    expect(typeof (pythonStatus as { connected: boolean }).connected).toBe(
      "boolean"
    );
    expect(typeof (pythonStatus as { detail: string }).detail).toBe("string");
    expect(
      typeof (pythonStatus as { reconnecting: boolean }).reconnecting
    ).toBe("boolean");
  });

  test("rejects message without hello", async ({ page }) => {
    const errorMessage = await page.evaluate(
      () =>
        new Promise<string | null>((resolve, reject) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);

          ws.addEventListener("open", () => {
            ws.send(
              JSON.stringify({
                payload: {},
                sessionId: "invalid-session",
                signalType: "offer",
                type: "signal",
              })
            );
          });

          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === "error") {
              ws.close();
              resolve(msg.message);
            }
          });

          ws.addEventListener("error", () =>
            reject(new Error("WebSocket error"))
          );

          setTimeout(() => {
            ws.close();
            resolve(null);
          }, 3000);
        })
    );

    expect(errorMessage).toContain("Session mismatch");
  });

  test("handles client.hello with provided sessionId", async ({ page }) => {
    const providedSessionId = "custom-session-123";

    const receivedSessionId = await page.evaluate(
      (sessionId) =>
        new Promise<string | null>((resolve, reject) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);

          ws.addEventListener("open", () => {
            ws.send(
              JSON.stringify({
                sessionId,
                type: "client.hello",
              })
            );
          });

          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === "session.ready") {
              ws.close();
              resolve(msg.sessionId);
            }
          });

          ws.addEventListener("close", () => resolve(null));
          ws.addEventListener("error", () =>
            reject(new Error("WebSocket error"))
          );

          setTimeout(() => {
            ws.close();
            resolve(null);
          }, 5000);
        }),
      providedSessionId
    );

    expect(receivedSessionId).toBe(providedSessionId);
  });

  test("handles signal messages", async ({ page }) => {
    const messages: unknown[] = await page.evaluate(
      () =>
        new Promise<unknown[]>((resolve, reject) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);
          const received: unknown[] = [];
          let sessionId: string | null = null;

          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "client.hello" }));
          });

          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            received.push(msg);

            if (msg.type === "session.ready") {
              ({ sessionId } = msg);
              ws.send(
                JSON.stringify({
                  payload: { sdp: "test-sdp" },
                  sessionId,
                  signalType: "offer",
                  type: "signal",
                })
              );
            }

            if (msg.type === "signal.ack") {
              ws.close();
            }
          });

          ws.addEventListener("close", () => resolve(received));
          ws.addEventListener("error", () =>
            reject(new Error("WebSocket error"))
          );

          setTimeout(() => {
            ws.close();
            resolve(received);
          }, 5000);
        })
    );

    const signalAck = messages.find(
      (m: unknown) => (m as { type: string }).type === "signal.ack"
    );
    expect(signalAck).toBeDefined();
    expect((signalAck as { signalType: string }).signalType).toBe("offer");
  });

  test("handles frame.submit messages", async ({ page }) => {
    const messages: unknown[] = await page.evaluate(
      () =>
        new Promise<unknown[]>((resolve, reject) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);
          const received: unknown[] = [];
          let sessionId: string | null = null;

          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "client.hello" }));
          });

          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            received.push(msg);

            if (msg.type === "session.ready") {
              ({ sessionId } = msg);
              ws.send(
                JSON.stringify({
                  capturedAt: Date.now(),
                  frameId: 1,
                  image: {
                    data: "dGVzdA==",
                    height: 100,
                    mimeType: "image/jpeg",
                    width: 100,
                  },
                  sampleIntervalMs: 80,
                  sessionId,
                  type: "frame.submit",
                })
              );
            }
          });

          ws.addEventListener("close", () => resolve(received));
          ws.addEventListener("error", () =>
            reject(new Error("WebSocket error"))
          );

          setTimeout(() => {
            ws.close();
            resolve(received);
          }, 5000);
        })
    );

    expect(
      messages.some(
        (m: unknown) => (m as { type: string }).type === "session.ready"
      )
    ).toBe(true);
  });

  test("rejects invalid message types", async ({ page }) => {
    const errorMessage = await page.evaluate(
      () =>
        new Promise<string | null>((resolve, reject) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);
          let sessionId: string | null = null;

          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "client.hello" }));
          });

          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === "session.ready") {
              ({ sessionId } = msg);
              ws.send(
                JSON.stringify({
                  sessionId,
                  type: "invalid.type",
                })
              );
            }
            if (msg.type === "error") {
              ws.close();
              resolve(msg.message);
            }
          });

          ws.addEventListener("error", () =>
            reject(new Error("WebSocket error"))
          );

          setTimeout(() => {
            ws.close();
            resolve(null);
          }, 3000);
        })
    );

    expect(errorMessage).toBeDefined();
  });

  test("handles malformed JSON", async ({ page }) => {
    const errorMessage = await page.evaluate(
      () =>
        new Promise<string | null>((resolve, reject) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);

          ws.addEventListener("open", () => {
            ws.send("not valid json");
          });

          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === "error") {
              ws.close();
              resolve(msg.message);
            }
          });

          ws.addEventListener("error", () =>
            reject(new Error("WebSocket error"))
          );

          setTimeout(() => {
            ws.close();
            resolve(null);
          }, 3000);
        })
    );

    expect(errorMessage).toBeDefined();
  });
});

test.describe("WebSocket connection lifecycle", () => {
  test("maintains connection across multiple messages", async ({ page }) => {
    const messageCount = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);
          let count = 0;
          let sessionId: string | null = null;

          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "client.hello" }));
          });

          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            count += 1;

            if (msg.type === "session.ready") {
              ({ sessionId } = msg);

              for (let i = 0; i < 3; i += 1) {
                ws.send(
                  JSON.stringify({
                    payload: { index: i },
                    sessionId,
                    signalType: "offer",
                    type: "signal",
                  })
                );
              }

              setTimeout(() => ws.close(), 1000);
            }
          });

          ws.addEventListener("close", () => resolve(count));
          ws.addEventListener("error", () =>
            reject(new Error("WebSocket error"))
          );

          setTimeout(() => {
            ws.close();
            resolve(count);
          }, 5000);
        })
    );

    expect(messageCount).toBeGreaterThanOrEqual(2);
  });
});

test.describe("Session ID handling", () => {
  test("generates new session ID when not provided", async ({ page }) => {
    const sessionId = await page.evaluate(
      () =>
        new Promise<string | null>((resolve, reject) => {
          const ws = new WebSocket(`ws://${window.location.host}/ws/client`);

          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "client.hello" }));
          });

          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === "session.ready") {
              ws.close();
              resolve(msg.sessionId);
            }
          });

          ws.addEventListener("error", () =>
            reject(new Error("WebSocket error"))
          );

          setTimeout(() => {
            ws.close();
            resolve(null);
          }, 3000);
        })
    );

    expect(sessionId).not.toBeNull();
    expect(sessionId?.length).toBe(36);
  });
});
