import type {
  PipelineProgressHit,
  PythonPipelineProgressMessage,
} from "../protocol/protocol";
import {
  cloneBox,
  createCameraController,
  detailCardRect,
  getTrackBox,
  makeTrackKey,
  placeFloatCard,
  scaleBox,
  shortMiddle,
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
    base64?: string;
    engine: string;
    imageUrl?: string | null;
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
const proofCard = requiredNode<HTMLElement>("#proof-card");
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
const intervalInput = requiredNode<HTMLInputElement>("#interval-input");
const intervalValue = requiredNode<HTMLElement>("#interval-value");
const qualityInput = requiredNode<HTMLInputElement>("#quality-input");
const qualityValue = requiredNode<HTMLElement>("#quality-value");
const trackLogs = requiredNode<HTMLElement>("#track-logs");

type TrackStage =
  | "anchoring"
  | "done"
  | "error"
  | "idle"
  | "scanning"
  | "searching";

interface TrackPostHit {
  base64?: string | undefined;
  engine: string;
  imageUrl?: string | null | undefined;
  platform: string;
  similarity?: number | null | undefined;
  snippet?: string | null | undefined;
  title: string | null;
  url: string;
}

interface TrackChainState {
  block: number | null;
  contentHash: string | null;
  kind: "unverified" | "verified";
  note: string | null;
  phase: "anchoring" | "done" | "failed" | "idle" | "skipped";
  tx: string | null;
}

interface TrackScan {
  chain: TrackChainState;
  log: string[];
  posts: TrackPostHit[];
  result: PipelineResultPayload | null;
  sawProgress: boolean;
  stage: TrackStage;
  startedAt: number;
  version: number;
}

const idleChain = (): TrackChainState => ({
  block: null,
  contentHash: null,
  kind: "unverified",
  note: null,
  phase: "idle",
  tx: null,
});

const camera = createCameraController(cameraFeed, overlayCanvas, captureCanvas);

const state = {
  frameId: 0,
  framesProcessed: 0,
  lastCompletedFrameId: 0,
  lastResultFrameId: -1,
  pipeline: {
    activeScanKey: null as string | null,
    autoScans: 0,
    busy: false,
    queue: [] as string[],
    result: null as PipelineResultPayload | null,
    scanStreams: new Map<string, EventSource>(),
    scanSubs: new Map<string, string>(),
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
  trackScans: new Map<string, TrackScan>(),
};

const updateCameraFlipButton = (): void => {
  cameraFlipButton.textContent =
    camera.facingMode === "user" ? "rear" : "front";
};

const applyEnrollmentSnapshot = (enrollment: unknown): void => {
  if (enrollment === null || typeof enrollment !== "object") {
    return;
  }

  const snapshot = enrollment as Record<string, unknown>;

  if (typeof snapshot["identities"] === "number") {
    enrollmentValue.textContent = String(snapshot["identities"]);
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
  };
  if (!response.ok) {
    throw new Error(payload.error ?? "Failed to load enrollment list.");
  }
  applyEnrollmentSnapshot(payload.enrollment);
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
      identity === null || identity.syncStatus === undefined
        ? undefined
        : { status: identity.syncStatus };
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
        <a href="${result.url}" target="_blank" rel="noopener">open</a>
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
      ? "verified (prev)"
      : "verified on-chain";
    hudVerifiedBadge.dataset["kind"] = "verified";
  } else {
    hudVerifiedBadge.textContent = "not verified";
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

const autoScanLabel = (): string => {
  if (state.pipeline.autoScans === 0) {
    return "scan identity";
  }
  return `rescan (${state.pipeline.autoScans})`;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const shortHash = (value: string, head = 10): string =>
  value.length > head ? `${value.slice(0, head)}…` : value;

const trackLabelFor = (key: string): string => {
  const track = state.renderTracks.get(key);
  if (track === undefined) {
    return key;
  }
  if (track.trackId !== null) {
    return `${track.headerLabel} #${track.trackId}`;
  }
  return track.headerLabel;
};

const pushTrackLog = (key: string, stage: TrackStage, line: string): void => {
  const existing = state.trackScans.get(key);
  if (existing === undefined) {
    state.trackScans.set(key, {
      chain: idleChain(),
      log: [line],
      posts: [],
      result: null,
      sawProgress: false,
      stage,
      startedAt: Date.now(),
      version: 1,
    });
    return;
  }
  existing.log.push(line);
  existing.stage = stage;
  existing.version += 1;
};

const updateChain = (key: string, patch: Partial<TrackChainState>): void => {
  const scan = state.trackScans.get(key);
  if (scan === undefined) {
    return;
  }
  Object.assign(scan.chain, patch);
  scan.version += 1;
};

const addPostHits = (key: string, hits: PipelineProgressHit[]): void => {
  const scan = state.trackScans.get(key);
  if (scan === undefined) {
    return;
  }
  const known = new Set(scan.posts.map((post) => post.url));
  for (const hit of hits) {
    if (!known.has(hit.url)) {
      known.add(hit.url);
      scan.posts.push({
        base64: hit.base64,
        engine: hit.engine,
        imageUrl: hit.imageUrl ?? null,
        platform: hit.platform,
        similarity: null,
        snippet: null,
        title: hit.title,
        url: hit.url,
      });
    }
  }
  scan.version += 1;
};

const beginTrackScan = (key: string): void => {
  state.trackScans.set(key, {
    chain: idleChain(),
    log: ["capture face", "crop > embed"],
    posts: [],
    result: null,
    sawProgress: false,
    stage: "scanning",
    startedAt: Date.now(),
    version: (state.trackScans.get(key)?.version ?? 0) + 1,
  });
  // Synthetic fallback when the SSE progress stream never arrives
  // (old server, blocked stream): only fires if no real events landed.
  const fallback = (stage: TrackStage, line: string): void => {
    const scan = state.trackScans.get(key);
    if (
      state.pipeline.busy &&
      scan !== undefined &&
      scan.sawProgress !== true
    ) {
      pushTrackLog(key, stage, line);
    }
  };
  window.setTimeout(() => {
    fallback("searching", "search vision / lens / yandex");
  }, 900);
  window.setTimeout(() => {
    fallback("anchoring", "rank posts > anchor on-chain");
  }, 2600);
};

const matchWord = (count: number): string =>
  count === 1 ? "1 match" : `${count} matches`;

const applyEngineProgress = (
  key: string,
  event: PythonPipelineProgressMessage
): void => {
  const engine = formatEngineName(event.engine ?? "?");
  if (event.state === "start") {
    pushTrackLog(key, "searching", `searching ${engine}…`);
  } else if (event.state === "done") {
    pushTrackLog(key, "searching", `${engine}: ${matchWord(event.count ?? 0)}`);
    addPostHits(key, event.results ?? []);
  } else if (event.state === "skip") {
    pushTrackLog(key, "searching", `${engine}: skipped`);
  } else {
    pushTrackLog(key, "searching", `${engine}: failed`);
  }
};

const applyAnchorProgress = (
  key: string,
  event: PythonPipelineProgressMessage
): void => {
  if (event.state === "start") {
    pushTrackLog(key, "anchoring", "anchoring on-chain…");
    updateChain(key, { phase: "anchoring" });
  } else if (event.state === "done" && event.tx) {
    pushTrackLog(key, "anchoring", `tx ${shortHash(event.tx)}`);
    updateChain(key, {
      block: event.block ?? null,
      contentHash: event.contentHash ?? null,
      kind: "unverified",
      note: null,
      phase: "done",
      tx: event.tx,
    });
  } else if (event.state === "done") {
    const detail = event.detail ?? "anchored";
    pushTrackLog(key, "anchoring", detail);
    updateChain(key, {
      kind: detail.includes("verified") ? "verified" : "unverified",
      note: detail,
      phase: "done",
    });
  } else if (event.state === "skip") {
    const detail = event.detail ?? "skipped";
    pushTrackLog(key, "anchoring", "chain skipped");
    updateChain(key, { note: detail, phase: "skipped" });
  } else {
    const detail = event.detail ?? "failed";
    pushTrackLog(key, "error", "chain failed");
    updateChain(key, { note: detail, phase: "failed" });
  }
};

const applyStageProgress = (
  key: string,
  event: PythonPipelineProgressMessage
): void => {
  switch (event.stage) {
    case "detect": {
      if (event.state === "start") {
        pushTrackLog(key, "scanning", "detecting face…");
      } else if (event.state === "done") {
        const confidence = Math.round((event.confidence ?? 0) * 100);
        pushTrackLog(key, "scanning", `face ${confidence}%`);
      } else {
        pushTrackLog(key, "error", "no face found");
      }
      break;
    }
    case "cache": {
      if (event.state === "hit") {
        pushTrackLog(
          key,
          "done",
          `cache: instant hit (${event.results ?? 0} posts)`
        );
      } else {
        pushTrackLog(key, "scanning", "cache miss · searching");
      }
      break;
    }
    case "search": {
      if (event.state === "done") {
        pushTrackLog(
          key,
          "searching",
          `search: ${event.candidates ?? 0} candidates`
        );
      }
      break;
    }
    case "rank": {
      if (event.state === "start") {
        pushTrackLog(key, "searching", `ranking ${event.candidates ?? 0}…`);
      } else if (event.state === "done") {
        pushTrackLog(key, "searching", `rank: ${event.results ?? 0} kept`);
      }
      break;
    }
    case "done": {
      pushTrackLog(
        key,
        "done",
        `done · ${event.results ?? 0} posts · ${event.strategy ?? ""}`.trim()
      );
      break;
    }
    default: {
      break;
    }
  }
};

const applyKeyProgress = (
  key: string,
  event: PythonPipelineProgressMessage
): void => {
  const scan = state.trackScans.get(key);
  if (scan === undefined) {
    return;
  }
  scan.sawProgress = true;
  if (event.stage === "engine") {
    applyEngineProgress(key, event);
  } else if (event.stage === "anchor") {
    applyAnchorProgress(key, event);
  } else {
    applyStageProgress(key, event);
  }
};

const closeScanStream = (scanId: string): void => {
  state.pipeline.scanStreams.get(scanId)?.close();
  state.pipeline.scanStreams.delete(scanId);
  state.pipeline.scanSubs.delete(scanId);
};

const applyScanProgress = (event: PythonPipelineProgressMessage): void => {
  if (event.stage === "scan") {
    // Terminal event: the server is done pushing for this scan, so its
    // stream can close now. Delivered in order, nothing after it is lost.
    if (event.state === "done") {
      closeScanStream(event.sessionId);
    }
    return;
  }
  const key = state.pipeline.scanSubs.get(event.sessionId);
  if (key === undefined) {
    return;
  }
  if (state.renderTracks.has(key)) {
    applyKeyProgress(key, event);
  }
};

const doneLinesFor = (
  scan: TrackScan | undefined,
  payload: PipelineResultPayload
): string[] => {
  const engineLine = payload.cacheHit
    ? "cache: instant hit"
    : `engines: ${payload.enginesUsed.map(formatEngineName).join(" / ") || "—"}`;
  return [
    ...(scan?.log ?? []),
    engineLine,
    `posts: ${payload.results.length} (${payload.anchorStrategy})`,
  ];
};

const chainStateFor = (payload: PipelineResultPayload): TrackChainState => {
  const chain = idleChain();
  if (payload.blockchain !== null) {
    chain.phase = "done";
    // Empty tx hash = duplicate of an earlier anchor, verified by lookup.
    chain.tx = payload.blockchain.txHash;
    chain.block =
      payload.blockchain.blockNumber === 0
        ? null
        : payload.blockchain.blockNumber;
    chain.contentHash = payload.blockchain.contentHash;
    chain.kind = payload.verified ? "verified" : "unverified";
  } else if (payload.blockchainError !== null) {
    chain.phase = "skipped";
    chain.note = payload.blockchainError;
  }
  return chain;
};

const finishOneTrackScan = (
  key: string,
  payload: PipelineResultPayload
): void => {
  if (!state.renderTracks.has(key)) {
    state.trackScans.delete(key);
    return;
  }
  const scan = state.trackScans.get(key);
  const version = (scan?.version ?? 0) + 1;
  const startedAt = scan?.startedAt ?? Date.now();
  const sawProgress = scan?.sawProgress ?? false;
  const posts: TrackPostHit[] = payload.results.map((post) => ({
    base64: post.base64,
    engine: post.engine,
    imageUrl: post.imageUrl,
    platform: post.platform,
    similarity: post.similarity ?? null,
    snippet: post.snippet,
    title: post.title,
    url: post.url,
  }));
  const hasChain =
    payload.blockchain !== null || payload.blockchainError !== null;
  const chain = hasChain
    ? chainStateFor(payload)
    : (scan?.chain ?? idleChain());
  if (payload.error !== null) {
    state.trackScans.set(key, {
      chain,
      log: [...(scan?.log ?? []), `error: ${payload.error}`],
      posts,
      result: payload,
      sawProgress,
      stage: "error",
      startedAt,
      version,
    });
    return;
  }
  state.trackScans.set(key, {
    chain,
    // With a live feed the run was already narrated line by line; without
    // one, fall back to the end-of-run summary.
    log: sawProgress ? (scan?.log ?? []) : doneLinesFor(scan, payload),
    posts,
    result: payload,
    sawProgress,
    stage: "done",
    startedAt,
    version,
  });
};

const renderTrackStatusCard = (key: string, scan: TrackScan): string => {
  const label = escapeHtml(trackLabelFor(key));
  const lines = scan.log
    .slice(-4)
    .map(
      (line) =>
        `<div class="track-log-line"><span class="k">›</span><span class="v">${escapeHtml(line)}</span></div>`
    )
    .join("");
  return `<section class="track-log"><div class="track-log-head"><span>${label}</span><span class="track-log-stage" data-stage="${scan.stage}">${scan.stage}</span></div>
    <div class="track-log-lines">${lines}</div></section>`;
};

const postThumbSrc = (post: TrackPostHit): string | null => {
  if (post.base64 !== undefined && post.base64 !== "") {
    return post.base64.startsWith("data:")
      ? post.base64
      : `data:image/jpeg;base64,${post.base64}`;
  }
  return post.imageUrl ?? null;
};

const renderTrackPostsCard = (scan: TrackScan): string => {
  if (scan.posts.length === 0) {
    return "";
  }
  const posts = scan.posts
    .slice(0, 4)
    .map((post) => {
      const platform = escapeHtml(
        post.platform === "none" ? "web" : post.platform
      );
      const title = escapeHtml(
        post.title ?? post.url.replace(/^https?:\/\//u, "").slice(0, 28)
      );
      const sim =
        typeof post.similarity === "number"
          ? `~${post.similarity.toFixed(2)}`
          : formatEngineName(post.engine);
      const url = escapeHtml(post.url);
      const thumb = postThumbSrc(post);
      const thumbHtml =
        thumb === null
          ? ""
          : `<img class="track-post-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" onerror="this.remove()" />`;
      const snippetHtml =
        post.snippet === null || post.snippet === undefined
          ? ""
          : `<div class="track-post-snippet">${escapeHtml(post.snippet)}</div>`;
      return `<div class="track-post">${thumbHtml}<div class="track-post-body"><div class="track-post-top"><a href="${url}" target="_blank" rel="noopener">${platform} · ${title}</a><span class="sim">${escapeHtml(sim)}</span></div>${snippetHtml}</div></div>`;
    })
    .join("");
  return `<section class="track-posts-card"><div class="track-log-head"><span>posts · ${scan.posts.length}</span></div>${posts}</section>`;
};

const chainStatusWord = (chain: TrackChainState): string => {
  switch (chain.phase) {
    case "anchoring": {
      return "anchoring…";
    }
    case "done": {
      if (chain.tx === "") {
        return "prev record";
      }
      return chain.kind === "verified" ? "verified" : "unverified";
    }
    case "failed": {
      return "failed";
    }
    case "skipped": {
      return "skipped";
    }
    default: {
      return "";
    }
  }
};

const renderTrackChainCard = (scan: TrackScan): string => {
  const { chain } = scan;
  if (chain.phase === "idle") {
    return "";
  }
  const rows: [string, string][] = [];
  if (chain.tx !== null) {
    rows.push(["tx", chain.tx === "" ? "prev record" : shortMiddle(chain.tx)]);
  }
  if (chain.block !== null && chain.block !== 0) {
    rows.push(["block", `#${chain.block}`]);
  }
  if (chain.contentHash !== null && chain.contentHash !== "") {
    rows.push(["hash", shortMiddle(chain.contentHash, 8, 4)]);
  }
  if (chain.note !== null && chain.tx === null) {
    rows.push(["note", chain.note]);
  }
  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`
    )
    .join("");
  return `<section class="track-chain-card" data-kind="${chain.kind}"><div class="track-log-head"><span>chain</span><span>${chainStatusWord(chain)}</span></div><dl class="track-chain-rows">${rowsHtml}</dl></section>`;
};

const renderTrackStack = (key: string, scan: TrackScan): string =>
  renderTrackStatusCard(key, scan) +
  renderTrackPostsCard(scan) +
  renderTrackChainCard(scan);

const trackLogEls = new Map<string, HTMLElement>();

const syncTrackLogs = (now: number): void => {
  const stageWidth = trackLogs.clientWidth || window.innerWidth;
  const stageHeight = trackLogs.clientHeight || window.innerHeight;
  for (const [key, el] of trackLogEls.entries()) {
    if (!state.renderTracks.has(key)) {
      el.remove();
      trackLogEls.delete(key);
      state.trackScans.delete(key);
    }
  }
  for (const [key, track] of state.renderTracks.entries()) {
    const scan = state.trackScans.get(key);
    if (scan === undefined) {
      continue;
    }
    if (
      track.sourceSize.width === 0 ||
      track.sourceSize.height === 0 ||
      overlayCanvas.width === 0 ||
      overlayCanvas.height === 0
    ) {
      continue;
    }
    let el = trackLogEls.get(key);
    if (el === undefined) {
      el = document.createElement("div");
      el.className = "track-stack";
      trackLogs.append(el);
      trackLogEls.set(key, el);
    }
    if (el.dataset["version"] !== String(scan.version)) {
      el.innerHTML = renderTrackStack(key, scan);
      el.dataset["version"] = String(scan.version);
    }
    const box = getTrackBox(track, now);
    const scaleX = overlayCanvas.width / track.sourceSize.width;
    const scaleY = overlayCanvas.height / track.sourceSize.height;
    const face = {
      height: box.height * scaleY,
      width: box.width * scaleX,
      x: box.x * scaleX,
      y: box.y * scaleY,
    };
    const detail = detailCardRect(face, track.layout, stageWidth);
    const placed = placeFloatCard(
      face,
      {
        height: el.offsetHeight || 120,
        width: el.offsetWidth || 228,
      },
      { height: stageHeight, width: stageWidth },
      detail
    );
    el.style.transform = `translate(${Math.round(placed.x)}px, ${Math.round(placed.y)}px)`;
  }
};

const setPipelineBusy = (busy: boolean): void => {
  state.pipeline.busy = busy;
  pipelineButton.disabled = busy;
  pipelineButtonLabel.textContent = busy ? "scanning…" : autoScanLabel();
  pipelineButton.dataset["busy"] = String(busy);
  if (busy) {
    hudFace.hidden = true;
    hudChain.hidden = true;
    hudResults.replaceChildren();
    setHudStatus("identifying…", "busy");
  }
};

const renderPipelineResult = (
  payload: PipelineResultPayload,
  key: string
): void => {
  state.pipeline.result = payload;
  finishOneTrackScan(key, payload);
  hudFace.hidden = false;
  hudResults.replaceChildren();

  hudFaceConfidence.textContent =
    payload.face === null
      ? "—"
      : `${(payload.face.confidence * 100).toFixed(0)}%`;
  hudCacheBadge.textContent = payload.cacheHit ? "instant" : "live search";
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

/**
 * Crop one tracked face out of the live video frame. Each face gets its own
 * pipeline run so multi-face scenes attribute the right posts to the right
 * face instead of broadcasting the first face's matches everywhere.
 */
const cropTrackFace = async (key: string): Promise<Blob | null> => {
  const track = state.renderTracks.get(key);
  const sourceWidth = cameraFeed.videoWidth;
  const sourceHeight = cameraFeed.videoHeight;
  if (
    track === undefined ||
    !sourceWidth ||
    !sourceHeight ||
    !track.sourceSize.width ||
    !track.sourceSize.height
  ) {
    return null;
  }
  const scaleX = sourceWidth / track.sourceSize.width;
  const scaleY = sourceHeight / track.sourceSize.height;
  const box = getTrackBox(track, performance.now());
  // Modest client-side padding; the Python stage pads again before search.
  const pad = 0.35;
  const sx = Math.max(0, (box.x - box.width * pad) * scaleX);
  const sy = Math.max(0, (box.y - box.height * pad) * scaleY);
  const sw = Math.min(box.width * (1 + pad * 2) * scaleX, sourceWidth - sx);
  const sh = Math.min(box.height * (1 + pad * 2) * scaleY, sourceHeight - sy);
  if (sw < 24 || sh < 24) {
    return null;
  }
  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = Math.round(sw);
  faceCanvas.height = Math.round(sh);
  const ctx = faceCanvas.getContext("2d");
  if (ctx === null) {
    return null;
  }
  ctx.drawImage(
    cameraFeed,
    sx,
    sy,
    sw,
    sh,
    0,
    0,
    faceCanvas.width,
    faceCanvas.height
  );
  const dataUrl = faceCanvas.toDataURL("image/jpeg", 0.9);
  const imageResponse = await fetch(dataUrl);
  return imageResponse.blob();
};

const openProgressStream = (scanId: string): void => {
  // Live progress stream: subscribe before POST so early stage events
  // (detect/cache) are replayed from the server buffer, not missed.
  try {
    const source = new EventSource(`/api/pipeline/progress?scanId=${scanId}`);
    state.pipeline.scanStreams.set(scanId, source);
    source.addEventListener("message", (event: MessageEvent<string>): void => {
      try {
        applyScanProgress(
          JSON.parse(event.data) as PythonPipelineProgressMessage
        );
      } catch {
        console.debug("[pipeline] ignoring malformed progress event");
      }
    });
    source.addEventListener("error", (): void => {
      // POST response stays the source of truth; the server also ends the
      // stream with scan/done. Nothing to do here.
    });
  } catch {
    console.debug("[pipeline] progress stream unavailable; using fallback");
  }
};

const runSingleScan = async (key: string): Promise<void> => {
  const blob = await cropTrackFace(key);
  if (blob === null) {
    return;
  }
  beginTrackScan(key);
  const scanId = crypto.randomUUID();
  state.pipeline.scanSubs.set(scanId, key);
  openProgressStream(scanId);
  try {
    const form = new FormData();
    form.set("image", blob, "face.jpg");
    form.set("scanId", scanId);

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
          },
      key
    );
  } catch (error) {
    renderPipelineResult(
      {
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
      },
      key
    );
  } finally {
    // Backstop: if scan/done never arrives (dropped stream), close after a
    // grace period so trailing anchor events still land first.
    window.setTimeout(() => {
      closeScanStream(scanId);
    }, 3000);
  }
};

const pumpScanQueue = async (): Promise<void> => {
  if (state.pipeline.activeScanKey !== null) {
    return;
  }
  const key = state.pipeline.queue.shift();
  if (key === undefined) {
    setPipelineBusy(false);
    return;
  }
  if (!state.renderTracks.has(key)) {
    await pumpScanQueue();
    return;
  }
  state.pipeline.activeScanKey = key;
  setPipelineBusy(true);
  try {
    await runSingleScan(key);
  } finally {
    if (state.pipeline.activeScanKey === key) {
      state.pipeline.activeScanKey = null;
    }
    if (state.pipeline.queue.length > 0) {
      await pumpScanQueue();
    } else {
      setPipelineBusy(false);
    }
  }
};

const enqueueScan = (key: string): void => {
  const track = state.renderTracks.get(key);
  if (
    track === undefined ||
    track.removeAfter !== null ||
    state.pipeline.activeScanKey === key ||
    state.pipeline.queue.includes(key)
  ) {
    return;
  }
  state.pipeline.queue.push(key);
  void pumpScanQueue();
};

const runPipeline = ({ manual = false } = {}): void => {
  if (manual) {
    for (const candidate of scanCandidates.values()) {
      candidate.lastTriggeredMs = 0;
    }
    let enqueued = 0;
    for (const [key, track] of state.renderTracks.entries()) {
      if (track.removeAfter === null) {
        enqueueScan(key);
        enqueued += 1;
      }
    }
    if (enqueued === 0 && !state.pipeline.busy) {
      setHudStatus("no faces to scan", "idle");
    }
  }
};

const maybeAutoTrigger = (): void => {
  if (document.hidden) {
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
      state.pipeline.autoScans += 1;
      // Each stable face scans on its own crop; the queue runs them one at
      // a time so every face gets its own posts instead of sharing the
      // first face's result.
      enqueueScan(key);
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
      ? "verified (prev)"
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

  proofCard.hidden = false;
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
  } catch {
    // enrollment stats unavailable — non-fatal
  }
};

const renderLoop = (): void => {
  const now = performance.now();
  camera.drawOverlay(state.renderTracks, state.sourceSize);
  syncTrackLogs(now);
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

hudProofButton.addEventListener("click", renderProofModal);
proofClose.addEventListener("click", () => {
  proofCard.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !proofCard.hidden) {
    proofCard.hidden = true;
  }
});

intervalValue.textContent = `${state.sampling.intervalMs} ms`;
qualityValue.textContent = state.sampling.jpegQuality.toFixed(2);
updateCameraFlipButton();
window.requestAnimationFrame(renderLoop);

window.addEventListener("resize", () => camera.syncOverlaySize());

void bootstrap();
