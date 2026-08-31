# Mira · HH Goa 2026 — Architecture & Flow

> **Task:** Face scan → Web/social media reverse image search → Blockchain verification  
> **Deadline:** September 7, 2026

---

## System Overview

Mira is extended from a closed-set local face recognition system into an open-world identity pipeline that:

1. Detects and embeds a face from a live webcam frame
2. Uses the face to perform a real reverse image search across the web — via **two independent search engines running in parallel**
3. Anchors the discovered social post (or face embedding if no post found) to the Ethereum Sepolia testnet as a tamper-evident, re-verifiable record

The system is built as a **Turborepo monorepo** split across two runtime boundaries:

| Service | Runtime | Port | Role |
|---------|---------|------|------|
| `apps/web` | Bun (TypeScript) | 3000 | HTTP server, WebSocket broker, blockchain client |
| `apps/serve` | Python (uv) | 8765 | Face detection, embedding, parallel search |

---

## Repository Layout (After Extension)

```
mira/
├── apps/
│   ├── serve/
│   │   ├── mira_serve/
│   │   │   ├── service.py             # ✅ KEEP  — FaceRecognitionService
│   │   │   ├── config.py              # ✅ EXTEND — SERPAPI_KEY, pipeline settings
│   │   │   ├── enrollment.py          # ✅ KEEP  — data models
│   │   │   ├── tracking.py            # ✅ KEEP  — ByteTrack (optional)
│   │   │   ├── protocol.py            # ✅ KEEP  — JSON helpers
│   │   │   ├── compat.py              # ✅ KEEP  — runtime patches
│   │   │   ├── enrollment_sync.py     # ⚠️  SOFT-DISABLED — env flag
│   │   │   ├── search.py              # 🆕 NEW  — parallel Google Lens + Yandex search
│   │   │   └── pipeline.py            # 🆕 NEW  — stage 1→2 orchestrator
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
│   └── hardhat.config.ts              # 🆕 NEW  — Hardhat Sepolia config
│
├── scripts/
│   ├── setup.sh                       # ✅ EXTEND
│   ├── gen-wallet.ts                  # 🆕 NEW  — burner wallet generator
│   └── deploy-contract.ts             # 🆕 NEW  — deploys FaceRecord to Sepolia
│
├── ARCHITECTURE_AND_FLOW.md
├── IMPLEMENTATION_PLAN.md
└── README.md
```

---

## Pipeline — Three Stages

