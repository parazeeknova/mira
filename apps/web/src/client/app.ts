import {
  cloneBox,
  createCameraController,
  getTrackBox,
  makeTrackKey,
  scaleBox,
  subtractBox,
} from "./camera";
import type { BBox, Track, TrackDetailRow } from "./camera";

interface ChainPayload {
  blockNumber: number;
  contentHash: string;
  explorerUrl: string;
  txHash: string;
}

interface PipelineResultPayload {
  anchorStrategy: string;
  blockchain: ChainPayload | null;
  blockchainError: string | null;
  cacheHit: boolean;
  duplicate: boolean;
  enginesUsed: string[];
  error: string | null;
  face: { bbox: Record<string, number>; confidence: number } | null;
  inputFaceHash: string | null;
  results: {
    engine: string;
    multiSourceCount: number;
    platform: string;
    similarity?: number | null;
    snippet: string | null;
    title: string | null;
    url: string;
  }[];
  verified: boolean;
}

interface Identity {
  color: string;
  email?: string;
  githubUsername?: string;
  id: string;
  linkedinId?: string;
  name: string;
  phoneNumber?: string;
  syncStatus?: string;
  worksAt?: string;
}

interface FrameResultPayload {
  faces: {
    bbox: BBox;
    confidence: number;
    identity: Identity | null;
    isUnknown: boolean;
    trackAgeFrames?: number;
    trackId: number | null;
  }[];
  frameId: number;
  indexVersion: number;
  latencyMs: number;
  sampleIntervalMs: number;
  sourceSize: { height: number; width: number };
}

const requiredNode = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new TypeError(`Missing required element: ${selector}`);
  }
  return element;
};

const cameraFeed = requiredNode<HTMLVideoElement>("#camera-feed");
const overlayCanvas = requiredNode<HTMLCanvasElement>("#overlay-canvas");
const captureCanvas = requiredNode<HTMLCanvasElement>("#capture-canvas");
const pipelineButton = requiredNode<HTMLButtonElement>("#pipeline-button");
const pipelineButtonLabel = requiredNode<HTMLElement>("#pipeline-button-label");
const pipelineHud = requiredNode<HTMLElement>("#pipeline-hud");
const hudStatus = requiredNode<HTMLElement>("#hud-status");
const hudFace = requiredNode<HTMLElement>("#hud-face");
const hudFaceConfidence = requiredNode<HTMLElement>("#hud-face-confidence");
const hudCacheBadge = requiredNode<HTMLElement>("#hud-cache-badge");
const hudAnchorBadge = requiredNode<HTMLElement>("#hud-anchor-badge");
const hudChain = requiredNode<HTMLElement>("#hud-chain");
const hudVerifiedBadge = requiredNode<HTMLElement>("#hud-verified-badge");
const hudTxPreview = requiredNode<HTMLElement>("#hud-tx-preview");
const hudProofButton = requiredNode<HTMLElement>("#hud-proof-button");
const hudResults = requiredNode<HTMLElement>("#hud-results");
const hudClose = requiredNode<HTMLElement>("#hud-close");
const proofModal = requiredNode<HTMLElement>("#proof-modal");
const proofClose = requiredNode<HTMLElement>("#proof-close");
const proofStatus = requiredNode<HTMLElement>("#proof-status");
const proofContentHash = requiredNode<HTMLElement>("#proof-content-hash");
const proofFaceHash = requiredNode<HTMLElement>("#proof-face-hash");
const proofTxLink = requiredNode<HTMLAnchorElement>("#proof-tx-link");
const proofBlock = requiredNode<HTMLElement>("#proof-block");
const proofEngines = requiredNode<HTMLElement>("#proof-engines");
const proofUrl = requiredNode<HTMLAnchorElement>("#proof-url");
const menuShell = requiredNode<HTMLDetailsElement>("#menu-shell");
const menuToggle = requiredNode<HTMLElement>("#menu-toggle");
const connectionValue = requiredNode<HTMLElement>("#connection-value");
const frameCounter = requiredNode<HTMLElement>("#frame-counter");
const latencyChip = requiredNode<HTMLElement>("#latency-chip");
const cameraFlipButton = requiredNode<HTMLElement>("#camera-flip-button");
const providersValue = requiredNode<HTMLElement>("#providers-value");
const trackingValue = requiredNode<HTMLElement>("#tracking-value");
const enrollmentValue = requiredNode<HTMLElement>("#enrollment-value");
const indexValue = requiredNode<HTMLElement>("#index-value");
const enrollmentForm = requiredNode<HTMLFormElement>("#enrollment-form");
const enrollmentStatus = requiredNode<HTMLElement>("#enrollment-status");
const enrollSubmitButton = requiredNode<HTMLElement>("#enroll-submit-button");
const enrollmentList = requiredNode<HTMLElement>("#enrollment-list");
const enrollmentDiagnostics = requiredNode<HTMLElement>(
  "#enrollment-diagnostics"
);
const identityNameInput = requiredNode<HTMLInputElement>(
  "#identity-name-input"
);
const identityWorksAtInput = requiredNode<HTMLInputElement>(
  "#identity-works-at-input"
);
const identityColorInput = requiredNode<HTMLInputElement>(
  "#identity-color-input"
);
const identityLinkedinInput = requiredNode<HTMLInputElement>(
  "#identity-linkedin-input"
);
const identityGithubInput = requiredNode<HTMLInputElement>(
  "#identity-github-input"
);
const identityEmailInput = requiredNode<HTMLInputElement>(
  "#identity-email-input"
);
const identityPhoneInput = requiredNode<HTMLInputElement>(
  "#identity-phone-input"
);
const identityFilesInput = requiredNode<HTMLInputElement>(
  "#identity-files-input"
);
const intervalInput = requiredNode<HTMLInputElement>("#interval-input");
const intervalValue = requiredNode<HTMLElement>("#interval-value");
const qualityInput = requiredNode<HTMLInputElement>("#quality-input");
const qualityValue = requiredNode<HTMLElement>("#quality-value");

