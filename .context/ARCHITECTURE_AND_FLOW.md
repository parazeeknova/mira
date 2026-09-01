# Mira · HH Goa 2026 — Architecture & Flow

> **Task:** Face scan → Web/social media reverse image search → Blockchain verification  
> **Deadline:** September 7, 2026

---

## System Overview

Mira is extended from a closed-set local face recognition system into an open-world identity pipeline that:

1. Detects and embeds a face from a live webcam frame
2. **Checks a local DB cache** — if the same person was seen before, returns the cached result instantly (no searches)
3. If no cache hit: fans out to **four independent search engines in parallel** to find matching web/social content
4. Downloads candidate images concurrently, re-detects faces in each, and filters by ArcFace cosine similarity against the input face
5. Anchors the top verified match (or the face embedding if nothing found) to a blockchain as a tamper-evident, re-verifiable record
6. **Writes the result to the DB** so future scans of the same person are instant cache hits

The system is built as a **Turborepo monorepo** split across two runtime boundaries:

| Service | Runtime | Port | Role |
|---------|---------|------|------|
| `apps/web` | Bun (TypeScript) | 3000 | HTTP server, WebSocket broker, blockchain client |
| `apps/serve` | Python (uv) | 8765 | Face detection, embedding, parallel search, DB cache |

---

## Repository Layout

```
mira/
├── apps/
│   ├── serve/
│   │   ├── mira_serve/
│   │   │   ├── service.py             # ✅ KEEP  — FaceRecognitionService
│   │   │   ├── config.py              # ✅ EXTEND — Vision + SerpAPI + FaceCheck + DB settings
│   │   │   ├── enrollment.py          # ✅ KEEP  — data models
│   │   │   ├── tracking.py            # ✅ KEEP  — ByteTrack (optional)
│   │   │   ├── protocol.py            # ✅ KEEP  — JSON helpers
│   │   │   ├── compat.py              # ✅ KEEP  — runtime patches
│   │   │   ├── enrollment_sync.py     # ⚠️  SOFT-DISABLED — env flag
│   │   │   ├── web_vision.py          # 🆕 NEW  — Google Cloud Vision Web Detection
│   │   │   ├── facecheck.py           # 🆕 NEW  — FaceCheck.id upload+poll engine
│   │   │   ├── search.py              # 🆕 NEW  — 4-engine orchestrator + merge/dedupe
│   │   │   ├── similarity.py          # 🆕 NEW  — ArcFace re-rank: download→detect→embed→cosine
│   │   │   ├── cache.py               # 🆕 NEW  — SQLite embedding cache (read + write)
│   │   │   └── pipeline.py            # 🆕 NEW  — stage 0→5 orchestrator
│   │   └── main.py                    # ✅ EXTEND — pipeline.run WS handler
│   │
│   └── web/
│       ├── index.ts                   # ✅ EXTEND — POST /api/pipeline
│       ├── lib/
│       │   ├── protocol.ts            # ✅ EXTEND — pipeline message types
│       │   ├── python-bridge.ts       # ✅ EXTEND — runPipeline() method
│       │   ├── blockchain.ts          # 🆕 NEW  — ethers.js v6 store + verify
│       │   └── enrollment-store.ts    # ✅ KEEP
│       └── public/
│           ├── index.html             # ✅ EXTEND — pipeline panel
│           └── client.js              # ✅ EXTEND — Run Pipeline button + result render
│
├── contracts/
│   ├── contracts/FaceRecord.sol       # 🆕 NEW  — on-chain tamper-evident record
│   └── hardhat.config.ts              # 🆕 NEW  — Hardhat config
│
├── scripts/
│   ├── setup.sh                       # ✅ EXTEND
│   ├── gen-wallet.ts                  # 🆕 NEW  — burner wallet generator
│   └── deploy-contract.ts             # 🆕 NEW  — deploys FaceRecord
│
├── data/
│   └── mira_cache.db                  # 🆕 AUTO-CREATED — SQLite embedding cache
│
├── ARCHITECTURE_AND_FLOW.md
├── IMPLEMENTATION_PLAN.md
└── README.md
```

