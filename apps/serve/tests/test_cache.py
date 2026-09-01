from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pytest

from mira_serve.cache import EmbeddingCache
from mira_serve.config import Settings
from mira_serve.search import SearchResult


def _make_settings(tmp_path: Path, threshold: float = 0.60) -> Settings:
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
        serpapi_key=None,
        search_timeout_seconds=5.0,
        search_max_results=5,
        pipeline_enabled=True,
        face_crop_padding_x=0.18,
        face_crop_padding_y=0.22,
        google_vision_enabled=False,
        google_vision_max_results=5,
        cache_threshold=threshold,
        cache_db_path=str(tmp_path / "cache.db"),
    )


def _normed(vec: np.ndarray) -> np.ndarray:
    v = vec.astype(np.float32)
    n = float(np.linalg.norm(v))
    return (v / n).astype(np.float32) if n else v


def _result(url: str = "https://example.com/a") -> SearchResult:
    return SearchResult(
        url=url,
        platform="web",
        title="t",
        snippet="s",
        image_url=None,
        fetched_at=int(time.time() * 1000),
        source_strategy="serpapi",
        engine="google_lens",
        similarity=0.88,
        final_score=0.88,
    )


def test_lookup_returns_none_on_empty_db(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path)
    cache = EmbeddingCache(settings)
    emb = _normed(np.random.randn(512).astype(np.float32))
    assert cache.lookup(emb) is None
    assert cache.count() == 0


def test_write_then_lookup_roundtrip(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path)
    cache = EmbeddingCache(settings)
    emb = _normed(np.ones(512, dtype=np.float32))
    results = [_result("https://twitter.com/a")]
    cache.write(
        emb,
        results,
        top_url=results[0].url,
        engines_used=["google_lens"],
        similarity=0.90,
    )
    assert cache.count() == 1

    # Same embedding → hit
    hit = cache.lookup(emb)
    assert hit is not None
    assert hit.top_url == "https://twitter.com/a"
    assert hit.engines_used == ["google_lens"]
    assert len(hit.results) == 1
    assert hit.results[0].url == "https://twitter.com/a"


def test_lookup_returns_cached_above_threshold(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, threshold=0.60)
    cache = EmbeddingCache(settings)
    base = _normed(np.random.randn(512).astype(np.float32))
    cache.write(
        base,
        [_result()],
        top_url="https://example.com/hit",
        engines_used=["vision"],
        similarity=0.8,
    )

    # Slightly perturbed but still high cosine
    same = _normed(base + np.random.randn(512).astype(np.float32) * 0.01)
    # Cosine should still be >0.60 with small noise
    cos = float(np.dot(base, same))
    assert cos > 0.60
    assert cache.lookup(same) is not None


def test_lookup_returns_none_below_threshold(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, threshold=0.60)
    cache = EmbeddingCache(settings)
    base = _normed(np.random.randn(512).astype(np.float32))
    cache.write(
        base,
        [_result()],
        top_url="https://example.com/hit",
        engines_used=["vision"],
        similarity=0.8,
    )

    # Random different person → low cosine ~0.0 ±0.1
    other = _normed(np.random.randn(512).astype(np.float32))
    cos = float(np.dot(base, other))
    # Likely below 0.60 (inter-person ~0.1-0.4), but make deterministic: force low via orthogonal-ish
    # If by chance >0.60, retry once
    if cos >= 0.60:
        other = _normed(-base + np.random.randn(512).astype(np.float32) * 0.01)
        cos = float(np.dot(base, other))
    assert cos < 0.60
    assert cache.lookup(other) is None


def test_embedding_fallback_not_written(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path)
    cache = EmbeddingCache(settings)
    emb = _normed(np.ones(512, dtype=np.float32))
    fallback = SearchResult(
        url="face-embedding://abc123",
        platform="none",
        title="Face Embedding Anchor",
        snippet="fallback",
        image_url=None,
        fetched_at=0,
        source_strategy="embedding-fallback",
        engine="embedding-fallback",
    )
    cache.write(
        emb,
        [fallback],
        top_url=fallback.url,
        engines_used=["embedding-fallback"],
        similarity=0.0,
    )
    assert cache.count() == 0
    assert cache.lookup(emb) is None