const camera = createCameraController(cameraFeed, overlayCanvas, captureCanvas);

const state = {
  editingIdentityId: null as string | null,
  enrollmentDiagnostics: [] as {
    embeddingCount: number;
    fileCount: number;
    id: string;
    name: string;
    warnings: string[];
  }[],
  enrollmentIdentities: [] as {
    files: string[];
    id: string;
    metadata: Omit<Identity, "id" | "syncStatus">;
  }[],
  frameId: 0,
  framesProcessed: 0,
  identitySyncStates: new Map<string, { error?: string; status: string }>(),
  lastCompletedFrameId: 0,
  lastResultFrameId: -1,
  pipeline: {
    autoScans: 0,
    busy: false,
    result: null as PipelineResultPayload | null,
  },
  renderTracks: new Map<string, Track>(),
  sampling: {
    intervalMs: Number(intervalInput.value),
    jpegQuality: Number(qualityInput.value) / 100,
    maxWidth: 320,
  },
  sessionId: crypto.randomUUID(),
  socket: null as WebSocket | null,
  sourceSize: { height: 0, width: 0 },
};

const renderEnrollmentList = (): void => {
  enrollmentList.replaceChildren();

  for (const identity of state.enrollmentIdentities) {
    const syncState = state.identitySyncStates.get(identity.id);
    const syncSuffix =
      syncState === undefined || syncState.status === "ready"
        ? ""
        : ` · ${syncState.status}`;
    const row = document.createElement("div");
    row.className = "identity-row";
    row.innerHTML = `
      <div>
        <strong>${identity.metadata.name}</strong>
        <span>${identity.id} · ${identity.files.length} file(s)${syncSuffix}</span>
      </div>
      <div class="identity-actions">
        <button class="identity-edit" data-id="${identity.id}" type="button">Edit</button>
        <button class="identity-delete" data-id="${identity.id}" type="button">Delete</button>
      </div>
    `;
    enrollmentList.append(row);
  }

  if (state.enrollmentIdentities.length === 0) {
    const empty = document.createElement("span");
    empty.className = "option-note";
    empty.textContent = "no identities";
    enrollmentList.append(empty);
  }
};

const updateCameraFlipButton = (): void => {
  cameraFlipButton.textContent =
    camera.facingMode === "user" ? "rear" : "front";
};

const setEnrollmentFormMode = (
  identity: (typeof state.enrollmentIdentities)[number] | null
): void => {
  state.editingIdentityId = identity?.id ?? null;

  if (identity === null) {
    enrollmentForm.reset();
    identityColorInput.value = "#4ee3ff";
    identityFilesInput.value = "";
    enrollSubmitButton.textContent = "Upload";
    return;
  }

  identityNameInput.value = identity.metadata.name;
  identityWorksAtInput.value = identity.metadata.worksAt ?? "";
  identityColorInput.value = identity.metadata.color;
  identityLinkedinInput.value = identity.metadata.linkedinId ?? "";
  identityGithubInput.value = identity.metadata.githubUsername ?? "";
  identityEmailInput.value = identity.metadata.email ?? "";
  identityPhoneInput.value = identity.metadata.phoneNumber ?? "";
  identityFilesInput.value = "";
  enrollSubmitButton.textContent = "Save";
  enrollmentStatus.textContent = `editing ${identity.id}`;
};

