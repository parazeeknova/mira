# Mira · HH Goa 2026 — Implementation Plan

> **Deadline:** September 7, 2026, 11:59 PM
> **Start:** August 31, 2026
> **Available days:** 7

---

## Overview

```
Phase 1 · Days 1-2  |  Python: face extraction + parallel search (Google Lens + Yandex)
Phase 2 · Day 3     |  Smart contract + Bun blockchain client
Phase 3 · Day 4     |  API wiring: full end-to-end over HTTP + WS
Phase 4 · Days 5-6  |  UI: webcam Run Pipeline + results panel
Finalise · Day 7    |  README, tests, demo recording, submission
```

---

## Phase 1 — Python Pipeline (Days 1–2)

### Goal
`Pipeline.run(image_bytes)` returns face data + merged results from Google Lens AND Yandex running in parallel via `asyncio.gather`. Independently testable via pytest.

---

### Step 1.1 — Extend `config.py`

**File:** `apps/serve/mira_serve/config.py`

Add to `Settings` dataclass:

```python
# Search
serpapi_key: str | None
search_timeout_seconds: float
search_max_results: int

# Pipeline
pipeline_enabled: bool
face_crop_padding_x: float
face_crop_padding_y: float
```

Add to `load_settings()`:

```python
import os

serpapi_key             = os.getenv("SERPAPI_KEY") or None,
search_timeout_seconds  = float(os.getenv("SEARCH_TIMEOUT_SECONDS", "12")),
search_max_results      = int(os.getenv("SEARCH_MAX_RESULTS", "5")),
pipeline_enabled        = os.getenv("PIPELINE_ENABLED", "true").lower() == "true",
face_crop_padding_x     = float(os.getenv("FACE_CROP_PADDING_X", "0.18")),
face_crop_padding_y     = float(os.getenv("FACE_CROP_PADDING_Y", "0.22")),
```

Soft-disable R2 sync default:
```python
enrollment_sync_enabled = os.getenv("MIRA_ENROLLMENT_SYNC_ENABLED", "false").lower() == "true",
```

---

### Step 1.2 — Create `mira_serve/search.py`

**New file.** Both SerpAPI engines fire simultaneously via `asyncio.gather`. Results are merged, deduplicated by URL, and ranked by platform signal.

#### Platform scoring (for result ranking)

```
twitter   = 5  (highest social signal)
linkedin  = 4
instagram = 3
reddit    = 2
web       = 1
none      = 0
```

#### Class structure

```
ReverseImageSearch
  |
  +-- search(image_bytes) -> list[SearchResult]
  |     Uploads image once to SerpAPI image host.
  |     Fires _serpapi_google + _serpapi_yandex in parallel.
  |     Calls _merge_and_rank on results.
  |     Falls back to _playwright if both return empty.
  |     Returns [] if all fail (caller applies embedding fallback).
  |
  +-- _serpapi_google(image_bytes) -> list[SearchResult]
  |     engine=google_lens via serpapi.com/search.json
  |     Parses: organic_results, visual_matches, knowledge_graph
  |     Tags results: engine="google_lens"
  |
  +-- _serpapi_yandex(image_bytes) -> list[SearchResult]
  |     engine=yandex via serpapi.com/search.json
  |     Parses: organic_results, images_results
  |     Tags results: engine="yandex"
  |     NOTE: Same SERPAPI_KEY, no extra cost.
  |     Yandex face-similarity algo is stronger for non-celebrities.
  |
  +-- _playwright(image_bytes) -> list[SearchResult]
  |     Chromium headless -> lens.google.com
  |     Only called if both SerpAPI engines fail.
  |
  +-- _merge_and_rank(google, yandex) -> list[SearchResult]
  |     Skips engine results that raised exceptions.
  |     Deduplicates by URL (first occurrence wins).
  |     Sorts by (platform_score DESC, engine=google_lens first on tie).
  |     Caps at settings.search_max_results.
  |
  +-- _upload_to_serpapi(image_bytes) -> str
        POST serpapi.com/upload.json -> returns hosted image URL
        Used by both Google and Yandex engine calls.
```

