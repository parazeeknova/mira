### Mira

Mira is a fully local, closed-set face recognition system built for controlled environments where every identity is explicitly enrolled in advance. The product is designed around deterministic matching over a private identity set rather than open-world recognition, cloud APIs, or scraped public data. The output is a live operator view that overlays names, roles, colors, and confidence on top of a local camera feed while keeping transport, inference, and enrollment boundaries explicit.

### Architecture

The Turborepo is split into two services with a deliberate separation of responsibilities. The Bun app is the orchestration layer: it serves the browser client, owns the browser session, handles signaling and WebSocket transport, accepts sampled frames from the canvas pipeline, and relays structured inference results back to the client for overlay rendering. The Python service is the compute layer: it receives compressed frame payloads over a persistent WebSocket, performs detection, embedding, matching, and tracking, then returns normalized JSON results without taking on any frontend or session-management work.

### Recognition Stack

The recognition service uses InsightFace with the `buffalo_l` model pack for face detection and embedding generation, backed by ONNX Runtime with CUDA enabled when available and CPU fallback otherwise. Enrolled identities are loaded from a local directory, reduced to normalized prototype embeddings, and indexed in an in-memory FAISS `IndexFlatIP` index so cosine similarity search stays exact and deterministic for a small closed dataset. ByteTrack-based stabilization is applied inside Python to reduce identity flicker across sampled frames, and the browser renders simple face boxes and labels on a 2D canvas rather than introducing a heavier WebGL path before it is necessary.

### Chosen Constraints

The current vertical slice intentionally samples frames in the browser instead of shipping a full media stream into the server for decode, because that keeps local latency predictable and preserves a clean Bun-orchestration versus Python-inference split. Enrollment is folder-based, with one directory per person and a `metadata.json` carrying `name`, `role`, and `color`, and the Python service rebuilds its in-memory state when the enrollment directory changes so the identity set can evolve during development. This keeps Mira optimized for a single local operator session, fast iterative testing, and a privacy-preserving deployment model where all sensitive recognition logic and data remain on the device.

### How to Run ?

**Prerequisites:** `bun@1.4.0`, `uv` (`curl -LsSf https://astral.sh/uv/install.sh | sh`), `python>=3.14` (managed by `uv` via `apps/serve/.python-version`).

**Setup (once, installs JS + Python deps):**
```bash
bun run setup   # = bun install + uv sync --frozen (see scripts/setup.sh)
```

**Configure search engines (apps/serve/.env):**
```bash
cp apps/serve/.env.example apps/serve/.env
```
Every engine is independently gated by its own env var — a missing key is skipped with a warning and the pipeline keeps running on the remaining engines:

| Engine | Env var(s) | Notes |
|---|---|---|
| Google Cloud Vision (primary) | `GOOGLE_VISION_ENABLED=true` + ADC or `GOOGLE_APPLICATION_CREDENTIALS` | Raw image bytes, no hosting. Local dev: `gcloud auth application-default login` (no service account / IAM needed). 1000 free/mo |
| SerpAPI Google Lens + Yandex | `SERPAPI_KEY` | One key drives both engines in parallel (2 searches per run). Free tier 100/mo |
| FaceCheck.id | `FACECHECK_API_TOKEN` | Dedicated 1.4B-face index, base64 crops in response (no downloads). Paid — set `FACECHECK_DEMO=true` for local dev (0 credits, ~100k faces) |

Tuning knobs (all optional, sensible defaults): `SEARCH_MAX_RESULTS`, `SEARCH_TIMEOUT_SECONDS`, `COSINE_THRESHOLD` (0.35), `CACHE_THRESHOLD` (0.60), `CACHE_DB_PATH` (default `data/mira_cache.db`, auto-created).

**Run:**
```bash
bun run dev        # setup-check + starts both services via turbo (web :3000, serve :8765)
# or for fast restart after initial setup:
bun run dev:quick
```

Then open `http://localhost:3000`, allow camera access, and you should see the live recognition overlay. The default enrollment set is synced from `https://r2-mira.singularityworks.xyz`; you can add identities via the UI (requires `MIRA_R2_*` env - see `apps/web/.env.example`) or extend enrollment directly.

### Open-World Pipeline (Phase 1 — Python side)

Beyond closed-set recognition, `apps/serve` hosts an open-world identity pipeline (`pipeline.run` over the same WebSocket):

1. **Detect + embed** — InsightFace `buffalo_l`, largest face, 512-d L2-normed embedding
2. **Cache lookup** — SQLite embedding cache (`apps/data/mira_cache.db`), same-person threshold 0.60; a hit returns instantly (<250 ms) and skips search entirely
3. **4-engine parallel reverse search** — Google Vision (raw bytes) + SerpAPI Lens (hosted URL) + SerpAPI Yandex (same hosted URL) + FaceCheck (upload → poll), merged and deduped by URL with multi-source counting
4. **Concurrent image acquisition** — FaceCheck candidates decode base64 in memory; URL candidates download concurrently (7 s timeout, HTML responses skipped)
5. **ArcFace re-ranking** — per-candidate face re-detection + cosine similarity (discard < 0.35), blended score (FaceCheck: `0.6·cos + 0.4·score`; URL: `cos × (1 + 0.2 × multi-source)`)
6. **Cache write** — successful real-URL results are persisted so future scans of the same person are instant

Typical timings on a cache miss: ~5–10 s (FaceCheck disabled); cache hit: <250 ms.

**Tests / lint / types (Python):**
```bash
cd apps/serve
uv run python -m pytest -q   # 86 tests, all network calls mocked
uv run ruff check .
uv run python -m pyright
```

**Blockchain verification (Phase 2), HTTP endpoint + AR HUD (Phases 3–4) are not implemented yet** — see `.context/IMPLEMENTATION_PLAN.md` for the remaining roadmap.
