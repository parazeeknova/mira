from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any
from urllib.parse import urlparse

import httpx

from config.config import Settings
from search.search import SearchResult

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[dict[str, Any]], Awaitable[None]]

# Host suffix → short label for the socials row in the posts card.
_SOCIAL_HOSTS: dict[str, str] = {
    "linkedin.com": "linkedin",
    "github.com": "github",
    "x.com": "x",
    "twitter.com": "x",
    "instagram.com": "instagram",
    "facebook.com": "facebook",
    "youtube.com": "youtube",
    "medium.com": "medium",
    "dev.to": "dev",
    "stackoverflow.com": "stack",
    "dribbble.com": "dribbble",
    "behance.net": "behance",
}

_SNIPPET_LIMIT = 400
_MAX_SOCIALS = 6
_SCRAPE_CONCURRENCY = 3

# Leading boilerplate sentences scraped from site chrome (cookie walls,
# signed-in notices). Matched case-insensitively, dropped from the front.
_BOILERPLATE_PREFIXES = (
    "skip to content",
    "you signed in with",
    "you signed out",
    "you switched accounts",
    "dismiss",
    "sign in to continue",
    "log in to continue",
)

# Link-host prefixes that are assets/docs, never a person's presence.
_ASSET_HOST_PREFIXES = (
    "avatar",
    "avatars",
    "cdn",
    "static",
    "assets",
    "media",
    "docs",
    "help",
    "support",
)


def _host(url: str) -> str:
    try:
        return urlparse(url.lower()).netloc.split(":")[0]
    except Exception:
        return ""


def classify_link(url: str) -> str | None:
    """Short label for recognized social hosts, else None."""
    host = _host(url)
    if not host:
        return None
    for needle, label in _SOCIAL_HOSTS.items():
        if host == needle or host.endswith(f".{needle}"):
            return label
    return None


def clean_markdown_snippet(markdown: str, limit: int = _SNIPPET_LIMIT) -> str:
    """Collapse page markdown into a short plain-text bio snippet."""
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", markdown)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[#>_*`~|-]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    # Drop site-chrome boilerplate from the front ("Skip to content…").
    lowered = text.lower()
    while True:
        for prefix in _BOILERPLATE_PREFIXES:
            if lowered.startswith(prefix):
                dot = text.find(". ")
                if dot == -1:
                    return ""
                text = text[dot + 2 :].lstrip()
                lowered = text.lower()
                break
        else:
            break
    if len(text) > limit:
        cut = text.rfind(" ", 0, limit)
        end = cut if cut > limit // 2 else limit
        text = text[:end].rstrip() + "…"
    return text


def _is_asset_host(host: str) -> bool:
    first = host.split(".", maxsplit=1)[0]
    return first in _ASSET_HOST_PREFIXES


def extract_social_links(
    page_url: str, links: list[str], limit: int = _MAX_SOCIALS
) -> list[tuple[str, str]]:
    """Recognized social links + one portfolio site from a scraped page."""
    page_host = _host(page_url)
    found: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    portfolio_added = False
    for raw in links:
        if not isinstance(raw, str) or not raw.startswith(("http://", "https://")):
            continue
        host = _host(raw)
        if not host or host == page_host or host.endswith(f".{page_host}"):
            continue
        if _is_asset_host(host):
            continue
        label = classify_link(raw)
        if label is None:
            if portfolio_added:
                continue
            label = "site"
            portfolio_added = True
        key = (label, raw)
        if key in seen:
            continue
        seen.add(key)
        found.append(key)
        if len(found) >= limit:
            break
    return found


class FirecrawlEnricher:
    """Scrape top match pages for bio text + social/portfolio links.

    Best-effort by design: every failure (no URL configured, scrape error,
    LinkedIn anti-bot wall) degrades to the original SearchResult untouched.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: httpx.AsyncClient | None = None

    @property
    def enabled(self) -> bool:
        return bool(self._settings.firecrawl_url)

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self._settings.firecrawl_timeout_seconds),
                follow_redirects=True,
            )
        return self._client

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._settings.firecrawl_api_key:
            headers["Authorization"] = f"Bearer {self._settings.firecrawl_api_key}"
        return headers

    async def enrich(
        self,
        results: list[SearchResult],
        on_progress: ProgressCallback | None = None,
        limit: int | None = None,
    ) -> list[SearchResult]:
        if not self.enabled or not results:
            return list(results)
        max_targets = (
            limit if limit is not None else self._settings.firecrawl_max_targets
        )
        targets = [r for r in results if r.url.startswith("http")][:max_targets]
        if not targets:
            return list(results)

        async def emit(event: dict[str, Any]) -> None:
            if on_progress is not None:
                await on_progress(event)

        await emit({"stage": "enrich", "state": "start", "count": len(targets)})
        semaphore = asyncio.Semaphore(_SCRAPE_CONCURRENCY)
        enriched = await asyncio.gather(
            *(self._enrich_one(result, semaphore) for result in targets)
        )
        enriched_count = sum(
            1 for r in enriched if r.enriched_snippet or r.social_links
        )
        await emit(
            {
                "stage": "enrich",
                "state": "done",
                "count": len(targets),
                "enriched": enriched_count,
            }
        )
        by_url = {r.url: r for r in enriched}
        return [by_url.get(r.url, r) for r in results]

    async def _enrich_one(
        self, result: SearchResult, semaphore: asyncio.Semaphore
    ) -> SearchResult:
        async with semaphore:
            try:
                data = await self._scrape(result.url)
            except Exception as exc:
                logger.info("[enrich] ✗ %s: scrape failed (%s)", result.url, exc)
                return result
        markdown = data.get("markdown") if isinstance(data, dict) else None
        raw_links = data.get("links") if isinstance(data, dict) else None
        snippet = (
            clean_markdown_snippet(markdown)
            if isinstance(markdown, str) and markdown.strip()
            else ""
        )
        links = raw_links if isinstance(raw_links, list) else []
        socials = extract_social_links(result.url, links)
        if not snippet and not socials:
            logger.info(
                "[enrich] ✗ %s: page scraped but empty (login wall / anti-bot?)",
                result.url,
            )
            return result
        logger.info(
            "[enrich] ✓ %s: snippet=%dc socials=%d",
            result.url,
            len(snippet),
            len(socials),
        )
        return replace(
            result,
            enriched_snippet=snippet or None,
            social_links=tuple(socials),
        )

    async def _scrape(self, url: str) -> dict[str, Any]:
        base = (self._settings.firecrawl_url or "").rstrip("/")
        client = self._get_client()
        resp = await client.post(
            f"{base}/v1/scrape",
            json={
                "url": url,
                "formats": ["markdown", "links"],
                "onlyMainContent": True,
            },
            headers=self._headers(),
        )
        resp.raise_for_status()
        payload: Any = resp.json()
        if not isinstance(payload, dict) or not payload.get("success"):
            raise RuntimeError(f"Firecrawl scrape unsuccessful for {url}")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise RuntimeError(f"Firecrawl scrape empty for {url}")
        return data
