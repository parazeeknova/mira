import type { Serve, ServerWebSocket } from "bun";

import {
  deleteEnrollmentIdentity,
  getEnrollmentIdentity,
  isEnrollmentStoreConfigured,
  listEnrollmentIdentities,
  readEnrollmentIdentityFiles,
  updateEnrollmentIdentityMetadata,
  upsertEnrollmentIdentity,
} from "./lib/enrollment-store";
import {
  DEFAULT_SAMPLING,
  parseClientMessage,
  stringifyMessage,
} from "./lib/protocol";
import type { ServerToClientMessage } from "./lib/protocol";
import { PythonBridge } from "./lib/python-bridge";

interface ClientData {
  sessionId: string | null;
}

const publicDir = new URL("public/", import.meta.url),
 pythonUrl = Bun.env["MIRA_SERVE_URL"] ?? "ws://127.0.0.1:8765",
 bridge = new PythonBridge(pythonUrl),

 asset = (pathname: string): Response =>
  new Response(Bun.file(new URL(pathname, publicDir))),

 send = (
  ws: ServerWebSocket<ClientData>,
  message: ServerToClientMessage
): void => {
  ws.send(stringifyMessage(message));
},

 json = (body: unknown, status = 200): Response =>
  Response.json(body, { status }),

 optionalString = (
  value: FormDataEntryValue | null
): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
},

 buildOptionalMetadata = ({
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
}),

 optionalJsonString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
},

 slugify = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug || "identity";
},

 buildIdentityId = (
  identities: { id: string }[],
  name: string
): string => {
  const base = slugify(name);
  let candidate = base,
   suffix = 2;

  while (identities.some((identity) => identity.id === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
},

 syncStoredEnrollmentToServe = async (
  identities: Awaited<ReturnType<typeof listEnrollmentIdentities>>
) => {
  const { ready } = bridge.getStatus(),
   shouldHydrate =
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
},

 handleEnrollmentRequest = async (req: Request): Promise<Response> => {
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
    const identities = await listEnrollmentIdentities(),
     enrollment = await syncStoredEnrollmentToServe(identities);
    return json({
      enrollment,
      identities,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/enrollment") {
    const form = await req.formData(),
     name = form.get("name"),
     worksAt = optionalString(form.get("worksAt")),
     color = form.get("color"),
     linkedinId = optionalString(form.get("linkedinId")),
     githubUsername = optionalString(form.get("githubUsername")),
     email = optionalString(form.get("email")),
     phoneNumber = optionalString(form.get("phoneNumber")),
     files = form
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

    const existingIdentities = await listEnrollmentIdentities(),
     id = buildIdentityId(existingIdentities, name),
     metadata = buildOptionalMetadata({
      color,
      email,
      githubUsername,
      linkedinId,
      name,
      phoneNumber,
      worksAt,
    }),
     identities = await upsertEnrollmentIdentity(
      {
        id,
        ...metadata,
      },
      files
    ),
     reload = await bridge.sendAdminMessage({
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

    const payload = (await req.json()) as Record<string, unknown>,
     name = optionalJsonString(payload["name"]),
     color = optionalJsonString(payload["color"]);
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
    }),
     identities = await updateEnrollmentIdentityMetadata(
      identityId,
      metadata
    ),
     reload = await bridge.sendAdminMessage({
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

    const identities = await deleteEnrollmentIdentity(identityId),
     reload = await bridge.sendAdminMessage({
      id: identityId,
      type: "admin.delete-identity",
    });
    return json({ identities, reload });
  }

  return json({ error: "Not found" }, 404);
},

 server = Bun.serve({
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

    if (url.pathname === "/client.js") {
      return asset("client.js");
    }

    if (
      url.pathname === "/favicon.ico" ||
      url.pathname === "/favicon.svg" ||
      url.pathname === "/mira.svg"
    ) {
      return asset("mira.svg");
    }

    if (url.pathname === "/styles.css") {
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
