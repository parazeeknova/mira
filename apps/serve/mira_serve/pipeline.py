# ruff: noqa
from __future__ import annotations

import asyncio
import hashlib
import io
import logging
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

    from .cache import EmbeddingCache
    from .service import FaceRecognitionService
    from .similarity import ArcFaceSimilarity

logger = logging.getLogger(__name__)


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
    cache_hit: bool = False
    input_face_hash: str = ""

    @property
    def input_face_hash_or_computed(self) -> str:
        if self.input_face_hash:
            return self.input_face_hash
        return hashlib.sha256(self.face.embedding.tobytes()).hexdigest()


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
    """Stage 1→5b orchestrator: face extract → cache lookup → 4-engine search → re-rank → cache write."""

    def __init__(
        self,
        service: FaceRecognitionService,
        settings: Settings,
        *,
        cache: EmbeddingCache | None = None,
        search: ReverseImageSearch | None = None,
        similarity: ArcFaceSimilarity | None = None,
    ) -> None:
        self._service = service
        self._settings = settings
        # Lazy / injectable for tests
        if cache is not None:
            self._cache = cache
        else:
            try:
                from .cache import EmbeddingCache as _EC  # noqa: PLC0415

                self._cache = _EC(settings)
            except Exception as e:
                logger.warning(
                    "Pipeline: cache init failed, running without cache: %s", e
                )
                self._cache = None  # type: ignore[assignment]

        self._search = search if search is not None else ReverseImageSearch(settings)

        if similarity is not None:
            self._similarity = similarity
        else:
            try:
                from .similarity import ArcFaceSimilarity as _AS  # noqa: PLC0415

                self._similarity = _AS(settings)
            except Exception as e:
                logger.warning("Pipeline: similarity init failed: %s", e)
                self._similarity = None  # type: ignore[assignment]

    async def run(self, image_bytes: bytes) -> PipelineResult:
        # Stage 1: face detection & embedding
        face = await asyncio.to_thread(self._extract_face, image_bytes)

        # Stage 2: embedding cache lookup — <5ms brute-force cosine (in-memory matrix)
        if self._cache is not None:
            try:
                cached = self._cache.lookup(face.embedding)
                if cached is not None:
                    logger.info(
                        "Pipeline cache HIT: %s (similarity=%.3f, engines=%s)",
                        cached.top_url,
                        cached.similarity,
                        cached.engines_used,
                    )
                    return PipelineResult(
                        face=face,
                        results=cached.results,
                        anchor_strategy="search",
                        engines_used=cached.engines_used,
                        cache_hit=True,
                        input_face_hash=hashlib.sha256(
                            face.embedding.tobytes()
                        ).hexdigest(),
                    )
            except Exception as e:
                logger.warning(
                    "Pipeline cache lookup failed, proceeding to search: %s: %s",
                    e.__class__.__name__,
                    e,
                    exc_info=True,
                )

        # Stage 3: 4-engine parallel search
        try:
            candidates = await self._search.search(
                face.cropped_jpeg, full_image_bytes=image_bytes
            )
        except Exception as e:
            logger.warning(
                "Pipeline search failed: %s: %s", e.__class__.__name__, e, exc_info=True
            )
            candidates = []

        # Stage 4+5: ArcFace re-ranking (if similarity available and candidates non-empty)
        ranked: list[SearchResult] = []
        if candidates and self._similarity is not None:
            try:
                ranked = await self._similarity.rank_candidates(
                    face.embedding, candidates, self._service
                )
            except Exception as e:
                logger.warning(
                    "Pipeline similarity re-rank failed, falling back to raw candidates: %s: %s",
                    e.__class__.__name__,
                    e,
                    exc_info=True,
                )
                ranked = []
            # If re-rank filtered everything, treat as no results → fallback
            # Otherwise use ranked; if similarity not available, use raw candidates capped
            if ranked:
                results = ranked
            elif candidates:
                # Similarity filtered all → check if we should still use raw? Spec says zero-survivor → embedding fallback.
                # So ranked empty → fallback path.
                results = []
            else:
                results = []
        else:
            # No similarity engine or no candidates
            results = candidates

        if results:
            engines = sorted({r.engine for r in results})
            # Stage 5b: cache write (only for real URLs, not fallback)
            if self._cache is not None:
                try:
                    top = results[0]
                    sim = (
                        float(top.similarity)
                        if top.similarity is not None
                        else float(top.final_score or 0.0)
                    )
                    # Don't cache fallback URLs
                    if not top.url.startswith("face-embedding://"):
                        # Run write synchronously but don't block pipeline on DB fsync
                        # Use to_thread to avoid blocking event loop on SQLite write
                        try:
                            await asyncio.to_thread(
                                self._cache.write,
                                face.embedding,
                                results,
                                top.url,
                                engines,
                                sim,  # type: ignore[attr-defined]
                            )
                        except TypeError:
                            # Fallback if write signature differs (old)
                            await asyncio.to_thread(
                                self._cache.write,
                                face.embedding,
                                results,
                                top.url,
                                engines,  # type: ignore[attr-defined]
                            )
                        logger.info("Pipeline cache WRITE: %s (sim=%.3f)", top.url, sim)
                except Exception as e:
                    logger.warning(
                        "Pipeline cache write failed: %s: %s",
                        e.__class__.__name__,
                        e,
                        exc_info=True,
                    )
            return PipelineResult(
                face=face,
                results=results,
                anchor_strategy="search",
                engines_used=engines,
                cache_hit=False,
                input_face_hash=hashlib.sha256(face.embedding.tobytes()).hexdigest(),
            )

        # Zero-survivor fallback: embedding hash
        fallback = _embedding_fallback(face.embedding)
        # Do NOT cache fallback (would corrupt future lookups)
        return PipelineResult(
            face=face,
            results=fallback,
            anchor_strategy="embedding",
            engines_used=["embedding-fallback"],
            cache_hit=False,
            input_face_hash=hashlib.sha256(face.embedding.tobytes()).hexdigest(),
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
        try:
            await self._search.aclose()
        except Exception:
            pass
        try:
            if self._similarity is not None:
                await self._similarity.aclose()  # type: ignore[attr-defined]
        except Exception:
            pass
