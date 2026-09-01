from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import urlparse

import httpx

from .config import Settings

_PLATFORM_SCORES: dict[str, int] = {
    "twitter": 5,
    "linkedin": 4,
    "instagram": 3,
    "reddit": 2,
    "web": 1,
    "none": 0,
}

_PLATFORM_HOSTS: dict[str, tuple[str, ...]] = {
    "twitter": ("twitter.com", "x.com", "t.co"),
    "linkedin": ("linkedin.com",),
    "instagram": ("instagram.com",),
    "reddit": ("reddit.com",),
}


def detect_platform(url: str) -> str:
    if not url:
        return "none"
    try:
        host = urlparse(url.lower()).netloc.split(":")[0]
        for platform, hosts in _PLATFORM_HOSTS.items():
            for needle in hosts:
                if host == needle or host.endswith(f".{needle}"):
                    return platform
    except Exception:
        pass
    return "web"


_detect_platform = detect_platform


@dataclass(frozen=True, slots=True)
class SearchResult:
    url: str
    platform: str
    title: str | None
    snippet: str | None
    image_url: str | None
    fetched_at: int
    source_strategy: str
    engine: str

    def to_protocol_dict(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "platform": self.platform,
            "title": self.title,
            "snippet": self.snippet,
            "imageUrl": self.image_url,
            "fetchedAt": self.fetched_at,
            "sourceStrategy": self.source_strategy,
            "engine": self.engine,
        }