---

## Pipeline — Six Stages

```
╔══════════════════════════════════════════════════════════════════════════╗
║  INPUT: Live webcam frame, captured on "Run Pipeline" button click       ║
╚══════════════════════╤═══════════════════════════════════════════════════╝
                       │  POST /api/pipeline  (JPEG, base64)
                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STAGE 1 · FACE DETECTION & EMBEDDING                    (Python)        ║
║                                                                          ║
║  InsightFace buffalo_l                                                   ║
║    det module  → RetinaFace → bounding box + landmarks                   ║
║    rec module  → ArcFace   → 512-dim float32 embedding (L2-normed)       ║
║  ONNX Runtime  (CUDAExecutionProvider → CPUExecutionProvider)            ║
║  Select largest face by bbox area, crop with 18%/22% x/y padding        ║
║                                                                          ║
║  Outputs:                                                                ║
║    bbox {x,y,w,h} · confidence float · input_embedding float32[512]     ║
║    cropped_jpeg bytes  (face region, padded, JPEG 88%)                   ║
╚══════════════════════╤═══════════════════════════════════════════════════╝
                       │
                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STAGE 2 · EMBEDDING CACHE LOOKUP                        (Python)        ║
║                                                                          ║
║  Query SQLite cache:                                                     ║
║    Brute-force cosine similarity vs all stored embeddings (numpy)        ║
║    Cache hit threshold: >= 0.60 (conservative — must be same person)    ║
║                                                                          ║
║  ── CACHE HIT ──────────────────────────────────────────────────────── ║
║    Return cached {results, top_match, engines_used}                      ║
║    Skip Stages 3-5 entirely → jump straight to Stage 6 (blockchain)     ║
║    Tag response: cache_hit=true                                          ║
║                                                                          ║
║  ── CACHE MISS ─────────────────────────────────────────────────────── ║
║    Proceed to Stage 3                                                    ║
╚══════════════════════╤═══════════════════════════════════════════════════╝
                       │ (cache miss only)
                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STAGE 3 · PARALLEL REVERSE IMAGE SEARCH — 4 ENGINES    (Python)        ║
║                                                                          ║
║  asyncio.gather() fires all four simultaneously:                         ║
║                                                                          ║
║  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ ║
║  │ Google Cloud │  │ SerpAPI      │  │ SerpAPI      │  │ FaceCheck  │ ║
║  │ Vision       │  │ Google Lens  │  │ Yandex Images│  │ .id        │ ║
║  │              │  │              │  │              │  │            │ ║
║  │ WEB_DETECTION│  │ engine=      │  │ engine=      │  │ POST       │ ║
║  │ Raw bytes    │  │ google_lens  │  │ yandex_images│  │ /upload_pic│ ║
║  │ No hosting   │  │ Hosted URL   │  │ Same hosted  │  │ → id_search│ ║
║  │              │  │              │  │ URL          │  │ POLL       │ ║
║  │ ~1-3s        │  │ ~2-3s        │  │ ~2-3s        │  │ /search    │ ║
║  │ 1000 free/mo │  │ 100 free/mo  │  │ (shared)     │  │ ~4-10s     │ ║
║  │              │  │              │  │              │  │            │ ║
║  │ Top 8 URLs   │  │ Top 8 URLs   │  │ Top 8 URLs   │  │ Top 8      │ ║
║  │              │  │              │  │              │  │ base64+url │ ║
║  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ ║
║         └─────────────────┴──────────────────┴────────────────┘        ║
║                                    │                                    ║
║                    Merge · Deduplicate by URL                            ║
║                    Multi-source boost: flagged if URL in 2+ engines     ║
║                    Cap: 8 per engine → max 32 pre-dedup                 ║
║                    Realistically ~15-22 unique URLs post-dedup           ║
║                    (Vision ↔ Lens overlap heavily; FaceCheck most novel) ║
║                                                                          ║
║  FaceCheck candidates: base64 image + score in response (no download)   ║
║  URL candidates (Vision/Lens/Yandex): URL only → download in Stage 4   ║
╚══════════════════════╤═══════════════════════════════════════════════════╝
                       │
                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STAGE 4 · CONCURRENT IMAGE ACQUISITION                  (Python)        ║
║                                                                          ║
║  Group A — FaceCheck candidates (base64 in API response):               ║
║    base64 decode → bytes directly. Zero network calls.                   ║
║                                                                          ║
║  Group B — URL candidates (Vision + Lens + Yandex):                     ║
║    asyncio.gather() all downloads concurrently                           ║
║    Per-download timeout: 7s                                              ║
║    Skip: 4xx / 5xx / timeout / non-image content-type                   ║
║    ~15-22 concurrent downloads — no semaphore needed at this scale      ║
║                                                                          ║
║  Output: list of (candidate_metadata, image_bytes) pairs                ║
╚══════════════════════╤═══════════════════════════════════════════════════╝
                       │
                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STAGE 5 · FACE RE-DETECTION + ARCFACE RE-RANKING        (Python)        ║
║                                                                          ║
║  For every acquired candidate image:                                     ║
║    1. RetinaFace detect → if no face found → discard                    ║
║    2. Select largest face → crop with padding                            ║
║    3. ArcFace embed → candidate_embedding float32[512]                  ║
║    4. cosine_similarity(input_embedding, candidate_embedding)            ║
║    5. If similarity < COSINE_THRESHOLD (0.35) → discard                 ║
║                                                                          ║
║  Score blending:                                                         ║
║    FaceCheck: final = 0.6 × cosine + 0.4 × (facecheck_score / 100)     ║
║    Others:    final = cosine × (1 + 0.2 × multi_source_count)           ║
║                                                                          ║
║  Rank all survivors descending by final_score                            ║
║  Top match selected                                                      ║
║                                                                          ║
║  Zero-survivor fallback:                                                 ║
║    SHA-256(embedding bytes) → uri = "face-embedding://{hex}"            ║
║    anchor_strategy = "embedding"                                         ║
║                                                                          ║
║  ── STAGE 5b · DB WRITE (cache miss path, real URL found) ──────────── ║
║    INSERT INTO face_cache:                                               ║
║      embedding     BLOB  (float32[512] raw bytes)                       ║
║      top_url       TEXT                                                  ║
║      similarity    REAL  (cosine similarity of top match)               ║
║      engines_used  TEXT  (JSON array)                                   ║
║      results_json  TEXT  (full ranked list JSON)                        ║
║      created_at    INT   (unix ms)                                      ║
╚══════════════════════╤═══════════════════════════════════════════════════╝
                       │  WS pipeline.result → Bun
                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STAGE 6 · BLOCKCHAIN VERIFICATION                       (Bun)           ║
║                                                                          ║
║  a) Canonicalize top result → deterministic JSON (sorted keys):          ║
║     { url, similarity, engines, timestamp, inputFaceHash }              ║
║     inputFaceHash = SHA-256(input_embedding bytes)                       ║
║                                                                          ║
║  b) SHA-256(canonical JSON) → contentHash bytes32                        ║
║                                                                          ║
║  c) ethers.js v6 → contract.store(contentHash, uri)                     ║
║     Network: Hardhat local (dev) / Polygon Amoy testnet (demo)          ║
║     Wait: provider.waitForTransaction(txHash, 1 block)                  ║
║                                                                          ║
║  d) VERIFICATION (immediate):                                            ║
║     contract.verify(contentHash) → { exists, uri, timestamp }           ║
║     Re-fetch on-chain record, recompute local hash, compare             ║
║     verified = (on_chain_hash === local_hash)                            ║
║                                                                          ║
║  Outputs: { txHash, blockNumber, contentHash, explorerUrl, verified }   ║
╚══════════════════════╤═══════════════════════════════════════════════════╝
                       │  HTTP 200 JSON
                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  BROWSER FLOATING AR HUD (Canvas Overlay beside tracked face)            ║
║  • Floating HUD Card anchored directly next to face bounding box        ║
║  • Platform badge ([TWITTER], [LINKEDIN], [INSTAGRAM], etc.)            ║
║  • Discovered post title / snippet                                       ║
║  • Engine badges: ⚡ Vision · Lens · Yandex · FaceCheck                 ║
║  • Similarity score badge (e.g. ~0.82 match)                            ║
║  • Cache badge: ⚡ INSTANT RESULT vs 🔍 LIVE SEARCH                    ║
║  • Blockchain Badge: ✅ VERIFIED ON-CHAIN (Block #, Amoy tx)            ║
║  • Interactive modal: Etherscan link, SHA-256 hash, full proof          ║
╚══════════════════════════════════════════════════════════════════════════╝
```

