# Mira · HH Goa 2026 — Implementation Plan

> **Deadline:** September 7, 2026, 11:59 PM  
> **Start:** August 31, 2026  
> **Available days:** 7

---

## Overview

```
Phase 1 · Days 1-2  |  Python: face extract + 4-engine parallel search + ArcFace re-ranking + SQLite cache
Phase 2 · Day 3     |  Smart contract + Bun blockchain client
Phase 3 · Day 4     |  API wiring: full end-to-end over HTTP + WS
Phase 4 · Days 5-6  |  UI: webcam Run Pipeline + AR HUD results panel
Finalise · Day 7    |  README, tests, demo recording, submission
```

---

## Phase 1 — Python Pipeline (Days 1–2)

### Goal
`Pipeline.run(image_bytes)` returns:
- On **cache hit**: cached result from SQLite, < 5ms lookup, stages 3–5 skipped
- On **cache miss**: face data + ArcFace-ranked results from 4 engines in parallel (Google Vision + SerpAPI Lens + SerpAPI Yandex + FaceCheck.id)

Independently testable via pytest, all network calls mocked.

---

### Step 1.1 — Extend `config.py`

**File:** `apps/serve/mira_serve/config.py`

Add to `Settings` dataclass:

```python
# Search — Google Cloud Vision (engine 1)
google_vision_enabled: bool
google_vision_max_results: int          # default 8

# Search — SerpAPI (engines 2 + 3)
serpapi_key: str | None
serpapi_max_results: int                # default 8, applied per engine

# Search — FaceCheck.id (engine 4)
facecheck_api_token: str | None
facecheck_max_results: int             # default 8
facecheck_demo: bool                   # default False (paid, full 1.4B index)
                                       # set True in .env for local dev only (0 credits, ~100k faces)

# Pipeline
pipeline_enabled: bool
face_crop_padding_x: float             # default 0.18
face_crop_padding_y: float             # default 0.22
search_timeout_seconds: float          # default 30.0 (covers FaceCheck poll)
cosine_threshold: float                # default 0.35 — discard below this

# Cache
cache_db_path: str                     # default "../../data/mira_cache.db"
cache_threshold: float                 # default 0.60 — same-person threshold
```

Also: lightweight `_load_dotenv()` in `config.py` auto-loads `apps/serve/.env`.
Soft-disable R2 sync default:
```python
enrollment_sync_enabled = os.getenv("MIRA_ENROLLMENT_SYNC_ENABLED", "false").lower() == "true"
```

---

### Step 1.2 — Create `mira_serve/cache.py`

**New file.** SQLite embedding cache — handles both lookup (Stage 2) and write (Stage 5b).

#### Schema

```python
CREATE TABLE IF NOT EXISTS face_cache (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    embedding    BLOB    NOT NULL,     -- float32[512] as raw bytes (2048 B)
    top_url      TEXT    NOT NULL,     -- best matched URL
    similarity   REAL    NOT NULL,     -- cosine similarity of top match
    engines_used TEXT    NOT NULL,     -- JSON array of engine names
    results_json TEXT    NOT NULL,     -- full ranked CandidateResult list
    cache_hit    INTEGER DEFAULT 0,   -- times returned as a cache hit
    created_at   INTEGER NOT NULL,    -- unix ms
    updated_at   INTEGER NOT NULL     -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_created ON face_cache(created_at);
```

#### Class structure

```
EmbeddingCache
  │
  ├─ lookup(input_embedding: np.ndarray) -> CachedResult | None
  │    Load all rows → np.array([decode(row.embedding) for row])
  │    scores = input_embedding @ stored.T     (dot = cosine, both L2-normed)
  │    best_idx = np.argmax(scores)
  │    If scores[best_idx] >= settings.cache_threshold:
  │      UPDATE cache_hit += 1, updated_at = now
  │      Return CachedResult(deserialize results_json, top_url, engines_used)
  │    Else: return None
  │
  └─ write(input_embedding, results, top_url, engines_used)
       Only called when anchor_strategy = "search" (real URL found)
       Embedding fallbacks NOT cached
       INSERT INTO face_cache (...) VALUES (...)
```

**DB path:** `data/mira_cache.db` — auto-created on first call to `EmbeddingCache()`.

---

### Step 1.3 — Create `mira_serve/web_vision.py` (engine 1)

**New file.** Google Cloud Vision `WEB_DETECTION`. Raw image bytes — no public hosting required.