```
╔══════════════════════════════════════════════════════════════════════╗
║  INPUT: Live webcam frame, captured on "Run Pipeline" button click   ║
╚══════════════════════════╤═══════════════════════════════════════════╝
                           │  POST /api/pipeline  (JPEG, base64)
                           ▼
╔══════════════════════════════════════════════════════════════════════╗
║  STAGE 1 · FACE DETECTION & EMBEDDING                (Python)        ║
║                                                                      ║
║  InsightFace buffalo_l                                               ║
║    det module  → RetinaFace → bounding box + landmarks               ║
║    rec module  → ArcFace   → 512-dim float32 embedding (L2-normed)   ║
║  ONNX Runtime  (CUDAExecutionProvider → CPUExecutionProvider)        ║
║  Select largest face by bbox area, crop with 18%/22% x/y padding     ║
║                                                                      ║
║  Outputs:                                                            ║
║    bbox {x,y,w,h} · confidence float · embedding float32[512]        ║
║    cropped_jpeg bytes  (face region, padded, JPEG 88%)               ║
╚══════════════════════════╤═══════════════════════════════════════════╝
                           │
                           ▼
╔══════════════════════════════════════════════════════════════════════╗
║  STAGE 2 · PARALLEL REVERSE IMAGE SEARCH             (Python)        ║
║                                                                      ║
║  asyncio.gather() fires both engines simultaneously:                 ║
║                                                                      ║
║  ┌─────────────────────────────┐  ┌──────────────────────────────┐  ║
║  │  SerpAPI Google Lens        │  │  SerpAPI Yandex Images       │  ║
║  │  engine=google_lens         │  │  engine=yandex               │  ║
║  │  Same API key               │  │  Same API key                │  ║
║  │  ~1-2s · Google index       │  │  ~1-2s · Yandex index        │  ║
║  │  Best for: news, LinkedIn,  │  │  Best for: faces, VK,        │  ║
║  │  Wikipedia, Twitter         │  │  Odnoklassniki, Instagram,   │  ║
║  │                             │  │  broader face similarity     │  ║
║  └──────────────┬──────────────┘  └──────────────┬───────────────┘  ║
║                 │                                │                  ║
║                 └────────────┬───────────────────┘                  ║
║                              │                                      ║
║                    Merge · Deduplicate by URL                        ║
║                    Score · Rank by platform signal:                  ║
║                    twitter > linkedin > instagram > reddit > web     ║
║                    Return top N results                              ║
║                                                                      ║
║  Playwright headless fallback (if both engines return 0 results):    ║
║    Launches Chromium → lens.google.com → scrapes result links        ║
║                                                                      ║
║  Zero-result fallback:                                               ║
║    SHA-256(embedding bytes) → uri = "face-embedding://{hex}"         ║
║                                                                      ║
║  Outputs: SearchResult[]                                             ║
║    { url, platform, title, snippet, image_url,                       ║
║      fetched_at, source_strategy, engine }                           ║
╚══════════════════════════╤═══════════════════════════════════════════╝
                           │  WS pipeline.result → Bun
                           ▼
╔══════════════════════════════════════════════════════════════════════╗
║  STAGE 3 · BLOCKCHAIN VERIFICATION                   (Bun)           ║
║                                                                      ║
║  a) Canonicalize best result → deterministic JSON (sorted keys)      ║
║  b) SHA-256(canonical JSON) → contentHash bytes32                    ║
║  c) ethers.js v6 → contract.store(contentHash, uri)                  ║
║     Network: Ethereum Sepolia (ChainID 11155111)                     ║
║     Wait: provider.waitForTransaction(txHash, 1)  (~12-15s)          ║
║                                                                      ║
║  d) VERIFICATION (same request, immediate):                          ║
║     contract.verify(contentHash) → { exists, uri, timestamp }        ║
║     compare on-chain hash === local hash → verified: boolean         ║
║                                                                      ║
║  Outputs: { txHash, blockNumber, contentHash, explorerUrl, verified }║
╚══════════════════════════╤═══════════════════════════════════════════╝
                           │  HTTP 200 JSON
                           ▼
╔══════════════════════════════════════════════════════════════════════╗
║  BROWSER FLOATING AR HUD (Canvas Overlay beside tracked face)         ║
║  • Floating HUD Card anchored directly next to face bounding box     ║
║  • Live tracking with smoothing (moves naturally with user)          ║
║  • Platform badge ([TWITTER], [LINKEDIN], [INSTAGRAM], etc.)         ║
║  • Discovered post title / snippet                                   ║
║  • Search engine badges (⚡ Google Lens • Yandex)                     ║
║  • Blockchain Badge: ✅ VERIFIED ON-CHAIN (Block #, Sepolia tx)      ║
║  • Interactive popup/modal on click for full Etherscan & SHA-256 hash║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## Search Engine Comparison — Why Both

| Property | Google Lens | Yandex Images |
|----------|------------|---------------|
| Index | Google web crawl | Yandex web crawl |
| Face similarity | Image similarity | Face-optimised algorithm |
| Social coverage | Twitter, LinkedIn, news | VK, OK.ru, Instagram, broader |
| Geographic strength | Global (English-heavy) | Russia, Eastern Europe + global |
| Results via SerpAPI | `engine=google_lens` | `engine=yandex` |
| API key needed | Same SERPAPI_KEY | Same SERPAPI_KEY — no extra cost |
| Latency | ~1-2s | ~1-2s |
| Run mode | **Parallel** | **Parallel** |

Running both in parallel adds zero latency cost (they complete in the same ~2s window) and gives two independent indexes. Results are merged, deduplicated by URL, and ranked before returning.

---

## Component Deep-Dive

### `mira_serve/search.py`

```
ReverseImageSearch
  │
  ├─ search(image_bytes: bytes) -> list[SearchResult]
  │    # Fire both engines in parallel
  │    google_task = asyncio.create_task(_serpapi_google(image_bytes))
  │    yandex_task = asyncio.create_task(_serpapi_yandex(image_bytes))
  │    google_res, yandex_res = await asyncio.gather(
  │        google_task, yandex_task, return_exceptions=True
  │    )
  │    # Collect non-exception results
  │    combined = merge_and_rank(google_res, yandex_res)
  │    if combined:
  │        return combined
  │    # Both failed → Playwright fallback
  │    playwright_res = await _playwright(image_bytes)
  │    if playwright_res:
  │        return playwright_res
  │    return []   # caller applies embedding fallback
  │
  ├─ _serpapi_google(image_bytes) -> list[SearchResult]
  │    Upload JPEG to SerpAPI image host → get temp URL
  │    GET serpapi.com/search.json?engine=google_lens&url={img_url}&api_key=...
  │    Parse: organic_results[], visual_matches[], knowledge_graph
  │    Tag each result: engine="google_lens"
  │
  ├─ _serpapi_yandex(image_bytes) -> list[SearchResult]
  │    Upload same JPEG to SerpAPI image host → same or new temp URL
  │    GET serpapi.com/search.json?engine=yandex&url={img_url}&api_key=...
  │    Parse: organic_results[], images_results[]
  │    Tag each result: engine="yandex"
  │
  ├─ _playwright(image_bytes) -> list[SearchResult]
  │    Chromium headless → lens.google.com upload → scrape top 5 links
  │    Tag: engine="playwright"
  │
  └─ _merge_and_rank(
         google: list[SearchResult] | Exception,
         yandex: list[SearchResult] | Exception
     ) -> list[SearchResult]
         # Skip exception results
         combined = deduplicate_by_url(google + yandex)
         # Score: twitter=5 linkedin=4 instagram=3 reddit=2 web=1 none=0
         # Within same score: google_lens results ranked first (more structured)
         return sorted(combined, key=platform_score, reverse=True)[:max_results]
