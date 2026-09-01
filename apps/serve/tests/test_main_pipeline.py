from __future__ import annotations

import base64
import io
import json
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest
from PIL import Image

from mira_serve.config import Settings
from mira_serve.pipeline import FaceData, NoFaceFoundError, PipelineResult
from mira_serve.search import SearchResult


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
        serpapi_key="test-key",
        search_timeout_seconds=5.0,
        search_max_results=5,
        pipeline_enabled=True,
        face_crop_padding_x=0.18,
        face_crop_padding_y=0.22,
        google_vision_enabled=True,
        google_vision_max_results=10,
    )


def _make_image_b64() -> str:
    img = Image.new("RGB", (32, 32), color="white")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _make_face_data() -> FaceData:
    return FaceData(
        bbox={"x": 10.0, "y": 20.0, "width": 100.0, "height": 100.0},
        confidence=0.98,
        embedding=np.ones(512, dtype=np.float32),
        cropped_jpeg=b"fake-jpeg",
    )


@pytest.mark.asyncio
async def test_handle_pipeline_run_success() -> None:
    from main import _handle_pipeline_run

    settings = _make_settings()
    # Mock pipeline
    mock_pipeline = MagicMock()
    face = _make_face_data()
    search_result = SearchResult(
        url="https://twitter.com/test",
        platform="twitter",
        title="Test Title",
        snippet="Test snippet",
        image_url="https://img.com/a.jpg",
        fetched_at=1234567890,
        source_strategy="serpapi",
        engine="google_lens",
    )
    pipeline_result = PipelineResult(
        face=face,
        results=[search_result],
        anchor_strategy="search",
        engines_used=["google_lens"],
    )
    mock_pipeline.run = AsyncMock(return_value=pipeline_result)

    payload: dict[str, object] = {
        "type": "pipeline.run",
        "sessionId": "sess-123",
        "image": {
            "data": _make_image_b64(),
            "mimeType": "image/jpeg",
            "width": 32,
            "height": 32,
        },
    }

    raw = await _handle_pipeline_run(payload, mock_pipeline)  # type: ignore[arg-type]
    data = json.loads(raw)
    assert data["type"] == "pipeline.result"
    assert data["sessionId"] == "sess-123"
    assert data["face"]["bbox"]["x"] == 10.0
    assert data["face"]["confidence"] == 0.98
    assert data["anchorStrategy"] == "search"
    assert data["enginesUsed"] == ["google_lens"]
    assert len(data["results"]) == 1
    # CamelCase checks
    res = data["results"][0]
    assert res["url"] == "https://twitter.com/test"
    assert res["platform"] == "twitter"
    assert res["imageUrl"] == "https://img.com/a.jpg"
    assert res["fetchedAt"] == 1234567890
    assert res["sourceStrategy"] == "serpapi"
    assert res["engine"] == "google_lens"
    assert "image_url" not in res


@pytest.mark.asyncio
async def test_handle_pipeline_run_no_face() -> None:
    from main import _handle_pipeline_run

    mock_pipeline = MagicMock()
    mock_pipeline.run = AsyncMock(side_effect=NoFaceFoundError("No face detected"))

    payload: dict[str, object] = {
        "type": "pipeline.run",
        "sessionId": "sess-456",
        "image": {
            "data": _make_image_b64(),
            "mimeType": "image/jpeg",
            "width": 32,
            "height": 32,
        },
    }

    raw = await _handle_pipeline_run(payload, mock_pipeline)  # type: ignore[arg-type]
    data = json.loads(raw)
    assert data["type"] == "pipeline.result"
    assert data["sessionId"] == "sess-456"
    assert data["anchorStrategy"] == "none"
    assert data["results"] == []
    assert "error" in data
    assert "No face" in data["error"]


@pytest.mark.asyncio
async def test_handle_pipeline_run_missing_image() -> None:
    from main import _handle_pipeline_run

    mock_pipeline = MagicMock()
    mock_pipeline.run = AsyncMock()

    payload: dict[str, object] = {
        "type": "pipeline.run",
        "sessionId": "sess-789",
        # Missing image field
    }

    raw = await _handle_pipeline_run(payload, mock_pipeline)  # type: ignore[arg-type]
    data = json.loads(raw)
    assert data["type"] == "pipeline.result"
    assert data["anchorStrategy"] == "none"
    assert data["results"] == []
    assert "error" in data


@pytest.mark.asyncio
async def test_handle_pipeline_run_embedding_fallback() -> None:
    from main import _handle_pipeline_run

    mock_pipeline = MagicMock()
    face = _make_face_data()
    fallback = SearchResult(
        url="face-embedding://abc123",
        platform="none",
        title="Face Embedding Anchor",
        snippet="No social post found.",
        image_url=None,
        fetched_at=999,
        source_strategy="embedding-fallback",
        engine="embedding-fallback",
    )
    pipeline_result = PipelineResult(
        face=face,
        results=[fallback],
        anchor_strategy="embedding",
        engines_used=["embedding-fallback"],
    )
    mock_pipeline.run = AsyncMock(return_value=pipeline_result)

    payload: dict[str, object] = {
        "type": "pipeline.run",
        "sessionId": "sess-emb",
        "image": {
            "data": _make_image_b64(),
            "mimeType": "image/jpeg",
            "width": 32,
            "height": 32,
        },
    }

    raw = await _handle_pipeline_run(payload, mock_pipeline)  # type: ignore[arg-type]
    data = json.loads(raw)
    assert data["anchorStrategy"] == "embedding"
    assert data["enginesUsed"] == ["embedding-fallback"]
    assert data["results"][0]["url"].startswith("face-embedding://")


@pytest.mark.asyncio
async def test_handle_pipeline_run_generic_exception() -> None:
    from main import _handle_pipeline_run

    mock_pipeline = MagicMock()
    mock_pipeline.run = AsyncMock(side_effect=RuntimeError("boom"))

    payload: dict[str, object] = {
        "type": "pipeline.run",
        "sessionId": "sess-err",
        "image": {
            "data": _make_image_b64(),
            "mimeType": "image/jpeg",
            "width": 32,
            "height": 32,
        },
    }

    raw = await _handle_pipeline_run(payload, mock_pipeline)  # type: ignore[arg-type]
    data = json.loads(raw)
    assert data["type"] == "pipeline.result"
    assert data["anchorStrategy"] == "none"
    assert "RuntimeError" in data["error"]
