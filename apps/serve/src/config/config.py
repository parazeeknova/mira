from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Settings:
    host: str
    port: int
    model_pack: str
    model_root: str
    detector_width: int
    detector_height: int
    match_threshold: float
    match_top_k: int
    match_margin_threshold: float
    min_detection_confidence: float
    reload_interval_seconds: float
    tracking_enabled: bool
    tracker_activation_threshold: float
    tracker_matching_threshold: float
    tracker_lost_buffer: int
    tracker_minimum_consecutive_frames: int
    tracker_frame_rate: int
    tracker_box_smoothing_alpha: float
    tracker_identity_switch_hits: int
    tracker_stable_confidence_floor: float
    tracker_track_hold_ms: int
    serpapi_key: str | None
    search_timeout_seconds: float
    search_max_results: int
    pipeline_enabled: bool
    face_crop_padding_x: float
    face_crop_padding_y: float
    google_vision_enabled: bool
    google_vision_max_results: int
    # --- FaceCheck.id (engine 4) ---
    facecheck_api_token: str | None = None
    facecheck_max_results: int = 8
    facecheck_demo: bool = False
    # --- Firecrawl enrichment (post-page scrape) ---
    firecrawl_url: str | None = None
    firecrawl_api_key: str | None = None
    firecrawl_max_targets: int = 3
    firecrawl_timeout_seconds: float = 15.0
    # --- Pipeline thresholds ---
    cosine_threshold: float = 0.35
    # --- Cache (Stage 2 / 5b) ---
    cache_threshold: float = 0.60
    cache_db_path: str = "../../../data/mira_cache.db"

    @property
    def detector_size(self) -> tuple[int, int]:
        return (self.detector_width, self.detector_height)


def _dotenv_candidates() -> list[Path]:
    # First-file-wins loader (only sets keys not already in os.environ),
    # so order matters: the gitignored private root `.env` (override) must
    # come before `.env.development` (defaults).
    # src/config/config.py → parents[3] = apps/serve, parents[4] = repo root
    here = Path(__file__).resolve()
    return [
        here.parents[4] / ".env",  # private overrides
        here.parents[4] / ".env.development",  # shared defaults
        here.parents[3] / ".env",
        Path.cwd() / ".env",
        Path.cwd().parent / ".env",
    ]


def _load_dotenv() -> None:
    # Lightweight .env loader: no external dep, respects existing env vars
    seen: set[Path] = set()
    for env_path in _dotenv_candidates():
        if env_path in seen or not env_path.is_file():
            continue
        seen.add(env_path)
        try:
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
        except Exception:
            continue


def load_settings() -> Settings:
    _load_dotenv()
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
        tracking_enabled=True,
        tracker_activation_threshold=0.35,
        tracker_matching_threshold=0.8,
        tracker_lost_buffer=10,
        tracker_minimum_consecutive_frames=1,
        tracker_frame_rate=6,
        tracker_box_smoothing_alpha=0.58,
        tracker_identity_switch_hits=2,
        tracker_stable_confidence_floor=0.48,
        tracker_track_hold_ms=4_000,
        serpapi_key=os.getenv("SERPAPI_KEY") or None,
        search_timeout_seconds=float(os.getenv("SEARCH_TIMEOUT_SECONDS", "12")),
        search_max_results=int(os.getenv("SEARCH_MAX_RESULTS", "5")),
        pipeline_enabled=os.getenv("PIPELINE_ENABLED", "true").lower() == "true",
        face_crop_padding_x=float(os.getenv("FACE_CROP_PADDING_X", "1.0")),
        face_crop_padding_y=float(os.getenv("FACE_CROP_PADDING_Y", "1.0")),
        google_vision_enabled=os.getenv("GOOGLE_VISION_ENABLED", "true").lower()
        == "true",
        google_vision_max_results=int(os.getenv("GOOGLE_VISION_MAX_RESULTS", "5")),
        facecheck_api_token=os.getenv("FACECHECK_API_TOKEN") or None,
        facecheck_max_results=int(os.getenv("FACECHECK_MAX_RESULTS", "8")),
        facecheck_demo=os.getenv("FACECHECK_DEMO", "false").lower() == "true",
        firecrawl_url=os.getenv("FIRECRAWL_URL") or None,
        firecrawl_api_key=os.getenv("FIRECRAWL_API_KEY") or None,
        firecrawl_max_targets=int(os.getenv("FIRECRAWL_MAX_TARGETS", "3")),
        firecrawl_timeout_seconds=float(os.getenv("FIRECRAWL_TIMEOUT_SECONDS", "15")),
        cosine_threshold=float(os.getenv("COSINE_THRESHOLD", "0.35")),
        cache_threshold=float(os.getenv("CACHE_THRESHOLD", "0.60")),
        cache_db_path=os.getenv("CACHE_DB_PATH", "../../../data/mira_cache.db"),
    )