---

## Stage 3 Deep-Dive: FaceCheck.id Engine

FaceCheck is a dedicated face search engine with a two-step async API — fundamentally different from the URL-based engines:

```
facecheck.py — FaceCheckSearch

  search(image_bytes) -> list[CandidateResult]
  │
  ├─ Step 1: POST https://facecheck.id/api/upload_pic
  │    Content-Type: multipart/form-data
  │    Header: Authorization: <FACECHECK_API_TOKEN>
  │    Body:   images=<cropped_face_jpeg>
  │    Returns: { id_search: "3vdi8t-s_8DAAA7D5E784616" }
  │
  └─ Step 2: Poll POST https://facecheck.id/api/search
       Content-Type: application/json
       Body: { id_search, with_progress: true, demo: false }
       Loop (1.5s sleep, max 20 iterations, 30s total timeout):
         response.progress < 100 → sleep → retry
         response.progress = 100 → parse output.items
       Per item:
         score     int     0-100 (face match confidence)
         url.value string  source page URL
         base64    string  "data:image/webp;base64,..." (face crop image)
       Extract top 8 by score → return CandidateResult(
         url             = item.url.value,
         base64          = item.base64,         # image already in response
         facecheck_score = item.score,          # normalized to 0-1 in Stage 5
         engine          = "facecheck",
         has_image       = True                 # skip download in Stage 4
       )
```