const renderEnrollmentDiagnostics = (): void => {
  enrollmentDiagnostics.replaceChildren();

  for (const diagnostic of state.enrollmentDiagnostics) {
    const row = document.createElement("div");
    row.className = "diagnostic-row";
    row.innerHTML = `
      <strong>${diagnostic.name} (${diagnostic.id})</strong>
      <span>${diagnostic.embeddingCount} embedding(s) from ${diagnostic.fileCount} file(s)</span>
      <span>${diagnostic.warnings.length > 0 ? diagnostic.warnings.join(" | ") : "ok"}</span>
    `;
    enrollmentDiagnostics.append(row);
  }

  if (state.enrollmentDiagnostics.length === 0) {
    const empty = document.createElement("span");
    empty.className = "option-note";
    empty.textContent = "no diagnostics";
    enrollmentDiagnostics.append(empty);
  }
};

const applyEnrollmentSnapshot = (enrollment: unknown): void => {
  if (enrollment === null || typeof enrollment !== "object") {
    return;
  }

  const snapshot = enrollment as Record<string, unknown>;

  if (Array.isArray(snapshot["diagnostics"])) {
    state.enrollmentDiagnostics = snapshot[
      "diagnostics"
    ] as typeof state.enrollmentDiagnostics;
    renderEnrollmentDiagnostics();
  }

  if (typeof snapshot["identities"] === "number") {
    enrollmentValue.textContent = `${snapshot["identities"]} identities`;
  }

  if (typeof snapshot["version"] === "number") {
    indexValue.textContent = String(snapshot["version"]);
  }
};

const loadEnrollmentList = async (): Promise<void> => {
  const response = await fetch("/api/enrollment");
  const payload = (await response.json()) as {
    enrollment: unknown;
    error?: string;
    identities: typeof state.enrollmentIdentities;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? "Failed to load enrollment list.");
  }

  state.enrollmentIdentities = payload.identities;
  applyEnrollmentSnapshot(payload.enrollment);
  renderEnrollmentList();
};