class ReverseImageSearch:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: httpx.AsyncClient | None = None
        # Lazy import avoids circular dependency (web_vision imports SearchResult)
        from .web_vision import VisionWebSearch  # noqa: PLC0415

        self._vision = VisionWebSearch(settings)

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        await self._vision.aclose()

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self._settings.search_timeout_seconds),
                follow_redirects=True,
            )
        return self._client

    async def search(
        self, image_bytes: bytes, full_image_bytes: bytes | None = None
    ) -> list[SearchResult]:
        # Vision (primary) gets the FULL original image (tight crop → 0 matches);
        # SerpAPI Google/Yandex get the face crop. All three fire in parallel.
        vision_input = full_image_bytes or image_bytes
        vision_task = asyncio.create_task(self._vision.search(vision_input))

        serpapi_key = self._settings.serpapi_key
        if serpapi_key:
            try:
                hosted_url = await self._host_image(image_bytes)
            except Exception:
                hosted_url = None
            if hosted_url:
                google_task = asyncio.create_task(
                    self._serpapi_request_with_url("google_lens", hosted_url)
                )
                yandex_task = asyncio.create_task(
                    self._serpapi_request_with_url("yandex_images", hosted_url)
                )
            else:
                google_task = asyncio.create_task(self._serpapi_google(image_bytes))
                yandex_task = asyncio.create_task(self._serpapi_yandex(image_bytes))
        else:
            google_task = asyncio.create_task(asyncio.sleep(0, result=[]))  # type: ignore[arg-type]
            yandex_task = asyncio.create_task(asyncio.sleep(0, result=[]))  # type: ignore[arg-type]

        vision_res, google_res, yandex_res = await asyncio.gather(
            vision_task, google_task, yandex_task, return_exceptions=True
        )
        return self._merge_three_way(vision_res, google_res, yandex_res)

    async def _serpapi_search(self, image_bytes: bytes) -> list[SearchResult]:
        if not self._settings.serpapi_key:
            return []
        # Host image once and reuse URL for both engines in parallel
        # (avoids double upload, reduces latency)
        try:
            hosted_url = await self._host_image(image_bytes)
        except Exception:
            # Fallback: per-engine upload (keeps tests mocking _upload_to_serpapi)
            google_task = asyncio.create_task(self._serpapi_google(image_bytes))
            yandex_task = asyncio.create_task(self._serpapi_yandex(image_bytes))
            google_res, yandex_res = await asyncio.gather(
                google_task, yandex_task, return_exceptions=True
            )
            return self._merge_and_rank(google_res, yandex_res)

        google_task = asyncio.create_task(
            self._serpapi_request_with_url("google_lens", hosted_url)
        )
        # Yandex SerpAPI engine is yandex_images (alias yandex also works)
        yandex_task = asyncio.create_task(
            self._serpapi_request_with_url("yandex_images", hosted_url)
        )
        google_res, yandex_res = await asyncio.gather(
            google_task, yandex_task, return_exceptions=True
        )
        # Balanced merge for SerpAPI: reserve at least 2 slots for Yandex
        # when both engines succeed, so Yandex is never crowded out by
        # Google's high-platform results.
        return self._merge_serpapi(google_res, yandex_res)

    async def _serpapi_google(self, image_bytes: bytes) -> list[SearchResult]:
        return await self._serpapi_request("google_lens", image_bytes)

    async def _serpapi_yandex(self, image_bytes: bytes) -> list[SearchResult]:
        # Keep alias for tests; internally uses yandex_images engine
        return await self._serpapi_request("yandex_images", image_bytes)

    async def _serpapi_request(
        self, engine: str, image_bytes: bytes
    ) -> list[SearchResult]:
        key = self._settings.serpapi_key
        if not key:
            return []
        image_url = await self._upload_to_serpapi(image_bytes)
        return await self._serpapi_request_with_url(engine, image_url)

    async def _serpapi_request_with_url(
        self, engine: str, image_url: str
    ) -> list[SearchResult]:
        key = self._settings.serpapi_key
        if not key:
            return []
        client = self._get_client()
        params: dict[str, str] = {
            "engine": engine,
            "url": image_url,
            "api_key": key,
        }
        resp = await client.get("https://serpapi.com/search.json", params=params)
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        if "error" in data:
            # SerpAPI returns 200 with error field for invalid key / quota
            raise RuntimeError(f"SerpAPI error ({engine}): {data['error']}")
        if engine == "google_lens":
            return self._parse_google_results(data)
        return self._parse_yandex_results(data)

    async def _host_image(self, image_bytes: bytes) -> str:
        client = self._get_client()
        # Try catbox.moe first (fast, 200 MB limit, no auth)
        try:
            resp = await client.post(
                "https://catbox.moe/user/api.php",
                files={"fileToUpload": ("face.jpg", image_bytes, "image/jpeg")},
                data={"reqtype": "fileupload"},
            )
            resp.raise_for_status()
            url = resp.text.strip()
            if url.startswith("https://") and "catbox" in url:
                return url
        except Exception:
            pass
        # Fallback: tmpfiles.org (500 MB, returns JSON)
        try:
            resp = await client.post(
                "https://tmpfiles.org/api/v1/upload",
                files={"file": ("face.jpg", image_bytes, "image/jpeg")},
            )
            resp.raise_for_status()
            payload: dict[str, Any] = resp.json()
            raw_data = payload.get("data")
            if isinstance(raw_data, dict):
                data_dict = cast(dict[str, Any], raw_data)
                url2 = data_dict.get("url")
                if isinstance(url2, str) and url2.startswith("https://"):
                    return url2
        except Exception:
            pass
        raise RuntimeError("Failed to host image for SerpAPI search")

    async def _upload_to_serpapi(self, image_bytes: bytes) -> str:
        # Kept for test mocks and backward compat — delegates to hosting
        return await self._host_image(image_bytes)

    def _parse_google_results(self, data: dict[str, Any]) -> list[SearchResult]:
        results: list[SearchResult] = []
        now_ms = int(time.time() * 1000)
        seen_urls: set[str] = set()

        def add_entry(
            raw_url: object,
            raw_title: object,
            raw_snippet: object,
            raw_image: object,
        ) -> None:
            if not isinstance(raw_url, str) or not raw_url or raw_url in seen_urls:
                return
            seen_urls.add(raw_url)
            title = raw_title if isinstance(raw_title, str) else None
            snippet = raw_snippet if isinstance(raw_snippet, str) else None
            image_url = raw_image if isinstance(raw_image, str) else None
            results.append(
                SearchResult(
                    url=raw_url,
                    platform=_detect_platform(raw_url),
                    title=title,
                    snippet=snippet,
                    image_url=image_url,
                    fetched_at=now_ms,
                    source_strategy="serpapi",
                    engine="google_lens",
                )
            )

        organic = data.get("organic_results")
        if isinstance(organic, list):
            for raw in cast(list[Any], organic):
                if not isinstance(raw, dict):
                    continue
                item = cast(dict[str, Any], raw)
                add_entry(
                    item.get("link") or item.get("url"),
                    item.get("title"),
                    item.get("snippet") or item.get("description"),
                    item.get("thumbnail") or item.get("image"),
                )

        visual = data.get("visual_matches")
        if isinstance(visual, list):
            for raw in cast(list[Any], visual):
                if not isinstance(raw, dict):
                    continue
                item = cast(dict[str, Any], raw)
                add_entry(
                    item.get("link") or item.get("source") or item.get("url"),
                    item.get("title"),
                    item.get("snippet") or item.get("description"),
                    item.get("thumbnail") or item.get("image"),
                )

        kg = data.get("knowledge_graph")
        if isinstance(kg, dict):
            kg_dict = cast(dict[str, Any], kg)
            source = kg_dict.get("source")
            if isinstance(source, dict):
                src = cast(dict[str, Any], source)
                add_entry(
                    src.get("link") or src.get("url"),
                    kg_dict.get("title") or src.get("name"),
                    kg_dict.get("description"),
                    kg_dict.get("image")
                    if isinstance(kg_dict.get("image"), str)
                    else None,
                )

        return results

    def _parse_yandex_results(self, data: dict[str, Any]) -> list[SearchResult]:  # noqa: PLR0912
        results: list[SearchResult] = []
        now_ms = int(time.time() * 1000)
        seen_urls: set[str] = set()

        def add_entry(
            raw_url: object,
            raw_title: object,
            raw_snippet: object,
            raw_image: object,
        ) -> None:
            if not isinstance(raw_url, str) or not raw_url or raw_url in seen_urls:
                return
            seen_urls.add(raw_url)
            title = raw_title if isinstance(raw_title, str) else None
            snippet = raw_snippet if isinstance(raw_snippet, str) else None
            image_url = raw_image if isinstance(raw_image, str) else None
            results.append(
                SearchResult(
                    url=raw_url,
                    platform=_detect_platform(raw_url),
                    title=title,
                    snippet=snippet,
                    image_url=image_url,
                    fetched_at=now_ms,
                    source_strategy="serpapi",
                    engine="yandex",
                )
            )

        organic = data.get("organic_results")
        if isinstance(organic, list):
            for raw in cast(list[Any], organic):
                if not isinstance(raw, dict):
                    continue
                item = cast(dict[str, Any], raw)
                add_entry(
                    item.get("link") or item.get("url"),
                    item.get("title"),
                    item.get("snippet") or item.get("description"),
                    item.get("thumbnail") or item.get("preview") or item.get("image"),
                )

        images = data.get("images_results")
        if isinstance(images, list):
            for raw in cast(list[Any], images):
                if not isinstance(raw, dict):
                    continue
                item = cast(dict[str, Any], raw)
                add_entry(
                    item.get("link") or item.get("source") or item.get("url"),
                    item.get("title"),
                    item.get("snippet") or item.get("description"),
                    item.get("thumbnail") or item.get("preview") or item.get("image"),
                )

        inline = data.get("inline_images")
        if isinstance(inline, list):
            for raw in cast(list[Any], inline):
                if not isinstance(raw, dict):
                    continue
                item = cast(dict[str, Any], raw)
                add_entry(
                    item.get("link") or item.get("source") or item.get("url"),
                    item.get("title"),
                    item.get("snippet"),
                    item.get("thumbnail") or item.get("image"),
                )

        # Yandex Images alternate keys (per SerpAPI docs for engine=yandex_images)
        for alt_key in ("image_results", "related_images", "similar_images"):
            alt = data.get(alt_key)
            if isinstance(alt, list):
                for raw in cast(list[Any], alt):
                    if not isinstance(raw, dict):
                        continue
                    item = cast(dict[str, Any], raw)
                    add_entry(
                        item.get("link") or item.get("url") or item.get("source"),
                        item.get("title"),
                        item.get("snippet") or item.get("description"),
                        item.get("thumbnail")
                        or item.get("image")
                        or item.get("preview"),
                    )

        return results

    def _merge_and_rank(  # noqa: PLR0912
        self,
        primary: list[SearchResult] | BaseException,
        secondary: list[SearchResult] | BaseException,
    ) -> list[SearchResult]:
        # Primary-first with cap split: guarantees both engines visible
        # when both succeed (primary gets ceil(cap/2) slots).
        def ranked(items: list[SearchResult]) -> list[SearchResult]:
            return sorted(
                items,
                key=lambda item: _PLATFORM_SCORES.get(item.platform, 0),
                reverse=True,
            )

        primary_list = [] if isinstance(primary, BaseException) else list(primary)
        secondary_list = [] if isinstance(secondary, BaseException) else list(secondary)
        primary_ranked = ranked(primary_list)
        secondary_ranked = ranked(secondary_list)

        cap = self._settings.search_max_results
        if cap <= 0:
            cap = len(primary_ranked) + len(secondary_ranked)

        seen: set[str] = set()
        merged: list[SearchResult] = []

        # Both engines have results: split cap to ensure secondary supplements
        if primary_ranked and secondary_ranked and cap > 1:
            primary_cap = (cap + 1) // 2
            for item in primary_ranked:
                if len(merged) >= primary_cap:
                    break
                if item.url in seen:
                    continue
                seen.add(item.url)
                merged.append(item)
            for item in secondary_ranked:
                if len(merged) >= cap:
                    break
                if item.url in seen:
                    continue
                seen.add(item.url)
                merged.append(item)
            # Fill any remaining slots (if dedupe removed some)
            if len(merged) < cap:
                for item in (*primary_ranked, *secondary_ranked):
                    if len(merged) >= cap:
                        break
                    if item.url in seen:
                        continue
                    seen.add(item.url)
                    merged.append(item)
            return merged[:cap]

        # One side empty: primary-first all
        for item in (*primary_ranked, *secondary_ranked):
            if item.url in seen:
                continue
            seen.add(item.url)
            merged.append(item)
        return merged[:cap]

    def _merge_three_way(  # noqa: PLR0912
        self,
        vision: list[SearchResult] | BaseException,
        google: list[SearchResult] | BaseException,
        yandex: list[SearchResult] | BaseException,
    ) -> list[SearchResult]:
        # Guarantees all three engines visible when they succeed:
        # Vision ceil(10/2)=5, Google floor(5/2)+1=3, Yandex 2 → total 10.
        def ranked(items: list[SearchResult]) -> list[SearchResult]:
            return sorted(
                items,
                key=lambda item: _PLATFORM_SCORES.get(item.platform, 0),
                reverse=True,
            )

        v_list = [] if isinstance(vision, BaseException) else list(vision)
        g_list = [] if isinstance(google, BaseException) else list(google)
        y_list = [] if isinstance(yandex, BaseException) else list(yandex)

        cap = self._settings.search_max_results
        if cap <= 0:
            cap = len(v_list) + len(g_list) + len(y_list)

        v_ranked = ranked(v_list)
        g_ranked = ranked(g_list)
        y_ranked = ranked(y_list)

        # Vision 5, Google 3, Yandex 2 for cap=10
        # Vision ceil(cap/2), remainder split Google/Yandex
        if cap > 2 and v_ranked and (g_ranked or y_ranked):  # noqa: PLR2004
            v_cap = (cap + 1) // 2  # 5 for cap 10
            rem = cap - min(len(v_ranked), v_cap)
            g_cap = (rem + 1) // 2  # 3 for rem 5
            y_cap = rem - g_cap  # 2
            seen: set[str] = set()
            merged: list[SearchResult] = []
            for item in v_ranked[:v_cap]:
                if item.url not in seen:
                    seen.add(item.url)
                    merged.append(item)
            for item in g_ranked[:g_cap]:
                if len(merged) >= v_cap + g_cap:
                    break
                if item.url in seen:
                    continue
                seen.add(item.url)
                merged.append(item)
            for item in y_ranked[:y_cap]:
                if len(merged) >= cap:
                    break
                if item.url in seen:
                    continue
                seen.add(item.url)
                merged.append(item)
            # Fill remainder from any engine if some had fewer than cap
            if len(merged) < cap:
                for item in (*v_ranked[v_cap:], *g_ranked[g_cap:], *y_ranked[y_cap:]):
                    if len(merged) >= cap:
                        break
                    if item.url in seen:
                        continue
                    seen.add(item.url)
                    merged.append(item)
            return merged[:cap]

        # Fallback: global platform sort
        combined = v_list + g_list + y_list
        seen2: set[str] = set()
        deduped: list[SearchResult] = []
        for item in sorted(
            combined, key=lambda r: _PLATFORM_SCORES.get(r.platform, 0), reverse=True
        ):
            if item.url in seen2:
                continue
            seen2.add(item.url)
            deduped.append(item)
        return deduped[:cap]

    def _merge_serpapi(  # noqa: PLR0912
        self,
        google: list[SearchResult] | BaseException,
        yandex: list[SearchResult] | BaseException,
    ) -> list[SearchResult]:
        # SerpAPI internal merge: balanced to keep Yandex visible.
        # Google and Yandex each get at least 2 slots when both succeed.
        def ranked(items: list[SearchResult]) -> list[SearchResult]:
            return sorted(
                items,
                key=lambda item: _PLATFORM_SCORES.get(item.platform, 0),
                reverse=True,
            )

        google_list = [] if isinstance(google, BaseException) else list(google)
        yandex_list = [] if isinstance(yandex, BaseException) else list(yandex)
        google_ranked = ranked(google_list)
        yandex_ranked = ranked(yandex_list)

        cap = self._settings.search_max_results
        if cap <= 0:
            cap = len(google_ranked) + len(yandex_ranked)

        # Reuse primary-first split but with google as primary
        if google_ranked and yandex_ranked and cap > 1:
            # Reserve at least 2 for Yandex, rest for Google
            yandex_min = min(2, len(yandex_ranked), cap - 1)
            google_cap = cap - yandex_min
            seen: set[str] = set()
            merged: list[SearchResult] = []
            for item in google_ranked[:google_cap]:
                if item.url in seen:
                    continue
                seen.add(item.url)
                merged.append(item)
            for item in yandex_ranked:
                if len(merged) >= cap:
                    break
                if item.url in seen:
                    continue
                seen.add(item.url)
                merged.append(item)
            # Fill remainder with Google if Yandex had fewer than yandex_min
            if len(merged) < cap:
                for item in google_ranked[google_cap:]:
                    if len(merged) >= cap:
                        break
                    if item.url in seen:
                        continue
                    seen.add(item.url)
                    merged.append(item)
            return merged[:cap]

        # Fallback: global platform sort
        combined = google_list + yandex_list
        seen2: set[str] = set()
        deduped: list[SearchResult] = []
        for item in sorted(
            combined, key=lambda r: _PLATFORM_SCORES.get(r.platform, 0), reverse=True
        ):
            if item.url in seen2:
                continue
            seen2.add(item.url)
            deduped.append(item)
        return deduped[:cap]
