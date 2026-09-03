# ruff: noqa
from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import faiss
import numpy as np
from PIL import Image

from config.config import Settings
from enrich.firecrawl import FirecrawlEnricher
from search.search import ReverseImageSearch, SearchResult

# Progress events stream stage updates (detect → cache → per-engine search →
# rank → done) to whoever is watching a run, e.g. the web client floating
# per-face status beside each tracked face. All events are plain JSON dicts
# with at least {"stage": ..., "state": ...}; states are start/done/skip/error.
ProgressCallback = Callable[[dict[str, Any]], Awaitable[None]]

if TYPE_CHECKING:
    from insightface.app import Face

    from cache.cache import EmbeddingCache
    from service.service import FaceRecognitionService
    from search.similarity import ArcFaceSimilarity

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
        enricher: FirecrawlEnricher | None = None,
    ) -> None:
        self._service = service
        self._settings = settings
        # Lazy / injectable for tests
        if cache is not None:
            self._cache = cache
        else:
            try:
                from cache.cache import EmbeddingCache as _EC  # noqa: PLC0415

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
                from search.similarity import ArcFaceSimilarity as _AS  # noqa: PLC0415

                self._similarity = _AS(settings)
            except Exception as e:
                logger.warning("Pipeline: similarity init failed: %s", e)
                self._similarity = None  # type: ignore[assignment]

        self._enricher = (
            enricher if enricher is not None else FirecrawlEnricher(settings)
        )

    async def run(
        self,
        image_bytes: bytes,
        on_progress: ProgressCallback | None = None,
    ) -> PipelineResult:
        async def emit(event: dict[str, Any]) -> None:
            if on_progress is not None:
                await on_progress(event)

        t0 = time.perf_counter()
        image_len = len(image_bytes)
        logger.info("[pipeline] ▶ START: %d bytes input", image_len)
        await emit({"stage": "detect", "state": "start"})

        # Stage 1: face detection & embedding
        try:
            face = await asyncio.to_thread(self._extract_face, image_bytes)
        except NoFaceFoundError:
            await emit({"stage": "detect", "state": "error", "error": "no face"})
            raise
        t1 = time.perf_counter()
        logger.info(
            "[pipeline] stage1 detect+embed: bbox=(%s) conf=%.3f (%.0fms)",
            ", ".join(f"{v:.0f}" for v in face.bbox.values()),
            face.confidence,
            (t1 - t0) * 1000,
        )
        await emit(
            {
                "stage": "detect",
                "state": "done",
                "confidence": round(face.confidence, 3),
            }
        )

        # Stage 2: embedding cache lookup — <5ms brute-force cosine (in-memory matrix)
        if self._cache is not None:
            try:
                cached = self._cache.lookup(face.embedding)
                if cached is not None:
                    logger.info(
                        "[pipeline] stage2 cache HIT: %s (similarity=%.3f, engines=%s) — "
                        "skipping stages 3-5 [total %.0fms]",
                        cached.top_url,
                        cached.similarity,
                        cached.engines_used,
                        (time.perf_counter() - t0) * 1000,
                    )
                    await emit(
                        {
                            "stage": "cache",
                            "state": "hit",
                            "engines": list(cached.engines_used),
                            "results": len(cached.results),
                        }
                    )
                    # Cache hits skip search (stages 3-5) but still get
                    # Firecrawl enrichment so the posts card has bio text.
                    hit_results = list(cached.results)
                    if self._enricher.enabled and hit_results:
                        t_enrich = time.perf_counter()
                        try:
                            hit_results = await self._enricher.enrich(
                                hit_results, on_progress=emit
                            )
                            logger.info(
                                "[pipeline] stage4.5 enrich on cache-hit: "
                                "%d/%d pages enriched (%.1fs)",
                                sum(
                                    1
                                    for r in hit_results
                                    if r.enriched_snippet or r.social_links
                                ),
                                len(hit_results),
                                time.perf_counter() - t_enrich,
                            )
                        except Exception as e:
                            logger.warning(
                                "[pipeline] stage4.5 enrich on cache-hit "
                                "failed, using cached results: %s: %s",
                                e.__class__.__name__,
                                e,
                            )
                    await emit(
                        {
                            "stage": "done",
                            "state": "done",
                            "strategy": "search",
                            "results": len(hit_results),
                            "engines": list(cached.engines_used),
                            "cached": True,
                        }
                    )
                    return PipelineResult(
                        face=face,
                        results=hit_results,
                        anchor_strategy="search",
                        engines_used=cached.engines_used,
                        cache_hit=True,
                        input_face_hash=hashlib.sha256(
                            face.embedding.tobytes()
                        ).hexdigest(),
                    )
                logger.info(
                    "[pipeline] stage2 cache MISS (best sim < %.2f) — proceeding to search",
                    self._settings.cache_threshold,
                )
                await emit({"stage": "cache", "state": "miss"})
            except Exception as e:
                logger.warning(
                    "[pipeline] stage2 cache lookup failed, proceeding to search: %s: %s",
                    e.__class__.__name__,
                    e,
                    exc_info=True,
                )

        # Stage 3: 4-engine parallel search
        await emit({"stage": "search", "state": "start"})
        try:
            candidates = await self._search.search(
                face.cropped_jpeg,
                full_image_bytes=image_bytes,
                on_progress=emit,
            )
            t2 = time.perf_counter()
            by_engine: dict[str, int] = {}
            for c in candidates:
                by_engine[c.engine] = by_engine.get(c.engine, 0) + 1
            logger.info(
                "[pipeline] stage3 search: %d candidates (%s) (%.1fs)",
                len(candidates),
                ", ".join(f"{k}={v}" for k, v in sorted(by_engine.items())) or "none",
                t2 - t1,
            )
            await emit(
                {
                    "stage": "search",
                    "state": "done",
                    "candidates": len(candidates),
                    "engines": dict(sorted(by_engine.items())),
                }
            )
        except Exception as e:
            logger.warning(
                "[pipeline] stage3 search failed: %s: %s",
                e.__class__.__name__,
                e,
                exc_info=True,
            )
            candidates = []

        # Stage 4+5: ArcFace re-ranking (if similarity available and candidates non-empty)
        ranked: list[SearchResult] = []
        if candidates and self._similarity is not None:
            await emit(
                {"stage": "rank", "state": "start", "candidates": len(candidates)}
            )
            try:
                t3 = time.perf_counter()
                ranked = await self._similarity.rank_candidates(
                    face.embedding, candidates, self._service
                )
                logger.info(
                    "[pipeline] stage4+5 re-rank: %d/%d survived (top sim=%.3f, final=%.3f) (%.1fs)",
                    len(ranked),
                    len(candidates),
                    ranked[0].similarity
                    if ranked and ranked[0].similarity is not None
                    else 0.0,
                    ranked[0].final_score
                    if ranked and ranked[0].final_score is not None
                    else 0.0,
                    time.perf_counter() - t3,
                )
                await emit(
                    {
                        "stage": "rank",
                        "state": "done",
                        "candidates": len(candidates),
                        "results": len(ranked),
                    }
                )
            except Exception as e:
                logger.warning(
                    "[pipeline] stage4+5 re-rank failed, falling back to raw candidates: %s: %s",
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
            # Stage 4.5: Firecrawl enrichment — bio text + social links for
            # the posts card. Best-effort; failures keep the raw results.
            if self._enricher.enabled:
                t_enrich = time.perf_counter()
                try:
                    results = await self._enricher.enrich(results, on_progress=emit)
                    logger.info(
                        "[pipeline] stage4.5 enrich: %d/%d pages enriched (%.1fs)",
                        sum(1 for r in results if r.enriched_snippet or r.social_links),
                        len(results),
                        time.perf_counter() - t_enrich,
                    )
                except Exception as e:
                    logger.warning(
                        "[pipeline] stage4.5 enrich failed, using raw results: %s: %s",
                        e.__class__.__name__,
                        e,
                    )
            else:
                logger.info("[pipeline] stage4.5 enrich skipped (FIRECRAWL_URL unset)")
            logger.info(
                "[pipeline] stage5 rank result: %d results, engines=%s, top=%s",
                len(results),
                engines,
                results[0].url,
            )
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
                        logger.info(
                            "[pipeline] stage5b cache WRITE: %s (sim=%.3f)",
                            top.url,
                            sim,
                        )
                except Exception as e:
                    logger.warning(
                        "[pipeline] stage5b cache write failed: %s: %s",
                        e.__class__.__name__,
                        e,
                        exc_info=True,
                    )
            logger.info(
                "[pipeline] ■ DONE (search): %d results via %s [total %.1fs]",
                len(results),
                engines,
                time.perf_counter() - t0,
            )
            await emit(
                {
                    "stage": "done",
                    "state": "done",
                    "strategy": "search",
                    "results": len(results),
                    "engines": engines,
                }
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
        logger.info(
            "[pipeline] ■ DONE (embedding fallback): no matches survived [total %.1fs]",
            time.perf_counter() - t0,
        )
        # Do NOT cache fallback (would corrupt future lookups)
        await emit(
            {"stage": "done", "state": "done", "strategy": "embedding", "results": 1}
        )
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
            await self._enricher.aclose()
        except Exception:
            pass
        try:
            if self._similarity is not None:
                await self._similarity.aclose()  # type: ignore[attr-defined]
        except Exception:
            pass
