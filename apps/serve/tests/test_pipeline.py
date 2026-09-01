from __future__ import annotations

import io
from unittest.mock import MagicMock, PropertyMock

import numpy as np
import pytest
from PIL import Image

from mira_serve.config import Settings
from mira_serve.pipeline import (
    NoFaceFoundError,
    Pipeline,
    _embedding_fallback,
)


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


def _make_image_bytes(width: int = 320, height: int = 320) -> bytes:
    img = Image.new("RGB", (width, height), color="white")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


def _make_dummy_service(
    faces: list[object] | None = None,
) -> MagicMock:
    service = MagicMock()

    # decode_image_bytes returns BGR numpy array (320x320x3)
    def fake_decode(data: bytes) -> np.ndarray:
        # Return white BGR image
        return np.ones((320, 320, 3), dtype=np.uint8) * 255

    service.decode_image_bytes.side_effect = fake_decode
    mock_analysis = MagicMock()
    mock_analysis.get.return_value = faces if faces is not None else []
    # analysis is a property, mock it
    type(service).analysis = PropertyMock(return_value=mock_analysis)
    return service


def test_embedding_fallback_url_format() -> None:
    emb = np.random.randn(512).astype(np.float32)
    results = _embedding_fallback(emb)
    assert len(results) == 1
    assert results[0].url.startswith("face-embedding://")
    assert results[0].platform == "none"
    assert results[0].source_strategy == "embedding-fallback"
    assert results[0].engine == "embedding-fallback"


def test_embedding_fallback_is_deterministic() -> None:
    emb = np.ones(512, dtype=np.float32)
    r1 = _embedding_fallback(emb)
    r2 = _embedding_fallback(emb)
    assert r1[0].url == r2[0].url
    # Different embedding => different hash
    emb2 = np.zeros(512, dtype=np.float32)
    r3 = _embedding_fallback(emb2)
    assert r1[0].url != r3[0].url


def test_no_face_raises_error() -> None:
    settings = _make_settings()
    service = _make_dummy_service(faces=[])
    pipeline = Pipeline(service, settings)
    img_bytes = _make_image_bytes()
    with pytest.raises(NoFaceFoundError):
        pipeline._extract_face(img_bytes)


def test_extract_face_success() -> None:
    settings = _make_settings()
    # Create a fake Face object
    fake_face = MagicMock()
    fake_face.bbox = np.array([50, 50, 150, 150], dtype=np.float32)
    fake_face.det_score = 0.99
    fake_face.embedding = np.random.randn(512).astype(np.float32)
    fake_face.normed_embedding = None

    service = _make_dummy_service(faces=[fake_face])
    pipeline = Pipeline(service, settings)
    img_bytes = _make_image_bytes()
    face_data = pipeline._extract_face(img_bytes)
    assert face_data.bbox["x"] == 50.0
    assert face_data.bbox["width"] == 100.0
    assert face_data.confidence == pytest.approx(0.99)
    assert face_data.embedding.shape == (512,)
    assert len(face_data.cropped_jpeg) > 100
    # Ensure JPEG decodable
    img = Image.open(io.BytesIO(face_data.cropped_jpeg))
    assert img.format == "JPEG"


def test_extract_face_selects_largest() -> None:
    settings = _make_settings()
    small = MagicMock()
    small.bbox = np.array([10, 10, 20, 20], dtype=np.float32)
    small.det_score = 0.9
    small.embedding = np.ones(512, dtype=np.float32)
    small.normed_embedding = np.ones(512, dtype=np.float32)

    large = MagicMock()
    large.bbox = np.array([0, 0, 200, 200], dtype=np.float32)
    large.det_score = 0.95
    large.embedding = np.ones(512, dtype=np.float32) * 2
    large.normed_embedding = np.ones(512, dtype=np.float32) * 2

    service = _make_dummy_service(faces=[small, large])
    pipeline = Pipeline(service, settings)
    img_bytes = _make_image_bytes()
    face_data = pipeline._extract_face(img_bytes)
    # Should pick large face
    assert face_data.bbox["width"] == 200.0
    assert face_data.embedding[0] == pytest.approx(2.0)


def test_extract_face_filters_low_confidence() -> None:
    settings = _make_settings()
    low = MagicMock()
    low.bbox = np.array([10, 10, 100, 100], dtype=np.float32)
    low.det_score = 0.1  # below 0.5 threshold
    low.embedding = np.ones(512, dtype=np.float32)
    low.normed_embedding = np.ones(512, dtype=np.float32)

    service = _make_dummy_service(faces=[low])
    pipeline = Pipeline(service, settings)
    img_bytes = _make_image_bytes()
    with pytest.raises(NoFaceFoundError):
        pipeline._extract_face(img_bytes)


@pytest.mark.asyncio
async def test_pipeline_run_embedding_fallback_when_search_empty() -> None:
    settings = _make_settings()
    fake_face = MagicMock()
    fake_face.bbox = np.array([50, 50, 150, 150], dtype=np.float32)
    fake_face.det_score = 0.99
    fake_face.embedding = np.ones(512, dtype=np.float32)
    fake_face.normed_embedding = np.ones(512, dtype=np.float32)

    service = _make_dummy_service(faces=[fake_face])
    pipeline = Pipeline(service, settings)
    # Isolate from real cache/DB and similarity (unit test of search→fallback path)
    pipeline._cache = MagicMock()
    pipeline._cache.lookup.return_value = None
    pipeline._cache.write = MagicMock()
    pipeline._similarity = None  # type: ignore[assignment]

    from unittest.mock import AsyncMock

    pipeline._search.search = AsyncMock(return_value=[])

    img_bytes = _make_image_bytes()
    result = await pipeline.run(img_bytes)
    assert result.anchor_strategy == "embedding"
    assert len(result.results) == 1
    assert result.results[0].url.startswith("face-embedding://")
    assert result.engines_used == ["embedding-fallback"]


@pytest.mark.asyncio
async def test_pipeline_run_search_success() -> None:
    from unittest.mock import AsyncMock

    from mira_serve.search import SearchResult

    settings = _make_settings()
    fake_face = MagicMock()
    fake_face.bbox = np.array([50, 50, 150, 150], dtype=np.float32)
    fake_face.det_score = 0.99
    fake_face.embedding = np.ones(512, dtype=np.float32)
    fake_face.normed_embedding = np.ones(512, dtype=np.float32)

    service = _make_dummy_service(faces=[fake_face])
    pipeline = Pipeline(service, settings)
    pipeline._cache = MagicMock()
    pipeline._cache.lookup.return_value = None
    pipeline._cache.write = MagicMock()
    pipeline._similarity = None  # type: ignore[assignment]

    mock_result = SearchResult(
        url="https://twitter.com/test",
        platform="twitter",
        title="Test",
        snippet="snip",
        image_url=None,
        fetched_at=123,
        source_strategy="serpapi",
        engine="google_lens",
    )
    pipeline._search.search = AsyncMock(return_value=[mock_result])

    img_bytes = _make_image_bytes()
    result = await pipeline.run(img_bytes)
    assert result.anchor_strategy == "search"
    assert len(result.results) == 1
    assert result.results[0].url == "https://twitter.com/test"
    assert result.engines_used == ["google_lens"]