**Key property:** FaceCheck returns a `base64`-encoded WebP of the matched face crop directly in the response. No outbound HTTP download is needed — we decode it in memory and pass straight to RetinaFace → ArcFace in Stage 5.

**Tier:** Paid tier (`demo: false` always in production). `FACECHECK_DEMO=true` is available in `.env` for local development only (scans ~100k faces at 0 credits).

**Wall time:** Typically 4–10s — FaceCheck is the likely bottleneck in the parallel gather. All other engines (1–3s) will have returned before it finishes.

**Graceful degradation:** If `FACECHECK_API_TOKEN` is absent or the API returns an error or timeout, the engine returns `[]`, logs a warning, and is excluded from `engines_used`. The remaining engines continue unaffected.

---

## Stage 5 Deep-Dive: Score Blending

```
For FaceCheck candidates:
  cosine_sim     ∈ [0, 1]       — ArcFace dot product (both L2-normed)
  facecheck_norm = score / 100  — FaceCheck's own match confidence
  final_score    = 0.6 × cosine_sim + 0.4 × facecheck_norm

  Rationale: cosine_sim is ground truth (same model as input embedding).
  facecheck_norm supplements with its own 1.4B-face database signal.
  FaceCheck scores are relative to its index, not to our input face,
  so they are weighted subordinately (0.4 vs 0.6).

For URL candidates (Vision / Google Lens / Yandex):
  final_score = cosine_sim × (1 + 0.2 × multi_source_count)

  multi_source_count = number of distinct engines that returned this URL
  Examples:
    1 engine,  cosine=0.72 → 0.72 × 1.2 = 0.864
    1 engine,  cosine=0.55 → 0.55 × 1.0 = 0.550  (no boost, count=0)
    3 engines, cosine=0.60 → 0.60 × 1.6 = 0.960  (strong multi-source boost)

Discard gate: cosine_sim < COSINE_THRESHOLD (default 0.35) before blending.
```

