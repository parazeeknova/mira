export interface BBox {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface TrackDetailRow {
  label: string;
  value: string;
}

export interface Track {
  confidenceText: string;
  detailRows: TrackDetailRow[];
  fadeDuration: number;
  fromBox: BBox;
  headerLabel: string;
  layout: {
    cardHeight: number;
    cardWidth: number;
    chipLabel: string;
    chipWidth: number;
    labelWidth: number;
    rowHeight: number;
    valueOffset: number;
  };
  maxPredictionMs: number;
  removeAfter: number | null;
  sourceSize: { height: number; width: number };
  toBox: BBox;
  trackId: number | null;
  transitionDuration: number;
  transitionStart: number;
  velocity: BBox;
}

export const cloneBox = (bbox: BBox): BBox => ({
  height: bbox.height,
  width: bbox.width,
  x: bbox.x,
  y: bbox.y,
});

export const makeTrackKey = (
  face: { trackId: number | null },
  index: number
): string =>
  face.trackId === null ? `ephemeral-${index}` : `track-${face.trackId}`;

export const mixBox = (fromBox: BBox, toBox: BBox, progress: number): BBox => ({
  height: fromBox.height + (toBox.height - fromBox.height) * progress,
  width: fromBox.width + (toBox.width - fromBox.width) * progress,
  x: fromBox.x + (toBox.x - fromBox.x) * progress,
  y: fromBox.y + (toBox.y - fromBox.y) * progress,
});

export const scaleBox = (box: BBox, factor: number): BBox => ({
  height: box.height * factor,
  width: box.width * factor,
  x: box.x * factor,
  y: box.y * factor,
});

export const subtractBox = (nextBox: BBox, previousBox: BBox): BBox => ({
  height: nextBox.height - previousBox.height,
  width: nextBox.width - previousBox.width,
  x: nextBox.x - previousBox.x,
  y: nextBox.y - previousBox.y,
});

export const measureTrackLayout = (
  ctx: CanvasRenderingContext2D,
  headerLabel: string,
  confidenceText: string,
  detailRows: TrackDetailRow[]
): Track["layout"] => {
  ctx.font = '14px "Cascadia Mono", monospace';
  const chipLabel = `${headerLabel} · ${confidenceText}`;
  const chipWidth = ctx.measureText(chipLabel).width + 20;

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

  ctx.font = '12px "Cascadia Mono", monospace';
  const labelWidth = Math.max(
    ...detailRows.map((row) => ctx.measureText(row.label).width)
  );
  const valueWidth = Math.max(
    ...detailRows.map((row) => ctx.measureText(row.value).width)
  );
  const cardWidth = Math.max(176, labelWidth + valueWidth + 44);
  const rowHeight = 20;

  return {
    cardHeight: 18 + detailRows.length * rowHeight,
    cardWidth,
    chipLabel,
    chipWidth,
    labelWidth,
    rowHeight,
    valueOffset: 20 + labelWidth,
  };
};

export const getTrackBox = (track: Track, now: number): BBox => {
  const duration = Math.max(track.transitionDuration, 1);
  const progress = Math.min(1, (now - track.transitionStart) / duration);
  const interpolated = mixBox(track.fromBox, track.toBox, progress);

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
};

export interface FloatRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

/**
 * Middle-truncate a long hash for narrow cards: keeps the prefix (chain
 * selector) and suffix (checksum-y tail) with an ellipsis between.
 */
export const shortMiddle = (value: string, head = 9, tail = 5): string =>
  value.length > head + tail + 1
    ? `${value.slice(0, head)}…${value.slice(-tail)}`
    : value;

export interface FloatSize {
  height: number;
  width: number;
}

/**
 * Screen rect of the identity detail card drawn beside a face box.
 * Mirrors the placement math in `drawOverlay` so HTML overlays can avoid it.
 * Returns null when the track has no detail rows to render.
 */
export const detailCardRect = (
  box: FloatRect,
  layout: Track["layout"],
  stageWidth: number
): FloatRect | null => {
  if (layout.cardHeight === 0 || layout.cardWidth === 0) {
    return null;
  }
  const preferredX = box.x + box.width + 12;
  const x =
    preferredX + layout.cardWidth <= stageWidth - 8
      ? preferredX
      : Math.max(8, box.x - layout.cardWidth - 12);
  return {
    height: layout.cardHeight,
    width: layout.cardWidth,
    x,
    y: Math.max(8, box.y),
  };
};

const rectsOverlap = (a: FloatRect, b: FloatRect): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/**
 * Places a floating card (scan log, tooltip) near a face box without
 * covering the box itself: tries right, right-below the detail card, left,
 * below, above — then falls back to clamping inside the stage.
 */
export const placeFloatCard = (
  box: FloatRect,
  card: FloatSize,
  stage: FloatSize,
  avoid: FloatRect | null = null,
  gap = 10,
  pad = 8
): FloatRect => {
  const candidates = [
    { x: box.x + box.width + gap, y: box.y },
    ...(avoid === null
      ? []
      : [{ x: box.x + box.width + gap, y: avoid.y + avoid.height + gap }]),
    { x: box.x - card.width - gap, y: box.y },
    { x: box.x, y: box.y + box.height + gap },
    { x: box.x, y: box.y - card.height - gap },
  ];
  const fits = (point: { x: number; y: number }): boolean =>
    point.x >= pad &&
    point.y >= pad &&
    point.x + card.width <= stage.width - pad &&
    point.y + card.height <= stage.height - pad;
  const clear = (point: { x: number; y: number }): boolean => {
    const rect: FloatRect = {
      height: card.height,
      width: card.width,
      x: point.x,
      y: point.y,
    };
    return (
      !rectsOverlap(rect, box) && (avoid === null || !rectsOverlap(rect, avoid))
    );
  };
  for (const point of candidates) {
    if (fits(point) && clear(point)) {
      return { height: card.height, width: card.width, x: point.x, y: point.y };
    }
  }
  for (const point of candidates) {
    if (fits(point)) {
      return { height: card.height, width: card.width, x: point.x, y: point.y };
    }
  }
  const [fallback] = candidates;
  const fallbackPoint = fallback ?? { x: pad, y: pad };
  return {
    height: card.height,
    width: card.width,
    x: Math.min(
      Math.max(fallbackPoint.x, pad),
      Math.max(pad, stage.width - card.width - pad)
    ),
    y: Math.min(
      Math.max(fallbackPoint.y, pad),
      Math.max(pad, stage.height - card.height - pad)
    ),
  };
};

interface CameraController {
  captureFrame: (sampling: {
    jpegQuality: number;
    maxWidth: number;
  }) => { base64: string; height: number; width: number } | null;
  drawOverlay: (
    tracks: Map<string, Track>,
    sourceSize: { height: number; width: number }
  ) => void;
  facingMode: "user" | "environment";
  measureTrackLayout: (
    headerLabel: string,
    confidenceText: string,
    detailRows: TrackDetailRow[]
  ) => Track["layout"];
  start: (mode?: "user" | "environment") => Promise<void>;
  stop: () => void;
  syncOverlaySize: () => void;
}

export const createCameraController = (
  cameraFeed: HTMLVideoElement,
  overlayCanvas: HTMLCanvasElement,
  captureCanvas: HTMLCanvasElement
): CameraController => {
  const overlayCtx = overlayCanvas.getContext("2d");
  const captureCtx = captureCanvas.getContext("2d");
  if (overlayCtx === null || captureCtx === null) {
    throw new TypeError("Canvas 2D contexts are required.");
  }

  let activeStream: MediaStream | null = null;
  let facingMode: "user" | "environment" = "user";

  const syncOverlaySize = (): void => {
    const rect = cameraFeed.getBoundingClientRect();
    overlayCanvas.height = rect.height;
    overlayCanvas.width = rect.width;
  };

  const stop = (): void => {
    if (!(activeStream instanceof MediaStream)) {
      return;
    }
    for (const track of activeStream.getTracks()) {
      track.stop();
    }
    activeStream = null;
  };

  const start = async (
    mode: "user" | "environment" = facingMode
  ): Promise<void> => {
    stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: mode },
        height: { ideal: 720 },
        width: { ideal: 1280 },
      },
    });
    activeStream = stream;
    facingMode = mode;

    cameraFeed.addEventListener(
      "loadedmetadata",
      () => {
        syncOverlaySize();
      },
      { once: true }
    );

    cameraFeed.srcObject = stream;
    await cameraFeed.play();
  };

  const captureFrame = (sampling: {
    jpegQuality: number;
    maxWidth: number;
  }): { base64: string; height: number; width: number } | null => {
    const sourceHeight = cameraFeed.videoHeight;
    const sourceWidth = cameraFeed.videoWidth;
    if (!sourceHeight || !sourceWidth) {
      return null;
    }
    const scale = Math.min(1, sampling.maxWidth / sourceWidth);
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));

    captureCanvas.height = targetHeight;
    captureCanvas.width = targetWidth;
    captureCtx.drawImage(cameraFeed, 0, 0, targetWidth, targetHeight);

    const dataUrl = captureCanvas.toDataURL("image/jpeg", sampling.jpegQuality);
    const [, base64] = dataUrl.split(",", 2);
    if (base64 === undefined) {
      return null;
    }
    return { base64, height: targetHeight, width: targetWidth };
  };

  const drawOverlay = (
    tracks: Map<string, Track>,
    sourceSize: { height: number; width: number }
  ): void => {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!sourceSize.height || !sourceSize.width) {
      return;
    }

    const now = performance.now();
    overlayCtx.font = '14px "Cascadia Mono", monospace';
    overlayCtx.lineWidth = 2;
    overlayCtx.textBaseline = "top";

    for (const [key, track] of tracks.entries()) {
      const scaleX = overlayCanvas.width / track.sourceSize.width;
      const scaleY = overlayCanvas.height / track.sourceSize.height;
      const box = getTrackBox(track, now);
      const width = box.width * scaleX;
      const height = box.height * scaleY;
      const x = box.x * scaleX;
      const y = box.y * scaleY;
      let alpha = 1;

      if (track.removeAfter !== null) {
        alpha = Math.max(
          0,
          (track.removeAfter - now) / Math.max(track.fadeDuration, 1)
        );
        if (alpha <= 0) {
          tracks.delete(key);
          continue;
        }
      }

      overlayCtx.shadowBlur = 0;
      overlayCtx.strokeStyle = "rgba(255, 255, 255, 0.92)";
      overlayCtx.globalAlpha = alpha;
      overlayCtx.strokeRect(x, y, width, height);

      const chipHeight = 28;
      const { layout } = track;
      const chipY = Math.max(8, y - chipHeight - 8);

      overlayCtx.fillStyle = "rgba(8, 10, 14, 0.66)";
      overlayCtx.fillRect(x, chipY, layout.chipWidth, chipHeight);
      overlayCtx.fillStyle = "#fff";
      overlayCtx.fillText(layout.chipLabel, x + 10, chipY + 6);

      if (track.detailRows.length > 0) {
        overlayCtx.font = '12px "Cascadia Mono", monospace';
        const detail = detailCardRect(
          { height, width, x, y },
          layout,
          overlayCanvas.width
        );
        if (detail === null) {
          continue;
        }
        const { x: cardX, y: cardY } = detail;

        overlayCtx.fillStyle = "rgba(8, 10, 14, 0.62)";
        overlayCtx.fillRect(cardX, cardY, layout.cardWidth, layout.cardHeight);

        for (const [detailIndex, row] of track.detailRows.entries()) {
          const rowY = cardY + 10 + detailIndex * layout.rowHeight;
          overlayCtx.fillStyle = "rgba(255, 255, 255, 0.48)";
          overlayCtx.fillText(row.label, cardX + 12, rowY);
          overlayCtx.fillStyle = "#fff";
          overlayCtx.fillText(row.value, cardX + layout.valueOffset, rowY);
        }

        overlayCtx.font = '14px "Cascadia Mono", monospace';
        overlayCtx.lineWidth = 2;
      }
    }

    overlayCtx.globalAlpha = 1;
    overlayCtx.shadowBlur = 0;
  };

  return {
    captureFrame,
    drawOverlay,
    get facingMode() {
      return facingMode;
    },
    measureTrackLayout: (
      headerLabel: string,
      confidenceText: string,
      detailRows: TrackDetailRow[]
    ) =>
      measureTrackLayout(overlayCtx, headerLabel, confidenceText, detailRows),
    start,
    stop,
    syncOverlaySize,
  };
};
