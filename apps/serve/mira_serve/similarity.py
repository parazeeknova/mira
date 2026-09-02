# ruff: noqa
from __future__ import annotations

import asyncio
import base64
import logging
from typing import Any

import httpx
import numpy as np

from .config import Settings

logger = logging.getLogger(__name__)

# ONNX Runtime's FaceAnalysis.get is not thread-safe; serialize inference.
_inference_lock = asyncio.Lock()


def _strip_data_uri(b64_str: str) -> bytes | None:
    """Decode FaceCheck base64 data URI (e.g. 'data:image/webp;base64,...') or raw base64."""
    if not b64_str:
        return None
    # FaceCheck returns "data:image/webp;base64,<payload>" per Swagger
    if "," in b64_str and b64_str.startswith("data:"):
        # Split on first comma after header
        try:
            _, payload = b64_str.split(",", 1)
            b64_str = payload
        except ValueError:
            return None
    # Also handle "data:image/webp;base64,<payload>" with space variant
    if "base64," in b64_str:
        b64_str = b64_str.split("base64,", 1)[-1]
    b64_str = b64_str.strip()
    if not b64_str:
        return None
    try:
        # Use validate=False for robustness; add padding if needed
        missing = len(b64_str) % 4
        if missing:
            b64_str += "=" * (4 - missing)
        return base64.b64decode(b64_str, validate=False)
    except Exception:
        logger.debug("similarity: base64 decode failed (len=%s)", len(b64_str))
        return None


def _embedding_from_face(face: Any) -> np.ndarray | None:
    """Extract L2-normalized embedding from InsightFace Face dict."""
    try:
        normed = getattr(face, "normed_embedding", None)
        if normed is not None:
            arr = np.asarray(normed, dtype=np.float32)
            if arr.shape == (512,):
                return arr
            if arr.size == 512:
                return arr.reshape(512).astype(np.float32)
        emb = getattr(face, "embedding", None)
        if emb is None:
            return None
        arr = np.asarray(emb, dtype=np.float32).reshape(-1)
        if arr.shape != (512,):
            return None
        n = float(np.linalg.norm(arr))
        if n == 0:
            return None
        return (arr / n).astype(np.float32)
    except Exception:
        return None


def _box_area(bbox: Any) -> float:
    try:
        x1, y1, x2, y2 = np.asarray(bbox, dtype=np.float32)
        return float(max(0.0, x2 - x1) * max(0.0, y2 - y1))
    except Exception:
        return 0.0


