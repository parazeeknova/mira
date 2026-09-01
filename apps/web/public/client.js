const requiredNode = (selector) => {
    const element = document.querySelector(selector);
    if (element === null) {
      throw new TypeError(`Missing required element: ${selector}`);
    }
    return element;
  },
  /** @type {HTMLVideoElement} */
  cameraFeed = requiredNode("#camera-feed"),
  /** @type {HTMLCanvasElement} */
  overlayCanvas = requiredNode("#overlay-canvas"),
  /** @type {HTMLCanvasElement} */
  captureCanvas = requiredNode("#capture-canvas"),
  pipelineButton = requiredNode("#pipeline-button"),
  pipelineButtonLabel = requiredNode("#pipeline-button-label"),
  pipelineHud = requiredNode("#pipeline-hud"),
  hudStatus = requiredNode("#hud-status"),
  hudFace = requiredNode("#hud-face"),
  hudFaceConfidence = requiredNode("#hud-face-confidence"),
  hudCacheBadge = requiredNode("#hud-cache-badge"),
  hudAnchorBadge = requiredNode("#hud-anchor-badge"),
  hudChain = requiredNode("#hud-chain"),
  hudVerifiedBadge = requiredNode("#hud-verified-badge"),
  hudTxPreview = requiredNode("#hud-tx-preview"),
  hudProofButton = requiredNode("#hud-proof-button"),
  hudResults = requiredNode("#hud-results"),
  hudClose = requiredNode("#hud-close"),
  proofModal = requiredNode("#proof-modal"),
  proofClose = requiredNode("#proof-close"),
  proofStatus = requiredNode("#proof-status"),
  proofContentHash = requiredNode("#proof-content-hash"),
  proofFaceHash = requiredNode("#proof-face-hash"),
  proofTxLink = requiredNode("#proof-tx-link"),
  proofBlock = requiredNode("#proof-block"),
  proofEngines = requiredNode("#proof-engines"),
  proofUrl = requiredNode("#proof-url"),
  /** @type {HTMLDetailsElement} */
  menuShell = requiredNode("#menu-shell"),
  /** @type {HTMLElement} */
  menuToggle = requiredNode("#menu-toggle"),
  connectionValue = requiredNode("#connection-value"),
  frameCounter = requiredNode("#frame-counter"),
  latencyChip = requiredNode("#latency-chip"),
  cameraFlipButton = requiredNode("#camera-flip-button"),
  providersValue = requiredNode("#providers-value"),
  trackingValue = requiredNode("#tracking-value"),
  enrollmentValue = requiredNode("#enrollment-value"),
  indexValue = requiredNode("#index-value"),
  enrollmentForm = requiredNode("#enrollment-form"),
  enrollmentStatus = requiredNode("#enrollment-status"),
  enrollSubmitButton = requiredNode("#enroll-submit-button"),
  enrollmentList = requiredNode("#enrollment-list"),
  enrollmentDiagnostics = requiredNode("#enrollment-diagnostics"),
  identityNameInput = requiredNode("#identity-name-input"),
  identityWorksAtInput = requiredNode("#identity-works-at-input"),
  identityColorInput = requiredNode("#identity-color-input"),
  identityLinkedinInput = requiredNode("#identity-linkedin-input"),
  identityGithubInput = requiredNode("#identity-github-input"),
  identityEmailInput = requiredNode("#identity-email-input"),
  identityPhoneInput = requiredNode("#identity-phone-input"),
  identityFilesInput = requiredNode("#identity-files-input"),
  /** @type {HTMLInputElement} */
  intervalInput = requiredNode("#interval-input"),
  intervalValue = requiredNode("#interval-value"),
  /** @type {HTMLInputElement} */
  qualityInput = requiredNode("#quality-input"),
  qualityValue = requiredNode("#quality-value"),
  overlayContext = overlayCanvas.getContext("2d"),
  captureContext = captureCanvas.getContext("2d");
if (overlayContext === null || captureContext === null) {
  throw new TypeError("Canvas 2D contexts are required.");
}

