from __future__ import annotations

from unittest.mock import MagicMock, patch

from config.config import Settings
from search.web_vision import VisionWebSearch, _extract_page_url


def _make_settings() -> Settings:
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
        serpapi_key="test-key",
        search_timeout_seconds=5.0,
        search_max_results=5,
        pipeline_enabled=True,
        face_crop_padding_x=0.18,
        face_crop_padding_y=0.22,
        google_vision_enabled=True,
        google_vision_max_results=10,
    )


def _make_mock_annotation(
    pages: list[MagicMock] | None = None,
    full_images: list[MagicMock] | None = None,
    partial_images: list[MagicMock] | None = None,
    entities: list[MagicMock] | None = None,
    labels: list[MagicMock] | None = None,
) -> MagicMock:
    annotation = MagicMock()
    annotation.pages_with_matching_images = pages or []
    annotation.full_matching_images = full_images or []
    annotation.partial_matching_images = partial_images or []
    annotation.web_entities = entities or []
    annotation.best_guess_labels = labels or []
    return annotation


def test_pages_with_matching_images_mapped_to_results() -> None:
    settings = _make_settings()
    vs = VisionWebSearch(settings)

    page = MagicMock()
    page.url = "https://twitter.com/user/status/123"
    page.page_title = "Some Tweet"

    annotation = _make_mock_annotation(pages=[page])
    results = vs._collect(annotation)

    assert len(results) == 1
    assert results[0].url == "https://twitter.com/user/status/123"
    assert results[0].title == "Some Tweet"
    assert results[0].platform == "twitter"
    assert results[0].engine == "google-vision"
    assert results[0].source_strategy == "google-vision"


def test_web_entities_used_as_title_fallback() -> None:
    settings = _make_settings()
    vs = VisionWebSearch(settings)

    entity = MagicMock()
    entity.description = "Simon Baker"
    entity.score = 1.5

    page = MagicMock()
    page.url = "https://example.com/page"
    page.page_title = None

    annotation = _make_mock_annotation(pages=[page], entities=[entity])
    results = vs._collect(annotation)

    assert results[0].title == "Simon Baker"


def test_best_guess_labels_used_as_snippet_fallback() -> None:
    settings = _make_settings()
    vs = VisionWebSearch(settings)

    label = MagicMock()
    label.label = "man in suit"

    page = MagicMock()
    page.url = "https://example.com/page"
    page.page_title = None

    annotation = _make_mock_annotation(pages=[page], labels=[label])
    results = vs._collect(annotation)

    assert results[0].snippet == "man in suit"


def test_full_matching_images_mapped() -> None:
    settings = _make_settings()
    vs = VisionWebSearch(settings)

    img = MagicMock()
    img.url = "https://pbs.twimg.com/media/abc123.jpg"

    annotation = _make_mock_annotation(full_images=[img])
    results = vs._collect(annotation)

    assert len(results) == 1
    assert results[0].image_url == "https://pbs.twimg.com/media/abc123.jpg"


def test_dedup_by_url_across_groups() -> None:
    settings = _make_settings()
    vs = VisionWebSearch(settings)

    page = MagicMock()
    page.url = "https://example.com/same"
    page.page_title = "Page"

    img = MagicMock()
    img.url = "https://example.com/same"

    annotation = _make_mock_annotation(pages=[page], full_images=[img])
    results = vs._collect(annotation)

    assert len(results) == 1


def test_max_results_cap() -> None:
    settings = _make_settings()
    vs = VisionWebSearch(settings)

    pages = []
    for i in range(15):
        p = MagicMock()
        p.url = f"https://example.com/page{i}"
        p.page_title = f"Page {i}"
        pages.append(p)

    annotation = _make_mock_annotation(pages=pages)
    results = vs._collect(annotation)

    assert len(results) == 10


def test_extract_page_url_twimg() -> None:
    assert (
        _extract_page_url("https://pbs.twimg.com/media/abc.jpg")
        == "https://twitter.com"
    )


def test_extract_page_url_unknown() -> None:
    assert _extract_page_url("https://random-cdn.net/image.jpg") is None


def test_disabled_vision_returns_empty() -> None:
    settings = _make_settings()
    import dataclasses

    settings = dataclasses.replace(settings, google_vision_enabled=False)
    vs = VisionWebSearch(settings)

    import asyncio

    async def run():
        return await vs.search(b"fake")

    result = asyncio.run(run())
    assert result == []


def test_vision_exception_returns_empty() -> None:
    settings = _make_settings()
    vs = VisionWebSearch(settings)

    with patch.object(vs, "_detect_sync", side_effect=RuntimeError("API error")):
        import asyncio

        async def run():
            return await vs.search(b"fake")

        result = asyncio.run(run())
        assert result == []
