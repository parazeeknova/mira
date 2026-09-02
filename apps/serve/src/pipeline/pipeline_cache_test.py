from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, PropertyMock

import numpy as np
import pytest
from PIL import Image

from config.config import Settings
from pipeline.pipeline import Pipeline
from search.search import SearchResult


def _make_settings(tmp_path: Path) -> Settings:
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
        cache_db_path=str(tmp_path / "cache.db"),
        cache_threshold=0.60,
        cosine_threshold=0.35,
    )


def _make_image_bytes() -> bytes:
    img = Image.new("RGB", (32, 32), color="white")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


def _make_dummy_service(embedding: np.ndarray):
    service = MagicMock()
    service.decode_image_bytes.side_effect = lambda data: (
        np.ones((320, 320, 3), dtype=np.uint8) * 255
    )
    fake_face = MagicMock()
    fake_face.bbox = np.array([10, 10, 100, 100], dtype=np.float32)
    fake_face.det_score = 0.99
    fake_face.embedding = embedding
    fake_face.normed_embedding = embedding / float(np.linalg.norm(embedding))
    mock_analysis = MagicMock()
    mock_analysis.get.return_value = [fake_face]
    type(service).analysis = PropertyMock(return_value=mock_analysis)
    return service


@pytest.mark.asyncio
async def test_cache_hit_skips_search(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path)
    emb = np.ones(512, dtype=np.float32)
    emb = emb / float(np.linalg.norm(emb))
    service = _make_dummy_service(emb)

    # Pre-populate cache
    from cache.cache import EmbeddingCache

    cache = EmbeddingCache(settings)
    cached_results = [
        SearchResult(
            url="https://twitter.com/cached",
            platform="twitter",
            title="Cached",
            snippet="hit",
            image_url=None,
            fetched_at=123,
            source_strategy="serpapi",
            engine="google_lens",
            similarity=0.9,
            final_score=0.9,
        )
    ]
    cache.write(
        emb,
        cached_results,
        top_url=cached_results[0].url,
        engines_used=["google_lens"],
        similarity=0.9,
    )

    pipeline = Pipeline(service, settings, cache=cache)
    pipeline._search.search = AsyncMock()  # should NOT be called on hit
    pipeline._similarity = MagicMock()  # should be skipped too
    # Mock similarity not needed; pipeline will skip stages 3-5

    result = await pipeline.run(_make_image_bytes())
    assert result.cache_hit is True
    assert result.results[0].url == "https://twitter.com/cached"
    assert result.anchor_strategy == "search"
    pipeline._search.search.assert_not_called()  # type: ignore[attr-defined]
    await pipeline.aclose()


@pytest.mark.asyncio
async def test_cache_miss_triggers_search_and_write(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path)
    emb = np.ones(512, dtype=np.float32)
    emb = emb / float(np.linalg.norm(emb))
    service = _make_dummy_service(emb)

    from cache.cache import EmbeddingCache

    cache = EmbeddingCache(settings)
    pipeline = Pipeline(service, settings, cache=cache)
    # Mock search to return a result
    mock_res = SearchResult(
        url="https://example.com/live",
        platform="web",
        title="Live",
        snippet="snip",
        image_url=None,
        fetched_at=123,
        source_strategy="serpapi",
        engine="google_lens",
        has_image=False,
    )
    pipeline._search.search = AsyncMock(return_value=[mock_res])
    # Mock similarity to return ranked with scores (so cache write triggers)
    ranked = SearchResult(
        url="https://example.com/live",
        platform="web",
        title="Live",
        snippet="snip",
        image_url=None,
        fetched_at=123,
        source_strategy="serpapi",
        engine="google_lens",
        similarity=0.8,
        final_score=0.9,
    )
    mock_sim = MagicMock()
    mock_sim.rank_candidates = AsyncMock(return_value=[ranked])
    mock_sim.aclose = AsyncMock()
    pipeline._similarity = mock_sim  # type: ignore[assignment]

    result = await pipeline.run(_make_image_bytes())
    assert result.cache_hit is False
    assert result.results[0].url == "https://example.com/live"
    # Verify cache now has entry
    assert cache.count() == 1
    hit = cache.lookup(emb)
    assert hit is not None
    assert hit.top_url == "https://example.com/live"
    await pipeline.aclose()


