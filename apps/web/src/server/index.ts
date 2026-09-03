// oxlint-disable complexity, no-await-in-loop
import type { Serve, ServerWebSocket } from "bun";

import { BlockchainClient } from "../blockchain/blockchain";
import { PythonBridge } from "../bridge/python-bridge";
import {
  deleteEnrollmentIdentity,
  getEnrollmentIdentity,
  isEnrollmentStoreConfigured,
  listEnrollmentIdentities,
  readEnrollmentIdentityFiles,
  updateEnrollmentIdentityMetadata,
  upsertEnrollmentIdentity,
} from "../enrollment/enrollment-store";
import {
  handlePipelineRequest,
  PipelineRequestError,
} from "../pipeline/pipeline-service";
import {
  DEFAULT_SAMPLING,
  parseClientMessage,
  stringifyMessage,
} from "../protocol/protocol";
import type { ServerToClientMessage } from "../protocol/protocol";

interface ClientData {
  sessionId: string | null;
}

const publicDir = new URL("../client/", import.meta.url);
const pythonUrl = Bun.env["MIRA_SERVE_URL"] ?? "ws://127.0.0.1:8765";
const bridge = new PythonBridge(pythonUrl);
const blockchainClient = new BlockchainClient();
const asset = (pathname: string): Response =>
  new Response(Bun.file(new URL(pathname, publicDir)));
