# ruff: noqa
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, cast

import httpx

from config.config import Settings
from search.search import SearchResult, detect_platform

logger = logging.getLogger(__name__)

_FACECHECK_UPLOAD_URL = "https://facecheck.id/api/upload_pic"
_FACECHECK_SEARCH_URL = "https://facecheck.id/api/search"


def _extract_url(raw_url: Any) -> str | None:
    """FaceCheck url field is MaskedUrl {value: str} per Swagger, but docs also show plain string.
    Handle both + defensive None.
    """
    if raw_url is None:
        return None
    if isinstance(raw_url, str):
        s = raw_url.strip()
        return s or None
    if isinstance(raw_url, dict):
        # Swagger: {"value": "https://..."}
        val = raw_url.get("value")
        if isinstance(val, str):
            s = val.strip()
            return s or None
        # Some responses use {"url": "..."} wrapped
        for key in ("url", "link", "href"):
            v = raw_url.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
        return None
    return None


class FaceCheckSearch:
    """FaceCheck.id upload→poll engine. Returns base64 crops directly — zero download needed.

    Implements the exact flow from official docs + Swagger v1.02:
      1. POST /api/upload_pic  multipart/form-data images=<jpeg>  → id_search
      2. Poll POST /api/search  JSON {id_search, with_progress, status_only, demo} → output.items
    Each item: {score 0-100, url: {value}, base64: "data:image/...;base64,..."}.

    Graceful degradation: any error/timeout → [] with WARNING, never raises.
    Poll uses 1.5s interval, max 20 iterations (~30s total wall time).
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
            # FaceCheck poll can take up to 30s; use a generous timeout
            timeout = httpx.Timeout(
                connect=10.0,
                read=max(30.0, self._settings.search_timeout_seconds),
                write=10.0,
                pool=10.0,
            )
            self._client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)
        return self._client

    async def search(self, image_bytes: bytes) -> list[SearchResult]:
        token = self._settings.facecheck_api_token
        if not token:
            logger.warning("FaceCheck: FACECHECK_API_TOKEN not set — skipping engine")
            return []
        if not image_bytes or len(image_bytes) < 100:
            logger.warning(
                "FaceCheck: image_bytes too small (%s), skipping",
                len(image_bytes) if image_bytes else 0,
            )
            return []
        try:
            id_search = await self._upload(image_bytes, token)
            if not id_search:
                return []
            return await self._poll(id_search, token)
        except httpx.TimeoutException as e:
            logger.warning("FaceCheck: timeout during search: %s", e)
            return []
        except httpx.HTTPStatusError as e:
            logger.warning("FaceCheck: HTTP %s: %s", e.response.status_code, e)
            return []
        except Exception as e:
            logger.warning(
                "FaceCheck: unexpected error: %s: %s",
                e.__class__.__name__,
                e,
                exc_info=True,
            )
            return []

    async def _upload(self, image_bytes: bytes, token: str) -> str | None:
        client = self._get_client()
        try:
            # Swagger: multipart/form-data with 'images' array of binary
            # Python requests example: files={'images': open(..., 'rb')}
            # httpx equivalent: files={"images": ("face.jpg", image_bytes, "image/jpeg")}
            files = {"images": ("face.jpg", image_bytes, "image/jpeg")}
            headers = {"accept": "application/json", "Authorization": token}
            resp = await client.post(
                _FACECHECK_UPLOAD_URL, files=files, headers=headers
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
            # Error handling per BrowserJsonResponse schema: error is string nullable
            error = data.get("error")
            if isinstance(error, str) and error.strip():
                code = data.get("code")
                logger.warning("FaceCheck upload error: %s (code=%s)", error, code)
                return None
            id_search = data.get("id_search")
            if isinstance(id_search, str) and id_search.strip():
                logger.debug("FaceCheck upload id_search=%s", id_search)
                return id_search.strip()
            # Some responses use camelCase? Swagger says id_search snake_case
            # Defensive fallback
            for alt in ("idSearch", "id", "search_id"):
                v = data.get(alt)
                if isinstance(v, str) and v.strip():
                    return v.strip()
            logger.warning(
                "FaceCheck upload: no id_search in response keys=%s", list(data.keys())
            )
            return None
        except httpx.HTTPStatusError:
            raise
        except Exception as e:
            logger.warning(
                "FaceCheck upload failed: %s: %s",
                e.__class__.__name__,
                e,
                exc_info=True,
            )
            return None

    async def _poll(self, id_search: str, token: str) -> list[SearchResult]:
        client = self._get_client()
        max_iterations = 20
        base_sleep = 1.5
        demo = self._settings.facecheck_demo
        cap = self._settings.facecheck_max_results
        if cap <= 0:
            cap = 8

        for iteration in range(max_iterations):
            try:
                payload: dict[str, Any] = {
                    "id_search": id_search,
                    "with_progress": True,
                    "status_only": False,
                    "demo": demo,
                }
                headers = {
                    "accept": "application/json",
                    "Authorization": token,
                    "Content-Type": "application/json",
                }
                resp = await client.post(
                    _FACECHECK_SEARCH_URL, json=payload, headers=headers
                )
                resp.raise_for_status()
                data: dict[str, Any] = resp.json()

                error = data.get("error")
                if isinstance(error, str) and error.strip():
                    code = data.get("code")
                    # FaceCheck returns error when search not found / queue issue — treat as empty
                    logger.warning("FaceCheck poll error: %s (code=%s)", error, code)
                    return []

                # Check for output
                output = data.get("output")
                if isinstance(output, dict):
                    items = output.get("items")
                    if isinstance(items, list) and items:
                        return self._parse_items(items, cap)
                    # output present but empty items → no matches
                    if isinstance(items, list) and len(items) == 0:
                        # Could be finished with zero matches
                        # Check progress == 100 to confirm completion
                        prog = data.get("progress")
                        if isinstance(prog, int) and prog >= 100:
                            logger.info("FaceCheck poll: completed with 0 matches")
                            return []
                        # else keep polling

                # Not ready yet — check progress
                progress = data.get("progress")
                message = data.get("message")
                if iteration == 0 or iteration % 5 == 0:
                    logger.debug(
                        "FaceCheck poll iter=%s progress=%s message=%s demo=%s",
                        iteration,
                        progress,
                        message,
                        demo,
                    )

                # If progress is 100 but no output, treat as done empty
                if isinstance(progress, int) and progress >= 100:
                    # No output → empty
                    logger.info(
                        "FaceCheck poll: progress 100 but no output, returning []"
                    )
                    return []

            except httpx.HTTPStatusError as e:
                # 4xx like 401 (bad token), 429 (rate limit) → degrade gracefully
                status = e.response.status_code
                if status in (401, 403):
                    logger.warning(
                        "FaceCheck poll: auth failed (%s), check FACECHECK_API_TOKEN",
                        status,
                    )
                    return []
                if status == 429:
                    logger.warning("FaceCheck poll: rate limited (429)")
                    return []
                logger.warning("FaceCheck poll HTTP %s: %s", status, e, exc_info=True)
                return []
            except httpx.TimeoutException:
                logger.warning("FaceCheck poll iteration %s timed out", iteration)
                # Continue polling — transient
            except Exception as e:
                logger.warning(
                    "FaceCheck poll iter %s error: %s: %s",
                    iteration,
                    e.__class__.__name__,
                    e,
                    exc_info=True,
                )
                # For last iteration return [], else continue

            # Sleep before next poll — backoff after 10 iterations
            if iteration < max_iterations - 1:
                sleep_s = base_sleep
                if iteration >= 10:
                    # Gentle backoff: 1.5 → 2.0 → 2.5
                    sleep_s = min(2.5, base_sleep + (iteration - 10) * 0.2)
                await asyncio.sleep(sleep_s)

        logger.warning(
            "FaceCheck poll: timeout after %s iterations (~%ss)",
            max_iterations,
            max_iterations * base_sleep,
        )
        return []

    def _parse_items(self, items: list[Any], cap: int) -> list[SearchResult]:
        """Parse FaceCheck items → SearchResult sorted by score descending, capped."""
        now_ms = int(time.time() * 1000)
        parsed: list[tuple[int, SearchResult]] = []

        for raw in items:
            if not isinstance(raw, dict):
                continue
            item = cast(dict[str, Any], raw)
            # score 0-100 per spec
            raw_score = item.get("score")
            score: int | None = None
            if isinstance(raw_score, int):
                score = max(0, min(100, raw_score))
            elif isinstance(raw_score, float):
                score = max(0, min(100, int(round(raw_score))))
            # Some API versions return score as string?
            elif isinstance(raw_score, str) and raw_score.isdigit():
                try:
                    score = max(0, min(100, int(raw_score)))
                except Exception:
                    score = None

            raw_url = item.get("url")
            url = _extract_url(raw_url)
            if not url:
                # Try alternate keys
                for alt_key in ("link", "href", "source_url"):
                    alt = item.get(alt_key)
                    if isinstance(alt, str) and alt.strip():
                        url = alt.strip()
                        break
                    if isinstance(alt, dict):
                        url = _extract_url(alt)
                        if url:
                            break
                if not url:
                    continue

            # base64 thumbnail — Swagger: base64 string, often "data:image/webp;base64,..."
            raw_b64 = item.get("base64")
            b64_str: str | None = None
            if isinstance(raw_b64, str) and raw_b64.strip():
                b64_str = raw_b64.strip()
                # Validate it looks like base64 data URI or raw base64
                # Keep as-is; similarity.py will decode stripping prefix

            # Build SearchResult — FaceCheck has_image=True, no download needed
            platform = detect_platform(url)
            # Title/snippet fallbacks — FaceCheck doesn't provide rich titles; use URL domain as snippet
            # Use guid or index for dedupe debugging (not exposed)
            title = None
            snippet = None
            # Try to extract domain for snippet
            try:
                from urllib.parse import urlparse as _up

                host = _up(url).netloc
                if host:
                    snippet = f"Found on {host}"
            except Exception:
                pass

            sr = SearchResult(
                url=url,
                platform=platform,
                title=title,
                snippet=snippet,
                image_url=None,
                fetched_at=now_ms,
                source_strategy="facecheck",
                engine="facecheck",
                base64=b64_str,
                facecheck_score=score,
                has_image=b64_str is not None,
                multi_source_count=0,
                similarity=None,
                final_score=None,
            )
            # Keep score for sorting; None scores sort last
            sort_key = score if score is not None else -1
            parsed.append((sort_key, sr))

        # Sort descending by score, cap
        parsed.sort(key=lambda x: x[0], reverse=True)
        capped = parsed[:cap] if cap > 0 else parsed
        return [sr for _, sr in capped]
