from __future__ import annotations

from typing import Any

import pytest

from config.config import Settings
from enrich.firecrawl import (
    FirecrawlEnricher,
    classify_link,
    clean_markdown_snippet,
    extract_social_links,
)
from search.search import SearchResult


def _make_settings(firecrawl_url: str | None = "http://127.0.0.1:48002") -> Settings:
    return Settings(
        host="0.0.0.0",
        port=8765,
        model_pack="buffalo_l",
        model_root=".insightface",
        detector_width=320,
        detector_height=320,
        match_threshold=0.55,
        match_top_k=5,
        match_margin_threshold=0.04,
        min_detection_confidence=0.5,
        reload_interval_seconds=2.0,
        tracking_enabled=False,
        tracker_activation_threshold=0.35,
        tracker_matching_threshold=0.8,
        tracker_lost_buffer=10,
        tracker_minimum_consecutive_frames=1,
        tracker_frame_rate=6,
        tracker_box_smoothing_alpha=0.58,
        tracker_identity_switch_hits=2,
        tracker_stable_confidence_floor=0.48,
        tracker_track_hold_ms=4000,
        serpapi_key=None,
        search_timeout_seconds=5.0,
        search_max_results=5,
        pipeline_enabled=True,
        face_crop_padding_x=0.18,
        face_crop_padding_y=0.22,
        google_vision_enabled=True,
        google_vision_max_results=10,
        firecrawl_url=firecrawl_url,
    )


def _result(url: str) -> SearchResult:
    return SearchResult(
        url=url,
        platform="linkedin",
        title="Aditya Nikam",
        snippet=None,
        image_url=None,
        fetched_at=123,
        source_strategy="serpapi",
        engine="google_lens",
    )


def test_clean_markdown_snippet_strips_markup() -> None:
    markdown = "# Aditya Nikam\n\nSenior [engineer](https://x.com) at **Foo**.\n\n![pic](https://img.com/a.jpg)"
    snippet = clean_markdown_snippet(markdown)
    assert "Aditya Nikam" in snippet
    assert "Senior engineer at Foo" in snippet
    assert "https://" not in snippet
    assert "**" not in snippet


def test_clean_markdown_snippet_truncates_at_word() -> None:
    snippet = clean_markdown_snippet("word " * 200, limit=100)
    assert len(snippet) <= 102
    assert snippet.endswith("…")


def test_clean_markdown_snippet_drops_chrome_boilerplate() -> None:
    markdown = "Skip to content You signed in with another tab. Linus builds Linux."
    assert clean_markdown_snippet(markdown) == "Linus builds Linux."


def test_classify_link_known_hosts() -> None:
    assert classify_link("https://github.com/aditya") == "github"
    assert classify_link("https://www.linkedin.com/in/aditya") == "linkedin"
    assert classify_link("https://x.com/aditya") == "x"
    assert classify_link("https://aditya.dev/blog") is None


def test_extract_social_links_skips_same_host_and_dupes() -> None:
    links = [
        "https://linkedin.com/in/aditya/posts/123",
        "https://linkedin.com/in/aditya",
        "https://github.com/aditya",
        "https://github.com/aditya",  # dupe
        "https://aditya.dev",  # portfolio
        "https://aditya.dev/blog",  # second site link ignored
        "not-a-url",
    ]
    socials = extract_social_links("https://linkedin.com/in/aditya", links)
    labels = [label for label, _ in socials]
    assert "linkedin" not in labels  # same page host skipped
    assert labels.count("github") == 1
    assert "site" in labels
    assert len(socials) == 2


def test_extract_social_links_skips_subdomains_and_assets() -> None:
    links = [
        "https://docs.github.com/articles/blocking",
        "https://avatars.githubusercontent.com/u/1024025",
        "https://torvalds.linux-foundation.org",
    ]
    socials = extract_social_links("https://github.com/torvalds", links)
    urls = [url for _, url in socials]
    assert not any("docs.github.com" in u for u in urls)
    assert not any("avatars" in u for u in urls)
    assert urls == ["https://torvalds.linux-foundation.org"]


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.calls = 0

    @property
    def is_closed(self) -> bool:
        return False

    async def post(self, *args: object, **kwargs: object) -> _FakeResponse:
        self.calls += 1
        return _FakeResponse(self._payload)

    async def aclose(self) -> None:
        pass


def _bind_fake(enricher: FirecrawlEnricher, payload: dict[str, Any]) -> _FakeClient:
    fake = _FakeClient(payload)
    enricher._client = fake  # type: ignore[assignment]
    return fake


@pytest.mark.asyncio
async def test_enrich_disabled_without_url_returns_originals() -> None:
    enricher = FirecrawlEnricher(_make_settings(firecrawl_url=None))
    assert enricher.enabled is False
    results = [_result("https://linkedin.com/in/a")]
    assert await enricher.enrich(results) == results


@pytest.mark.asyncio
async def test_enrich_attaches_snippet_and_socials() -> None:
    enricher = FirecrawlEnricher(_make_settings())
    _bind_fake(
        enricher,
        {
            "success": True,
            "data": {
                "markdown": "# Aditya Nikam\n\nBuilds infra at Foo Corp.",
                "links": [
                    "https://github.com/aditya",
                    "https://aditya.dev",
                ],
            },
        },
    )
    events: list[dict[str, object]] = []

    async def collect(event: dict[str, object]) -> None:
        events.append(event)

    (enriched,) = await enricher.enrich([_result("https://linkedin.com/in/a")], collect)
    assert enriched.enriched_snippet is not None
    assert "Builds infra" in enriched.enriched_snippet
    assert ("github", "https://github.com/aditya") in enriched.social_links
    assert ("site", "https://aditya.dev") in enriched.social_links
    # original fields untouched
    assert enriched.title == "Aditya Nikam"
    assert enriched.url == "https://linkedin.com/in/a"
    assert ("enrich", "start") in [(e["stage"], e["state"]) for e in events]
    assert ("enrich", "done") in [(e["stage"], e["state"]) for e in events]


@pytest.mark.asyncio
async def test_enrich_skips_non_http_and_failed_scrapes() -> None:
    enricher = FirecrawlEnricher(_make_settings())
    fake = _bind_fake(enricher, {"success": False, "data": {}})
    results = [_result("face-embedding://abc"), _result("https://example.com/b")]
    out = await enricher.enrich(results)
    assert fake.calls == 1  # embedding URL never scraped
    assert out[0].enriched_snippet is None
    assert out[1].enriched_snippet is None
    assert out[1].social_links == ()


@pytest.mark.asyncio
async def test_enrich_respects_limit() -> None:
    enricher = FirecrawlEnricher(_make_settings())
    fake = _bind_fake(enricher, {"success": True, "data": {"markdown": "bio"}})
    results = [_result(f"https://example.com/{i}") for i in range(5)]
    await enricher.enrich(results, limit=2)
    assert fake.calls == 2