const optionalInputValue = (input: HTMLInputElement): string | undefined => {
  const normalized = input.value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const collectEnrollmentSubmission = ():
  | { error: string }
  | { form: FormData }
  | null => {
  const { files } = identityFilesInput;
  if (
    state.editingIdentityId === null &&
    (files === null || files.length === 0)
  ) {
    return { error: "select at least one file" };
  }

  const form = new FormData();
  form.set("name", identityNameInput.value.trim());
  form.set("color", identityColorInput.value.trim());

  const optionalFields = [
    ["worksAt", optionalInputValue(identityWorksAtInput)],
    ["linkedinId", optionalInputValue(identityLinkedinInput)],
    ["githubUsername", optionalInputValue(identityGithubInput)],
    ["email", optionalInputValue(identityEmailInput)],
    ["phoneNumber", optionalInputValue(identityPhoneInput)],
  ] as const;

  for (const [field, value] of optionalFields) {
    if (value !== undefined) {
      form.set(field, value);
    }
  }

  if (state.editingIdentityId === null && files !== null) {
    for (const file of files) {
      form.append("files", file);
    }
  }

  return { form };
};

const applyEnrollmentReload = (payload: {
  identities: typeof state.enrollmentIdentities;
  reload?: { enrollment?: unknown; ok?: boolean };
}): void => {
  state.enrollmentIdentities = payload.identities;
  applyEnrollmentSnapshot(payload.reload?.enrollment ?? null);
  renderEnrollmentList();
};

const getIdentityDetailRows = (identity: Identity | null): TrackDetailRow[] => {
  if (identity === null) {
    return [];
  }

  return [
    identity.worksAt ? { label: "WORK", value: identity.worksAt } : null,
    identity.linkedinId ? { label: "IN", value: identity.linkedinId } : null,
    identity.githubUsername
      ? { label: "GH", value: identity.githubUsername }
      : null,
    identity.email ? { label: "MAIL", value: identity.email } : null,
    identity.phoneNumber ? { label: "TEL", value: identity.phoneNumber } : null,
  ].filter((row): row is TrackDetailRow => row !== null);
};

const withSyncDetail = (
  detailRows: TrackDetailRow[],
  syncState: { status: string } | undefined
): TrackDetailRow[] => {
  if (syncState === undefined || syncState.status === "ready") {
    return detailRows;
  }

  return [{ label: "SYNC", value: syncState.status }, ...detailRows];
};

const updateRenderTracks = (message: FrameResultPayload): void => {
  const activeKeys = new Set<string>();
  const now = performance.now();
  const fadeDuration = Math.max(220, message.sampleIntervalMs * 1.35);

  for (const [index, face] of message.faces.entries()) {
    const key = makeTrackKey(face, index);
    const existing = state.renderTracks.get(key);
    const fromBox = existing ? getTrackBox(existing, now) : cloneBox(face.bbox);
    const { identity } = face;
    const syncState =
      identity === null
        ? undefined
        : (state.identitySyncStates.get(identity.id) ??
          (identity.syncStatus === undefined
            ? undefined
            : { status: identity.syncStatus }));
    const confidenceText = `${(face.confidence * 100).toFixed(0)}%`;
    const detailRows = withSyncDetail(
      getIdentityDetailRows(identity),
      syncState
    );
    const headerLabel = identity ? identity.name : "unknown";
    const transitionDuration = Math.max(48, message.sampleIntervalMs * 0.9);
    const velocity =
      existing === undefined
        ? scaleBox(cloneBox(face.bbox), 0)
        : scaleBox(
            subtractBox(face.bbox, existing.toBox),
            1 / Math.max(now - existing.transitionStart, 16)
          );

    activeKeys.add(key);
    state.renderTracks.set(key, {
      confidenceText,
      detailRows,
      fadeDuration,
      fromBox,
      headerLabel,
      layout: camera.measureTrackLayout(
        headerLabel,
        confidenceText,
        detailRows
      ),
      maxPredictionMs: Math.max(90, message.sampleIntervalMs * 1.2),
      removeAfter: null,
      sourceSize: message.sourceSize,
      toBox: cloneBox(face.bbox),
      trackId: face.trackId,
      transitionDuration,
      transitionStart: now,
      velocity,
    });
  }

  for (const [key, track] of state.renderTracks.entries()) {
    if (activeKeys.has(key)) {
      continue;
    }

    if (track.trackId === null) {
      state.renderTracks.delete(key);
      continue;
    }

    if (track.removeAfter === null) {
      const frozenBox = getTrackBox(track, now);
      state.renderTracks.set(key, {
        ...track,
        fromBox: frozenBox,
        removeAfter: now + fadeDuration,
        toBox: frozenBox,
        transitionStart: now,
      });
    }
  }
};

const formatEngineName = (engine: string): string => {
  switch (engine) {
    case "google-vision": {
      return "vision";
    }
    case "google_lens": {
      return "lens";
    }
    case "yandex": {
      return "yandex";
    }
    case "facecheck": {
      return "facecheck";
    }
    default: {
      return engine;
    }
  }
};

const platformLabel = (platform: string): string | null =>
  platform === "none" ? null : platform.toUpperCase();

const renderResultCard = (
  result: PipelineResultPayload["results"][number]
): HTMLElement => {
  const card = document.createElement("article");
  card.className = "result-card";
  const platform = platformLabel(result.platform);
  const similarity =
    typeof result.similarity === "number"
      ? `~${result.similarity.toFixed(2)}`
      : null;
  const extraSources =
    result.multiSourceCount > 1
      ? [`+${result.multiSourceCount - 1} sources`]
      : [];
  const engineBadges = [result.engine, ...extraSources]
    .map((engine) => `<span class="badge">${formatEngineName(engine)}</span>`)
    .join("");
  const titleHtml =
    result.title === null ? "" : `<p class="result-title">${result.title}</p>`;
  const snippetHtml =
    result.snippet === null
      ? ""
      : `<p class="result-snippet">${result.snippet}</p>`;
  const similarityHtml =
    similarity === null
      ? ""
      : `<span class="badge similarity">${similarity}</span>`;

  card.innerHTML = `
      <header class="result-card-header">
        <span class="result-platform">${platform ?? "web"}</span>
        ${similarityHtml}
      </header>
      ${titleHtml}
      ${snippetHtml}
      <footer class="result-card-footer">
        ${engineBadges}
        <a href="${result.url}" target="_blank" rel="noopener">open ↗</a>
      </footer>
    `;
  return card;
};

const renderChainStatus = (payload: PipelineResultPayload): void => {
  if (payload.blockchain === null && payload.blockchainError === null) {
    hudChain.hidden = true;
    return;
  }

  hudChain.hidden = false;
  if (payload.verified) {
    hudVerifiedBadge.textContent = payload.duplicate
      ? "✅ verified (previously)"
      : "✅ verified on-chain";
    hudVerifiedBadge.dataset["kind"] = "verified";
  } else {
    hudVerifiedBadge.textContent = "⚠️ not verified";
    hudVerifiedBadge.dataset["kind"] = "unverified";
  }

  hudTxPreview.textContent =
    payload.blockchain === null || payload.blockchain.txHash === ""
      ? (payload.blockchainError ?? "—")
      : `tx ${payload.blockchain.txHash.slice(0, 10)}… block #${payload.blockchain.blockNumber || "—"}`;
};

const hudStatusTextFor = (payload: PipelineResultPayload): string => {
  if (payload.error !== null) {
    return "scan failed";
  }
  return payload.cacheHit ? "instant result" : "live search complete";
};

const setHudStatus = (text: string, kind = "idle"): void => {
  hudStatus.textContent = text;
  hudStatus.dataset["kind"] = kind;
};

const resetPipelineHud = (): void => {
  state.pipeline.result = null;
  pipelineHud.hidden = true;
  hudResults.replaceChildren();
  hudFace.hidden = true;
  hudChain.hidden = true;
};

const autoScanLabel = (): string => {
  if (state.pipeline.autoScans === 0) {
    return "scan identity";
  }
  return `rescan (${state.pipeline.autoScans})`;
};

const setPipelineBusy = (busy: boolean): void => {
  state.pipeline.busy = busy;
  pipelineButton.disabled = busy;
  pipelineButtonLabel.textContent = busy ? "scanning…" : autoScanLabel();
  pipelineButton.dataset["busy"] = String(busy);
  if (busy) {
    pipelineHud.hidden = false;
    hudFace.hidden = true;
    hudChain.hidden = true;
    hudResults.replaceChildren();
    setHudStatus("identifying…", "busy");
  }
};

const renderPipelineResult = (payload: PipelineResultPayload): void => {
  state.pipeline.result = payload;
  pipelineHud.hidden = false;
  hudFace.hidden = false;
  hudResults.replaceChildren();

  hudFaceConfidence.textContent =
    payload.face === null
      ? "—"
      : `${(payload.face.confidence * 100).toFixed(0)}%`;
  hudCacheBadge.textContent = payload.cacheHit
    ? "⚡ instant"
    : "🔍 live search";
  hudAnchorBadge.textContent =
    payload.anchorStrategy === "search" ? "post match" : "embedding";

  renderChainStatus(payload);

  for (const result of payload.results) {
    hudResults.append(renderResultCard(result));
  }

  if (payload.results.length === 0) {
    const empty = document.createElement("p");
    empty.className = "option-note";
    empty.textContent =
      payload.error ?? "no public matches found for this face";
    hudResults.append(empty);
  }

  setHudStatus(
    hudStatusTextFor(payload),
    payload.error === null ? "done" : "error"
  );
};

const AUTO_TRIGGER_MIN_HITS = 12;
const AUTO_TRIGGER_MIN_AGE_MS = 900;
const AUTO_TRIGGER_COOLDOWN_MS = 30_000;
const scanCandidates = new Map<
  string,
  {
    firstSeenMs: number;
    hits: number;
    lastSeenMs: number;
    lastTriggeredMs: number;
  }
>();

const runPipeline = async ({ manual = false } = {}): Promise<void> => {
  if (state.pipeline.busy) {
    return;
  }

  const sourceHeight = cameraFeed.videoHeight;
  const sourceWidth = cameraFeed.videoWidth;
  if (!sourceHeight || !sourceWidth) {
    return;
  }

  if (manual) {
    for (const candidate of scanCandidates.values()) {
      candidate.lastTriggeredMs = 0;
    }
  } else {
    state.pipeline.autoScans += 1;
  }

  setPipelineBusy(true);
  try {
    const scanCanvas = document.createElement("canvas");
    scanCanvas.height = sourceHeight;
    scanCanvas.width = sourceWidth;
    const ctx = scanCanvas.getContext("2d");
    if (ctx === null) {
      throw new Error("scan canvas 2d context missing");
    }
    ctx.drawImage(cameraFeed, 0, 0, sourceWidth, sourceHeight);
    const dataUrl = scanCanvas.toDataURL("image/jpeg", 0.9);
    const imageResponse = await fetch(dataUrl);
    const blob = await imageResponse.blob();
    const form = new FormData();
    form.set("image", blob, "frame.jpg");

    const response = await fetch("/api/pipeline", {
      body: form,
      method: "POST",
    });
    const payload = (await response.json()) as PipelineResultPayload;
    renderPipelineResult(
      response.ok
        ? payload
        : {
            ...payload,
            error: payload.error ?? `scan failed (${response.status})`,
          }
    );
  } catch (error) {
    renderPipelineResult({
      anchorStrategy: "none",
      blockchain: null,
      blockchainError: null,
      cacheHit: false,
      duplicate: false,
      enginesUsed: [],
      error: error instanceof Error ? error.message : "scan failed",
      face: null,
      inputFaceHash: null,
      results: [],
      verified: false,
    });
  } finally {
    setPipelineBusy(false);
  }
};

const maybeAutoTrigger = (): void => {
  if (state.pipeline.busy || document.hidden) {
    return;
  }

  const now = Date.now();
  for (const [key, track] of state.renderTracks.entries()) {
    if (track.trackId === null || track.removeAfter !== null) {
      scanCandidates.delete(key);
      continue;
    }

    const candidate = scanCandidates.get(key) ?? {
      firstSeenMs: now,
      hits: 0,
      lastSeenMs: now,
      lastTriggeredMs: 0,
    };
    candidate.hits += 1;
    candidate.lastSeenMs = now;
    scanCandidates.set(key, candidate);

    const stableFor = now - candidate.firstSeenMs;
    const neverScanned = candidate.lastTriggeredMs === 0;
    const cooledDown =
      !neverScanned &&
      now - candidate.lastTriggeredMs >= AUTO_TRIGGER_COOLDOWN_MS;

    if (
      candidate.hits >= AUTO_TRIGGER_MIN_HITS &&
      stableFor >= AUTO_TRIGGER_MIN_AGE_MS &&
      (neverScanned || cooledDown)
    ) {
      candidate.lastTriggeredMs = now;
      void runPipeline();
      return;
    }
  }

  for (const [key, candidate] of scanCandidates.entries()) {
    if (now - candidate.lastSeenMs > 4000) {
      scanCandidates.delete(key);
    }
  }
};

const handleFrameResultMessage = (message: FrameResultPayload): void => {
  if (message.frameId < state.lastResultFrameId) {
    return;
  }

  state.lastCompletedFrameId = Math.max(
    state.lastCompletedFrameId,
    message.frameId
  );
  state.framesProcessed += 1;
  state.lastResultFrameId = message.frameId;
  state.sourceSize = message.sourceSize;
  frameCounter.textContent = `${state.framesProcessed} frames`;
  indexValue.textContent = String(message.indexVersion);
  latencyChip.textContent = `${message.latencyMs.toFixed(1)} ms`;

  if (message.latencyMs > 300) {
    state.sampling.jpegQuality = 0.42;
    state.sampling.maxWidth = 224;
  } else if (message.latencyMs > 160) {
    state.sampling.jpegQuality = 0.46;
    state.sampling.maxWidth = 256;
  } else if (message.latencyMs < 80) {
    state.sampling.jpegQuality = 0.5;
    state.sampling.maxWidth = 320;
  }

  updateRenderTracks(message);
  maybeAutoTrigger();
};

let sampleTimer: number | null = null;

const sampleAndSendFrame = (): void => {
  const sourceHeight = cameraFeed.videoHeight;
  const sourceWidth = cameraFeed.videoWidth;
  if (!sourceHeight || !sourceWidth || document.hidden) {
    return;
  }
  if (
    state.frameId - state.lastCompletedFrameId > 0 ||
    !(state.socket instanceof WebSocket) ||
    state.socket.bufferedAmount > 128_000
  ) {
    return;
  }

  const frame = camera.captureFrame(state.sampling);
  if (frame === null) {
    return;
  }

  state.frameId += 1;
  state.socket.send(
    JSON.stringify({
      capturedAt: Date.now(),
      frameId: state.frameId,
      image: {
        data: frame.base64,
        height: frame.height,
        mimeType: "image/jpeg",
        width: frame.width,
      },
      sampleIntervalMs: state.sampling.intervalMs,
      sessionId: state.sessionId,
      type: "frame.submit",
    })
  );
};

const restartSampler = (): void => {
  if (sampleTimer !== null) {
    window.clearInterval(sampleTimer);
  }

  sampleTimer = window.setInterval(() => {
    if (
      !(state.socket instanceof WebSocket) ||
      state.socket.readyState !== WebSocket.OPEN ||
      cameraFeed.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }

    sampleAndSendFrame();
  }, state.sampling.intervalMs);
};

const handleEnrollmentSyncMessage = (message: {
  error?: string;
  identityId: string;
  status: string;
}): void => {
  state.identitySyncStates.set(message.identityId, {
    ...(message.error === undefined ? {} : { error: message.error }),
    status: message.status,
  });
  renderEnrollmentList();
  if (message.status === "ready") {
    void loadEnrollmentList();
  }
};

const handleSessionReadyMessage = (message: {
  sampling: { intervalMs: number; jpegQuality: number; maxWidth: number };
  sessionId: string;
}): void => {
  state.sampling = {
    ...state.sampling,
    intervalMs: message.sampling.intervalMs,
    jpegQuality: message.sampling.jpegQuality,
    maxWidth: message.sampling.maxWidth,
  };
  state.sessionId =
    message.sessionId as `${string}-${string}-${string}-${string}-${string}`;
  intervalInput.value = String(message.sampling.intervalMs);
  intervalValue.textContent = `${message.sampling.intervalMs} ms`;
  qualityInput.value = String(Math.round(message.sampling.jpegQuality * 100));
  qualityValue.textContent = message.sampling.jpegQuality.toFixed(2);
  restartSampler();
};

const setConnectionState = (mode: string): void => {
  menuToggle.dataset["state"] = mode;
  switch (mode) {
    case "connected": {
      connectionValue.textContent = "bun online";
      break;
    }
    case "error": {
      connectionValue.textContent = "error";
      break;
    }
    case "python-ready": {
      connectionValue.textContent = "python ready";
      break;
    }
    case "python-wait": {
      connectionValue.textContent = "python wait";
      break;
    }
    default: {
      connectionValue.textContent = "offline";
      menuToggle.dataset["state"] = "offline";
    }
  }
};

const handlePythonStatusMessage = (message: {
  connected: boolean;
  ready: {
    enrollment: unknown;
    providers: string[];
    trackingEnabled: boolean;
  } | null;
}): void => {
  setConnectionState(message.connected ? "python-ready" : "python-wait");
  enrollmentValue.textContent = message.ready
    ? `${(message.ready.enrollment as { identities: number }).identities} identities`
    : "pending";
  indexValue.textContent = message.ready
    ? String((message.ready.enrollment as { version: number }).version)
    : "pending";
  providersValue.textContent = message.ready
    ? message.ready.providers.join(", ")
    : "pending";
  trackingValue.textContent = message.ready?.trackingEnabled
    ? "ByteTrack"
    : "off";
  applyEnrollmentSnapshot(message.ready?.enrollment ?? null);
};

const handleServerMessage = (message: Record<string, unknown>): void => {
  const { type } = message;
  if (type === "enrollment.sync") {
    handleEnrollmentSyncMessage(
      message as unknown as Parameters<typeof handleEnrollmentSyncMessage>[0]
    );
    return;
  }

  if (type === "error") {
    connectionValue.textContent = String(message["message"] ?? "error");
    return;
  }

  if (type === "frame.result") {
    handleFrameResultMessage(message as unknown as FrameResultPayload);
    return;
  }

  if (type === "python.status") {
    handlePythonStatusMessage(
      message as unknown as Parameters<typeof handlePythonStatusMessage>[0]
    );
    return;
  }

  if (type === "session.ready") {
    handleSessionReadyMessage(
      message as unknown as Parameters<typeof handleSessionReadyMessage>[0]
    );
  }
};

const connectSocket = (): void => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(
    `${protocol}://${window.location.host}/ws/client`
  );
  state.socket = socket;

  socket.addEventListener("close", () => {
    setConnectionState("offline");
    window.setTimeout(connectSocket, 1000);
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    handleServerMessage(JSON.parse(event.data) as Record<string, unknown>);
  });

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        sessionId: state.sessionId,
        type: "client.hello",
      })
    );
    setConnectionState("connected");
  });
};

