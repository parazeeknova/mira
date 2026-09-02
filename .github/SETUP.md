### How to Run ?

**Install deps:**

```bash
bun run setup
```

**Configure search engines (apps/serve/.env):**

```bash
cp apps/serve/.env.example apps/serve/.env
```

Every engine is independently gated by its own env var a missing key is skipped with a warning and the pipeline keeps running:

| Engine                        | Env var(s)                                                             | Notes                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Google Cloud Vision (primary) | `GOOGLE_VISION_ENABLED=true` + ADC or `GOOGLE_APPLICATION_CREDENTIALS` | Raw image bytes                                                                                                                     |
| SerpAPI Google Lens + Yandex  | `SERPAPI_KEY`                                                          | One key drives both engines in parallel (2 searches per run).                                                                       |
| FaceCheck.id                  | `FACECHECK_API_TOKEN`                                                  | Dedicated 1.4B face index for local its only 140K, base64 crops in response (no downloads). set `FACECHECK_DEMO=true` for local dev |

**Google Cloud credentials:**

The Vision engine authenticates via Application Default Credentials (ADC):

```bash
gcloud auth login                                   # log into your Google account
gcloud config set project YOUR_PROJECT_ID           # any project with Vision API enabled
gcloud services enable vision.googleapis.com        # enable the Cloud Vision API
gcloud auth application-default login               # writes ~/.config/gcloud/application_default_credentials.json
```

Leave `GOOGLE_APPLICATION_CREDENTIALS` unset in `apps/serve/.env` — the client library finds ADC automatically. (Alternative for CI/other machines: create a service account key JSON and point `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json` at it.)

Tuning knobs (all optional, sensible defaults): `SEARCH_MAX_RESULTS`, `SEARCH_TIMEOUT_SECONDS`, `COSINE_THRESHOLD` (0.35), `CACHE_THRESHOLD` (0.60), `CACHE_DB_PATH` (default `data/mira_cache.db`, auto-created).

**Run:**

```bash
bun run dev
```
