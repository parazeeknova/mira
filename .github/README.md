### Mira

Mira is a closed-set face recognition system built & designed around deterministic matching over a private identity set, cloud APIs, or scraped public data. The output is a live operator view that overlays names, roles, colors, and confidence on top of a camera feed while keeping transport, inference, and enrollment boundaries.

### Recognition Stack

The recognition service uses InsightFace with the `buffalo_l` model pack for face detection and embedding generation, backed by ONNX Runtime with CUDA enabled when available and CPU fallback. Enrolled identities are loaded from a local directory, reduced to normalized prototype embeddings, and indexed in an in-memory FAISS `IndexFlatIP` index so cosine similarity search stays exact and deterministic for a small closed dataset. ByteTrack-based stabilization is applied inside Python to reduce identity flicker across sampled frames, and the browser renders simple face boxes and labels on a 2D canvas rather than introducing a heavier WebGL path before it is necessary.

### Chosen Constraints

The current vertical slice intentionally samples frames in the browser instead of shipping a full media stream into the server for decode, because that keeps local latency predictable and preserves a clean Bun-orchestration versus Python-inference split. Enrollment is folder-based, with one directory per person and a `metadata.json` carrying `name`, `role`, and `color`, and the Python service rebuilds its in-memory state when the enrollment directory changes so the identity set can evolve during development. This keeps Mira optimized for a single local operator session, fast iterative testing, and a privacy-preserving deployment model where all sensitive recognition logic and data remain on the device.
