from __future__ import annotations

import asyncio
import hashlib
import io
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import faiss
import numpy as np
from PIL import Image

from .config import Settings
from .search import ReverseImageSearch, SearchResult

if TYPE_CHECKING:
    from insightface.app import Face

    from .service import FaceRecognitionService


class NoFaceFoundError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class FaceData:
    bbox: dict[str, float]
    confidence: float
    embedding: np.ndarray
    cropped_jpeg: bytes


@dataclass(frozen=True, slots=True)
class PipelineResult:
    face: FaceData
    results: list[SearchResult]
    anchor_strategy: str
    engines_used: list[str]


def _embedding_fallback(embedding: np.ndarray) -> list[SearchResult]:
    sha = hashlib.sha256(embedding.tobytes()).hexdigest()
    return [
        SearchResult(
            url=f"face-embedding://{sha}",
            platform="none",
            title="Face Embedding Anchor",
            snippet=(
                "No social post found. Anchoring face embedding hash to the blockchain."
            ),
            image_url=None,
            fetched_at=int(time.time() * 1000),
            source_strategy="embedding-fallback",
            engine="embedding-fallback",
        )
    ]


def _bbox_payload(raw_bbox: np.ndarray[Any, Any]) -> dict[str, float]:
    x1, y1, x2, y2 = np.asarray(raw_bbox, dtype=np.float32)
    return {
        "x": round(float(x1), 2),
        "y": round(float(y1), 2),
        "width": round(float(x2 - x1), 2),
        "height": round(float(y2 - y1), 2),
    }


def _box_area(raw_bbox: np.ndarray[Any, Any]) -> float:
    x1, y1, x2, y2 = np.asarray(raw_bbox, dtype=np.float32)
    return float(max(0.0, x2 - x1) * max(0.0, y2 - y1))


def _normalized_embedding(face: Face) -> np.ndarray:
    normed = getattr(face, "normed_embedding", None)
    if normed is not None:
        return np.asarray(normed, dtype=np.float32)
    embedding = np.asarray(face.embedding, dtype=np.float32)  # type: ignore[attr-defined]
    faiss.normalize_L2(embedding.reshape(1, -1))
    return embedding


class Pipeline:
    def __init__(self, service: FaceRecognitionService, settings: Settings) -> None:
        self._service = service
        self._settings = settings
        self._search = ReverseImageSearch(settings)

    async def run(self, image_bytes: bytes) -> PipelineResult:
        face = await asyncio.to_thread(self._extract_face, image_bytes)
        # Vision gets the full original image; SerpAPI gets the face crop.
        results = await self._search.search(
            face.cropped_jpeg, full_image_bytes=image_bytes
        )
        if results:
            engines = sorted({r.engine for r in results})
            return PipelineResult(
                face=face,
                results=results,
                anchor_strategy="search",
                engines_used=engines,
            )
        fallback = _embedding_fallback(face.embedding)
        return PipelineResult(
            face=face,
            results=fallback,
            anchor_strategy="embedding",
            engines_used=["embedding-fallback"],
        )

    def _extract_face(self, image_bytes: bytes) -> FaceData:
        image = self._service.decode_image_bytes(image_bytes)
        faces: list[Face] = self._service.analysis.get(image)  # type: ignore[assignment]
        filtered: list[Face] = [
            f
            for f in faces
            if float(getattr(f, "det_score", 1.0))
            >= self._settings.min_detection_confidence
        ]
        if not filtered:
            raise NoFaceFoundError("No face detected in image.")
        face: Face = max(filtered, key=lambda c: _box_area(c.bbox))  # type: ignore[attr-defined]

        bbox = _bbox_payload(face.bbox)  # type: ignore[attr-defined]
        confidence = float(getattr(face, "det_score", 1.0))
        embedding = _normalized_embedding(face)

        # Crop with padding
        x1, y1, x2, y2 = np.asarray(face.bbox, dtype=np.float32)  # type: ignore[attr-defined]
        h, w = image.shape[0], image.shape[1]
        bw = float(x2 - x1)
        bh = float(y2 - y1)
        pad_x = int(bw * self._settings.face_crop_padding_x)
        pad_y = int(bh * self._settings.face_crop_padding_y)
        cx1 = max(0, int(x1) - pad_x)
        cy1 = max(0, int(y1) - pad_y)
        cx2 = min(w, int(x2) + pad_x)
        cy2 = min(h, int(y2) + pad_y)
        if cx2 <= cx1 or cy2 <= cy1:
            cx1, cy1, cx2, cy2 = int(x1), int(y1), int(x2), int(y2)
            cx1 = max(0, cx1)
            cy1 = max(0, cy1)
            cx2 = min(w, cx2)
            cy2 = min(h, cy2)

        cropped_bgr = image[cy1:cy2, cx1:cx2]
        # BGR -> RGB for PIL
        cropped_rgb = cropped_bgr[:, :, ::-1]
        pil_image = Image.fromarray(cropped_rgb)
        # Handle EXIF orientation already done in decode, but ensure RGB
        if pil_image.mode != "RGB":
            pil_image = pil_image.convert("RGB")
        buf = io.BytesIO()
        pil_image.save(buf, format="JPEG", quality=95)
        cropped_jpeg = buf.getvalue()

        # Fallback if crop is too small
        if len(cropped_jpeg) < 100:  # noqa: PLR2004
            buf2 = io.BytesIO()
            full_rgb = image[:, :, ::-1]
            Image.fromarray(full_rgb).save(buf2, format="JPEG", quality=95)
            cropped_jpeg = buf2.getvalue()

        return FaceData(
            bbox=bbox,
            confidence=confidence,
            embedding=embedding,
            cropped_jpeg=cropped_jpeg,
        )

    async def aclose(self) -> None:
        await self._search.aclose()