class ArcFaceSimilarity:
    """Stage 4+5: acquire candidate images, re-detect faces, ArcFace cosine re-rank.

    Performance: downloads ~15-22 concurrent, inference serial via lock (ONNX not thread-safe).
    Total re-rank ~1-3s for 20 candidates.
    Graceful: skips candidates with no face / below threshold / download failures; never raises.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: httpx.AsyncClient | None = None

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            # Per-download timeout 7s per spec
            timeout = httpx.Timeout(7.0, connect=5.0)
            self._client = httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=True,
                headers={"User-Agent": "Mira/1.0 (+facecheck)"},
            )
        return self._client

    async def rank_candidates(
        self,
        input_embedding: np.ndarray,
        candidates: list[Any],  # SearchResult but avoid circular import at type-check
        face_service: Any,
    ) -> list[Any]:
        """Rank candidates by ArcFace cosine (re-detect required) and blended score.

        Returns sorted list[SearchResult] (with similarity/final_score populated) descending by final_score.
        May be empty → caller should use embedding fallback.
        """
        if not candidates:
            return []

        # Ensure input is L2-normed
        try:
            inp = np.asarray(input_embedding, dtype=np.float32).reshape(512)
            n = float(np.linalg.norm(inp))
            if n > 0 and abs(n - 1.0) > 1e-3:
                inp = (inp / n).astype(np.float32)
        except Exception:
            logger.warning("similarity: invalid input_embedding shape")
            return []

        # Split Group A (FaceCheck base64) vs Group B (URL)
        group_a: list[Any] = []
        group_b: list[Any] = []
        for c in candidates:
            has_image = bool(
                getattr(c, "has_image", False) and getattr(c, "base64", None)
            )
            if has_image:
                group_a.append(c)
            else:
                group_b.append(c)

        # Acquire images
        # Group A: in-memory decode (zero network)
        a_pairs: list[tuple[Any, bytes]] = []
        for cand in group_a:
            b64 = getattr(cand, "base64", None)
            if not isinstance(b64, str):
                continue
            dec = _strip_data_uri(b64)
            if dec and len(dec) > 100:
                a_pairs.append((cand, dec))
            else:
                logger.debug(
                    "similarity: FaceCheck candidate %s base64 decode failed or too small",
                    cand.url,
                )

        # Group B: concurrent async downloads
        b_pairs: list[tuple[Any, bytes]] = []
        if group_b:
            download_results = await asyncio.gather(
                *(self._download_candidate(c) for c in group_b), return_exceptions=True
            )
            ok_downloads = 0
            for cand, res in zip(group_b, download_results, strict=True):
                if isinstance(res, BaseException) or res is None:
                    logger.info(
                        "similarity: download FAILED: %s (%s)",
                        cand.url,
                        res.__class__.__name__
                        if isinstance(res, BaseException)
                        else "empty/html",
                    )
                    continue
                if isinstance(res, (bytes, bytearray)) and len(res) > 100:
                    b_pairs.append((cand, bytes(res)))
                    ok_downloads += 1
            logger.info(
                "similarity: acquired images: %d/%d URL downloads ok, %d/%d facecheck in-memory",
                ok_downloads,
                len(group_b),
                len(a_pairs),
                len(group_a),
            )

        all_pairs = a_pairs + b_pairs
        if not all_pairs:
            logger.info(
                "similarity: no candidate images acquired (a=%s b=%s)",
                len(a_pairs),
                len(b_pairs),
            )
            return []

        # Per-candidate face detection + embedding (serial via lock)
        threshold = float(self._settings.cosine_threshold)
        ranked: list[
            tuple[float, float, Any]
        ] = []  # (final_score, cosine, SearchResult)

        for cand, img_bytes in all_pairs:
            try:
                # Decode image bytes via service helper (BGR)
                try:
                    image = face_service.decode_image_bytes(img_bytes)
                except Exception:
                    # Fallback: try PIL decode then assume BGR conversion already? service already does BGR
                    logger.debug("similarity: decode failed for %s", cand.url)
                    continue

                # InsightFace detection — ONNX not thread-safe, serialize
                async with _inference_lock:
                    try:
                        faces = await asyncio.to_thread(
                            face_service.analysis.get, image
                        )
                    except Exception as e:
                        logger.debug(
                            "similarity: FaceAnalysis.get failed for %s: %s",
                            cand.url,
                            e,
                        )
                        continue

                if not faces:
                    logger.info("similarity: DISCARD (no face): %s", cand.url)
                    continue

                # Select largest face
                try:
                    largest = max(
                        faces, key=lambda f: _box_area(getattr(f, "bbox", []))
                    )
                except Exception:
                    largest = faces[0]

                cand_emb = _embedding_from_face(largest)
                if cand_emb is None:
                    logger.debug("similarity: no embedding for %s", cand.url)
                    continue

                cosine = float(np.dot(inp, cand_emb))
                # Clamp to [-1, 1] (numerical)
                cosine = max(-1.0, min(1.0, cosine))
                if cosine < threshold:
                    logger.info(
                        "similarity: DISCARD (cos %.3f < %.3f): %s",
                        cosine,
                        threshold,
                        cand.url,
                    )
                    continue

                # Score blending per ARCHITECTURE Stage 5
                facecheck_score = getattr(cand, "facecheck_score", None)
                multi_source = int(getattr(cand, "multi_source_count", 0) or 0)
                if (
                    facecheck_score is not None
                    and isinstance(facecheck_score, int)
                    and getattr(cand, "engine", "") == "facecheck"
                ):
                    # FaceCheck: 0.6×cosine + 0.4×facecheck_norm
                    facecheck_norm = max(0.0, min(1.0, facecheck_score / 100.0))
                    final = 0.6 * cosine + 0.4 * facecheck_norm
                else:
                    # URL candidates: cosine × (1 + 0.2 × multi_source_count)
                    # multi_source_count is distinct engines count; count>=1 → boost
                    final = cosine * (1.0 + 0.2 * float(multi_source))

                # Create new SearchResult with similarity/final_score populated
                from .search import SearchResult as _SR  # local import

                # Preserve all original fields, update scores
                # SearchResult is frozen — reconstruct
                new_sr = _SR(
                    url=cand.url,
                    platform=cand.platform,
                    title=cand.title,
                    snippet=cand.snippet,
                    image_url=cand.image_url,
                    fetched_at=cand.fetched_at,
                    source_strategy=cand.source_strategy,
                    engine=cand.engine,
                    base64=cand.base64,
                    facecheck_score=facecheck_score
                    if isinstance(facecheck_score, int)
                    else None,
                    has_image=bool(getattr(cand, "has_image", False)),
                    multi_source_count=multi_source,
                    similarity=cosine,
                    final_score=final,
                )
                ranked.append((final, cosine, new_sr))
                logger.info(
                    "similarity: SURVIVOR cos=%.3f final=%.3f (sources=%d): %s",
                    cosine,
                    final,
                    multi_source,
                    cand.url,
                )
            except Exception as e:
                logger.debug(
                    "similarity: candidate %s failed: %s: %s",
                    cand.url,
                    e.__class__.__name__,
                    e,
                    exc_info=True,
                )
                continue

        if not ranked:
            logger.info(
                "similarity: all candidates filtered (threshold=%.2f, acquired=%s)",
                threshold,
                len(all_pairs),
            )
            return []

        # Sort descending by final_score, then cosine
        ranked.sort(key=lambda x: (x[0], x[1]), reverse=True)
        return [sr for _, _, sr in ranked]

    async def _download_candidate(self, cand: Any) -> bytes | None:
        """Download candidate image from URL (or image_url fallback). Returns bytes or None."""
        # Prefer image_url if present (more likely to be direct image), else url
        target = getattr(cand, "image_url", None) or getattr(cand, "url", None)
        if not isinstance(target, str) or not target.startswith("http"):
            return None
        # Skip obviously non-image page URLs that will return HTML (but try anyway — service will detect no face and discard)
        # Quick heuristic: if target is page (no image extension), still attempt download — Vision pages may still host image
        client = self._get_client()
        try:
            resp = await client.get(target)
            # Accept only 2xx and image content-type or at least >100 bytes
            if resp.status_code >= 400:
                logger.debug(
                    "similarity: download %s -> HTTP %s", target, resp.status_code
                )
                return None
            ct = resp.headers.get("content-type", "").lower()
            # If server returns html, skip (no face anyway, but avoid wasting inference)
            if ct and "text/html" in ct:
                logger.debug("similarity: download %s returned HTML, skipping", target)
                return None
            data = resp.content
            if not data or len(data) < 100:
                return None
            # Limit size to 10 MB to avoid OOM
            if len(data) > 10 * 1024 * 1024:
                logger.debug(
                    "similarity: download %s too large %s bytes, skipping",
                    target,
                    len(data),
                )
                return None
            return data
        except httpx.TimeoutException:
            logger.debug("similarity: download timeout %s", target)
            return None
        except httpx.HTTPError as e:
            logger.debug("similarity: download HTTP error %s: %s", target, e)
            return None
        except Exception as e:
            logger.debug(
                "similarity: download error %s: %s: %s", target, e.__class__.__name__, e
            )
            return None