---

## Stage 2 Deep-Dive: Embedding Cache (SQLite)

```
cache.py — EmbeddingCache

  DB: data/mira_cache.db  (auto-created on first run)

  Schema:
    CREATE TABLE face_cache (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      embedding    BLOB    NOT NULL,   -- float32[512] raw bytes (512×4 = 2048 B)
      top_url      TEXT    NOT NULL,   -- winning result URL
      similarity   REAL    NOT NULL,   -- cosine sim of top match
      engines_used TEXT    NOT NULL,   -- JSON: ["google-vision", "facecheck", ...]
      results_json TEXT    NOT NULL,   -- full ranked CandidateResult list (JSON)
      cache_hit    INTEGER DEFAULT 0, -- times returned as cache hit
      created_at   INTEGER NOT NULL,  -- unix ms
      updated_at   INTEGER NOT NULL   -- unix ms (bumped on each cache hit)
    );
    CREATE INDEX idx_created ON face_cache(created_at);

  lookup(input_embedding) → CachedResult | None   [Stage 2]
    Load all stored embeddings into numpy array (shape [N, 512])
    scores = input_embedding @ stored_embeddings.T   (dot product = cosine, L2-normed)
    best_idx = np.argmax(scores)
    If scores[best_idx] >= CACHE_THRESHOLD (0.60):
      UPDATE SET cache_hit += 1, updated_at = now WHERE id = best_idx
      Return CachedResult (deserialize results_json)
    Else: Return None

  write(input_embedding, results, top_url, engines_used)   [Stage 5b]
    Only called when anchor_strategy = "search" (real URL found)
    Embedding fallbacks are NOT cached — they'd corrupt future lookups
    INSERT INTO face_cache (...) VALUES (...)

  Performance: numpy brute-force cosine < 5ms for up to ~5000 entries.
  No ANN library needed at demo scale.
```

---

## Component Summary

### `mira_serve/web_vision.py`
Google Cloud Vision `WEB_DETECTION`. Takes raw image bytes (no public hosting). Wraps sync gRPC in `asyncio.to_thread`. Any failure → `[]`. Returns top 8 `CandidateResult` objects with `has_image=False`.

### `mira_serve/facecheck.py`
FaceCheck.id upload + poll engine. Uploads cropped face JPEG, polls until `progress=100`. Returns top 8 `CandidateResult` with `has_image=True` (base64 image embedded). Gracefully returns `[]` on timeout or API error.

### `mira_serve/search.py`
4-engine orchestrator. Hosts image once to catbox.moe (tmpfiles.org fallback) for SerpAPI. Fires all 4 engines via `asyncio.gather(return_exceptions=True)`. Merges: dedupes by URL (first-seen wins), tracks `multi_source_count`, caps at 8 per engine.

### `mira_serve/similarity.py`
Splits candidates into Group A (has_image, base64 decode) and Group B (URL download, async, 7s timeout). Runs RetinaFace + ArcFace per candidate. Applies cosine threshold, score blending, and ranking. Returns sorted `list[RankedResult]`.

### `mira_serve/cache.py`
SQLite-backed embedding cache. `lookup()` uses numpy dot product over all stored embeddings. `write()` inserts new record after successful real-URL search. Thread-safe via connection-per-call pattern.

### `mira_serve/pipeline.py`
Top-level orchestrator. Runs Stage 1 → 2 → 3 → 4+5 → 5b in sequence, with Stage 3-5 skipped entirely on cache hit. Returns `PipelineResult(face, results, anchor_strategy, engines_used, cache_hit)`.

### `lib/blockchain.ts`
Canonical JSON: `{url, similarity, engines, timestamp, inputFaceHash}` with sorted keys. SHA-256 via `crypto.subtle`. `store()` + `tx.wait(1)`. `verify()` recomputes and cross-checks. Returns `verified: boolean`.

