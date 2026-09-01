from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from mira_serve.config import Settings
from mira_serve.search import ReverseImageSearch


def _make_settings() -> Settings:
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
        serpapi_key="fake-key",
        search_timeout_seconds=5.0,
        search_max_results=5,
        pipeline_enabled=True,
        face_crop_padding_x=0.18,
        face_crop_padding_y=0.22,
        google_vision_enabled=True,
        google_vision_max_results=10,
    )


@pytest.mark.asyncio
async def test_search_parallel_merges_both_engines() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)

    # Mock hosting to avoid real HTTP
    search._host_image = AsyncMock(return_value="https://files.catbox.moe/test.jpg")  # type: ignore[method-assign]

    google_json = {
        "organic_results": [
            {
                "link": "https://twitter.com/user/status/1",
                "title": "Twitter Post",
                "snippet": "Found on Twitter",
                "thumbnail": "https://img.com/t.jpg",
            }
        ],
        "visual_matches": [],
        "knowledge_graph": {},
    }
    yandex_json = {
        "organic_results": [
            {
                "link": "https://instagram.com/p/abc",
                "title": "Insta Post",
                "snippet": "Found on Insta",
                "thumbnail": "https://img.com/i.jpg",
            }
        ],
        "images_results": [],
    }

    async def fake_get(
        url: str,
        params: dict[str, str] | None = None,
        **kwargs: object,
    ) -> MagicMock:
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        engine = (params or {}).get("engine", "")
        if engine == "google_lens":
            resp.json.return_value = google_json
        else:
            resp.json.return_value = yandex_json
        return resp

    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.get.side_effect = fake_get
    mock_client.is_closed = False
    search._client = mock_client  # type: ignore[assignment]

    # Mock Vision to return empty so this test isolates SerpAPI
    search._vision.search = AsyncMock(return_value=[])  # type: ignore[method-assign]

    results = await search.search(b"fake-jpeg-bytes")

    assert len(results) == 2
    # Twitter (score 5) should rank before Instagram (score 3)
    assert results[0].platform == "twitter"
    assert results[0].engine == "google_lens"
    assert results[1].platform == "instagram"
    assert results[1].engine == "yandex"
    # Verify both engines were called (yandex uses yandex_images engine)
    assert mock_client.get.call_count == 2
    engines_called = {
        call.kwargs["params"]["engine"] for call in mock_client.get.call_args_list
    }
    assert engines_called == {"google_lens", "yandex_images"}


@pytest.mark.asyncio
async def test_search_one_engine_fails_other_succeeds() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)
    search._host_image = AsyncMock(return_value="https://files.catbox.moe/test.jpg")  # type: ignore[method-assign]

    yandex_json = {
        "organic_results": [
            {"link": "https://example.com/y", "title": "Y", "snippet": "S"}
        ],
        "images_results": [],
    }

    async def fake_get(
        url: str,
        params: dict[str, str] | None = None,
        **kwargs: object,
    ) -> MagicMock:
        engine = (params or {}).get("engine", "")
        if engine == "google_lens":
            raise httpx.HTTPError("google failed")
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        resp.json.return_value = yandex_json
        return resp

    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.get.side_effect = fake_get
    mock_client.is_closed = False
    search._client = mock_client  # type: ignore[assignment]
    search._vision.search = AsyncMock(return_value=[])  # type: ignore[method-assign]

    results = await search.search(b"fake-jpeg")

    # Should return yandex result despite google failure
    assert len(results) == 1
    assert results[0].engine == "yandex"


@pytest.mark.asyncio
async def test_search_both_fail_returns_empty() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)
    search._host_image = AsyncMock(side_effect=RuntimeError("upload failed"))  # type: ignore[method-assign]
    # Also mock fallback per-engine uploads to fail
    search._upload_to_serpapi = AsyncMock(side_effect=RuntimeError("upload failed"))  # type: ignore[method-assign]
    search._vision.search = AsyncMock(return_value=[])  # type: ignore[method-assign]

    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False
    search._client = mock_client  # type: ignore[assignment]

    results = await search.search(b"fake-jpeg")
    assert results == []


@pytest.mark.asyncio
async def test_upload_to_serpapi_parses_response() -> None:
    settings = _make_settings()
    search = ReverseImageSearch(settings)

    fake_resp = MagicMock(spec=httpx.Response)
    fake_resp.raise_for_status = MagicMock()
    fake_resp.text = "https://files.catbox.moe/test123.jpg"
    fake_resp.json.return_value = {"error": "should not be called"}

    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.post = AsyncMock(return_value=fake_resp)
    mock_client.is_closed = False
    search._client = mock_client  # type: ignore[assignment]

    url = await search._host_image(b"fake-bytes")
    assert url == "https://files.catbox.moe/test123.jpg"
    mock_client.post.assert_called_once()
    call_kwargs = mock_client.post.call_args.kwargs
    # catbox uses fileToUpload
    assert "fileToUpload" in call_kwargs["files"]