```
VisionWebSearch
  │
  ├─ search(image_bytes: bytes) -> list[CandidateResult]
  │    asyncio.to_thread(_detect_sync, image_bytes)
  │    Any exception → [] (degrades gracefully)
  │
  ├─ _detect_sync(image_bytes)
  │    client.web_detection(image=vision.Image(content=image_bytes))
  │    Auth via GOOGLE_APPLICATION_CREDENTIALS (ADC)
  │
  └─ _collect(annotation) -> list[CandidateResult]
       pages_with_matching_images → url + page_title  (primary)
       full_matching_images       → image_url          (supplement)
       partial_matching_images    → image_url          (supplement)
       web_entities               → title fallback
       best_guess_labels          → snippet fallback
       Tags: engine="google-vision", has_image=False
       Cap at settings.google_vision_max_results (8)
```

**Install:** `uv add google-cloud-vision`

---

### Step 1.4 — Create `mira_serve/facecheck.py` (engine 4)

**New file.** FaceCheck.id two-step upload + poll engine.

```
FaceCheckSearch
  │
  ├─ search(image_bytes: bytes) -> list[CandidateResult]
  │    If not settings.facecheck_api_token → return []
  │    id_search = await _upload(image_bytes)
  │    return await _poll(id_search)
  │    Any exception / timeout → [] (degrades gracefully)
  │
  ├─ _upload(image_bytes) -> str
  │    POST https://facecheck.id/api/upload_pic
  │    Header: Authorization: {FACECHECK_API_TOKEN}
  │    Form:   images=<image_bytes as file>
  │    Returns response["id_search"]
  │
  └─ _poll(id_search: str) -> list[CandidateResult]
       max_iterations = 20, sleep = 1.5s, total cap = 30s
       Loop:
         POST https://facecheck.id/api/search
         Body: { id_search, with_progress: true,
                 demo: settings.facecheck_demo,   # False in prod; True for local dev
                 status_only: false }
         if response["output"] is not None:
           items = response["output"]["items"]
           items.sort(key=lambda x: x["score"], reverse=True)
           top8 = items[:settings.facecheck_max_results]
           return [CandidateResult(
             url             = item["url"]["value"],
             base64          = item["base64"],     # "data:image/webp;base64,..."
             facecheck_score = item["score"],      # 0-100
             engine          = "facecheck",
             has_image       = True,
           ) for item in top8]
         sleep 1.5s, continue
       Return [] on timeout

Graceful degradation:
  - If FACECHECK_API_TOKEN is not set → log WARNING, return [] immediately
  - If _upload() raises (network error, 401, 429) → log WARNING, return []
  - If _poll() times out (30s) → log WARNING, return []
  - If response schema is unexpected → log WARNING, return []
  In all cases: other engines are unaffected; facecheck excluded from engines_used
```

**Install:** `uv add httpx` (shared with SerpAPI)

---

### Step 1.5 — Create `mira_serve/search.py` (4-engine orchestrator)

**New file.** Fires all four engines via `asyncio.gather`, merges and deduplicates results.

#### `CandidateResult` dataclass

```python
@dataclass
class CandidateResult:
    url: str
    engine: str               # "google-vision"|"google_lens"|"yandex"|"facecheck"|"embedding-fallback"
    platform: str             # "twitter"|"instagram"|"linkedin"|"reddit"|"web"|"none"
    title: str | None
    snippet: str | None
    image_url: str | None     # external image URL (URL candidates only)
    base64: str | None        # base64 data URI (FaceCheck candidates only)
    facecheck_score: int | None  # 0-100 (FaceCheck only)
    has_image: bool           # True = base64 present, skip download
    fetched_at: int           # unix ms
    source_strategy: str      # "google-vision"|"serpapi"|"facecheck"|"embedding-fallback"
    multi_source_count: int   # filled during merge; default 0
```

#### Class structure