const state = {
    activeStream: null,
    cameraFacingMode: "user",
    editingIdentityId: null,
    enrollmentDiagnostics: [],
    enrollmentIdentities: [],
    frameId: 0,
    framesProcessed: 0,
    identitySyncStates: new Map(),
    lastCompletedFrameId: 0,
    lastResultFrameId: -1,
    renderTracks: new Map(),
    sampleTimer: null,
    sampling: {
      intervalMs: Number(intervalInput.value),
      jpegQuality: Number(qualityInput.value) / 100,
      maxWidth: 320,
    },
    sessionId: crypto.randomUUID(),
    socket: null,
    sourceSize: {
      height: 0,
      width: 0,
    },
    pipeline: {
      autoScans: 0,
      busy: false,
      manual: false,
      result: null,
    },
  },
  renderEnrollmentList = () => {
    enrollmentList.replaceChildren();

    for (const identity of state.enrollmentIdentities) {
      const syncState = state.identitySyncStates.get(identity.id),
        syncSuffix =
          syncState === undefined || syncState.status === "ready"
            ? ""
            : ` · ${syncState.status}`,
        row = document.createElement("div");
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
  },
  updateCameraFlipButton = () => {
    cameraFlipButton.textContent =
      state.cameraFacingMode === "user" ? "rear" : "front";
  },
  setEnrollmentFormMode = (identity) => {
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
  },
  renderEnrollmentDiagnostics = () => {
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
  },
  applyEnrollmentSnapshot = (enrollment) => {
    if (enrollment === null || typeof enrollment !== "object") {
      return;
    }

    if (Array.isArray(enrollment.diagnostics)) {
      state.enrollmentDiagnostics = enrollment.diagnostics;
      renderEnrollmentDiagnostics();
    }

    if (typeof enrollment.identities === "number") {
      enrollmentValue.textContent = `${enrollment.identities} identities`;
    }

    if (typeof enrollment.version === "number") {
      indexValue.textContent = String(enrollment.version);
    }
  },
  loadEnrollmentList = async () => {
    const response = await fetch("/api/enrollment"),
      payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "Failed to load enrollment list.");
    }

    state.enrollmentIdentities = payload.identities;
    applyEnrollmentSnapshot(payload.enrollment);
    renderEnrollmentList();
  },
  collectEnrollmentSubmission = () => {
    if (
      !(identityNameInput instanceof HTMLInputElement) ||
      !(identityWorksAtInput instanceof HTMLInputElement) ||
      !(identityColorInput instanceof HTMLInputElement) ||
      !(identityLinkedinInput instanceof HTMLInputElement) ||
      !(identityGithubInput instanceof HTMLInputElement) ||
      !(identityEmailInput instanceof HTMLInputElement) ||
      !(identityPhoneInput instanceof HTMLInputElement) ||
      !(identityFilesInput instanceof HTMLInputElement)
    ) {
      return null;
    }

    const { files } = identityFilesInput;
    if (
      state.editingIdentityId === null &&
      (files === null || files.length === 0)
    ) {
      return {
        error: "select at least one file",
      };
    }

    const form = new FormData();
    form.set("name", identityNameInput.value.trim());
    form.set("color", identityColorInput.value.trim());

    for (const [field, value] of [
      ["worksAt", optionalInputValue(identityWorksAtInput)],
      ["linkedinId", optionalInputValue(identityLinkedinInput)],
      ["githubUsername", optionalInputValue(identityGithubInput)],
      ["email", optionalInputValue(identityEmailInput)],
      ["phoneNumber", optionalInputValue(identityPhoneInput)],
    ]) {
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
  },
  applyEnrollmentReload = (payload) => {
    state.enrollmentIdentities = payload.identities;
    applyEnrollmentSnapshot(payload.reload?.enrollment ?? null);
    renderEnrollmentList();
  },
  optionalInputValue = (input) => {
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    const normalized = input.value.trim();
    return normalized.length > 0 ? normalized : undefined;
  },
  getIdentityDetailRows = (identity) => {
    if (identity === null) {
      return [];
    }

    return [
      identity.worksAt
        ? {
            label: "WORK",
            value: identity.worksAt,
          }
        : null,
      identity.linkedinId
        ? {
            label: "IN",
            value: identity.linkedinId,
          }
        : null,
      identity.githubUsername
        ? {
            label: "GH",
            value: identity.githubUsername,
          }
        : null,
      identity.email
        ? {
            label: "MAIL",
            value: identity.email,
          }
        : null,
      identity.phoneNumber
        ? {
            label: "TEL",
            value: identity.phoneNumber,
          }
        : null,
    ].filter((row) => row !== null);
  },
  withSyncDetail = (detailRows, syncState) => {
    if (syncState === undefined || syncState.status === "ready") {
      return detailRows;
    }

    return [
      {
        label: "SYNC",
        value: syncState.status,
      },
      ...detailRows,
    ];
  },
  measureTrackLayout = (headerLabel, confidenceText, detailRows) => {
    overlayContext.font = '14px "Cascadia Mono", monospace';
    const chipLabel = `${headerLabel} · ${confidenceText}`,
      chipWidth = overlayContext.measureText(chipLabel).width + 20;

    if (detailRows.length === 0) {
      return {
        cardHeight: 0,
        cardWidth: 0,
        chipLabel,
        chipWidth,
        labelWidth: 0,
        rowHeight: 20,
        valueOffset: 0,
      };
    }

    overlayContext.font = '12px "Cascadia Mono", monospace';
    const labelWidth = Math.max(
        ...detailRows.map((row) => overlayContext.measureText(row.label).width)
      ),
      valueWidth = Math.max(
        ...detailRows.map((row) => overlayContext.measureText(row.value).width)
      ),
      cardWidth = Math.max(176, labelWidth + valueWidth + 44),
      rowHeight = 20;

    return {
      cardHeight: 18 + detailRows.length * rowHeight,
      cardWidth,
      chipLabel,
      chipWidth,
      labelWidth,
      rowHeight,
      valueOffset: 20 + labelWidth,
    };
  },
  cloneBox = (bbox) => ({
    height: bbox.height,
    width: bbox.width,
    x: bbox.x,
    y: bbox.y,
  }),
  makeTrackKey = (face, index) =>
    face.trackId === null ? `ephemeral-${index}` : `track-${face.trackId}`,
  mixBox = (fromBox, toBox, progress) => ({
    height: fromBox.height + (toBox.height - fromBox.height) * progress,
    width: fromBox.width + (toBox.width - fromBox.width) * progress,
    x: fromBox.x + (toBox.x - fromBox.x) * progress,
    y: fromBox.y + (toBox.y - fromBox.y) * progress,
  }),
  scaleBox = (box, factor) => ({
    height: box.height * factor,
    width: box.width * factor,
    x: box.x * factor,
    y: box.y * factor,
  }),
  subtractBox = (nextBox, previousBox) => ({
    height: nextBox.height - previousBox.height,
    width: nextBox.width - previousBox.width,
    x: nextBox.x - previousBox.x,
    y: nextBox.y - previousBox.y,
  }),
  setConnectionState = (mode) => {
    menuToggle.dataset.state = mode;
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
        menuToggle.dataset.state = "offline";
      }
    }
  },
  getTrackBox = (track, now) => {
    const duration = Math.max(track.transitionDuration, 1),
      progress = Math.min(1, (now - track.transitionStart) / duration),
      interpolated = mixBox(track.fromBox, track.toBox, progress);

    if (progress < 1) {
      return interpolated;
    }

    const predictiveElapsed = Math.min(
      now - (track.transitionStart + duration),
      track.maxPredictionMs
    );
    if (predictiveElapsed <= 0) {
      return interpolated;
    }

    return mixBox(
      interpolated,
      {
        height: interpolated.height + track.velocity.height,
        width: interpolated.width + track.velocity.width,
        x: interpolated.x + track.velocity.x,
        y: interpolated.y + track.velocity.y,
      },
      predictiveElapsed / track.maxPredictionMs
    );
  },
  updateRenderTracks = (message) => {
    const activeKeys = new Set(),
      now = performance.now(),
      fadeDuration = Math.max(220, message.sampleIntervalMs * 1.35);

    for (const [index, face] of message.faces.entries()) {
      const key = makeTrackKey(face, index),
        existing = state.renderTracks.get(key),
        fromBox = existing ? getTrackBox(existing, now) : cloneBox(face.bbox),
        { identity } = face,
        syncState =
          identity === null
            ? undefined
            : (state.identitySyncStates.get(identity.id) ??
              (identity.syncStatus === undefined
                ? undefined
                : {
                    status: identity.syncStatus,
                  })),
        confidenceText = `${(face.confidence * 100).toFixed(0)}%`,
        detailRows = withSyncDetail(getIdentityDetailRows(identity), syncState),
        headerLabel = identity ? identity.name : "unknown",
        transitionDuration = Math.max(48, message.sampleIntervalMs * 0.9),
        velocity =
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
        layout: measureTrackLayout(headerLabel, confidenceText, detailRows),
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
  },
  drawOverlay = () => {
    overlayContext.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!state.sourceSize.height || !state.sourceSize.width) {
      return;
    }

    const now = performance.now();

    overlayContext.font = '14px "Cascadia Mono", monospace';
    overlayContext.lineWidth = 2;
    overlayContext.textBaseline = "top";

    for (const [key, track] of state.renderTracks.entries()) {
      const scaleX = overlayCanvas.width / track.sourceSize.width,
        scaleY = overlayCanvas.height / track.sourceSize.height,
        box = getTrackBox(track, now),
        width = box.width * scaleX,
        height = box.height * scaleY,
        x = box.x * scaleX,
        y = box.y * scaleY;
      let alpha = 1;

      if (track.removeAfter !== null) {
        alpha = Math.max(
          0,
          (track.removeAfter - now) / Math.max(track.fadeDuration, 1)
        );
        if (alpha <= 0) {
          state.renderTracks.delete(key);
          continue;
        }
      }

      overlayContext.shadowBlur = 0;
      overlayContext.strokeStyle = "rgba(255, 255, 255, 0.92)";
      overlayContext.globalAlpha = alpha;
      overlayContext.strokeRect(x, y, width, height);

      const chipHeight = 28,
        { layout } = track,
        chipY = Math.max(8, y - chipHeight - 8);

      overlayContext.fillStyle = "rgba(8, 10, 14, 0.66)";
      overlayContext.fillRect(x, chipY, layout.chipWidth, chipHeight);
      overlayContext.fillStyle = "#fff";
      overlayContext.fillText(layout.chipLabel, x + 10, chipY + 6);

      if (track.detailRows.length > 0) {
        overlayContext.font = '12px "Cascadia Mono", monospace';
        const preferredX = x + width + 12,
          cardX =
            preferredX + layout.cardWidth <= overlayCanvas.width - 8
              ? preferredX
              : Math.max(8, x - layout.cardWidth - 12),
          cardY = Math.max(8, y);

        overlayContext.fillStyle = "rgba(8, 10, 14, 0.62)";
        overlayContext.fillRect(
          cardX,
          cardY,
          layout.cardWidth,
          layout.cardHeight
        );

        for (const [detailIndex, row] of track.detailRows.entries()) {
          const rowY = cardY + 10 + detailIndex * layout.rowHeight;
          overlayContext.fillStyle = "rgba(255, 255, 255, 0.48)";
          overlayContext.fillText(row.label, cardX + 12, rowY);
          overlayContext.fillStyle = "#fff";
          overlayContext.fillText(row.value, cardX + layout.valueOffset, rowY);
        }

        overlayContext.font = '14px "Cascadia Mono", monospace';
        overlayContext.lineWidth = 2;
      }
    }

    overlayContext.globalAlpha = 1;
    overlayContext.shadowBlur = 0;
  },
  renderLoop = () => {
    drawOverlay();
    window.requestAnimationFrame(renderLoop);
  },
  syncOverlaySize = () => {
    const rect = cameraFeed.getBoundingClientRect();
    overlayCanvas.height = rect.height;
    overlayCanvas.width = rect.width;
    drawOverlay();
  },
  handleEnrollmentSyncMessage = (message) => {
    state.identitySyncStates.set(message.identityId, {
      ...(message.error === undefined ? {} : { error: message.error }),
      status: message.status,
    });
    renderEnrollmentList();
    if (message.status === "ready") {
      void loadEnrollmentList();
    }
  },
  handleFrameResultMessage = (message) => {
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
  },
  // ── Zero-click auto-trigger ──────────────────────────────────────
  // A face track becomes a scan candidate once it has been observed
  // steadily (min hits / ~1s). Each track scans at most once per
  // cooldown window so a person standing in frame is not re-scanned.
  AUTO_TRIGGER_MIN_HITS = 12,
  AUTO_TRIGGER_MIN_AGE_MS = 900,
  AUTO_TRIGGER_COOLDOWN_MS = 30_000,
  scanCandidates = new Map(),
  maybeAutoTrigger = () => {
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
        lastTriggeredMs: 0,
      };
      candidate.hits += 1;
      candidate.lastSeenMs = now;
      scanCandidates.set(key, candidate);

      const stableFor = now - candidate.firstSeenMs,
        neverScanned = candidate.lastTriggeredMs === 0,
        cooledDown =
          !neverScanned &&
          now - candidate.lastTriggeredMs >= AUTO_TRIGGER_COOLDOWN_MS;

      if (
        candidate.hits >= AUTO_TRIGGER_MIN_HITS &&
        stableFor >= AUTO_TRIGGER_MIN_AGE_MS &&
        (neverScanned || cooledDown)
      ) {
        candidate.lastTriggeredMs = now;
        void runPipeline();
        return; // one scan at a time
      }
    }

    // Prune stale candidates (tracks that left the frame).
    for (const [key, candidate] of scanCandidates.entries()) {
      if (now - candidate.lastSeenMs > 4000) {
        scanCandidates.delete(key);
      }
    }
  },
  setHudStatus = (text, stateKind = "idle") => {
    hudStatus.textContent = text;
    hudStatus.dataset.kind = stateKind;
  },
  resetPipelineHud = () => {
    state.pipeline.result = null;
    pipelineHud.hidden = true;
    hudResults.replaceChildren();
    hudFace.hidden = true;
    hudChain.hidden = true;
  },
  setPipelineBusy = (busy) => {
    state.pipeline.busy = busy;
    pipelineButton.disabled = busy;
    pipelineButtonLabel.textContent = busy
      ? "scanning…"
      : state.pipeline.autoScans > 0
        ? `rescan (${state.pipeline.autoScans})`
        : "scan identity";
    pipelineButton.dataset.busy = String(busy);
    pipelineButton.dataset.busy = String(busy);
    if (busy) {
      pipelineHud.hidden = false;
      hudFace.hidden = true;
      hudChain.hidden = true;
      hudResults.replaceChildren();
      setHudStatus("identifying…", "busy");
    }
  },
  formatEngineName = (engine) => {
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
  },
  platformLabel = (platform) =>
    platform === "none" ? null : platform.toUpperCase(),
  renderResultCard = (result) => {
    const card = document.createElement("article");
    card.className = "result-card";
    const platform = platformLabel(result.platform),
      similarity =
        typeof result.similarity === "number"
          ? `~${result.similarity.toFixed(2)}`
          : null,
      engineBadges = [
        result.engine,
        ...(result.multiSourceCount > 1
          ? [`+${result.multiSourceCount - 1} sources`]
          : []),
      ]
        .map(
          (engine) => `<span class="badge">${formatEngineName(engine)}</span>`
        )
        .join("");
    card.innerHTML = `
      <header class="result-card-header">
        <span class="result-platform">${platform ?? "web"}</span>
        ${similarity === null ? "" : `<span class="badge similarity">${similarity}</span>`}
      </header>
      ${result.title === null ? "" : `<p class="result-title">${result.title}</p>`}
      ${result.snippet === null ? "" : `<p class="result-snippet">${result.snippet}</p>`}
      <footer class="result-card-footer">
        ${engineBadges}
        <a href="${result.url}" target="_blank" rel="noopener">open ↗</a>
      </footer>
    `;
    return card;
  },
  renderPipelineResult = (payload) => {
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

    if (payload.blockchain === null && payload.blockchainError === null) {
      hudChain.hidden = true;
    } else {
      hudChain.hidden = false;
      if (payload.verified) {
        hudVerifiedBadge.textContent = payload.duplicate
          ? "✅ verified (previously)"
          : "✅ verified on-chain";
        hudVerifiedBadge.dataset.kind = "verified";
      } else {
        hudVerifiedBadge.textContent = "⚠️ not verified";
        hudVerifiedBadge.dataset.kind = "unverified";
      }
      hudTxPreview.textContent =
        payload.blockchain === null || payload.blockchain.txHash === ""
          ? (payload.blockchainError ?? "—")
          : `tx ${payload.blockchain.txHash.slice(0, 10)}… block #${payload.blockchain.blockNumber || "—"}`;
    }

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
      payload.error === null
        ? payload.cacheHit
          ? "instant result"
          : "live search complete"
        : "scan failed",
      payload.error === null ? "done" : "error"
    );
  },
  runPipeline = async ({ manual = false } = {}) => {
    if (state.pipeline.busy) {
      return;
    }

    const sourceHeight = cameraFeed.videoHeight,
      sourceWidth = cameraFeed.videoWidth;
    if (!sourceHeight || !sourceWidth) {
      return;
    }

    if (manual) {
      // Manual override: bypass per-track cooldown by resetting candidates.
      for (const candidate of scanCandidates.values()) {
        candidate.lastTriggeredMs = 0;
      }
    } else {
      state.pipeline.autoScans += 1;
    }

    setPipelineBusy(true);
    try {
      // Dedicated canvas: the tracking sampler reuses #capture-canvas at
      // 320px on its 80ms timer and would corrupt a mid-flight capture.
      const scanCanvas = document.createElement("canvas");
      scanCanvas.height = sourceHeight;
      scanCanvas.width = sourceWidth;
      scanCanvas
        .getContext("2d")
        .drawImage(cameraFeed, 0, 0, sourceWidth, sourceHeight);
      const dataUrl = scanCanvas.toDataURL("image/jpeg", 0.9);
      const blob = await (await fetch(dataUrl)).blob();
      const form = new FormData();
      form.set("image", blob, "frame.jpg");

      const response = await fetch("/api/pipeline", {
        body: form,
        method: "POST",
      });
      const payload = await response.json();
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
  },
  renderProofModal = () => {
    const payload = state.pipeline.result;
    if (payload === null) {
      return;
    }

    proofModal.hidden = false;
    if (payload.verified) {
      proofStatus.textContent = payload.duplicate
        ? "verified (previously anchored)"
        : "verified on-chain";
      proofStatus.dataset.kind = "verified";
    } else {
      proofStatus.textContent = payload.blockchainError ?? "not verified";
      proofStatus.dataset.kind = "unverified";
    }
    proofContentHash.textContent = payload.blockchain?.contentHash ?? "—";
    proofFaceHash.textContent = payload.inputFaceHash ?? "—";
    const txHash = payload.blockchain?.txHash;
    if (txHash !== undefined && txHash !== "") {
      proofTxLink.textContent = `${txHash.slice(0, 22)}…`;
      proofTxLink.href = payload.blockchain?.explorerUrl || "#";
    } else {
      proofTxLink.textContent = "—";
      proofTxLink.removeAttribute("href");
    }
    proofBlock.textContent =
      payload.blockchain?.blockNumber === undefined ||
      payload.blockchain === null ||
      payload.blockchain.blockNumber === 0
        ? "—"
        : `#${payload.blockchain.blockNumber}`;
    proofEngines.textContent = payload.enginesUsed.join(", ") || "—";
    const top = payload.results[0];
    proofUrl.textContent = top?.url ?? "—";
    proofUrl.href = top?.url ?? "#";
  },
  handlePythonStatusMessage = (message) => {
    setConnectionState(message.connected ? "python-ready" : "python-wait");
    enrollmentValue.textContent = message.ready
      ? `${message.ready.enrollment.identities} identities`
      : "pending";
    indexValue.textContent = message.ready
      ? String(message.ready.enrollment.version)
      : "pending";
    providersValue.textContent = message.ready
      ? message.ready.providers.join(", ")
      : "pending";
    trackingValue.textContent = message.ready?.trackingEnabled
      ? "ByteTrack"
      : "off";
    applyEnrollmentSnapshot(message.ready?.enrollment ?? null);
  },
  handleSessionReadyMessage = (message) => {
    state.sampling = {
      ...state.sampling,
      intervalMs: message.sampling.intervalMs,
      jpegQuality: message.sampling.jpegQuality,
      maxWidth: message.sampling.maxWidth,
    };
    state.sessionId = message.sessionId;
    intervalInput.value = String(message.sampling.intervalMs);
    intervalValue.textContent = `${message.sampling.intervalMs} ms`;
    qualityInput.value = String(Math.round(message.sampling.jpegQuality * 100));
    qualityValue.textContent = message.sampling.jpegQuality.toFixed(2);
    restartSampler();
  },
  handleServerMessage = (message) => {
    if (message.type === "enrollment.sync") {
      handleEnrollmentSyncMessage(message);
      return;
    }

    if (message.type === "error") {
      connectionValue.textContent = message.message;
      return;
    }

    if (message.type === "frame.result") {
      handleFrameResultMessage(message);
      return;
    }

    if (message.type === "python.status") {
      handlePythonStatusMessage(message);
      return;
    }

    if (message.type === "session.ready") {
      handleSessionReadyMessage(message);
    }
  },
  sampleAndSendFrame = () => {
    const sourceHeight = cameraFeed.videoHeight,
      sourceWidth = cameraFeed.videoWidth;
    if (!sourceHeight || !sourceWidth) {
      return;
    }
    if (document.hidden) {
      return;
    }
    if (
      state.frameId - state.lastCompletedFrameId > 0 ||
      !(state.socket instanceof WebSocket) ||
      state.socket.bufferedAmount > 128_000
    ) {
      return;
    }

    const scale = Math.min(1, state.sampling.maxWidth / sourceWidth),
      targetHeight = Math.max(1, Math.round(sourceHeight * scale)),
      targetWidth = Math.max(1, Math.round(sourceWidth * scale));

    captureCanvas.height = targetHeight;
    captureCanvas.width = targetWidth;
    captureContext.drawImage(cameraFeed, 0, 0, targetWidth, targetHeight);

    const dataUrl = captureCanvas.toDataURL(
        "image/jpeg",
        state.sampling.jpegQuality
      ),
      [, base64] = dataUrl.split(",", 2);
    if (base64 === undefined) {
      return;
    }

    state.frameId += 1;
    state.socket.send(
      JSON.stringify({
        capturedAt: Date.now(),
        frameId: state.frameId,
        image: {
          data: base64,
          height: targetHeight,
          mimeType: "image/jpeg",
          width: targetWidth,
        },
        sampleIntervalMs: state.sampling.intervalMs,
        sessionId: state.sessionId,
        type: "frame.submit",
      })
    );
  },
  restartSampler = () => {
    if (state.sampleTimer !== null) {
      window.clearInterval(state.sampleTimer);
    }

    state.sampleTimer = window.setInterval(() => {
      if (
        !(state.socket instanceof WebSocket) ||
        state.socket.readyState !== WebSocket.OPEN ||
        cameraFeed.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return;
      }

      sampleAndSendFrame();
    }, state.sampling.intervalMs);
  },
  connectSocket = () => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws",
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/client`);
    state.socket = socket;

    socket.addEventListener("close", () => {
      setConnectionState("offline");
      window.setTimeout(connectSocket, 1000);
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      handleServerMessage(JSON.parse(event.data));
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
  },
  stopCameraStream = () => {
    if (!(state.activeStream instanceof MediaStream)) {
      return;
    }

    for (const track of state.activeStream.getTracks()) {
      track.stop();
    }
    state.activeStream = null;
  },
  startCamera = async (facingMode = state.cameraFacingMode) => {
    stopCameraStream();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        height: { ideal: 720 },
        width: { ideal: 1280 },
      },
    });
    state.activeStream = stream;
    state.cameraFacingMode = facingMode;
    updateCameraFlipButton();

    cameraFeed.addEventListener(
      "loadedmetadata",
      () => {
        syncOverlaySize();
      },
      { once: true }
    );

    cameraFeed.srcObject = stream;
    await cameraFeed.play();
    restartSampler();
  },
  bootstrap = async () => {
    await startCamera();
    connectSocket();
    try {
      await loadEnrollmentList();
    } catch (error) {
      enrollmentStatus.textContent =
        error instanceof Error ? error.message : "enrollment unavailable";
    }
  },
  flipCamera = async () => {
    const nextFacingMode =
      state.cameraFacingMode === "user" ? "environment" : "user";

    try {
      await startCamera(nextFacingMode);
    } catch {
      await startCamera(state.cameraFacingMode);
    }
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
    event.target instanceof Element &&
    event.target.hasAttribute("data-close")
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
  const response = await fetch(
      isEditing
        ? `/api/enrollment/${state.editingIdentityId}`
        : "/api/enrollment",
      {
        body: isEditing
          ? JSON.stringify(Object.fromEntries(submission.form.entries()))
          : submission.form,
        headers: isEditing
          ? {
              "Content-Type": "application/json",
            }
          : undefined,
        method: isEditing ? "PATCH" : "POST",
      }
    ),
    payload = await response.json();
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
    const identityId = event.target.dataset.id;
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

  const identityId = event.target.dataset.id;
  if (identityId === undefined) {
    return;
  }

  enrollmentStatus.textContent = "deleting…";
  const response = await fetch(`/api/enrollment/${identityId}`, {
      method: "DELETE",
    }),
    payload = await response.json();
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

window.addEventListener("resize", syncOverlaySize);

void bootstrap();