```

### `mira_serve/pipeline.py`

```
Pipeline.run(image_bytes) -> PipelineResult
  Stage 1: _extract_face(image_bytes)
             -> FaceData(bbox, confidence, embedding, cropped_jpeg)
             Raises NoFaceFoundError if nothing detected.

  Stage 2: await search.search(face_data.cropped_jpeg)
             -> results: list[SearchResult]  (merged from both engines)
             If empty -> _embedding_fallback(face_data.embedding)

  Returns PipelineResult(face, results, anchor_strategy)
  anchor_strategy: "search" | "embedding"
```

### `lib/blockchain.ts`

```
BlockchainClient
  store(result) -> ChainRecord
    canonical   = JSON.stringify(result, sortedKeys)
    contentHash = sha256(canonical)
    tx          = contract.store(hash, result.url)
    receipt     = tx.wait(1 block)

  verify(contentHash) -> VerificationResult
    [exists, uri, ts] = contract.verify(contentHash)
```

### `contracts/contracts/FaceRecord.sol`

```solidity
// store(bytes32 contentHash, string uri) — immutable record
// verify(bytes32 contentHash) — returns (exists, uri, timestamp, submitter)
// recordCount() — total records stored
```

---

## Data Flow — Full Sequence

```
Browser            Bun (index.ts)          Python (pipeline.py)        Sepolia
  │                     │                         │                       │
  │── Run Pipeline ─────│                         │                       │
  │── POST /api/pipe ──►│                         │                       │
  │                     │── WS pipeline.run ─────►│                       │
  │                     │                         │                       │
  │                     │            InsightFace detect + embed            │
  │                     │            crop face JPEG                        │
  │                     │                         │                       │
  │                     │            asyncio.gather():                    │
  │                     │            ┌─ SerpAPI Google Lens               │
  │                     │            └─ SerpAPI Yandex      (parallel)    │
  │                     │            merge + dedupe + rank                 │
  │                     │            [fallback: Playwright]               │
  │                     │            [fallback: embedding hash]            │
  │                     │                         │                       │
  │                     │◄── WS pipeline.result ──│                       │
  │                     │                         │                       │
  │                 canonicalize + sha256          │                       │
  │                     │── contract.store() ─────────────────────────────►│
  │                     │◄── txHash, block ────────────────────────────────│
  │                     │── contract.verify() ────────────────────────────►│
  │                     │◄── exists=true ──────────────────────────────────│
  │◄── HTTP 200 JSON ───│                         │                       │
  │ render panel        │                         │                       │