```
ReverseImageSearch
  │
  ├─ search(image_bytes: bytes) -> list[CandidateResult]
  │    # Host image for SerpAPI — only if SERPAPI_KEY is set
  │    If settings.serpapi_key: hosted_url = await _host_image(image_bytes)
  │    Else: hosted_url = None
  │
  │    # Build task list — only create tasks for configured engines
  │    tasks = []
  │    if settings.google_vision_enabled and GOOGLE_APPLICATION_CREDENTIALS:
  │        tasks.append(_vision.search(image_bytes))
  │    else:
  │        tasks.append(_noop())   # returns [] immediately
  │
  │    if settings.serpapi_key and hosted_url:
  │        tasks.append(_serpapi_lens(hosted_url))
  │        tasks.append(_serpapi_yandex(hosted_url))
  │    else:
  │        tasks += [_noop(), _noop()]
  │
  │    if settings.facecheck_api_token:
  │        tasks.append(_facecheck.search(image_bytes))
  │    else:
  │        tasks.append(_noop())
  │
  │    results = await asyncio.gather(*tasks, return_exceptions=True)
  │    return _merge(results)
  │
  ├─ _noop() -> list[CandidateResult]
  │    # Placeholder for unconfigured engines — returns [] instantly
  │    return []
  │
  ├─ _serpapi_lens(hosted_url) -> list[CandidateResult]
  │    try:
  │        GET serpapi.com/search.json?engine=google_lens&url={hosted_url}&api_key=...
  │        Parse: organic_results, visual_matches, knowledge_graph
  │        Top 8; engine="google_lens", has_image=False
  │    except Exception as e:
  │        logger.warning("SerpAPI Lens failed: %s", e)
  │        return []
  │
  ├─ _serpapi_yandex(hosted_url) -> list[CandidateResult]
  │    try:
  │        GET serpapi.com/search.json?engine=yandex_images&url={hosted_url}&api_key=...
  │        Parse: organic_results, images_results, inline_images
  │        Top 8; engine="yandex", has_image=False
  │    except Exception as e:
  │        logger.warning("SerpAPI Yandex failed: %s", e)
  │        return []
  │
  ├─ _host_image(image_bytes) -> str | None
  │    try:
  │        POST catbox.moe/user/api.php → https://files.catbox.moe/{id}.jpg
  │    except Exception:
  │        try: POST tmpfiles.org/api/v1/upload (fallback)
  │        except Exception:
  │            logger.warning("Image hosting failed — SerpAPI engines skipped")
  │            return None
  │    Shared URL used by both Lens and Yandex (upload once)
  │
  └─ _merge(results_per_engine: list) -> list[CandidateResult]
       # results_per_engine contains list[CandidateResult] or Exception per engine
       active = [r for r in results_per_engine if isinstance(r, list)]
       # Exceptions from gather are already caught per-engine above, but
       # return_exceptions=True ensures any leak is also swallowed here
       Dedupe by URL — first-seen wins (Vision > Lens > Yandex > FaceCheck)
       Track multi_source_count per surviving URL
       FaceCheck candidates sorted first (has_image=True, no download needed)
       Max 8 per engine enforced pre-merge
       Return merged list (max 32 pre-dedup, realistically ~15-22 post-dedup)
       If active is empty → return []  (embedding fallback applied in pipeline.py)
```

---

### Step 1.6 — Create `mira_serve/similarity.py`

**New file.** ArcFace cosine re-ranking of all candidates.

```
ArcFaceSimilarity
  │
  └─ rank_candidates(
       input_embedding: np.ndarray,
       candidates: list[CandidateResult],
       face_service: FaceRecognitionService
     ) -> list[RankedResult]
  │
  │  1. Split:
  │       group_a = [c for c in candidates if c.has_image]   # FaceCheck
  │       group_b = [c for c in candidates if not c.has_image]  # URL
  │
  │  2. Acquire images:
  │       Group A: base64.b64decode(strip_data_uri(c.base64)) → bytes
  │       Group B: asyncio.gather all downloads, timeout=7s per URL
  │                Skip failed downloads (4xx / 5xx / timeout)
  │
  │  3. For each (candidate, image_bytes):
  │       faces = face_service.detect_faces(image_bytes)
  │       if not faces: continue  (discard — no face in candidate image)
  │       largest = max(faces, key=lambda f: f.bbox_area)
  │       candidate_embedding = face_service.embed(largest)  # L2-normed
  │       cosine_sim = float(np.dot(input_embedding, candidate_embedding))
  │       if cosine_sim < settings.cosine_threshold: continue  (discard)
  │
  │  4. Score blend:
  │       FaceCheck: final = 0.6 * cosine_sim + 0.4 * (facecheck_score / 100)
  │       Others:    final = cosine_sim * (1 + 0.2 * multi_source_count)
  │
  │  5. Sort descending by final_score
  │  Return list[RankedResult]  (may be empty → embedding fallback)
```

#### `RankedResult` dataclass

```python
@dataclass
class RankedResult:
    candidate: CandidateResult
    similarity: float          # raw cosine similarity
    final_score: float         # blended score used for ranking
```

---

### Step 1.7 — Create `mira_serve/pipeline.py`