### `contracts/contracts/FaceRecord.sol`
```solidity
// store(bytes32 contentHash, string uri) — immutable record per hash
// verify(bytes32 contentHash) → (exists, uri, timestamp, submitter)
// recordCount() → uint256
```

---

## Data Flow — Full Sequence

```
Browser           Bun (index.ts)         Python (pipeline.py)          Chain
  │                    │                        │                         │
  │── Run Pipeline ────│                        │                         │
  │── POST /api/pipe ─►│                        │                         │
  │                    │── WS pipeline.run ────►│                         │
  │                    │                        │                         │
  │                    │         Stage 1: InsightFace detect + ArcFace    │
  │                    │                  input_embedding + cropped_jpeg  │
  │                    │                        │                         │
  │                    │         Stage 2: cache.lookup(input_embedding)   │
  │                    │         ┌── HIT → return cached result ─────────►(Stage 6)
  │                    │         └── MISS → proceed                       │
  │                    │                        │                         │
  │                    │         Stage 3: asyncio.gather(4 engines)       │
  │                    │           ├─ Google Vision  (raw bytes)          │
  │                    │           ├─ SerpAPI Lens   (hosted URL)         │
  │                    │           ├─ SerpAPI Yandex (same hosted URL)    │
  │                    │           └─ FaceCheck.id   (upload → poll)      │
  │                    │           merge + dedupe → ~15-22 candidates     │
  │                    │                        │                         │
  │                    │         Stage 4: FaceCheck → base64 decode      │
  │                    │                  URL candidates → async download │
  │                    │                        │                         │
  │                    │         Stage 5: per-candidate:                  │
  │                    │                  RetinaFace detect → crop        │
  │                    │                  ArcFace embed                   │
  │                    │                  cosine filter (≥ 0.35)         │
  │                    │                  score blend + rank              │
  │                    │                        │                         │
  │                    │         Stage 5b: cache.write(embedding, result) │
  │                    │                        │                         │
  │                    │◄── WS pipeline.result ─│                         │
  │                    │                        │                         │
  │               Stage 6: canonicalize + sha256                          │
  │                    │── contract.store(hash, url) ───────────────────►│
  │                    │◄── txHash, blockNumber ─────────────────────────│
  │                    │── contract.verify(hash) ───────────────────────►│
  │                    │◄── exists=true, re-verify ──────────────────────│
  │◄── HTTP 200 JSON ──│                        │                         │
  │ render AR HUD      │                        │                         │
```

---

## Protocol — Message Types

### Internal: Bun → Python (WS)
```typescript
interface PythonPipelineRunMessage {
  type: "pipeline.run";
  sessionId: string;
  image: { data: string; mimeType: "image/jpeg"; width: number; height: number };
}
```

### Internal: Python → Bun (WS)
```typescript
interface CandidateResult {
  url: string;
  platform: "twitter" | "instagram" | "linkedin" | "reddit" | "web" | "none";
  title: string | null;
  snippet: string | null;
  imageUrl: string | null;
  fetchedAt: number;
  sourceStrategy: "google-vision" | "serpapi" | "facecheck" | "embedding-fallback";
  engine: "google-vision" | "google_lens" | "yandex" | "facecheck" | "embedding-fallback";
  similarity: number | null;      // cosine sim after re-ranking (null if fallback)
  finalScore: number | null;      // blended score used for ranking
  multiSourceCount: number;       // distinct engines that returned this URL
}

interface PythonPipelineResultMessage {
  type: "pipeline.result";
  sessionId: string;
  error?: string;
  face?: { bbox: BBox; confidence: number };
  results: CandidateResult[];
  anchorStrategy: "search" | "embedding" | "none";
  enginesUsed: string[];
  cacheHit: boolean;
}
```

### External: Bun → Browser (HTTP)
```typescript
interface PipelineResponse {
  face: { bbox: BBox; confidence: number } | null;
  results: CandidateResult[];
  anchorStrategy: "search" | "embedding";
  cacheHit: boolean;
  blockchain: {
    contentHash: string; txHash: string; blockNumber: number;
    storedAt: number; explorerUrl: string; contractAddress: string;
  } | null;
  verified: boolean;
  enginesUsed: string[];
}
```