#### `SearchResult` dataclass fields

```python
url:             str
platform:        str   # twitter|instagram|linkedin|reddit|web|none
title:           str | None
snippet:         str | None
image_url:       str | None
fetched_at:      int  # unix ms
source_strategy: str  # serpapi|playwright|embedding-fallback
engine:          str  # google_lens|yandex|playwright|embedding-fallback
```

#### Key implementation detail — parallel gather

```python
async def search(self, image_bytes: bytes) -> list[SearchResult]:
    if self._key:
        google_task = asyncio.create_task(self._serpapi_google(image_bytes))
        yandex_task = asyncio.create_task(self._serpapi_yandex(image_bytes))
        google_res, yandex_res = await asyncio.gather(
            google_task, yandex_task,
            return_exceptions=True,  # never crashes if one engine fails
        )
        merged = self._merge_and_rank(google_res, yandex_res)
        if merged:
            return merged
    # Playwright fallback only if both SerpAPI engines empty/failed
    try:
        pw = await self._playwright(image_bytes)
        if pw:
            return pw
    except Exception:
        pass
    return []
```

**Install dependencies:**
```bash
cd apps/serve
uv add httpx playwright
uv run playwright install chromium
```

---

### Step 1.3 — Create `mira_serve/pipeline.py`

```
Pipeline.run(image_bytes) -> PipelineResult

  Stage 1: _extract_face(image_bytes)
    - Decode image (PIL)
    - InsightFace detect: filter by det_score >= min_detection_confidence
    - Select largest face by bbox area
    - Crop with face_crop_padding_x/y (18%/22% default)
    - Encode crop as JPEG at quality=88
    - Extract L2-normalised 512-dim ArcFace embedding
    - Returns FaceData(bbox, confidence, embedding, cropped_jpeg)
    - Raises NoFaceFoundError if no face detected

  Stage 2: await search.search(face_data.cropped_jpeg)
    - Both engines fire in parallel (see Step 1.2)
    - Returns merged list[SearchResult]
    - If empty -> _embedding_fallback(face_data.embedding)

  Returns PipelineResult(
    face, results, anchor_strategy, engines_used
  )
  anchor_strategy: "search" | "embedding"
  engines_used: list of engine names that returned results
```

**Embedding fallback logic:**
```python
def _embedding_fallback(embedding: np.ndarray) -> list[SearchResult]:
    sha = hashlib.sha256(embedding.tobytes()).hexdigest()
    return [SearchResult(
        url=f"face-embedding://{sha}",
        platform="none",
        title="Face Embedding Anchor",
        snippet="No social post found. Anchoring face embedding hash to the blockchain.",
        image_url=None,
        fetched_at=int(time.time() * 1000),
        source_strategy="embedding-fallback",
        engine="embedding-fallback",
    )]
```

---

### Step 1.4 — Extend `main.py`

Add `pipeline.run` WS message routing:

```python
# In handle_connection() message routing:
elif payload.get("type") == "pipeline.run":
    response = await _handle_pipeline_run(payload, pipeline)
    await websocket.send(dumps(response))
```

New `_handle_pipeline_run` function decodes base64 image, calls `pipeline.run()`, serializes the result to JSON-compatible dict and returns it. On `NoFaceFoundError`, returns `{type: pipeline.result, error: ..., results: []}` without crashing the WS connection.

Instantiate `Pipeline(service, settings)` in `main()` alongside `FaceRecognitionService`.

---

### Step 1.5 — Tests

**`apps/serve/tests/test_search.py`**
- `test_merge_deduplicates_by_url` — same URL from both engines appears once
- `test_merge_ranks_by_platform_score` — twitter > linkedin > web
- `test_merge_skips_exception_engine` — if one engine raises, the other's results are returned
- `test_google_lens_ranked_before_yandex_on_tie` — tie-break by engine

**`apps/serve/tests/test_pipeline.py`**
- `test_embedding_fallback_url_format` — URL starts with `face-embedding://`
- `test_embedding_fallback_is_deterministic` — same embedding -> same hash always
- `test_no_face_raises_error` — blank image raises `NoFaceFoundError`