const startCamera = async (): Promise<void> => {
  await camera.start();
  updateCameraFlipButton();
  camera.syncOverlaySize();
  restartSampler();
};

const flipCamera = async (): Promise<void> => {
  const nextFacingMode = camera.facingMode === "user" ? "environment" : "user";

  try {
    await camera.start(nextFacingMode);
  } catch {
    await camera.start(camera.facingMode);
  }
  updateCameraFlipButton();
  camera.syncOverlaySize();
  restartSampler();
};

const renderProofStatus = (payload: PipelineResultPayload): void => {
  if (payload.verified) {
    proofStatus.textContent = payload.duplicate
      ? "verified (previously anchored)"
      : "verified on-chain";
    proofStatus.dataset["kind"] = "verified";
    return;
  }
  proofStatus.textContent = payload.blockchainError ?? "not verified";
  proofStatus.dataset["kind"] = "unverified";
};

const renderProofTxLink = (blockchain: ChainPayload | null): void => {
  const txHash = blockchain?.txHash;
  if (txHash !== undefined && txHash !== "") {
    proofTxLink.textContent = `${txHash.slice(0, 22)}…`;
    proofTxLink.href = blockchain?.explorerUrl || "#";
    return;
  }
  proofTxLink.textContent = "—";
  proofTxLink.removeAttribute("href");
};

