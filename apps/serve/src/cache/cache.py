# ruff: noqa
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from config.config import Settings

if TYPE_CHECKING:
    from search.search import SearchResult

logger = logging.getLogger(__name__)

_EMBEDDING_DIM = 512
_EMBEDDING_BYTES = _EMBEDDING_DIM * 4  # float32


@dataclass(frozen=True, slots=True)
class CachedResult:
    results: list[SearchResult]
    top_url: str
    similarity: float
    engines_used: list[str]
    created_at: int
    updated_at: int
    cache_hit: int


def _resolve_db_path(raw: str) -> Path:
    p = Path(raw)
    if p.is_absolute():
        return p
    base = Path(__file__).resolve().parent
    return (base / p).resolve()


class EmbeddingCache:
    """SQLite embedding cache with brute-force cosine lookup.

    Performance: <5 ms for ~5000 entries via single matrix multiply.
    Thread-safe via connection-per-call + threading.Lock for writes.
    WAL mode prevents read/write blocking. In-memory matrix avoids
    re-reading SQLite on every lookup when DB unchanged.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._db_path = _resolve_db_path(settings.cache_db_path)
        self._lock = threading.Lock()
        # In-memory matrix cache
        self._matrix: np.ndarray | None = None  # shape [N, 512]
        self._rows_cache: list[dict[str, Any]] | None = None
        self._row_count: int = -1
        self._max_updated_at: int = -1
        self._init_db()

    # -- schema ----------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self._db_path),
            timeout=10.0,
            check_same_thread=False,
            isolation_level=None,  # autocommit
        )
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA cache_size=-64000;")  # 64 MB
        conn.execute("PRAGMA temp_store=MEMORY;")
        conn.execute("PRAGMA busy_timeout=5000;")
        return conn

    def _init_db(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS face_cache (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    embedding    BLOB    NOT NULL,
                    top_url      TEXT    NOT NULL,
                    similarity   REAL    NOT NULL,
                    engines_used TEXT    NOT NULL,
                    results_json TEXT    NOT NULL,
                    cache_hit    INTEGER DEFAULT 0,
                    created_at   INTEGER NOT NULL,
                    updated_at   INTEGER NOT NULL
                );
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_created ON face_cache(created_at);"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_updated ON face_cache(updated_at);"
            )
        finally:
            conn.close()

    # -- internal matrix load --------------------------------------------

    def _load_matrix(self) -> tuple[np.ndarray | None, list[dict[str, Any]]]:
        """Load all rows and build [N,512] matrix. Uses in-memory cache if row count unchanged."""
        conn = self._connect()
        try:
            # Fast path: check row count + max updated_at without loading blobs
            cur = conn.execute(
                "SELECT COUNT(*), COALESCE(MAX(updated_at), 0) FROM face_cache"
            )
            row = cur.fetchone()
            count = int(row[0]) if row else 0
            max_ts = int(row[1]) if row else 0
            if count == 0:
                self._matrix = None
                self._rows_cache = []
                self._row_count = 0
                self._max_updated_at = 0
                return None, []

            # Cache hit: same count and same max timestamp → no change
            if (
                self._matrix is not None
                and self._rows_cache is not None
                and count == self._row_count
                and max_ts == self._max_updated_at
            ):
                return self._matrix, self._rows_cache

            # Reload
            cur = conn.execute(
                "SELECT id, embedding, top_url, similarity, engines_used, results_json, cache_hit, created_at, updated_at FROM face_cache ORDER BY id ASC"
            )
            rows = cur.fetchall()
            embeddings: list[np.ndarray] = []
            row_dicts: list[dict[str, Any]] = []
            for r in rows:
                (
                    _id,
                    emb_blob,
                    top_url,
                    sim,
                    engines_json,
                    results_json,
                    hit,
                    c_at,
                    u_at,
                ) = r
                # Validate blob size
                if not isinstance(emb_blob, (bytes, bytearray)):
                    logger.warning(
                        "cache: row %s has non-bytes embedding, skipping", _id
                    )
                    continue
                if len(emb_blob) != _EMBEDDING_BYTES:
                    logger.warning(
                        "cache: row %s embedding size %s != %s, skipping",
                        _id,
                        len(emb_blob),
                        _EMBEDDING_BYTES,
                    )
                    continue
                arr = np.frombuffer(emb_blob, dtype=np.float32).copy()
                if arr.shape != (_EMBEDDING_DIM,):
                    logger.warning(
                        "cache: row %s shape %s != (%s,), skipping",
                        _id,
                        arr.shape,
                        _EMBEDDING_DIM,
                    )
                    continue
                embeddings.append(arr)
                row_dicts.append(
                    {
                        "id": _id,
                        "top_url": top_url,
                        "similarity": sim,
                        "engines_used": engines_json,
                        "results_json": results_json,
                        "cache_hit": hit,
                        "created_at": c_at,
                        "updated_at": u_at,
                    }
                )

            if not embeddings:
                self._matrix = None
                self._rows_cache = []
                self._row_count = 0
                self._max_updated_at = max_ts
                return None, []

            mat = np.vstack(embeddings).astype(np.float32)  # [N,512]
            self._matrix = mat
            self._rows_cache = row_dicts
            self._row_count = count
            self._max_updated_at = max_ts
            return mat, row_dicts
        finally:
            conn.close()

    # -- public API ------------------------------------------------------

    def lookup(self, input_embedding: np.ndarray) -> CachedResult | None:
        """Brute-force cosine lookup. Both embeddings are L2-normed → dot == cosine.

        Returns CachedResult if best score >= cache_threshold, else None.
        Also bumps cache_hit counter and updated_at on hit.
        """
        try:
            emb = np.asarray(input_embedding, dtype=np.float32).reshape(512)
            # Ensure L2-normalized (defensive: normalize if not)
            norm = np.linalg.norm(emb)
            if norm == 0:
                return None
            if abs(norm - 1.0) > 1e-3:
                emb = emb / norm

            matrix, rows = self._load_matrix()
            if matrix is None or not rows:
                return None

            # Single matrix multiply: [512] @ [512, N] → [N]
            scores = emb @ matrix.T  # cosine similarities
            best_idx = int(np.argmax(scores))
            best_score = float(scores[best_idx])
            if best_score < self._settings.cache_threshold:
                return None

            row = rows[best_idx]
            row_id = int(row["id"])

            # Bump hit counter atomically
            now = int(time.time() * 1000)
            try:
                with self._lock:
                    conn = self._connect()
                    try:
                        conn.execute(
                            "UPDATE face_cache SET cache_hit = cache_hit + 1, updated_at = ? WHERE id = ?",
                            (now, row_id),
                        )
                    finally:
                        conn.close()
                # Invalidate matrix cache max_ts so next load reflects new timestamp
                self._max_updated_at = -1
            except Exception:
                logger.warning(
                    "cache: failed to bump hit counter for id %s", row_id, exc_info=True
                )

            # Deserialize results
            try:
                engines_used: list[str] = (
                    json.loads(row["engines_used"])
                    if isinstance(row["engines_used"], str)
                    else []
                )
            except Exception:
                engines_used = []
            results_json = row["results_json"]
            results: list[SearchResult] = []
            try:
                from search.search import SearchResult as _SR  # local import to avoid cycle

                raw_list = (
                    json.loads(results_json) if isinstance(results_json, str) else []
                )
                if isinstance(raw_list, list):
                    for item in raw_list:
                        if not isinstance(item, dict):
                            continue
                        try:
                            # Reconstruct via protocol dict → SearchResult fields
                            # Support both old and new field sets
                            url = item.get("url") or item.get("top_url") or ""
                            if not isinstance(url, str) or not url:
                                continue
                            platform = item.get("platform", "web")
                            title = item.get("title")
                            snippet = item.get("snippet")
                            image_url = item.get("imageUrl") or item.get("image_url")
                            fetched_at = (
                                item.get("fetchedAt") or item.get("fetched_at") or now
                            )
                            source_strategy = (
                                item.get("sourceStrategy")
                                or item.get("source_strategy")
                                or "cache"
                            )
                            engine = item.get("engine", "cache")
                            # Extended fields (optional)
                            base64_data = item.get("base64")
                            facecheck_score = item.get("facecheckScore") or item.get(
                                "facecheck_score"
                            )
                            has_image = bool(
                                item.get("hasImage") or item.get("has_image") or False
                            )
                            multi_source_count = int(
                                item.get("multiSourceCount")
                                or item.get("multi_source_count")
                                or 0
                            )
                            similarity = item.get("similarity")
                            final_score = item.get("finalScore") or item.get(
                                "final_score"
                            )
                            enriched_snippet = item.get("enrichedSnippet")
                            raw_socials = item.get("socialLinks") or []
                            social_links = tuple(
                                (str(entry.get("label", "")), str(entry.get("url", "")))
                                for entry in raw_socials
                                if isinstance(entry, dict) and entry.get("url")
                            )
                            results.append(
                                _SR(
                                    url=url,
                                    platform=str(platform),
                                    title=title if isinstance(title, str) else None,
                                    snippet=snippet
                                    if isinstance(snippet, str)
                                    else None,
                                    image_url=image_url
                                    if isinstance(image_url, str)
                                    else None,
                                    fetched_at=int(fetched_at),
                                    source_strategy=str(source_strategy),
                                    engine=str(engine),
                                    base64=base64_data
                                    if isinstance(base64_data, str)
                                    else None,
                                    facecheck_score=int(facecheck_score)
                                    if isinstance(facecheck_score, int)
                                    else None,
                                    has_image=has_image,
                                    multi_source_count=multi_source_count,
                                    similarity=float(similarity)
                                    if isinstance(similarity, (int, float))
                                    else None,
                                    final_score=float(final_score)
                                    if isinstance(final_score, (int, float))
                                    else None,
                                    enriched_snippet=enriched_snippet
                                    if isinstance(enriched_snippet, str)
                                    else None,
                                    social_links=social_links,
                                )
                            )
                        except Exception:
                            continue
            except Exception:
                logger.warning(
                    "cache: failed to deserialize results_json for id %s",
                    row_id,
                    exc_info=True,
                )
                results = []

            return CachedResult(
                results=results,
                top_url=str(row["top_url"]),
                similarity=float(row["similarity"]),
                engines_used=list(engines_used),
                created_at=int(row["created_at"]),
                updated_at=now,
                cache_hit=int(row["cache_hit"]) + 1,
            )
        except Exception:
            logger.warning("cache: lookup failed", exc_info=True)
            return None

    def write(
        self,
        input_embedding: np.ndarray,
        results: list[SearchResult],
        top_url: str,
        engines_used: list[str],
        similarity: float | None = None,
    ) -> None:
        """Persist a new cache entry. Only called for anchor_strategy == 'search'.

        Embedding fallbacks are NOT cached (caller must enforce).
        """
        if not results:
            return
        if not top_url or top_url.startswith("face-embedding://"):
            return
        try:
            emb = np.asarray(input_embedding, dtype=np.float32).reshape(512)
            if emb.shape != (512,):
                logger.warning(
                    "cache: write embedding shape %s != (512,), skip", emb.shape
                )
                return
            # Ensure float32 bytes
            blob = emb.astype(np.float32).tobytes()
            if len(blob) != _EMBEDDING_BYTES:
                logger.warning(
                    "cache: write blob len %s != %s, skip", len(blob), _EMBEDDING_BYTES
                )
                return

            # Serialize results to JSON via protocol dicts
            results_payload = []
            for r in results:
                try:
                    d = r.to_protocol_dict()
                    results_payload.append(d)
                except Exception:
                    continue
            results_json = json.dumps(results_payload, ensure_ascii=False)
            engines_json = json.dumps(list(engines_used), ensure_ascii=False)
            sim_val = (
                float(similarity)
                if similarity is not None
                else float(results[0].similarity or 0.0)
                if hasattr(results[0], "similarity")
                else 0.0
            )
            # Fallback: try to get similarity from first result's final_score or 0
            if sim_val == 0.0 and results:
                # Try final_score as proxy
                fs = getattr(results[0], "final_score", None)
                if isinstance(fs, (int, float)):
                    sim_val = float(fs)

            now = int(time.time() * 1000)
            with self._lock:
                conn = self._connect()
                try:
                    conn.execute(
                        """
                        INSERT INTO face_cache
                            (embedding, top_url, similarity, engines_used, results_json, cache_hit, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
                        """,
                        (blob, top_url, sim_val, engines_json, results_json, now, now),
                    )
                finally:
                    conn.close()
            # Invalidate cache so next lookup sees new row
            self._max_updated_at = -1
            self._row_count = -1
        except Exception:
            logger.warning("cache: write failed for top_url=%s", top_url, exc_info=True)

    def clear(self) -> None:
        """Delete all rows — used in tests."""
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("DELETE FROM face_cache")
            finally:
                conn.close()
        self._matrix = None
        self._rows_cache = None
        self._row_count = -1
        self._max_updated_at = -1

    def count(self) -> int:
        conn = self._connect()
        try:
            cur = conn.execute("SELECT COUNT(*) FROM face_cache")
            row = cur.fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()
