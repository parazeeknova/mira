from __future__ import annotations

import time

import pytest

from config.config import Settings
from search.search import ReverseImageSearch, SearchResult


def _make_settings(
    max_results: int = 5, serpapi_key: str | None = "test-key"
) -> Settings:
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
        serpapi_key=serpapi_key,
        search_timeout_seconds=5.0,
        search_max_results=max_results,
        pipeline_enabled=True,
        face_crop_padding_x=0.18,
        face_crop_padding_y=0.22,
        google_vision_enabled=True,
        google_vision_max_results=10,
    )


def _result(url: str, platform: str, engine: str = "google_lens") -> SearchResult:
    return SearchResult(
        url=url,
        platform=platform,
        title="title",
        snippet="snippet",
        image_url=None,
        fetched_at=int(time.time() * 1000),
        source_strategy="serpapi",
        engine=engine,
    )


def test_merge_deduplicates_by_url() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)
    google = [_result("https://example.com/a", "web", "google_lens")]
    yandex = [_result("https://example.com/a", "web", "yandex")]
    merged = search._merge_and_rank(google, yandex)
    assert len(merged) == 1
    assert merged[0].url == "https://example.com/a"


def test_merge_ranks_by_platform_score() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)
    # 同一引擎内部：按平台分排序 twitter > linkedin > web
    google = [
        _result("https://twitter.com/user/status/1", "twitter", "google_lens"),
        _result("https://linkedin.com/in/user", "linkedin", "google_lens"),
        _result("https://example.com/web", "web", "google_lens"),
    ]
    yandex: list[SearchResult] = []
    merged = search._merge_and_rank(google, yandex)
    assert merged[0].platform == "twitter"
    assert merged[1].platform == "linkedin"
    assert merged[2].platform == "web"


def test_merge_primary_occupies_top_slots() -> None:
    # primary-first 语义：primary（google-vision）结果占顶部，
    # 即使 secondary 有更高平台分（twitter=5 > web=1）
    settings = _make_settings()
    search = ReverseImageSearch(settings)
    primary = [_result("https://example.com/vision", "web", "google-vision")]
    secondary = [_result("https://twitter.com/user/status/1", "twitter", "yandex")]
    merged = search._merge_and_rank(primary, secondary)
    assert merged[0].engine == "google-vision"
    assert merged[0].url == "https://example.com/vision"
    assert merged[1].engine == "yandex"


def test_merge_primary_exception_secondary_fills() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)
    secondary = [
        _result("https://twitter.com/user/status/1", "twitter", "google_lens"),
        _result("https://linkedin.com/in/user", "linkedin", "yandex"),
    ]
    merged = search._merge_and_rank(RuntimeError("vision failed"), secondary)
    assert merged[0].platform == "twitter"
    assert merged[1].platform == "linkedin"


def test_merge_skips_exception_engine() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)
    yandex = [_result("https://example.com/y", "web", "yandex")]
    merged = search._merge_and_rank(RuntimeError("google failed"), yandex)
    assert len(merged) == 1
    assert merged[0].engine == "yandex"


def test_google_lens_ranked_before_yandex_on_tie() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)
    google = [_result("https://example.com/g", "web", "google_lens")]
    yandex = [_result("https://example.com/y", "web", "yandex")]
    merged = search._merge_and_rank(google, yandex)
    assert len(merged) == 2
    assert merged[0].engine == "google_lens"
    assert merged[1].engine == "yandex"


def test_merge_caps_at_max_results() -> None:
    settings = _make_settings(max_results=2)
    search = ReverseImageSearch(settings)
    google = [
        _result("https://twitter.com/a", "twitter", "google_lens"),
        _result("https://linkedin.com/a", "linkedin", "google_lens"),
        _result("https://example.com/a", "web", "google_lens"),
    ]
    yandex: list[SearchResult] = []
    merged = search._merge_and_rank(google, yandex)
    assert len(merged) == 2


def test_platform_detection_from_url() -> None:
    from search.search import _detect_platform

    assert _detect_platform("https://twitter.com/user") == "twitter"
    assert _detect_platform("https://x.com/user") == "twitter"
    assert _detect_platform("https://linkedin.com/in/user") == "linkedin"
    assert _detect_platform("https://instagram.com/p/abc") == "instagram"
    assert _detect_platform("https://reddit.com/r/test") == "reddit"
    assert _detect_platform("https://example.com/page") == "web"


@pytest.mark.asyncio
async def test_search_no_key_returns_empty() -> None:
    settings = _make_settings(serpapi_key=None)
    search = ReverseImageSearch(settings)
    result = await search.search(b"fake-image-bytes")
    assert result == []


def test_search_result_to_protocol_dict_camelcase() -> None:
    sr = SearchResult(
        url="https://example.com",
        platform="web",
        title="t",
        snippet="s",
        image_url="https://img.com/a.jpg",
        fetched_at=123456,
        source_strategy="serpapi",
        engine="google_lens",
    )
    d = sr.to_protocol_dict()
    assert d["url"] == "https://example.com"
    assert d["imageUrl"] == "https://img.com/a.jpg"
    assert d["fetchedAt"] == 123456
    assert d["sourceStrategy"] == "serpapi"
    assert d["engine"] == "google_lens"
    assert "image_url" not in d
    assert "fetched_at" not in d


@pytest.mark.asyncio
async def test_search_emits_per_engine_progress() -> None:
    from unittest.mock import AsyncMock

    settings = _make_settings(serpapi_key=None)
    search = ReverseImageSearch(settings)
    # Isolate vision from the network; lens/yandex/facecheck have no keys.
    search._vision.search = AsyncMock(
        return_value=[
            _result("https://linkedin.com/in/a", "linkedin", engine="google-vision")
        ]
    )

    events: list[dict[str, object]] = []

    async def collect(event: dict[str, object]) -> None:
        events.append(event)

    results = await search.search(b"fake-image-bytes", on_progress=collect)
    assert len(results) == 1

    by_engine = {(e["engine"], e["state"]) for e in events if "engine" in e}
    assert ("vision", "start") in by_engine
    assert ("vision", "done") in by_engine
    assert ("lens", "skip") in by_engine
    assert ("yandex", "skip") in by_engine
    assert ("facecheck", "skip") in by_engine

    vision_done = next(
        e for e in events if e.get("engine") == "vision" and e["state"] == "done"
    )
    assert vision_done["count"] == 1
    slim = vision_done["results"]
    assert isinstance(slim, list)
    first = slim[0]
    assert isinstance(first, dict)
    assert first["url"] == "https://linkedin.com/in/a"