@pytest.mark.asyncio
async def test_embedding_fallback_not_cached(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path)
    emb = np.ones(512, dtype=np.float32)
    emb = emb / float(np.linalg.norm(emb))
    service = _make_dummy_service(emb)
    from cache.cache import EmbeddingCache

    cache = EmbeddingCache(settings)
    pipeline = Pipeline(service, settings, cache=cache)
    pipeline._search.search = AsyncMock(return_value=[])
    pipeline._similarity = MagicMock()
    pipeline._similarity.rank_candidates = AsyncMock(return_value=[])  # type: ignore[attr-defined]
    pipeline._similarity.aclose = AsyncMock()

    result = await pipeline.run(_make_image_bytes())
    assert result.anchor_strategy == "embedding"
    assert result.results[0].url.startswith("face-embedding://")
    # Fallback must NOT be cached
    assert cache.count() == 0
    assert cache.lookup(emb) is None
    await pipeline.aclose()


@pytest.mark.asyncio
async def test_cache_second_run_is_hit(tmp_path: Path) -> None:
    """End-to-end: first run miss → second run hit (<250ms path)."""
    settings = _make_settings(tmp_path)
    emb = np.ones(512, dtype=np.float32) * 2
    emb = emb / float(np.linalg.norm(emb))
    service = _make_dummy_service(emb)
    from cache.cache import EmbeddingCache

    cache = EmbeddingCache(settings)
    pipeline = Pipeline(service, settings, cache=cache)
    mock_res = SearchResult(
        url="https://example.com/first",
        platform="web",
        title="First",
        snippet="s",
        image_url=None,
        fetched_at=0,
        source_strategy="serpapi",
        engine="google_lens",
        has_image=False,
    )
    ranked = SearchResult(
        url="https://example.com/first",
        platform="web",
        title="First",
        snippet="s",
        image_url=None,
        fetched_at=0,
        source_strategy="serpapi",
        engine="google_lens",
        similarity=0.85,
        final_score=0.85,
    )
    pipeline._search.search = AsyncMock(return_value=[mock_res])
    mock_sim = MagicMock()
    mock_sim.rank_candidates = AsyncMock(return_value=[ranked])
    mock_sim.aclose = AsyncMock()
    pipeline._similarity = mock_sim  # type: ignore[assignment]

    r1 = await pipeline.run(_make_image_bytes())
    assert r1.cache_hit is False
    # Second pipeline instance with same cache file should hit
    service2 = _make_dummy_service(emb)
    pipeline2 = Pipeline(service2, settings, cache=cache)
    pipeline2._search.search = AsyncMock()  # should not be called
    r2 = await pipeline2.run(_make_image_bytes())
    assert r2.cache_hit is True
    assert r2.results[0].url == "https://example.com/first"
    await pipeline.aclose()
    await pipeline2.aclose()


@pytest.mark.asyncio
async def test_similarity_filters_then_fallback(tmp_path: Path) -> None:
    """If search returns candidates but similarity filters all, should fallback, not return raw."""
    settings = _make_settings(tmp_path)
    emb = np.ones(512, dtype=np.float32)
    emb = emb / float(np.linalg.norm(emb))
    service = _make_dummy_service(emb)
    from cache.cache import EmbeddingCache

    cache = EmbeddingCache(settings)
    pipeline = Pipeline(service, settings, cache=cache)
    mock_res = SearchResult(
        url="https://example.com/a",
        platform="web",
        title=None,
        snippet=None,
        image_url="https://example.com/a.jpg",
        fetched_at=0,
        source_strategy="serpapi",
        engine="google_lens",
    )
    pipeline._search.search = AsyncMock(return_value=[mock_res])
    mock_sim = MagicMock()
    mock_sim.rank_candidates = AsyncMock(return_value=[])  # filtered all
    mock_sim.aclose = AsyncMock()
    pipeline._similarity = mock_sim  # type: ignore[assignment]

    result = await pipeline.run(_make_image_bytes())
    assert result.anchor_strategy == "embedding"
    assert result.results[0].url.startswith("face-embedding://")
    assert cache.count() == 0
    await pipeline.aclose()
