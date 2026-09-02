from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from config.config import Settings
from search.facecheck import FaceCheckSearch


def _make_settings(
    token: str | None = "test-token",
    demo: bool = False,
    max_results: int = 8,
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
        serpapi_key=None,
        search_timeout_seconds=5.0,
        search_max_results=5,
        pipeline_enabled=True,
        face_crop_padding_x=0.18,
        face_crop_padding_y=0.22,
        google_vision_enabled=False,
        google_vision_max_results=5,
        facecheck_api_token=token,
        facecheck_max_results=max_results,
        facecheck_demo=demo,
    )


def _b64_webp() -> str:
    return "data:image/webp;base64,dGVzdA=="  # "test" base64


@pytest.mark.asyncio
async def test_no_token_returns_empty() -> None:
    settings = _make_settings(token=None)
    fc = FaceCheckSearch(settings)
    res = await fc.search(b"fake-jpeg-bytes" * 100)
    assert res == []
    await fc.aclose()


@pytest.mark.asyncio
async def test_upload_returns_id_search() -> None:
    settings = _make_settings(token="tok123")
    fc = FaceCheckSearch(settings)

    # Mock upload + poll empty
    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False

    async def fake_post(url: str, **kwargs):  # type: ignore[no-untyped-def]
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        if "upload_pic" in url:
            resp.json.return_value = {
                "id_search": "abc123",
                "error": None,
                "code": None,
                "message": "uploaded",
            }
        else:
            resp.json.return_value = {
                "progress": 100,
                "output": {"items": []},
                "error": None,
            }
        return resp

    mock_client.post = AsyncMock(side_effect=fake_post)
    fc._client = mock_client  # type: ignore[assignment]

    res = await fc.search(b"fake-jpeg" * 200)
    # Empty poll → []
    assert res == []
    # Verify upload file field used 'images'
    called = mock_client.post.call_args_list[0]
    assert "upload_pic" in str(called.args[0])
    await fc.aclose()


@pytest.mark.asyncio
async def test_poll_returns_top_8_by_score() -> None:
    settings = _make_settings(token="tok", max_results=2)
    fc = FaceCheckSearch(settings)

    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False

    items = [
        {
            "score": 90,
            "url": {"value": "https://example.com/high"},
            "base64": _b64_webp(),
        },
        {
            "score": 50,
            "url": {"value": "https://example.com/low"},
            "base64": _b64_webp(),
        },
        {
            "score": 75,
            "url": {"value": "https://example.com/mid"},
            "base64": _b64_webp(),
        },
    ]

    async def fake_post(url: str, **kwargs):  # type: ignore[no-untyped-def]
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        if "upload_pic" in url:
            resp.json.return_value = {"id_search": "sid123", "error": None}
        else:
            resp.json.return_value = {
                "progress": 100,
                "output": {"items": items},
                "error": None,
            }
        return resp

    mock_client.post = AsyncMock(side_effect=fake_post)
    fc._client = mock_client  # type: ignore[assignment]

    res = await fc.search(b"fake" * 300)
    assert len(res) == 2
    # Sorted desc by score
    assert res[0].url == "https://example.com/high"
    assert res[0].facecheck_score == 90
    assert res[1].url == "https://example.com/mid"
    assert res[1].facecheck_score == 75
    await fc.aclose()


@pytest.mark.asyncio
async def test_has_image_flag_and_base64_preserved() -> None:
    settings = _make_settings(token="tok")
    fc = FaceCheckSearch(settings)
    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False
    b64 = "data:image/webp;base64,aGVsbG8="
    items = [{"score": 80, "url": {"value": "https://example.com/a"}, "base64": b64}]

    async def fake_post(url: str, **kwargs):  # type: ignore[no-untyped-def]
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        if "upload_pic" in url:
            resp.json.return_value = {"id_search": "sid", "error": None}
        else:
            resp.json.return_value = {
                "output": {"items": items},
                "error": None,
                "progress": 100,
            }
        return resp

    mock_client.post = AsyncMock(side_effect=fake_post)
    fc._client = mock_client  # type: ignore[assignment]
    res = await fc.search(b"fake" * 300)
    assert len(res) == 1
    assert res[0].has_image is True
    assert res[0].base64 == b64
    assert res[0].engine == "facecheck"
    assert res[0].source_strategy == "facecheck"
    await fc.aclose()


@pytest.mark.asyncio
async def test_url_string_vs_maskedurl_object() -> None:
    """Swagger says url is {value: str}, but docs examples use plain string — handle both."""
    settings = _make_settings(token="tok")
    fc = FaceCheckSearch(settings)
    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False
    items = [
        {"score": 80, "url": "https://example.com/plain", "base64": _b64_webp()},
        {
            "score": 70,
            "url": {"value": "https://example.com/masked"},
            "base64": _b64_webp(),
        },
    ]

    async def fake_post(url: str, **kwargs):  # type: ignore[no-untyped-def]
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        if "upload_pic" in url:
            resp.json.return_value = {"id_search": "sid", "error": None}
        else:
            resp.json.return_value = {"output": {"items": items}, "error": None}
        return resp

    mock_client.post = AsyncMock(side_effect=fake_post)
    fc._client = mock_client  # type: ignore[assignment]
    res = await fc.search(b"fake" * 300)
    urls = {r.url for r in res}
    assert "https://example.com/plain" in urls
    assert "https://example.com/masked" in urls
    await fc.aclose()