```
Pipeline.run(image_bytes: bytes) -> PipelineResult

  Stage 1: _extract_face(image_bytes)
    - Decode image (PIL)
    - InsightFace detect, filter by det_score >= min_detection_confidence
    - Select largest face by bbox area
    - Crop with face_crop_padding_x/y (18%/22%)
    - Encode crop as JPEG quality=88
    - Extract L2-normalised 512-dim ArcFace embedding
    - Returns FaceData(bbox, confidence, input_embedding, cropped_jpeg)
    - Raises NoFaceFoundError if no face detected

  Stage 2: cache.lookup(face_data.input_embedding)
    - If CachedResult returned:
        return PipelineResult(
          face=face_data, results=cached.results,
          anchor_strategy="search", engines_used=cached.engines_used,
          cache_hit=True
        )

  Stage 3: await search.search(face_data.cropped_jpeg)
    - 4 engines parallel → list[CandidateResult]

  Stage 4+5: await similarity.rank_candidates(
               face_data.input_embedding, candidates, self._service)
    - Returns list[RankedResult], sorted by final_score

  Stage 5b (if results non-empty):
    - cache.write(input_embedding, results, top_url, engines_used)

  If results empty:
    - _embedding_fallback(face_data.input_embedding)
    - anchor_strategy = "embedding"

  Returns PipelineResult(
    face, results, anchor_strategy, engines_used, cache_hit=False
  )
```

#### Embedding fallback

```python
def _embedding_fallback(embedding: np.ndarray) -> list[RankedResult]:
    sha = hashlib.sha256(embedding.tobytes()).hexdigest()
    candidate = CandidateResult(
        url=f"face-embedding://{sha}",
        engine="embedding-fallback",
        platform="none",
        title="Face Embedding Anchor",
        snippet="No verified social post found. Anchoring face embedding hash.",
        image_url=None, base64=None, facecheck_score=None,
        has_image=False, fetched_at=int(time.time() * 1000),
        source_strategy="embedding-fallback", multi_source_count=0,
    )
    return [RankedResult(candidate=candidate, similarity=0.0, final_score=0.0)]
```

---

### Step 1.8 — Extend `main.py`

Add `pipeline.run` WS message routing:

```python
elif payload.get("type") == "pipeline.run":
    response = await _handle_pipeline_run(payload, pipeline)
    await websocket.send(dumps(response))
```

`_handle_pipeline_run` decodes base64 image, calls `pipeline.run()`, serializes result. On `NoFaceFoundError`: returns `{type: "pipeline.result", error: "...", results: []}` without crashing the WS connection.

Instantiate `Pipeline(service, settings, cache, search, similarity)` in `main()`.

---

### Step 1.9 — Tests

**`apps/serve/tests/test_cache.py`**
- `test_lookup_returns_none_on_empty_db`
- `test_lookup_returns_cached_above_threshold`
- `test_lookup_returns_none_below_threshold`
- `test_write_then_lookup_roundtrip`
- `test_embedding_fallback_not_written_to_cache`
- `test_cache_hit_increments_counter`

**`apps/serve/tests/test_facecheck.py`**
- `test_upload_returns_id_search`
- `test_poll_returns_top_8_by_score`
- `test_poll_timeout_returns_empty`
- `test_no_token_returns_empty`
- `test_has_image_flag_is_true`
- `test_base64_field_preserved_in_candidate`

**`apps/serve/tests/test_search.py`**
- `test_merge_deduplicates_by_url`
- `test_merge_multi_source_count_incremented`
- `test_merge_skips_exception_engine`
- `test_facecheck_candidates_sorted_first_in_merge`
- `test_platform_detection_from_url`
- `test_no_serpapi_key_returns_empty_for_lens_yandex`

**`apps/serve/tests/test_similarity.py`**
- `test_facecheck_score_blending` — 0.6×cosine + 0.4×facecheck_norm
- `test_url_candidate_multi_source_boost`
- `test_below_threshold_discarded`
- `test_no_face_in_candidate_image_discarded`
- `test_empty_candidates_returns_empty`
- `test_ranking_order_by_final_score`

**`apps/serve/tests/test_web_vision.py`**
- `test_pages_with_matching_images_mapped`
- `test_web_entities_title_fallback`
- `test_best_guess_labels_snippet_fallback`
- `test_exception_returns_empty`
- `test_max_results_cap`

**`apps/serve/tests/test_pipeline.py`**
- `test_cache_hit_skips_search`
- `test_cache_miss_triggers_search`
- `test_embedding_fallback_url_format`
- `test_embedding_fallback_is_deterministic`
- `test_no_face_raises_error`
- `test_cache_written_after_successful_search`
- `test_embedding_fallback_not_cached`

