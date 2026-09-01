from __future__ import annotations

import asyncio
import time
from typing import Any, cast
from urllib.parse import urlparse

from google.cloud import vision

from .config import Settings
from .search import SearchResult, detect_platform


def _clean(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


class VisionWebSearch:
    """Primary search: Google Cloud Vision Web Detection.

    Accepts raw image bytes (no public hosting required) and returns
    pages on the web that reference the image.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: Any | None = None

    # proto client has no stub-friendly type
    def _get_client(self) -> Any:  # noqa: ANN401
        if self._client is None:
            self._client = vision.ImageAnnotatorClient()
        return self._client

    async def aclose(self) -> None:
        client = self._client
        self._client = None
        if client is not None:
            transport: Any = getattr(client, "transport", None)
            if transport is not None and hasattr(transport, "close"):
                await asyncio.to_thread(transport.close)

    def _detect_sync(self, image_bytes: bytes) -> Any:  # noqa: ANN401
        client = self._get_client()
        image = vision.Image(content=image_bytes)
        response = client.web_detection(image=image)
        if response.error.message:
            raise RuntimeError(f"Google Vision error: {response.error.message}")
        return response.web_detection

    async def search(self, image_bytes: bytes) -> list[SearchResult]:
        if not self._settings.google_vision_enabled:
            return []
        try:
            annotation: Any = await asyncio.to_thread(self._detect_sync, image_bytes)
        except Exception:
            return []
        return self._collect(annotation)

    def _collect(self, annotation: Any) -> list[SearchResult]:  # noqa: ANN401, PLR0912
        now_ms = int(time.time() * 1000)
        results: list[SearchResult] = []
        seen: set[str] = set()
        title_fallback: str | None = None
        snippet_fallback: str | None = None

        raw_entities: object = getattr(annotation, "web_entities", None)
        entities: list[object] = (
            list(cast("Any", raw_entities)) if raw_entities is not None else []
        )
        for entity in entities:
            description = _clean(getattr(entity, "description", None))
            if description and title_fallback is None:
                title_fallback = description
            if description and snippet_fallback is None:
                snippet_fallback = description

        raw_labels: object = getattr(annotation, "best_guess_labels", None)
        labels: list[object] = (
            list(cast("Any", raw_labels)) if raw_labels is not None else []
        )
        for label in labels:
            label_text = _clean(getattr(label, "label", None))
            if label_text and snippet_fallback is None:
                snippet_fallback = label_text

        raw_pages: object = getattr(annotation, "pages_with_matching_images", None)
        pages: list[object] = (
            list(cast("Any", raw_pages)) if raw_pages is not None else []
        )
        for page in pages:
            page_url = _clean(getattr(page, "url", None))
            if not page_url or page_url in seen:
                continue
            seen.add(page_url)
            results.append(
                SearchResult(
                    url=page_url,
                    platform=detect_platform(page_url),
                    title=_clean(getattr(page, "page_title", None)) or title_fallback,
                    snippet=snippet_fallback,
                    image_url=None,
                    fetched_at=now_ms,
                    source_strategy="google-vision",
                    engine="google-vision",
                )
            )

        for group_name in ("full_matching_images", "partial_matching_images"):
            raw_group: object = getattr(annotation, group_name, None)
            group: list[object] = (
                list(cast("Any", raw_group)) if raw_group is not None else []
            )
            for image in group:
                image_page_url = _clean(getattr(image, "url", None))
                if not image_page_url or image_page_url in seen:
                    continue
                seen.add(image_page_url)
                page_url = _extract_page_url(image_page_url)
                if page_url and page_url in seen:
                    continue
                if page_url:
                    seen.add(page_url)
                results.append(
                    SearchResult(
                        url=page_url or image_page_url,
                        platform=detect_platform(page_url or image_page_url),
                        title=title_fallback,
                        snippet=snippet_fallback,
                        image_url=image_page_url,
                        fetched_at=now_ms,
                        source_strategy="google-vision",
                        engine="google-vision",
                    )
                )

        cap = self._settings.google_vision_max_results
        if cap > 0:
            return results[:cap]
        return results


def _extract_page_url(image_url: str) -> str | None:
    """Best-effort page URL from an image CDN URL."""
    try:
        host = urlparse(image_url).netloc.lower()
        known = (
            "twimg.com",
            "instagram.com",
            "cdninstagram.com",
            "fbcdn.net",
            "linkedin.com",
            "licdn.com",
            "redd.it",
            "redditmedia.com",
        )
        for needle in known:
            if needle in host:
                if needle == "twimg.com":
                    return "https://twitter.com"
                if needle in ("instagram.com", "cdninstagram.com"):
                    return "https://www.instagram.com"
                if needle == "fbcdn.net":
                    return "https://www.facebook.com"
                if needle in ("linkedin.com", "licdn.com"):
                    return "https://www.linkedin.com"
                if needle in ("redd.it", "redditmedia.com"):
                    return "https://www.reddit.com"
    except Exception:
        pass
    return None