const renderProofModal = (): void => {
  const payload = state.pipeline.result;
  if (payload === null) {
    return;
  }

  proofModal.hidden = false;
  renderProofStatus(payload);
  proofContentHash.textContent = payload.blockchain?.contentHash ?? "—";
  proofFaceHash.textContent = payload.inputFaceHash ?? "—";
  renderProofTxLink(payload.blockchain);
  proofBlock.textContent =
    payload.blockchain === null ||
    payload.blockchain.blockNumber === undefined ||
    payload.blockchain.blockNumber === 0
      ? "—"
      : `#${payload.blockchain.blockNumber}`;
  proofEngines.textContent = payload.enginesUsed.join(", ") || "—";
  const [top] = payload.results;
  proofUrl.textContent = top?.url ?? "—";
  proofUrl.href = top?.url ?? "#";
};

const bootstrap = async (): Promise<void> => {
  await startCamera();
  connectSocket();
  try {
    await loadEnrollmentList();
  } catch (error) {
    enrollmentStatus.textContent =
      error instanceof Error ? error.message : "enrollment unavailable";
  }
};

const renderLoop = (): void => {
  camera.drawOverlay(state.renderTracks, state.sourceSize);
  window.requestAnimationFrame(renderLoop);
};

menuToggle.addEventListener("click", () => {
  menuToggle.setAttribute("aria-expanded", String(!menuShell.open));
});

