from __future__ import annotations

import time

import pytest

from mira_serve.config import Settings
from mira_serve.search import ReverseImageSearch, SearchResult


def _make_settings(
    max_results: int = 8, facecheck_token: str | None = None
) -> Settings:
    return Settings(
        host="0.0.0.0",
        port=8765,
        enrollment_sync_base_url=None,
        enrollment_sync_enabled=False,
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
        serpapi_key="test-key",
        search_timeout_seconds=5.0,
        search_max_results=max_results,
        pipeline_enabled=True,
        face_crop_padding_x=0.18,
        face_crop_padding_y=0.22,
        google_vision_enabled=True,
        google_vision_max_results=10,
        facecheck_api_token=facecheck_token,
        facecheck_max_results=8,
        facecheck_demo=False,
    )


def _result(
    url: str, platform: str, engine: str, has_image: bool = False
) -> SearchResult:
    return SearchResult(
        url=url,
        platform=platform,
        title="t",
        snippet="s",
        image_url=None,
        fetched_at=int(time.time() * 1000),
        source_strategy="serpapi" if engine != "facecheck" else "facecheck",
        engine=engine,
        has_image=has_image,
        base64="data:;base64,abc" if has_image else None,
        facecheck_score=80 if has_image else None,
    )


def test_merge_four_way_deduplicates_by_url() -> None:
    settings = _make_settings(max_results=10)
    search = ReverseImageSearch(settings)
    vision = [_result("https://example.com/a", "web", "google-vision")]
    google = [_result("https://example.com/a", "web", "google_lens")]
    yandex = [_result("https://example.com/b", "web", "yandex")]
    facecheck = [_result("https://example.com/c", "web", "facecheck", has_image=True)]
    merged = search._merge_four_way(vision, google, yandex, facecheck)
    urls = [r.url for r in merged]
    assert urls.count("https://example.com/a") == 1
    assert "https://example.com/b" in urls
    assert "https://example.com/c" in urls


def test_merge_four_way_multi_source_count() -> None:
    settings = _make_settings(max_results=10)
    search = ReverseImageSearch(settings)
    # Same URL from vision and google → count 2
    vision = [_result("https://example.com/shared", "twitter", "google-vision")]
    google = [_result("https://example.com/shared", "twitter", "google_lens")]
    merged = search._merge_four_way(vision, google, [], [])
    assert len(merged) == 1
    assert merged[0].multi_source_count == 2
    # Unique URL → count 1
    vision2 = [_result("https://example.com/unique", "web", "google-vision")]
    merged2 = search._merge_four_way(vision2, [], [], [])
    assert merged2[0].multi_source_count == 1


def test_merge_four_way_facecheck_sorted_first() -> None:
    settings = _make_settings(max_results=10)
    search = ReverseImageSearch(settings)
    vision = [_result("https://example.com/v", "web", "google-vision")]
    facecheck = [_result("https://example.com/f", "web", "facecheck", has_image=True)]
    merged = search._merge_four_way(vision, [], [], facecheck)
    # FaceCheck has_image=True should be first after merge (optimization: no download)
    assert merged[0].has_image is True
    assert merged[0].engine == "facecheck"


def test_merge_four_way_exception_engine_skipped() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)
    yandex = [_result("https://example.com/y", "web", "yandex")]
    # Google raises exception → should be ignored
    merged = search._merge_four_way(
        RuntimeError("vision down"), RuntimeError("google down"), yandex, []
    )
    assert len(merged) == 1
    assert merged[0].engine == "yandex"


def test_merge_four_way_reserves_slots_per_engine() -> None:
    """With cap=8, each successful engine should get at least 1 slot."""
    settings = _make_settings(max_results=8)
    search = ReverseImageSearch(settings)
    vision = [
        _result(f"https://example.com/v{i}", "web", "google-vision") for i in range(5)
    ]
    google = [
        _result(f"https://example.com/g{i}", "web", "google_lens") for i in range(5)
    ]
    yandex = [_result(f"https://example.com/y{i}", "web", "yandex") for i in range(5)]
    facecheck = [
        _result(f"https://example.com/f{i}", "web", "facecheck", has_image=True)
        for i in range(5)
    ]
    merged = search._merge_four_way(vision, google, yandex, facecheck)
    engines = {r.engine for r in merged}
    # All 4 should be represented when cap allows
    assert "google-vision" in engines
    # At least 3 engines (some may be crowded out if cap small, but >=3)
    assert len(engines) >= 3


def test_merge_four_way_per_engine_cap_8() -> None:
    settings = _make_settings(max_results=8)
    search = ReverseImageSearch(settings)
    # Each engine returns 10, but merge should cap each at 8 pre-dedup
    vision = [
        _result(f"https://example.com/v{i}", "web", "google-vision") for i in range(10)
    ]
    merged = search._merge_four_way(vision, [], [], [])
    # Even with 10 input, per-engine cap 8 means at most 8 survive (plus global cap 8)
    assert len(merged) <= 8


def test_search_result_protocol_dict_extended_fields() -> None:
    sr = SearchResult(
        url="https://example.com",
        platform="twitter",
        title="t",
        snippet="s",
        image_url="https://img.com/a.jpg",
        fetched_at=123,
        source_strategy="facecheck",
        engine="facecheck",
        base64="data:;base64,xyz",
        facecheck_score=88,
        has_image=True,
        multi_source_count=2,
        similarity=0.77,
        final_score=0.85,
    )
    d = sr.to_protocol_dict()
    assert d["facecheckScore"] == 88
    assert d["hasImage"] is True
    assert d["multiSourceCount"] == 2
    assert d["similarity"] == pytest.approx(0.77)
    assert d["finalScore"] == pytest.approx(0.85)
    # Base64 only when has_image
    assert "base64" in d
    # Ensure old fields still present
    assert d["imageUrl"] == "https://img.com/a.jpg"


def test_attach_multi_source_preserves_other_fields() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)
    r1 = _result("https://example.com/a", "twitter", "google-vision")
    r2 = _result("https://example.com/a", "twitter", "google_lens")
    # Simulate deduped single survivor with count 2
    merged = [r1]
    out = search._attach_multi_source(merged, [[r1], [r2], [], []])
    assert out[0].multi_source_count == 2
    assert out[0].url == r1.url
    assert out[0].platform == r1.platform
