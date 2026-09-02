from __future__ import annotations

import base64
import io
from unittest.mock import AsyncMock, MagicMock, PropertyMock

import numpy as np
import pytest
from PIL import Image

from config.config import Settings
from search.search import SearchResult
from search.similarity import ArcFaceSimilarity


def _make_settings(threshold: float = 0.35) -> Settings:
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
        cosine_threshold=threshold,
        cache_threshold=0.60,
        cache_db_path=":memory:",
    )


def _b64_image_bytes(color: str = "white", size: int = 32) -> str:
    img = Image.new("RGB", (size, size), color=color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    b = buf.getvalue()
    return "data:image/jpeg;base64," + base64.b64encode(b).decode()


def _make_face(bbox, embedding: np.ndarray):
    f = MagicMock()
    f.bbox = np.array(bbox, dtype=np.float32)
    f.det_score = 0.99
    f.embedding = embedding
    f.normed_embedding = embedding / float(np.linalg.norm(embedding))
    return f


def _make_service_with_faces(faces_per_call: list[list[MagicMock]]):
    """Mock service that returns faces sequentially per call to analysis.get."""
    service = MagicMock()
    # decode returns a dummy BGR image (any array)
    service.decode_image_bytes.return_value = (
        np.ones((112, 112, 3), dtype=np.uint8) * 128
    )
    mock_analysis = MagicMock()
    # Side effect: pop from list
    calls = {"i": 0}

    def fake_get(img):
        idx = calls["i"]
        calls["i"] += 1
        if idx < len(faces_per_call):
            return faces_per_call[idx]
        return []

    mock_analysis.get.side_effect = fake_get
    type(service).analysis = PropertyMock(return_value=mock_analysis)
    return service


@pytest.mark.asyncio
async def test_empty_candidates_returns_empty() -> None:
    settings = _make_settings()
    sim = ArcFaceSimilarity(settings)
    inp = np.random.randn(512).astype(np.float32)
    inp = inp / float(np.linalg.norm(inp))
    res = await sim.rank_candidates(inp, [], MagicMock())
    assert res == []
    await sim.aclose()


@pytest.mark.asyncio
async def test_below_threshold_discarded() -> None:
    settings = _make_settings(threshold=0.90)  # very strict
    sim = ArcFaceSimilarity(settings)
    inp = np.ones(512, dtype=np.float32)
    inp = inp / float(np.linalg.norm(inp))

    # Candidate embedding orthogonal → cosine ~0
    cand_emb = np.random.randn(512).astype(np.float32)
    cand_emb = cand_emb / float(np.linalg.norm(cand_emb))
    # Make sure cosine is low (<0.9)
    cos = float(np.dot(inp, cand_emb))
    if cos >= 0.9:
        cand_emb = -inp

    service = _make_service_with_faces([[_make_face([0, 0, 50, 50], cand_emb)]])
    cand = SearchResult(
        url="https://example.com/a",
        platform="web",
        title=None,
        snippet=None,
        image_url="https://example.com/a.jpg",
        fetched_at=0,
        source_strategy="serpapi",
        engine="google_lens",
        has_image=False,
    )
    # Mock download to return valid jpeg so rank proceeds
    sim._download_candidate = AsyncMock(return_value=b"fake-jpeg-bytes" * 100)  # type: ignore[method-assign]
    res = await sim.rank_candidates(inp, [cand], service)
    assert res == []
    await sim.aclose()


@pytest.mark.asyncio
async def test_no_face_in_candidate_image_discarded() -> None:
    settings = _make_settings()
    sim = ArcFaceSimilarity(settings)
    inp = np.ones(512, dtype=np.float32)
    inp = inp / float(np.linalg.norm(inp))
    # Service returns no faces
    service = _make_service_with_faces([[]])
    cand = SearchResult(
        url="https://example.com/a",
        platform="web",
        title=None,
        snippet=None,
        image_url="https://example.com/a.jpg",
        fetched_at=0,
        source_strategy="serpapi",
        engine="google_lens",
        has_image=False,
    )
    sim._download_candidate = AsyncMock(return_value=b"fakejpeg" * 100)  # type: ignore[method-assign]
    res = await sim.rank_candidates(inp, [cand], service)
    assert res == []
    await sim.aclose()


@pytest.mark.asyncio
async def test_facecheck_score_blending() -> None:
    """FaceCheck: final = 0.6×cosine + 0.4×facecheck_norm"""
    settings = _make_settings(threshold=0.0)
    sim = ArcFaceSimilarity(settings)
    inp = np.ones(512, dtype=np.float32)
    inp = inp / float(np.linalg.norm(inp))
    # Candidate embedding identical → cosine=1.0
    cand_emb = inp.copy()
    service = _make_service_with_faces([[_make_face([0, 0, 50, 50], cand_emb)]])
    b64 = _b64_image_bytes()
    cand = SearchResult(
        url="https://example.com/fc",
        platform="web",
        title=None,
        snippet=None,
        image_url=None,
        fetched_at=0,
        source_strategy="facecheck",
        engine="facecheck",
        base64=b64,
        facecheck_score=80,
        has_image=True,
    )
    res = await sim.rank_candidates(inp, [cand], service)
    assert len(res) == 1
    # cosine 1.0, facecheck_norm 0.8 → 0.6*1 +0.4*0.8 = 0.92
    assert res[0].similarity == pytest.approx(1.0, abs=0.02)
    assert res[0].final_score == pytest.approx(0.92, abs=0.02)
    await sim.aclose()


@pytest.mark.asyncio
async def test_url_candidate_multi_source_boost() -> None:
    """URL candidates: final = cosine × (1 + 0.2×multi_source_count)"""
    settings = _make_settings(threshold=0.0)
    sim = ArcFaceSimilarity(settings)
    inp = np.ones(512, dtype=np.float32)
    inp = inp / float(np.linalg.norm(inp))
    cand_emb = inp.copy()
    service = _make_service_with_faces([[_make_face([0, 0, 50, 50], cand_emb)]])
    cand = SearchResult(
        url="https://example.com/a",
        platform="web",
        title=None,
        snippet=None,
        image_url="https://example.com/a.jpg",
        fetched_at=0,
        source_strategy="serpapi",
        engine="google_lens",
        has_image=False,
        multi_source_count=2,
    )
    sim._download_candidate = AsyncMock(return_value=b"fakejpeg" * 100)  # type: ignore[method-assign]
    res = await sim.rank_candidates(inp, [cand], service)
    assert len(res) == 1
    # cosine 1.0 × (1+0.2*2)=1.4
    assert res[0].final_score == pytest.approx(1.4, abs=0.02)
    await sim.aclose()


@pytest.mark.asyncio
async def test_ranking_order_by_final_score() -> None:
    settings = _make_settings(threshold=0.0)
    sim = ArcFaceSimilarity(settings)
    inp = np.ones(512, dtype=np.float32)
    inp = inp / float(np.linalg.norm(inp))

    # Two candidates: one high cosine, one low
    high_emb = inp.copy()  # cos 1.0
    # Create low cosine embedding: ~0.2
    low_emb = np.random.randn(512).astype(np.float32)
    low_emb = low_emb / float(np.linalg.norm(low_emb))
    # Ensure orthogonal-ish to inp
    low_emb = low_emb - np.dot(low_emb, inp) * inp
    low_emb = low_emb / float(np.linalg.norm(low_emb))
    # Blend slightly with inp to get ~0.3 cosine
    low_emb = 0.3 * inp + 0.7 * low_emb
    low_emb = low_emb / float(np.linalg.norm(low_emb))

    service = _make_service_with_faces(
        [
            [_make_face([0, 0, 50, 50], high_emb)],
            [_make_face([0, 0, 50, 50], low_emb)],
        ]
    )
    b64 = _b64_image_bytes()
    c_high = SearchResult(
        url="https://example.com/high",
        platform="twitter",
        title=None,
        snippet=None,
        image_url=None,
        fetched_at=0,
        source_strategy="facecheck",
        engine="facecheck",
        base64=b64,
        facecheck_score=50,
        has_image=True,
    )
    c_low = SearchResult(
        url="https://example.com/low",
        platform="web",
        title=None,
        snippet=None,
        image_url="https://example.com/low.jpg",
        fetched_at=0,
        source_strategy="serpapi",
        engine="yandex",
        has_image=False,
    )
    sim._download_candidate = AsyncMock(return_value=b"fakejpeg" * 100)  # type: ignore[method-assign]
    res = await sim.rank_candidates(inp, [c_low, c_high], service)
    assert len(res) == 2
    assert res[0].url == "https://example.com/high"
    assert res[1].url == "https://example.com/low"
    await sim.aclose()


@pytest.mark.asyncio
async def test_facecheck_base64_decode_without_download() -> None:
    """FaceCheck candidates should be decoded in-memory, not via _download_candidate."""
    settings = _make_settings(threshold=0.0)
    sim = ArcFaceSimilarity(settings)
    inp = np.ones(512, dtype=np.float32)
    inp = inp / float(np.linalg.norm(inp))
    cand_emb = inp.copy()
    service = _make_service_with_faces([[_make_face([0, 0, 50, 50], cand_emb)]])
    b64 = _b64_image_bytes()
    cand = SearchResult(
        url="https://example.com/fc",
        platform="web",
        title=None,
        snippet=None,
        image_url=None,
        fetched_at=0,
        source_strategy="facecheck",
        engine="facecheck",
        base64=b64,
        facecheck_score=90,
        has_image=True,
    )
    # If download were called, it would be mocked to fail; but FaceCheck should not call it
    sim._download_candidate = AsyncMock(return_value=None)  # type: ignore[method-assign]
    res = await sim.rank_candidates(inp, [cand], service)
    assert len(res) == 1
    # Ensure download not called
    sim._download_candidate.assert_not_called()
    await sim.aclose()


@pytest.mark.asyncio
async def test_similarity_handles_corrupt_base64() -> None:
    settings = _make_settings(threshold=0.0)
    sim = ArcFaceSimilarity(settings)
    inp = np.ones(512, dtype=np.float32)
    inp = inp / float(np.linalg.norm(inp))
    cand = SearchResult(
        url="https://example.com/bad",
        platform="web",
        title=None,
        snippet=None,
        image_url=None,
        fetched_at=0,
        source_strategy="facecheck",
        engine="facecheck",
        base64="data:image/webp;base64,not-valid!!!",
        facecheck_score=90,
        has_image=True,
    )
    service = _make_service_with_faces([])
    res = await sim.rank_candidates(inp, [cand], service)
    # Corrupt base64 → no image acquired → empty
    assert res == []
    await sim.aclose()


@pytest.mark.asyncio
async def test_mixed_groups_both_processed() -> None:
    settings = _make_settings(threshold=0.0)
    sim = ArcFaceSimilarity(settings)
    inp = np.ones(512, dtype=np.float32)
    inp = inp / float(np.linalg.norm(inp))
    emb = inp.copy()
    service = _make_service_with_faces(
        [
            [_make_face([0, 0, 50, 50], emb)],
            [_make_face([0, 0, 50, 50], emb)],
        ]
    )
    b64 = _b64_image_bytes()
    fc_cand = SearchResult(
        url="https://example.com/fc",
        platform="twitter",
        title=None,
        snippet=None,
        image_url=None,
        fetched_at=0,
        source_strategy="facecheck",
        engine="facecheck",
        base64=b64,
        facecheck_score=90,
        has_image=True,
    )
    url_cand = SearchResult(
        url="https://example.com/url",
        platform="web",
        title=None,
        snippet=None,
        image_url="https://example.com/url.jpg",
        fetched_at=0,
        source_strategy="serpapi",
        engine="google_lens",
        has_image=False,
    )
    sim._download_candidate = AsyncMock(return_value=b"fakejpeg" * 200)  # type: ignore[method-assign]
    res = await sim.rank_candidates(inp, [fc_cand, url_cand], service)
    assert len(res) == 2
    urls = {r.url for r in res}
    assert "https://example.com/fc" in urls
    assert "https://example.com/url" in urls
    await sim.aclose()