**`apps/serve/tests/test_main_pipeline.py`**
- WS handler: success / cache_hit / no-face / embedding-fallback / generic-error
- camelCase serialization assertions

All tests mocked — no network calls, no real DB writes in CI (use `tmp_path` fixture for SQLite).

---

## Phase 2 — Smart Contract + Blockchain Client (Day 3)

### Goal
Deployed `FaceRecord` on Polygon Amoy. Working `BlockchainClient` with `store()` and `verify()`. Independently testable.

---

### Step 2.1 — Contracts Workspace

```bash
mkdir contracts && cd contracts
bun init -y
bun add -d hardhat @nomicfoundation/hardhat-toolbox-viem
bunx hardhat init    # choose: TypeScript project
```

**`contracts/hardhat.config.ts`:**
```typescript
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";

const config: HardhatUserConfig = {
  solidity: "0.8.24",
  networks: {
    hardhat: {},           // local dev
    amoy: {
      url:      process.env.AMOY_RPC_URL ?? "",
      accounts: process.env.WALLET_PRIVATE_KEY
        ? [process.env.WALLET_PRIVATE_KEY]
        : [],
    },
  },
};

export default config;
```

---

### Step 2.2 — `contracts/contracts/FaceRecord.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract FaceRecord {
    struct Record {
        bytes32 contentHash;
        string  uri;
        uint256 timestamp;
        address submitter;
    }

    mapping(bytes32 => Record) public records;
    bytes32[] public recordIndex;

    event RecordStored(
        bytes32 indexed contentHash,
        string  uri,
        uint256 timestamp,
        address indexed submitter
    );

    function store(bytes32 contentHash, string calldata uri) external {
        require(records[contentHash].timestamp == 0, "FaceRecord: already exists");
        records[contentHash] = Record(contentHash, uri, block.timestamp, msg.sender);
        recordIndex.push(contentHash);
        emit RecordStored(contentHash, uri, block.timestamp, msg.sender);
    }

    function verify(bytes32 contentHash)
        external view
        returns (bool exists, string memory uri, uint256 timestamp, address submitter)
    {
        Record storage r = records[contentHash];
        return (r.timestamp != 0, r.uri, r.timestamp, r.submitter);
    }

    function recordCount() external view returns (uint256) {
        return recordIndex.length;
    }
}
```

Compile: `cd contracts && bunx hardhat compile`

---

### Step 2.3 — `scripts/gen-wallet.ts`

Generates a fresh burner wallet via `ethers.Wallet.createRandom()`.
Prints address, private key, and Amoy faucet URLs.

```bash
bun run gen:wallet
```

---

### Step 2.4 — `scripts/deploy-contract.ts`

Loads compiled `FaceRecord.json` artifact. Deploys to Amoy via `ethers.ContractFactory`.
Waits for deployment confirmation. Auto-patches `apps/web/.env` with `FACE_RECORD_CONTRACT_ADDR=0x...`.

```bash
bun run deploy:contract
```

---

### Step 2.5 — `apps/web/lib/blockchain.ts`

**Hash schema** (canonical JSON, sorted keys, no whitespace):
```typescript
interface HashableResult {
  engines: string[];          // sorted array of engine names
  inputFaceHash: string;      // SHA-256(input_embedding bytes) — hex
  similarity: number;         // cosine similarity of top match (0 if fallback)
  timestamp: number;          // unix ms
  url: string;                // top result URL
}
```

**`store(result, inputFaceHash)` flow:**
1. Build `HashableResult` from `result` + `inputFaceHash`
2. `canonical = JSON.stringify(hashable, sortedKeys)` — deterministic
3. `contentHash = sha256(canonical)` via `crypto.subtle.digest`
4. `contract.store(contentHash, result.url)`
5. `tx.wait(1)` — 1 confirmation (~2s on Amoy)
6. Return `ChainRecord(txHash, blockNumber, contentHash, storedAt, explorerUrl)`

**`verify(contentHash)` flow:**
1. `contract.verify(contentHash)` → `[exists, uri, ts, submitter]`
2. Returns `{ verified: exists, uri, timestamp, submitter }`

**`verifyResult(result, inputFaceHash, expectedHash)`:**
- Recomputes hash from result object
- `hashMatch = recomputedHash === expectedHash`
- Calls `verify(expectedHash)` for on-chain check
- Returns `{ verified: exists && hashMatch }`

Install: `cd apps/web && bun add ethers`

---

### Step 2.6 — Blockchain Smoke Test

```bash
# scripts/test-blockchain.ts
# Stores a mock result, verifies it, prints: stored=true, verified=true
bun run scripts/test-blockchain.ts
```

---

## Phase 3 — API Wiring (Day 4)

### Goal
`POST /api/pipeline` fully connected. `curl` test returns `verified: true` with real txHash. Cache hit path tested.

---

### Step 3.1 — Extend `lib/protocol.ts`

Add types:
- `CandidateResult` — includes `similarity`, `finalScore`, `multiSourceCount`, `cacheHit`
- `PythonPipelineRunMessage`
- `PythonPipelineResultMessage` — includes `cacheHit: boolean`, `enginesUsed: string[]`
- `PipelineResponse` — includes `cacheHit: boolean`

---

### Step 3.2 — `runPipeline()` on `PythonBridge`

```
bridge.runPipeline(sessionId, image)
  → sends WS: { type: "pipeline.run", sessionId, image }
  → listens for WS: { type: "pipeline.result", sessionId }
  → resolves Promise<PythonPipelineResultMessage> on match
  → rejects after 60s timeout (covers FaceCheck poll + re-ranking)