---

## Phase 2 — Smart Contract + Blockchain Client (Day 3)

### Goal
Deployed `FaceRecord` on Ethereum Sepolia. Working `BlockchainClient` with `store()` and `verify()`. Independently testable.

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
    sepolia: {
      url:      process.env.SEPOLIA_RPC_URL ?? "",
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

Compile:
```bash
cd contracts && bunx hardhat compile
```

---

### Step 2.3 — `scripts/gen-wallet.ts`

Generates a fresh burner wallet via `ethers.Wallet.createRandom()`.
Prints address, private key, and Sepolia faucet URLs.
User copies `WALLET_PRIVATE_KEY=0x...` into `apps/web/.env`.

```bash
# Run once:
bun run gen:wallet
```

---

### Step 2.4 — `scripts/deploy-contract.ts`

Loads compiled `FaceRecord.json` artifact.
Deploys to Sepolia via `ethers.ContractFactory`.
Waits for deployment confirmation.
Auto-patches `apps/web/.env` with `FACE_RECORD_CONTRACT_ADDR=0x...`.

```bash
# Run once after wallet is funded:
bun run deploy:contract
```

Add both to root `package.json`:
```json
"gen:wallet":      "bun run scripts/gen-wallet.ts",
"deploy:contract": "bun run scripts/deploy-contract.ts"
```

---

### Step 2.5 — `apps/web/lib/blockchain.ts`

**Key design decisions:**

1. **Canonical JSON** — keys sorted alphabetically, no whitespace:
   `{engine, fetchedAt, imageUrl, platform, snippet, sourceStrategy, title, url}`
   This ensures the same `SearchResult` always produces the same hash regardless of object construction order.

2. **SHA-256** via `crypto.subtle.digest` — built into Bun, no deps.

3. **`store(result)`** flow:
   - `canonicalize(result)` → string
   - `sha256(canonical)` → `contentHash` (hex, prefixed `0x`)
   - `contract.store(contentHash, result.url)`
   - `tx.wait(1)` — waits for 1 block confirmation
   - Returns `ChainRecord` with txHash, blockNumber, storedAt, explorerUrl

4. **`verify(contentHash)`** flow:
   - `contract.verify(contentHash)`
   - Returns `{ verified: exists, uri, timestamp, submitter }`

5. **`verifyResult(result, expectedHash)`** — recomputes hash from result object and cross-checks with on-chain state. Returns `hashMatch: boolean` in addition to on-chain verification.

Install:
```bash
cd apps/web && bun add ethers
```

---

### Step 2.6 — Blockchain Smoke Test

Create `scripts/test-blockchain.ts`:
```typescript
// Stores a mock result, verifies it, prints: stored, verified: true
// Run with: bun run scripts/test-blockchain.ts
```

---

## Phase 3 — API Wiring (Day 4)

### Goal
`POST /api/pipeline` is fully connected. `curl` test returns `verified: true` with real txHash.

---

### Step 3.1 — Extend `lib/protocol.ts`

Add `SearchResult`, `PythonPipelineRunMessage`, `PythonPipelineResultMessage`, `PipelineResponse` types.

Key new fields vs original plan:
- `SearchResult.engine: "google_lens" | "yandex" | "playwright" | "embedding-fallback"`
- `PythonPipelineResultMessage.enginesUsed: string[]`
- `PipelineResponse.enginesUsed: string[]`

---

### Step 3.2 — `runPipeline()` on `PythonBridge`

New method that sends a `pipeline.run` WS message to Python and returns a `Promise<PythonPipelineResultMessage>` resolved by a one-shot message listener. 30s timeout.

```
bridge.runPipeline(sessionId, image)
  -> sends WS: { type: "pipeline.run", sessionId, image }
  -> listens for WS: { type: "pipeline.result", sessionId }
  -> resolves promise when matching message arrives
  -> rejects after 30s timeout
```

---

### Step 3.3 — `POST /api/pipeline` in `index.ts`

Flow:
1. Parse `multipart/form-data` image
2. Resize to max 320px via Sharp
3. Generate `sessionId = crypto.randomUUID()`
4. `await bridge.runPipeline(sessionId, imagePayload)` — Python handles stages 1+2
5. If error or empty results → return 422 with error detail
6. `await blockchainClient.store(results[0])` — stage 3
7. `await blockchainClient.verify(chainRecord.contentHash)` — verification
8. Return 200 JSON with `{face, results, anchorStrategy, enginesUsed, blockchain, verified}`

`BlockchainClient` instantiation is guarded — returns 503 if env vars missing.

---

### Step 3.4 — End-to-End Smoke Test

```bash
bun run dev &
sleep 8
curl -s -X POST http://localhost:3000/api/pipeline \
  -F "image=@test-face.jpg" \
  | jq '{verified, enginesUsed, topResult: .results[0].url}'

# Expected:
# {
#   "verified": true,
#   "enginesUsed": ["google_lens", "yandex"],
#   "topResult": "https://twitter.com/..."
# }
```

---

## Phase 4 — Floating AR HUD UI (Days 5–6)

### Goal
A sleek floating HUD card rendered directly on the video canvas next to the tracked face bounding box (moving with the user), displaying the search match, engine badges, and on-chain verification badge, plus a modal for full cryptographic proof details.

---

### Step 4.1 — `public/index.html`

Add:
- `#pipeline-btn` — fixed bottom-right action button (`🔍 Run Pipeline`)
- `#proof-modal` — interactive modal popup (opens when clicking the floating canvas card or a "View Proof" button) showing complete Etherscan links, block explorer, and raw SHA-256 fingerprint

---

### Step 4.2 — Extend `public/client.js` Canvas Renderer

**1. Click Handler (`#pipeline-btn`):**
- Capture current frame from canvas
- Send `POST /api/pipeline`
- Save result into `state.pipelineResult`

**2. Floating Canvas Card Drawing (`drawOverlay()`):**
- As the user moves, the bounding box smoothly tracks the face
- Anchor a floating glassmorphic card rectangle to `(bbox.x + bbox.width + 12, bbox.y)`
- Render inside the floating HUD card:
  - **Platform Badge & Title**: `[TWITTER] @username "Post Title"`
  - **Engine Badges**: `⚡ Google Lens • Yandex`
  - **Blockchain Status**: `⛓️ SEPOLIA: ✅ VERIFIED (Block #...)`
  - **Tx Preview**: `Tx: 0x3f9a...`

---

### Step 4.3 — `public/styles.css`

Styles for the trigger button, canvas overlay effects, and proof modal.

---

## Finalise — Day 7

### Step 5.1 — Update `.env.example`

```bash
MIRA_SERVE_URL=ws://127.0.0.1:8765
MIRA_ENROLLMENT_SYNC_ENABLED=false

# Single key drives BOTH Google Lens and Yandex in parallel
SERPAPI_KEY=your_serpapi_key_here

# Blockchain (run gen:wallet then deploy:contract to populate)
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
WALLET_PRIVATE_KEY=0x...
FACE_RECORD_CONTRACT_ADDR=0x...
```

---

### Step 5.2 — Update `README.md`

Sections:
1. **Project Overview** — 3-stage pipeline, dual parallel search
2. **Architecture** — link `ARCHITECTURE_AND_FLOW.md`
3. **Setup**
   ```bash
   bun run setup
   cp apps/web/.env.example apps/web/.env
   # fill SERPAPI_KEY and SEPOLIA_RPC_URL
   bun run gen:wallet        # prints address + faucet links
   # fund wallet from faucet (~0.01 ETH needed)
   bun run deploy:contract   # deploys FaceRecord, writes addr to .env
   bun run dev
   ```
4. **Usage** — open localhost:3000, allow camera, click Run Pipeline
5. **Blockchain Network** — Ethereum Sepolia, ChainID 11155111, Etherscan
6. **Search Coverage** — Google Lens + Yandex parallel, Playwright fallback
7. **Known Limitations**
   - Sepolia confirmation ~12–15s
   - Playwright requires Chromium (~150MB first run)
   - SerpAPI free tier: 100 calls/month (each pipeline run = 2 calls)
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
  -F "image=@test-face.jpg" | jq .verified
# -> true
```

---

### Step 5.4 — Screen Recording Checklist

- [ ] `bun run dev` in terminal — both services start cleanly
- [ ] Browser opens `http://localhost:3000` — camera live
- [ ] Click **Run Pipeline**
- [ ] ~200ms: face bbox drawn green on canvas
- [ ] ~2s: engine badges appear (Google Lens · Yandex)
- [ ] ~2s: social post card appears (platform · title · snippet · link)
- [ ] ~15s: blockchain card appears (txHash, block, Etherscan link)
- [ ] **✅ Verified On-Chain** badge shown
- [ ] Click Etherscan link — live tx shown on Sepolia Explorer

Upload to YouTube (Unlisted) or Google Drive. Submit via form.

---

## Dependencies Summary

### Python additions (`apps/serve/pyproject.toml`)

| Package | Purpose |
|---------|---------|
| `httpx>=0.28` | Async HTTP for SerpAPI (both engines in parallel) |
| `playwright>=1.50` | Headless browser fallback |

### TypeScript additions (`apps/web/package.json`)

| Package | Purpose |
|---------|---------|
| `ethers` v6 | Blockchain client (store + verify on Sepolia) |

### Contracts (`contracts/`)

| Package | Purpose |
|---------|---------|
| `hardhat` | Solidity compile + Sepolia deploy |
| `@nomicfoundation/hardhat-toolbox-viem` | Hardhat toolbox |

---

## Risk Register

| Risk | Mitigation |
|------|------------|
| Yandex SerpAPI response schema differs | Parse both `organic_results` + `images_results`; skip gracefully on exception |
| Both engines return 0 results | Playwright fallback; then embedding fallback — pipeline never crashes |
| Sepolia block time spikes | `waitForTransaction(hash, 1)` waits exactly 1 confirmation (~12s typical) |
| Same hash already on-chain | Different photos → different embeddings/canonical JSON → different hash |
| SerpAPI rate limit (100 free/mo) | 2 calls per pipeline run = 50 free runs; more than enough for demo |
| Playwright cold start slow | Pre-warm Chromium on Python service startup as a background task |
| Face not detected on webcam | Good lighting required; test before recording demo |

---

## File Change Summary

```
NEW:
  apps/serve/mira_serve/search.py        <- parallel Google Lens + Yandex + Playwright
  apps/serve/mira_serve/pipeline.py      <- stage 1+2 orchestrator
  apps/web/lib/blockchain.ts             <- ethers.js store + verify
  contracts/contracts/FaceRecord.sol     <- Solidity smart contract
  contracts/hardhat.config.ts
  scripts/gen-wallet.ts
  scripts/deploy-contract.ts
  ARCHITECTURE_AND_FLOW.md
  IMPLEMENTATION_PLAN.md

MODIFIED:
  apps/serve/mira_serve/config.py        <- new settings fields
  apps/serve/main.py                     <- pipeline.run WS handler
  apps/web/index.ts                      <- POST /api/pipeline
  apps/web/lib/protocol.ts               <- SearchResult + pipeline types
  apps/web/lib/python-bridge.ts          <- runPipeline() method
  apps/web/public/index.html             <- pipeline panel HTML
  apps/web/public/client.js              <- Run Pipeline + result render
  apps/web/public/styles.css             <- panel + badge styles
  apps/web/.env.example                  <- new env vars
  apps/serve/pyproject.toml              <- httpx, playwright
  package.json                           <- gen:wallet, deploy:contract
  README.md

UNCHANGED:
  apps/serve/mira_serve/service.py
  apps/serve/mira_serve/tracking.py
  apps/serve/mira_serve/enrollment.py
  apps/serve/mira_serve/enrollment_sync.py  (soft-disabled via env)
  apps/serve/mira_serve/protocol.py
  apps/serve/mira_serve/compat.py
  apps/web/lib/enrollment-store.ts
  turbo.json
```