---

## Technology Stack

| Concern | Technology | Notes |
|---------|-----------|-------|
| Face detection | InsightFace `buffalo_l` + RetinaFace | Already in repo; reused for candidate re-detection |
| Face embedding | ArcFace 512d (L2-normalised) | Already in repo; reused for cosine re-ranking |
| Inference runtime | ONNX Runtime (CUDA → CPU) | Already in repo |
| **Search — engine 1** | **Google Cloud Vision Web Detection** | Raw bytes, 1000 free/month |
| **Search — engine 2** | **SerpAPI Google Lens** | Hosted URL, Google index |
| **Search — engine 3** | **SerpAPI Yandex Images** | Same hosted URL, Yandex index |
| **Search — engine 4** | **FaceCheck.id API** | 1.4B face index, base64 results, 3 credits/search |
| Candidate download | `httpx` async, 7s timeout | URL candidates only; FaceCheck = base64 decode |
| Embedding cache | `sqlite3` (stdlib) + `numpy` | Brute-force cosine, <5ms at demo scale |
| Vision client | `google-cloud-vision` (sync gRPC) | Wrapped in `asyncio.to_thread` |
| Bun server | Bun 1.4+ | Already in repo |
| Blockchain | Hardhat local (dev) / Polygon Amoy (demo) | Amoy ~2s blocks vs Sepolia ~12s |
| Chain client | ethers.js v6 | Native Bun/ESM |
| Smart contract | Solidity ^0.8.24 | Minimal, auditable |
| Hash | SHA-256 via `crypto.subtle` | Deterministic canonical JSON |

---

## Environment Variables

```bash
# apps/serve/.env

GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GOOGLE_VISION_ENABLED=true
GOOGLE_VISION_MAX_RESULTS=8

SERPAPI_KEY=your_serpapi_key_here
SERPAPI_MAX_RESULTS=8

FACECHECK_API_TOKEN=your_facecheck_token_here
FACECHECK_MAX_RESULTS=8
# FACECHECK_DEMO=true            # uncomment for local dev only (0 credits, ~100k face index)

COSINE_THRESHOLD=0.35            # discard candidates below this similarity
CACHE_THRESHOLD=0.60             # treat as same person if cached sim >= this
PIPELINE_ENABLED=true
FACE_CROP_PADDING_X=0.18
FACE_CROP_PADDING_Y=0.22
CACHE_DB_PATH=../../data/mira_cache.db

# apps/web/.env

MIRA_SERVE_URL=ws://127.0.0.1:8765
MIRA_ENROLLMENT_SYNC_ENABLED=false

AMOY_RPC_URL=https://polygon-amoy.g.alchemy.com/v2/YOUR_KEY
WALLET_PRIVATE_KEY=0x...
FACE_RECORD_CONTRACT_ADDR=0x...
```

> **Note:** Any engine whose key is absent is silently skipped — the pipeline keeps running on whatever engines are configured. See the **Graceful Degradation** section for full tier details.


---

## Graceful Degradation

Every engine is independently gated by its own env var. A missing key or runtime failure produces `[]` and a `WARNING` log — it never raises into the orchestrator. `asyncio.gather(return_exceptions=True)` ensures one engine crashing cannot affect the others.

### Engine gating rules

| Engine | Required env var(s) | Missing → |
|--------|--------------------|-----------| 
| Google Cloud Vision | `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_VISION_ENABLED=true` | Skipped with `WARNING: Vision disabled or unconfigured` |
| SerpAPI Google Lens | `SERPAPI_KEY` | Skipped with `WARNING: SERPAPI_KEY not set` |
| SerpAPI Yandex | `SERPAPI_KEY` | Same key — both Lens and Yandex skip together |
| FaceCheck.id | `FACECHECK_API_TOKEN` | Skipped with `WARNING: FACECHECK_API_TOKEN not set` |

### Degradation tiers