```

---

### Step 3.3 — `POST /api/pipeline` in `index.ts`

Flow:
1. Parse `multipart/form-data` image
2. Resize to max 320px via Sharp
3. Generate `sessionId = crypto.randomUUID()`
4. `inputFaceHash = sha256(imageBytes)` — computed Bun-side for hash schema
5. `await bridge.runPipeline(sessionId, imagePayload)` — Python runs Stages 1–5
6. If error or no results → 422 with error detail
7. `await blockchainClient.store(results[0], inputFaceHash)` — Stage 6
8. `await blockchainClient.verify(chainRecord.contentHash)` — tamper check
9. Return 200 JSON `{face, results, anchorStrategy, cacheHit, enginesUsed, blockchain, verified}`

`BlockchainClient` instantiation guarded — returns 503 if env vars missing.

---

### Step 3.4 — End-to-End Smoke Test

```bash
bun run dev &
sleep 10
curl -s -X POST http://localhost:3000/api/pipeline \
  -F "image=@test-face.jpg" \
  | jq '{verified, cacheHit, enginesUsed, topResult: .results[0].url, similarity: .results[0].similarity}'

# Expected (first run):
# { "verified": true, "cacheHit": false,
#   "enginesUsed": ["google-vision","facecheck",...],
#   "topResult": "https://twitter.com/...", "similarity": 0.78 }

# Run again with same face — expected (second run):
# { "verified": true, "cacheHit": true, ... }  # instant cache hit
```

---

## Phase 4 — Floating AR HUD UI (Days 5–6)

### Goal
Sleek floating HUD card on the video canvas next to the tracked face. Displays match info, similarity score, engine badges, cache indicator, and on-chain badge. Modal for full cryptographic proof.

---

### Step 4.1 — `public/index.html`

Add:
- `#proof-modal` — modal showing Etherscan link, block explorer, raw SHA-256, full engine list

---

### Step 4.2 — Extend `public/client.js` Canvas Renderer

**Auto-Trigger State Controller (`onFrameResult()`):**
- Track `face.trackId` stability count (require >= 15 frames / ~1 sec)
- Check `!scannedTrackIds.has(trackId)` and `!isPipelineBusy`
- Capture current frame from canvas
- Set HUD state to "🔍 Identifying..."
- `POST /api/pipeline`
- Save result into `state.pipelineResult`

**Floating HUD card drawing (`drawOverlay()`):**
- Anchor glassmorphic card to `(bbox.x + bbox.width + 12, bbox.y)`
- Render:
  - **Platform badge**: `[TWITTER] @username "Post Title"`
  - **Similarity badge**: `~0.82 match`
  - **Engine badges**: `⚡ Vision · Lens · Yandex · FaceCheck`
  - **Cache indicator**: `⚡ INSTANT (cached)` or `🔍 LIVE SEARCH`
  - **Blockchain**: `⛓️ AMOY: ✅ VERIFIED (Block #...)`
  - **Tx preview**: `Tx: 0x3f9a...`

---

### Step 4.3 — `public/styles.css`

Styles for trigger button, canvas overlay, glassmorphic card, proof modal.

---

## Finalise — Day 7

### Step 5.1 — Update `.env.example`