@pytest.mark.asyncio
async def test_poll_with_progress_then_output() -> None:
    """FaceCheck poll should loop while progress <100 and return once output appears."""
    settings = _make_settings(token="tok")
    fc = FaceCheckSearch(settings)
    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False
    poll_calls = 0

    async def fake_post(url: str, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal poll_calls
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        if "upload_pic" in url:
            resp.json.return_value = {"id_search": "sid", "error": None}
        else:
            poll_calls += 1
            if poll_calls < 3:
                resp.json.return_value = {
                    "progress": 50,
                    "message": "searching",
                    "error": None,
                    "output": None,
                }
            else:
                resp.json.return_value = {
                    "progress": 100,
                    "output": {
                        "items": [
                            {
                                "score": 88,
                                "url": {"value": "https://example.com/done"},
                                "base64": _b64_webp(),
                            }
                        ]
                    },
                    "error": None,
                }
        return resp

    mock_client.post = AsyncMock(side_effect=fake_post)
    fc._client = mock_client  # type: ignore[assignment]
    # Patch sleep to speed up test
    with patch("search.facecheck.asyncio.sleep", new=AsyncMock()):
        res = await fc.search(b"fake" * 300)
    assert len(res) == 1
    assert res[0].url == "https://example.com/done"
    assert poll_calls == 3
    await fc.aclose()


@pytest.mark.asyncio
async def test_poll_timeout_returns_empty() -> None:
    settings = _make_settings(token="tok")
    fc = FaceCheckSearch(settings)
    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False

    async def fake_post(url: str, **kwargs):  # type: ignore[no-untyped-def]
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        if "upload_pic" in url:
            resp.json.return_value = {"id_search": "sid", "error": None}
        else:
            resp.json.return_value = {"progress": 50, "error": None, "output": None}
        return resp

    mock_client.post = AsyncMock(side_effect=fake_post)
    fc._client = mock_client  # type: ignore[assignment]
    with patch("search.facecheck.asyncio.sleep", new=AsyncMock()):
        res = await fc.search(b"fake" * 300)
    assert res == []
    await fc.aclose()


@pytest.mark.asyncio
async def test_upload_error_returns_empty() -> None:
    settings = _make_settings(token="tok")
    fc = FaceCheckSearch(settings)
    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False

    async def fake_post(url: str, **kwargs):  # type: ignore[no-untyped-def]
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        resp.json.return_value = {"error": "Invalid token", "code": "401"}
        return resp

    mock_client.post = AsyncMock(side_effect=fake_post)
    fc._client = mock_client  # type: ignore[assignment]
    res = await fc.search(b"fake" * 300)
    assert res == []
    await fc.aclose()


@pytest.mark.asyncio
async def test_http_error_gracefully_returns_empty() -> None:
    settings = _make_settings(token="tok")
    fc = FaceCheckSearch(settings)
    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False

    async def fake_post(url: str, **kwargs):  # type: ignore[no-untyped-def]
        raise httpx.HTTPStatusError(
            "err", request=MagicMock(), response=MagicMock(status_code=429)
        )

    mock_client.post = AsyncMock(side_effect=fake_post)
    fc._client = mock_client  # type: ignore[assignment]
    res = await fc.search(b"fake" * 300)
    assert res == []
    await fc.aclose()


@pytest.mark.asyncio
async def test_demo_flag_passed_to_search() -> None:
    settings = _make_settings(token="tok", demo=True)
    fc = FaceCheckSearch(settings)
    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False
    captured_payload: dict[str, object] = {}

    async def fake_post(url: str, json=None, **kwargs):  # type: ignore[no-untyped-def]
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        if "upload_pic" in url:
            resp.json.return_value = {"id_search": "sid", "error": None}
        else:
            if json:
                captured_payload.update(json)
            resp.json.return_value = {
                "output": {"items": []},
                "error": None,
                "progress": 100,
            }
        return resp

    mock_client.post = AsyncMock(side_effect=fake_post)
    fc._client = mock_client  # type: ignore[assignment]
    await fc.search(b"fake" * 300)
    assert captured_payload.get("demo") is True
    await fc.aclose()


@pytest.mark.asyncio
async def test_platform_detection_from_facecheck_url() -> None:
    settings = _make_settings(token="tok")
    fc = FaceCheckSearch(settings)
    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.is_closed = False
    items = [
        {
            "score": 90,
            "url": {"value": "https://twitter.com/user/status/1"},
            "base64": _b64_webp(),
        },
        {
            "score": 80,
            "url": {"value": "https://linkedin.com/in/user"},
            "base64": _b64_webp(),
        },
    ]

    async def fake_post(url: str, **kwargs):  # type: ignore[no-untyped-def]
        resp = MagicMock(spec=httpx.Response)
        resp.raise_for_status = MagicMock()
        if "upload_pic" in url:
            resp.json.return_value = {"id_search": "sid", "error": None}
        else:
            resp.json.return_value = {"output": {"items": items}, "error": None}
        return resp

    mock_client.post = AsyncMock(side_effect=fake_post)
    fc._client = mock_client  # type: ignore[assignment]
    res = await fc.search(b"fake" * 300)
    assert res[0].platform == "twitter"
    assert res[1].platform == "linkedin"
    await fc.aclose()