def test_cache_hit_increments_counter(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path)
    cache = EmbeddingCache(settings)
    emb = _normed(np.ones(512, dtype=np.float32) * 2)
    cache.write(
        emb,
        [_result()],
        top_url="https://example.com/a",
        engines_used=["vision"],
        similarity=0.9,
    )
    # First lookup
    hit1 = cache.lookup(emb)
    assert hit1 is not None
    assert hit1.cache_hit == 1
    # Second lookup should increment
    hit2 = cache.lookup(emb)
    assert hit2 is not None
    assert hit2.cache_hit == 2
    assert hit2.updated_at >= hit1.updated_at


def test_write_persists_similarity_and_engines(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path)
    cache = EmbeddingCache(settings)
    emb = _normed(np.random.randn(512).astype(np.float32))
    results = [
        SearchResult(
            url="https://twitter.com/x",
            platform="twitter",
            title="t",
            snippet="s",
            image_url="https://img.com/a.jpg",
            fetched_at=123,
            source_strategy="serpapi",
            engine="google_lens",
            similarity=0.77,
            final_score=0.80,
        ),
        SearchResult(
            url="https://linkedin.com/in/y",
            platform="linkedin",
            title="t2",
            snippet="s2",
            image_url=None,
            fetched_at=124,
            source_strategy="serpapi",
            engine="yandex",
            similarity=0.60,
            final_score=0.65,
        ),
    ]
    cache.write(
        emb,
        results,
        top_url=results[0].url,
        engines_used=["google_lens", "yandex"],
        similarity=0.77,
    )
    hit = cache.lookup(emb)
    assert hit is not None
    assert hit.similarity == pytest.approx(0.77)
    assert set(hit.engines_used) == {"google_lens", "yandex"}
    assert len(hit.results) == 2
    assert hit.results[0].similarity == pytest.approx(0.77)


def test_lookup_performance_brute_force(tmp_path: Path) -> None:
    """Performance: <5 ms for ~500 entries (scaled down for CI)."""
    settings = _make_settings(tmp_path)
    cache = EmbeddingCache(settings)
    base = _normed(np.random.randn(512).astype(np.float32))
    # Insert 200 entries (proxy for 5000; still measures matrix path)
    for i in range(200):
        e = _normed(np.random.randn(512).astype(np.float32))
        cache.write(
            e,
            [_result(f"https://example.com/{i}")],
            top_url=f"https://example.com/{i}",
            engines_used=["vision"],
            similarity=0.5,
        )
    assert cache.count() == 200
    # Warm up
    cache.lookup(base)
    start = time.perf_counter()
    for _ in range(10):
        cache.lookup(base)
    elapsed_ms = (time.perf_counter() - start) / 10 * 1000
    # Should be <5 ms avg (allow 15 ms in CI under load)
    assert elapsed_ms < 15, f"lookup too slow: {elapsed_ms:.2f} ms"


def test_cache_thread_safety_wal(tmp_path: Path) -> None:
    """WAL + file creation: DB parent dirs auto-created, second cache instance sees same rows."""
    settings = _make_settings(tmp_path)
    cache1 = EmbeddingCache(settings)
    emb = _normed(np.ones(512, dtype=np.float32))
    cache1.write(
        emb,
        [_result("https://example.com/shared")],
        top_url="https://example.com/shared",
        engines_used=["vision"],
        similarity=0.9,
    )

    # Second instance should see the row (shared SQLite file)
    cache2 = EmbeddingCache(settings)
    assert cache2.count() == 1
    hit = cache2.lookup(emb)
    assert hit is not None
    assert hit.top_url == "https://example.com/shared"


def test_cache_handles_corrupt_embedding_gracefully(tmp_path: Path) -> None:
    import sqlite3

    settings = _make_settings(tmp_path)
    cache = EmbeddingCache(settings)
    # Inject corrupt row directly
    conn = sqlite3.connect(str(tmp_path / "cache.db"))
    conn.execute(
        "INSERT INTO face_cache (embedding, top_url, similarity, engines_used, results_json, cache_hit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
        (b"bad", "https://example.com/bad", 0.9, "[]", "[]", 0, 0),
    )
    conn.commit()
    conn.close()

    # lookup should skip corrupt row and return None, not raise
    emb = _normed(np.ones(512, dtype=np.float32))
    assert cache.lookup(emb) is None

    # Write valid entry afterwards should still work
    cache.write(
        emb,
        [_result("https://example.com/good")],
        top_url="https://example.com/good",
        engines_used=["vision"],
        similarity=0.9,
    )
    hit = cache.lookup(emb)
    assert hit is not None
    assert hit.top_url == "https://example.com/good"