```bash
# apps/serve/.env.example
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GOOGLE_VISION_ENABLED=true
GOOGLE_VISION_MAX_RESULTS=8

SERPAPI_KEY=your_serpapi_key_here
SERPAPI_MAX_RESULTS=8

FACECHECK_API_TOKEN=your_facecheck_token_here
FACECHECK_MAX_RESULTS=8
FACECHECK_DEMO=false

COSINE_THRESHOLD=0.35
CACHE_THRESHOLD=0.60
CACHE_DB_PATH=../../data/mira_cache.db

# apps/web/.env.example
MIRA_SERVE_URL=ws://127.0.0.1:8765
MIRA_ENROLLMENT_SYNC_ENABLED=false

AMOY_RPC_URL=https://polygon-amoy.g.alchemy.com/v2/YOUR_KEY
WALLET_PRIVATE_KEY=0x...
FACE_RECORD_CONTRACT_ADDR=0x...
```

---

### Step 5.2 — Update `README.md`

Sections:
1. **Project Overview** — 6-stage pipeline, 4-engine parallel search, ArcFace re-ranking, SQLite cache
2. **Architecture** — link `ARCHITECTURE_AND_FLOW.md`
3. **Setup**
   ```bash
   bun run setup
   cp apps/web/.env.example apps/web/.env
   cp apps/serve/.env.example apps/serve/.env
   # Fill SERPAPI_KEY, FACECHECK_API_TOKEN, AMOY_RPC_URL
   bun run gen:wallet        # prints address + Amoy faucet link
   # Fund wallet (0.01 MATIC from https://faucet.polygon.technology/)
   bun run deploy:contract   # deploys FaceRecord, writes addr to .env
   bun run dev
   ```
4. **Usage** — open localhost:3000, allow camera, click Run Pipeline
5. **Blockchain Network** — Polygon Amoy (ChainID 80002), ~2s block time, Amoy explorer
6. **Search Coverage** — 4 parallel engines, ArcFace cosine re-ranking, SQLite cache
7. **Known Limitations**
   - FaceCheck.id: 3 credits per full search, may be the pipeline bottleneck (~4–10s)
   - SerpAPI: 100 calls/month free (2 per run: Lens + Yandex)
   - Vision: 1000/month free
   - Cache is per-machine SQLite (not shared across deployments)
   - Search only finds publicly indexed content

---

### Step 5.3 — Final Checks

```bash
# Python
cd apps/serve
uv run ruff check mira_serve/
uv run python -m pyright

# TypeScript
cd apps/web
bun run check
bun run check-types

# E2E smoke
curl -s -X POST http://localhost:3000/api/pipeline \
  -F "image=@test-face.jpg" | jq '{verified, cacheHit, similarity: .results[0].similarity}'
# → { "verified": true, "cacheHit": false, "similarity": 0.xx }
```

---

### Step 5.4 — Screen Recording Checklist

- [ ] `bun run dev` in terminal — both services start cleanly
- [ ] Browser opens `http://localhost:3000` — camera live
- [ ] Click **Run Pipeline** (first run)
- [ ] ~200ms: face bbox drawn green on canvas
- [ ] ~5-10s: results appear — engine badges (Vision · Lens · Yandex · FaceCheck), similarity score
- [ ] Social post card: platform · title · snippet · link
- [ ] ~2-5s after: blockchain card (txHash, block, Amoy explorer link)
- [ ] **✅ Verified On-Chain** badge shown
- [ ] Click **Run Pipeline** again (same face) → `⚡ INSTANT (cached)` — result in <250ms
- [ ] Click Amoy explorer link — live tx shown

Upload to YouTube (Unlisted) or Google Drive. Submit via form.

---

## Dependencies Summary

### Python additions (`apps/serve/pyproject.toml`)

| Package | Purpose |
|---------|---------|
| `httpx>=0.28` | Async HTTP — SerpAPI, FaceCheck.id (upload + poll), image hosting |
| `google-cloud-vision>=3` | Web Detection — engine 1 (raw bytes, 1000 free/mo) |
| `numpy` | Cosine similarity in cache lookup and ArcFace re-ranking |

### TypeScript additions (`apps/web/package.json`)

| Package | Purpose |
|---------|---------|
| `ethers` v6 | Blockchain client (store + verify on Amoy) |

### Contracts (`contracts/`)

| Package | Purpose |
|---------|---------|
| `hardhat` | Solidity compile + Amoy deploy |
| `@nomicfoundation/hardhat-toolbox-viem` | Hardhat toolbox |

---

## File Change Summary