```
All 4 engines active         → max coverage, ~15-22 candidates
Vision only                  → still useful; Google index, no hosting
SerpAPI only (Lens + Yandex) → still useful; catbox.moe hosting required
FaceCheck only               → strongest face-specific signal; base64 results
1 engine active              → pipeline still runs; fewer candidates
0 engines / all filtered     → embedding fallback (face-embedding://{sha256})
                               anchor_strategy = "embedding"
```

### Runtime failure handling

```python
# search.py — _merge() skips any result that is an Exception
results = await asyncio.gather(
    _vision.search(image_bytes),      # returns [] on any error
    _serpapi_lens(hosted_url),        # returns [] on any error
    _serpapi_yandex(hosted_url),      # returns [] on any error
    _facecheck.search(image_bytes),   # returns [] on timeout or API error
    return_exceptions=True
)
# Exceptions from gather itself are also caught and treated as []
active = [r for r in results if isinstance(r, list)]
```

Each engine's `search()` method has its own `try/except Exception` at the outermost level — API errors, timeouts, schema changes, and network failures are all swallowed internally and produce `[]` with a `logger.warning(...)`. The pipeline response always includes `engines_used: []` to reflect exactly which engines contributed results.

---

## Locked Design Decisions

| # | Decision |
|---|----------|
| Search engines | **4 parallel engines**: Google Vision (raw bytes) + SerpAPI Lens (hosted) + SerpAPI Yandex (same hosted URL) + FaceCheck.id (upload→poll) |
| Candidate cap | **Top 8 per engine** → max 32 pre-dedup → ~15–22 post-dedup |
| FaceCheck images | **base64 in API response** — no download step; decoded in-memory for ArcFace |
| Re-ranking | **ArcFace cosine on every candidate** — RetinaFace detect required per candidate first; discard if no face |
| Score blending | FaceCheck: `0.6×cosine + 0.4×facecheck_norm`; URL: `cosine × (1 + 0.2×multi_source_count)` |
| Cosine threshold | **0.35** (config: `COSINE_THRESHOLD`) — tunable, not hardcoded |
| Cache | **SQLite + numpy brute-force cosine**, lookup threshold 0.60 — same person skips Stages 3–5 entirely |
| Cache writes | Only on `anchor_strategy="search"` — embedding fallbacks not cached |
| Hash schema | **SHA-256({url, similarity, engines, timestamp, inputFaceHash})** — `inputFaceHash = SHA-256(embedding bytes)` |
| No-result fallback | `face-embedding://{sha256}` — pipeline never crashes |
| Blockchain network | **Polygon Amoy** (demo) — ~2s block time vs ~12s on Sepolia |

---

## Performance Budget

| Stage | Target | Notes |
|-------|--------|-------|
| Stage 1: detect + embed | < 200ms | ONNX, 320×320 |
| Stage 2: cache lookup | < 5ms | numpy brute-force |
| **Cache HIT — total E2E** | **< 250ms** | Stages 3–5 skipped entirely |
| Image host (catbox.moe) | ~0.5-1s | Shared across Lens + Yandex |
| Google Cloud Vision | ~1-3s | |
| SerpAPI Lens + Yandex | ~2-3s | Both in parallel, one upload |
| FaceCheck.id poll | ~4-10s | Likely bottleneck |
| **Parallel search wall time** | **~5-10s** | `max(Vision, SerpAPI, FaceCheck)` |
| Stage 4: FaceCheck decode | < 10ms | In-memory base64 decode |
| Stage 4: URL downloads | < 7s | ~15-22 concurrent, 7s timeout |
| Stage 5: re-rank all candidates | ~1-3s | RetinaFace + ArcFace per candidate |
| Stage 6: blockchain submit | < 2s | Broadcast only |
| Stage 6: confirm (1 block) | ~2-5s | Polygon Amoy ~2s blocks |
| **Total E2E (cache miss)** | **~15-25s** | Dominated by FaceCheck poll |
| **Total E2E (cache hit)** | **< 250ms** | Instant on repeat person |