const send = (
  ws: ServerWebSocket<ClientData>,
  message: ServerToClientMessage
): void => {
  ws.send(stringifyMessage(message));
};
const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });
const optionalString = (
  value: FormDataEntryValue | null
): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};
const buildOptionalMetadata = ({
  color,
  email,
  githubUsername,
  linkedinId,
  name,
  phoneNumber,
  worksAt,
}: {
  color: string;
  email: string | undefined;
  githubUsername: string | undefined;
  linkedinId: string | undefined;
  name: string;
  phoneNumber: string | undefined;
  worksAt: string | undefined;
}) => ({
  color,
  ...(email === undefined ? {} : { email }),
  ...(githubUsername === undefined ? {} : { githubUsername }),
  ...(linkedinId === undefined ? {} : { linkedinId }),
  name,
  ...(phoneNumber === undefined ? {} : { phoneNumber }),
  ...(worksAt === undefined ? {} : { worksAt }),
});
const optionalJsonString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};
const slugify = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return slug || "identity";
};
const buildIdentityId = (
  identities: { id: string }[],
  name: string
): string => {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;

  while (identities.some((identity) => identity.id === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};
const syncStoredEnrollmentToServe = async (
  identities: Awaited<ReturnType<typeof listEnrollmentIdentities>>
) => {
  const { ready } = bridge.getStatus();
  const shouldHydrate =
    identities.length > 0 &&
    (ready === null ||
      (ready.enrollment.identities === 0 &&
        ready.enrollment.diagnostics.length === 0));

  if (!shouldHydrate) {
    return ready?.enrollment ?? null;
  }

  let enrollment = ready?.enrollment ?? null;
  for (const identity of identities) {
    const result = await bridge.sendAdminMessage({
      files: await readEnrollmentIdentityFiles(identity),
      id: identity.id,
      metadata: identity.metadata,
      type: "admin.upsert-identity",
    });
    if (result.ok && result.enrollment !== undefined) {
      ({ enrollment } = result);
    }
  }

  return enrollment;
};
const handleEnrollmentRequest = async (req: Request): Promise<Response> => {
  if (!isEnrollmentStoreConfigured()) {
    return json(
      {
        error: "Enrollment storage is not configured.",
      },
      503
    );
  }

  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/api/enrollment") {
    const identities = await listEnrollmentIdentities();
    const enrollment = await syncStoredEnrollmentToServe(identities);
    return json({
      enrollment,
      identities,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/enrollment") {
    const form = await req.formData();
    const name = form.get("name");
    const worksAt = optionalString(form.get("worksAt"));
    const color = form.get("color");
    const linkedinId = optionalString(form.get("linkedinId"));
    const githubUsername = optionalString(form.get("githubUsername"));
    const email = optionalString(form.get("email"));
    const phoneNumber = optionalString(form.get("phoneNumber"));
    const files = form
      .getAll("files")
      .filter(
        (value): value is File => value instanceof File && value.size > 0
      );

    if (
      typeof name !== "string" ||
      typeof color !== "string" ||
      files.length === 0
    ) {
      return json(
        { error: "name, color, and at least one file are required." },
        400
      );
    }

    const existingIdentities = await listEnrollmentIdentities();
    const id = buildIdentityId(existingIdentities, name);
    const metadata = buildOptionalMetadata({
      color,
      email,
      githubUsername,
      linkedinId,
      name,
      phoneNumber,
      worksAt,
    });
    const identities = await upsertEnrollmentIdentity(
      {
        id,
        ...metadata,
      },
      files
    );
    const reload = await bridge.sendAdminMessage({
      files: await Promise.all(
        files.map(async (file) => ({
          data: Buffer.from(await file.arrayBuffer()).toString("base64"),
          name: file.name,
        }))
      ),
      id,
      metadata,
      type: "admin.upsert-identity",
    });
    return json({ identities, reload });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/enrollment/")) {
    const identityId = decodeURIComponent(
      url.pathname.replace("/api/enrollment/", "")
    );
    if (!identityId) {
      return json({ error: "identity id is required." }, 400);
    }

    const existingIdentity = await getEnrollmentIdentity(identityId);
    if (existingIdentity === undefined) {
      return json({ error: "identity not found." }, 404);
    }

    const payload = (await req.json()) as Record<string, unknown>;
    const name = optionalJsonString(payload["name"]);
    const color = optionalJsonString(payload["color"]);
    if (name === undefined || color === undefined) {
      return json({ error: "name and color are required." }, 400);
    }

    const metadata = buildOptionalMetadata({
      color,
      email: optionalJsonString(payload["email"]),
      githubUsername: optionalJsonString(payload["githubUsername"]),
      linkedinId: optionalJsonString(payload["linkedinId"]),
      name,
      phoneNumber: optionalJsonString(payload["phoneNumber"]),
      worksAt: optionalJsonString(payload["worksAt"]),
    });
    const identities = await updateEnrollmentIdentityMetadata(
      identityId,
      metadata
    );
    const reload = await bridge.sendAdminMessage({
      files: await readEnrollmentIdentityFiles(existingIdentity),
      id: identityId,
      metadata,
      type: "admin.upsert-identity",
    });
    return json({ identities, reload });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/enrollment/")) {
    const identityId = decodeURIComponent(
      url.pathname.replace("/api/enrollment/", "")
    );
    if (!identityId) {
      return json({ error: "identity id is required." }, 400);
    }

    const identities = await deleteEnrollmentIdentity(identityId);
    const reload = await bridge.sendAdminMessage({
      id: identityId,
      type: "admin.delete-identity",
    });
    return json({ identities, reload });
  }

  return json({ error: "Not found" }, 404);
};
const server = Bun.serve({
  async fetch(req, serverInstance) {
    const url = new URL(req.url);

    if (url.pathname === "/ws/client") {
      const upgraded = serverInstance.upgrade(req, {
        data: {
          sessionId: null,
        },
      });

      if (upgraded) {
        return;
      }

      return new Response("WebSocket upgrade failed.", { status: 500 });
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        pythonUrl,
      });
    }

    if (url.pathname.startsWith("/api/enrollment")) {
      try {
        return await handleEnrollmentRequest(req);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Enrollment request failed.",
          },
          500
        );
      }
    }

    if (url.pathname === "/api/pipeline/progress" && req.method === "GET") {
      const scanId = url.searchParams.get("scanId") ?? "";
      if (!/^[A-Za-z0-9-]{8,64}$/u.test(scanId)) {
        return json({ error: "Query param 'scanId' is required." }, 400);
      }
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;
      const stream = new ReadableStream<string>({
        cancel() {
          if (heartbeat !== undefined) {
            clearInterval(heartbeat);
          }
          unsubscribe?.();
        },
        start(controller) {
          const push = (data: string): void => {
            try {
              controller.enqueue(data);
            } catch {
              // client went away; cancel() cleans up
            }
          };
          unsubscribe = bridge.subscribePipelineProgress(scanId, (event) => {
            push(`data: ${JSON.stringify(event)}\n\n`);
            if (event.stage === "scan" && event.state === "done") {
              // Terminal event — give the transport a beat to flush, then end.
              setTimeout(() => {
                try {
                  controller.close();
                } catch {
                  // already closed
                }
              }, 50);
            }
          });
          heartbeat = setInterval(() => {
            push(": ping\n\n");
          }, 15_000);
          req.signal.addEventListener(
            "abort",
            () => {
              if (heartbeat !== undefined) {
                clearInterval(heartbeat);
              }
              unsubscribe?.();
              try {
                controller.close();
              } catch {
                // already closed
              }
            },
            { once: true }
          );
        },
      });
      return new Response(stream, {
        headers: {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        },
      });
    }

    if (url.pathname === "/api/pipeline" && req.method === "POST") {
      try {
        return await handlePipelineRequest(req, bridge, blockchainClient);
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
            error:
              error instanceof Error
                ? error.message
                : "Pipeline request failed.",
            face: null,
            inputFaceHash: null,
            results: [],
            verified: false,
          },
          500
        );
      }
    }

    // Client bundle — `src/client/app.ts` + `camera.ts` → `client/app.js`
    // Uses Bun.build on-the-fly in dev so TS is served as JS without a
    // separate build step; `bun run build` handles prod bundling.
    if (
      url.pathname === "/client/app.js" ||
      url.pathname === "/client/camera.js" ||
      url.pathname === "/client.js"
    ) {
      const entry =
        url.pathname === "/client/camera.js"
          ? new URL("../client/camera.ts", import.meta.url).pathname
          : new URL("../client/app.ts", import.meta.url).pathname;
      try {
        const build = await Bun.build({
          entrypoints: [entry],
          minify: false,
          sourcemap: "inline",
          target: "browser",
        });
        const [output] = build.outputs;
        if (build.success && output !== undefined) {
          const text = await output.text();
          return new Response(text, {
            headers: { "Content-Type": "application/javascript" },
          });
        }
      } catch {
        // fall through to static file
      }
      // Fallback: serve the TS source directly (browser will handle as JS if no TS syntax)
      const fallback =
        url.pathname === "/client/camera.js" ? "camera.ts" : "app.ts";
      return new Response(
        Bun.file(new URL(`../client/${fallback}`, import.meta.url)),
        {
          headers: { "Content-Type": "application/javascript" },
        }
      );
    }

    if (
      url.pathname === "/favicon.ico" ||
      url.pathname === "/favicon.svg" ||
      url.pathname === "/mira.svg"
    ) {
      return asset("mira.svg");
    }

    if (
      url.pathname === "/styles.css" ||
      url.pathname === "/client/styles.css"
    ) {
      return asset("styles.css");
    }

    return asset("index.html");
  },
  port: Number(Bun.env["PORT"] ?? 3000),
  websocket: {
    close(ws) {
      if (ws.data.sessionId !== null) {
        bridge.unregisterSession(ws.data.sessionId);
      }
    },
    data: {} as ClientData,
    idleTimeout: 120,
    maxPayloadLength: 8 * 1024 * 1024,
    message(ws, raw) {
      try {
        const message = parseClientMessage(raw);
        if (message.type === "client.hello") {
          const sessionId = message.sessionId ?? crypto.randomUUID();
          ws.data.sessionId = sessionId;
          const status = bridge.registerSession(sessionId, (payload) => {
            send(ws, payload);
          });

          send(ws, {
            sampling: DEFAULT_SAMPLING,
            sessionId,
            type: "session.ready",
          });
          send(ws, {
            connected: status.connected,
            detail: status.detail,
            ready: status.ready,
            reconnecting: status.reconnecting,
            type: "python.status",
          });
          return;
        }

        const { sessionId } = ws.data;
        if (sessionId === null || sessionId !== message.sessionId) {
          send(ws, {
            message: "Session mismatch. Refresh the page and reconnect.",
            type: "error",
          });
          return;
        }

        if (message.type === "signal") {
          bridge.handleSignal(message);
          return;
        }

        bridge.handleFrame(message);
      } catch (error) {
        send(ws, {
          message:
            error instanceof Error ? error.message : "Unknown server error",
          type: "error",
        });
      }
    },
    perMessageDeflate: true,
  },
} satisfies Serve.Options<ClientData>);

console.log(
  `Mira web listening on http://${server.hostname}:${server.port} ` +
    `with Python bridge ${pythonUrl}`
);

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Mira web shutting down on ${signal}`);
  bridge.close();
  await server.stop(true);
  process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