```

---

## Protocol — New Message Types

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
interface SearchResult {
  url: string;
  platform: "twitter" | "instagram" | "linkedin" | "reddit" | "web" | "none";
  title: string | null;
  snippet: string | null;
  imageUrl: string | null;
  fetchedAt: number;
  sourceStrategy: "serpapi" | "playwright" | "embedding-fallback";
  engine: "google_lens" | "yandex" | "playwright" | "embedding-fallback";
}

interface PythonPipelineResultMessage {
  type: "pipeline.result";
  sessionId: string;
  error?: string;
  face?: { bbox: BBox; confidence: number };
  results: SearchResult[];
  anchorStrategy: "search" | "embedding" | "none";
  enginesUsed: string[];   // e.g. ["google_lens", "yandex"]
}
```

### External: Bun → Browser (HTTP)
```typescript
interface PipelineResponse {
  face: { bbox: BBox; confidence: number } | null;
  results: SearchResult[];
  anchorStrategy: "search" | "embedding";
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
| Face detection | InsightFace `buffalo_l` + RetinaFace | Already in repo |
| Face embedding | ArcFace 512d (L2-normalised) | Already in repo |
| Inference runtime | ONNX Runtime (CUDA → CPU) | Already in repo |
| **Search — primary** | **SerpAPI Google Lens** (`engine=google_lens`) | Parallel, Google index |
| **Search — primary** | **SerpAPI Yandex** (`engine=yandex`) | Parallel, Yandex index, better face recall |
| Search fallback | Playwright Chromium headless | Only if both SerpAPI calls fail |
| HTTP client | `httpx` (async) | Async parallel requests |
| Result merging | Custom: dedupe by URL + platform score | In `search.py` |
| Bun server | Bun 1.4+ | Already in repo |
| Blockchain | Ethereum Sepolia (ChainID 11155111) | Free testnet |
| Chain client | ethers.js v6 | Native Bun/ESM |
| Smart contract | Solidity ^0.8.24 | Minimal, auditable |
| Hash | SHA-256 via `crypto.subtle` | No deps, deterministic |
| Contract deploy | Hardhat + TypeScript | Industry standard |

---

## Environment Variables

```bash
# apps/web/.env

MIRA_SERVE_URL=ws://127.0.0.1:8765
MIRA_ENROLLMENT_SYNC_ENABLED=false

# Search — single key drives both Google Lens AND Yandex
SERPAPI_KEY=your_serpapi_key_here

# Blockchain
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
WALLET_PRIVATE_KEY=0x...
FACE_RECORD_CONTRACT_ADDR=0x...
```

---

## Locked Design Decisions

| # | Decision |
|---|----------|
| Search engines | **Google Lens + Yandex in parallel** via SerpAPI (same key, no extra cost) |
| Search fallback | **Playwright Chromium headless** — only if both SerpAPI engines return 0 |
| No-result fallback | **SHA-256(embedding bytes)** anchored to chain; `uri = "face-embedding://{hash}"` |
| Wallet | **Fresh burner wallet** via `bun run gen:wallet` |
| Contract deploy | **`bun run deploy:contract`** — Hardhat writes addr to `.env` |
| Demo input | **Live webcam** — "Run Pipeline" captures current frame |
| R2 / auto-enroll | **Soft-disabled** via `MIRA_ENROLLMENT_SYNC_ENABLED=false` |

---

## Performance Budget

| Stage | Target | Notes |
|-------|--------|-------|
| Face detect + embed | < 200ms | ONNX, 320×320 |
| Face crop + encode | < 50ms | Pillow |
| Google Lens search | ~1-2s | ) both fire at |
| Yandex search | ~1-2s | ) t=0, complete together |
| **Parallel search wall time** | **< 2.5s** | Limited by slower of the two |
| Playwright fallback | < 8s | Cold Chromium launch |
| Blockchain tx submit | < 2s | Just broadcast |
| Blockchain confirm (1 block) | ~12-15s | Sepolia ~12s block time |
| **Total E2E** | **< 20s** | Dominated by chain confirm |