```
NEW:
  apps/serve/mira_serve/web_vision.py    ← Google Cloud Vision engine
  apps/serve/mira_serve/facecheck.py     ← FaceCheck.id upload+poll engine
  apps/serve/mira_serve/search.py        ← 4-engine orchestrator + merge/dedupe
  apps/serve/mira_serve/similarity.py    ← ArcFace cosine re-ranking
  apps/serve/mira_serve/cache.py         ← SQLite embedding cache
  apps/serve/mira_serve/pipeline.py      ← stage 1→5 orchestrator
  apps/web/lib/blockchain.ts             ← ethers.js store + verify
  contracts/contracts/FaceRecord.sol     ← Solidity smart contract
  contracts/hardhat.config.ts
  scripts/gen-wallet.ts
  scripts/deploy-contract.ts
  data/mira_cache.db                     ← auto-created at runtime
  ARCHITECTURE_AND_FLOW.md
  IMPLEMENTATION_PLAN.md

MODIFIED:
  apps/serve/mira_serve/config.py        ← Vision + SerpAPI + FaceCheck + cache settings
  apps/serve/main.py                     ← pipeline.run WS handler
  apps/web/index.ts                      ← POST /api/pipeline
  apps/web/lib/protocol.ts               ← CandidateResult + pipeline types
  apps/web/lib/python-bridge.ts          ← runPipeline() method
  apps/web/public/index.html             ← pipeline panel + proof modal HTML
  apps/web/public/client.js              ← Run Pipeline + AR HUD render
  apps/web/public/styles.css             ← HUD + badge + modal styles
  apps/web/.env.example                  ← new env vars
  apps/serve/.env.example                ← new env vars
  apps/serve/pyproject.toml              ← httpx, google-cloud-vision, numpy
  package.json                           ← gen:wallet, deploy:contract scripts
  README.md

UNCHANGED:
  apps/serve/mira_serve/service.py       (adds 2 public accessors only)
  apps/serve/mira_serve/tracking.py
  apps/serve/mira_serve/enrollment.py
  apps/serve/mira_serve/enrollment_sync.py  (soft-disabled via env)
  apps/serve/mira_serve/protocol.py
  apps/serve/mira_serve/compat.py
  apps/web/lib/enrollment-store.ts
  turbo.json
```

---

### Risk Register

| Risk | Mitigation |
|------|------------|
| **Any engine missing env var** | Engine's `search()` detects absent key at call time → returns `[]` + `WARNING` log. Other engines unaffected. `engines_used` reflects only engines that returned results. |
| **Any engine raises a runtime exception** | `try/except Exception` in each engine's outermost `search()` → returns `[]` + `WARNING`. `asyncio.gather(return_exceptions=True)` catches any leak. Pipeline never propagates engine errors upward. |
| **All engines return 0 results / 0 pass cosine filter** | Embedding fallback — SHA-256(embedding bytes) → `face-embedding://{hex}`. `anchor_strategy="embedding"`. Pipeline never crashes. |
| FaceCheck poll times out (>30s) | Returns `[]`; other 3 engines continue unaffected. |
| FaceCheck API error (401 / 429 / 5xx) | Caught per-request → `[]` + `WARNING`. Excluded from `engines_used`. |
| FaceCheck base64 corrupt / not a face | RetinaFace in Stage 5 discards candidate if no face detected. |
| Vision API auth failure | Returns `[]`; SerpAPI + FaceCheck continue. |
| Vision API quota exceeded | Returns `[]` (exception caught); SerpAPI + FaceCheck continue. |
| SERPAPI_KEY absent | Lens + Yandex both skip (same key). Vision + FaceCheck still run. |
| catbox.moe hosting fails | tmpfiles.org fallback attempted. If both fail → `hosted_url = None` → Lens + Yandex skip (`_noop()`). Vision + FaceCheck bypass hosting. |
| SerpAPI Lens or Yandex response schema changes | Parsing wrapped in `try/except` per-field — skip unknown fields, return whatever was parsed. |
| Cosine threshold too aggressive (0.35) | Config-driven via `COSINE_THRESHOLD` — lower to 0.25 if legitimate matches are filtered. |
| Cache false positive (different person, high sim) | Threshold is 0.60 — conservative for ArcFace L2-normed space; typical intra-person ~0.7–0.9, inter-person ~0.1–0.4. |
| Amoy block time spikes | `waitForTransaction(hash, 1)` waits exactly 1 confirmation, however long it takes. |
| Same hash already on-chain | `require(records[hash].timestamp == 0)` — different faces produce different embeddings → different canonical JSON → different SHA-256. |
| numpy not available | Explicitly listed in pyproject.toml; already a transitive dep of InsightFace. |