menuShell.addEventListener("toggle", () => {
  menuToggle.setAttribute("aria-expanded", String(menuShell.open));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuShell.open) {
    menuShell.open = false;
  }
});

intervalInput.addEventListener("input", () => {
  state.sampling.intervalMs = Number(intervalInput.value);
  intervalValue.textContent = `${state.sampling.intervalMs} ms`;
  restartSampler();
});

qualityInput.addEventListener("input", () => {
  state.sampling.jpegQuality = Number(qualityInput.value) / 100;
  qualityValue.textContent = state.sampling.jpegQuality.toFixed(2);
});

cameraFlipButton.addEventListener("click", () => {
  void flipCamera();
});

pipelineButton.addEventListener("click", () => {
  void runPipeline({ manual: true });
});

hudClose.addEventListener("click", resetPipelineHud);
hudProofButton.addEventListener("click", renderProofModal);
proofClose.addEventListener("click", () => {
  proofModal.hidden = true;
});
proofModal.addEventListener("click", (event) => {
  if (
    event.target instanceof HTMLElement &&
    Object.hasOwn(event.target.dataset, "close")
  ) {
    proofModal.hidden = true;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !proofModal.hidden) {
    proofModal.hidden = true;
  }
});

intervalValue.textContent = `${state.sampling.intervalMs} ms`;
qualityValue.textContent = state.sampling.jpegQuality.toFixed(2);
updateCameraFlipButton();
window.requestAnimationFrame(renderLoop);

enrollmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const submission = collectEnrollmentSubmission();
  if (submission === null) {
    return;
  }

  if ("error" in submission) {
    enrollmentStatus.textContent = submission.error;
    return;
  }

  const isEditing = state.editingIdentityId !== null;
  enrollmentStatus.textContent = isEditing ? "saving…" : "uploading…";
  const request: RequestInit = {
    body: isEditing
      ? JSON.stringify(Object.fromEntries(submission.form.entries()))
      : submission.form,
    method: isEditing ? "PATCH" : "POST",
  };
  if (isEditing) {
    request.headers = { "Content-Type": "application/json" };
  }
  const response = await fetch(
    isEditing
      ? `/api/enrollment/${state.editingIdentityId}`
      : "/api/enrollment",
    request
  );
  const payload = (await response.json()) as {
    error?: string;
    identities: typeof state.enrollmentIdentities;
    reload?: { enrollment?: unknown; ok?: boolean };
  };
  if (!response.ok) {
    enrollmentStatus.textContent = payload.error ?? "save failed";
    return;
  }

  applyEnrollmentReload(payload);
  if (isEditing) {
    enrollmentStatus.textContent = payload.reload?.ok
      ? "saved + synced"
      : "saved; sync pending";
  } else {
    const failedDiagnostics = state.enrollmentDiagnostics.filter(
      (diagnostic) => diagnostic.embeddingCount === 0
    );
    if (!payload.reload?.ok) {
      enrollmentStatus.textContent = "uploaded; sync pending";
    } else if (failedDiagnostics.length > 0) {
      enrollmentStatus.textContent = "uploaded; no embedding extracted";
    } else {
      enrollmentStatus.textContent = "uploaded + synced";
    }
  }
  setEnrollmentFormMode(null);
});

enrollmentList.addEventListener("click", async (event) => {
  if (!(event.target instanceof HTMLButtonElement)) {
    return;
  }

  if (event.target.classList.contains("identity-edit")) {
    const identityId = event.target.dataset["id"];
    if (identityId === undefined) {
      return;
    }
    const identity = state.enrollmentIdentities.find(
      (candidate) => candidate.id === identityId
    );
    if (identity !== undefined) {
      setEnrollmentFormMode(identity);
    }
    return;
  }

  const identityId = event.target.dataset["id"];
  if (identityId === undefined) {
    return;
  }

  enrollmentStatus.textContent = "deleting…";
  const response = await fetch(`/api/enrollment/${identityId}`, {
    method: "DELETE",
  });
  const payload = (await response.json()) as {
    error?: string;
    identities: typeof state.enrollmentIdentities;
    reload?: { enrollment?: unknown; ok?: boolean };
  };
  if (!response.ok) {
    enrollmentStatus.textContent = payload.error ?? "delete failed";
    return;
  }

  state.enrollmentIdentities = payload.identities;
  applyEnrollmentSnapshot(payload.reload?.enrollment ?? null);
  renderEnrollmentList();
  if (state.editingIdentityId === identityId) {
    setEnrollmentFormMode(null);
  }
  enrollmentStatus.textContent = payload.reload?.ok
    ? "deleted + synced"
    : "deleted; sync pending";
});

window.addEventListener("resize", () => camera.syncOverlaySize());

void bootstrap();
