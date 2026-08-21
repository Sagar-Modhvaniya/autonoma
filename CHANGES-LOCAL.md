# Local deviations from upstream (Autonoma-AI/autonoma)

Tracking file for everything this clone changes, so a future fork/PR can
separate self-host convenience hacks from upstreamable work. NEVER push this
clone anywhere; PRs to upstream get cherry-picked from the `feat/gitlab-provider`
commits only.

## Branch layout
- `local/self-host` — all self-hosting tweaks below (NOT for upstream)
- `feat/gitlab-provider` — GitLab integration (CANDIDATE for upstream PR, keep clean)

## Self-host tweaks (local/self-host, not upstreamable as-is)
- `apps/api/src/app.ts` — mount LLM proxy without STRIPE_ENABLED (self-hosted, unmetered)
- `apps/api/src/env.ts` — `LLM_PROXY_UPSTREAM_URL` (point proxy at any OpenAI-compatible gateway)
- `apps/api/src/llm-proxy/llm-proxy-http.router.ts` — configurable upstream; skip OpenRouter-only `usage` param for non-OpenRouter upstreams
- `apps/ui/vite.config.ts` — UI port 3300 (artha dev owns 3000); `.api-port` read from apps/api/ (upstream reads repo root — arguably a real bug, could be its own tiny PR)
- `packages/ai/src/env.ts` + `registry/providers.ts` — `OPENROUTER_BASE_URL` override (route engine models through local LiteLLM → Azure)
- `packages/ai/src/registry/model-entries.ts` — added OPENROUTER_MODEL_ENTRIES.GEMINI_3_5_FLASH_LITE
- `packages/engine/src/platform/engine-model-registry.ts` — engine slots use OpenRouter-routed entries (single-key self-hosting)
- `packages/storage/src/env.ts` + `providers/s3-storage.ts` — `S3_ENDPOINT` for MinIO (possibly upstreamable)
- `packages/visual-ai/src/freestyle/object/{qwen,gemini}-object-detector.ts` — `label` optional→nullable (Azure strict structured outputs; possibly upstreamable)
- `docker-compose.override.yaml`, `litellm-config.yaml` — local infra (MinIO, LiteLLM, port remaps)

## GitLab integration (feat/gitlab-provider, upstream candidate)
- See commits on that branch; all new code under `packages/github/src/gitlab/`
  plus minimal env/factory wiring in `apps/api`.
