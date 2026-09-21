<p align="center"><img src="public/logo.svg" alt="loqo" width="96"></p>

# loqo

Self-hosted, LLM-driven localization for software. Adapters pull strings out of the places they live (iOS `.xcstrings`, Android `values` XML, flat JSON, Payload CMS), the platform translates them through a versioned pipeline of prompts and guards, and the adapters write the results back — as a pull request in CI or in place inside a CMS.

- **Pipeline as data.** Layers (a literal translate pass, a native-speaker enhance pass), models and prompts are edited in the UI and versioned in Postgres, so every translation records exactly which prompt produced it.
- **Guards, not hope.** Placeholder, plural and newline parity, length caps and brand terms are checked in code; a failing value goes back to the model with a repair instruction before it is rejected.
- **Scenarios.** Resource tags (`ios`, `email`, `google-ads`, …) select prompt fragments and guards per content type.
- **Human control.** Pin a value to freeze it, mark it native to make it a reference example, invite members with reader/editor/admin roles, mint per-project API keys for CI.
- **Cost visible.** Token usage and provider prices are tracked per run.

## Architecture

```
  repository / CMS                        loqo (Bun)                          LLM providers
┌──────────────────┐   POST /import   ┌──────────────────────┐   provider:model   ┌───────────┐
│ @loqo/adapters   │ ───────────────▶ │ server ── Postgres   │ ────────────────▶  │ OpenAI    │
│ @loqo/payload    │                  │   │      (drizzle,   │   translate ▸      │ Anthropic │
│ your adapter     │ ◀─────────────── │ worker ◀─ pg-boss)   │   enhance ▸ guards │ …         │
└──────────────────┘ GET /translations└──────────────────────┘                    └───────────┘
```

- `src/server` — HTTP API and the React UI (Bun bundles `src/ui` at startup). Google sign-in for people, project API keys for machines.
- `src/core` — the domain: resources and targets, layers and prompts, scenarios, guards, the pipeline, pricing, members, audit.
- `src/core/queue` — a pg-boss worker groups queued targets by locale and runs them through the layers with batching, concurrency limits and per-provider 429 backoff. `ROLE=server` / `ROLE=worker` splits the two processes when scaling out; the default runs both.
- `translate.config.ts` — what stays code: provider registry (any [AI SDK](https://ai-sdk.dev) provider), guards, value processors, code stages, deployment-owned prompt fragments. Point `TRANSLATE_CONFIG` at your own copy.
- `packages/sdk` — the `Adapter` contract (`pull()` / `push()`) and a typed HTTP client. Adapters run where the content lives, never inside the platform.
- `packages/adapters` — `.xcstrings`, Android XML and JSON adapters plus the `loqo-sync` CLI (`request` → `check` → `import`), wrapped by `.github/actions/sync` for a translate-and-open-a-PR loop.
- `packages/payload` — a Payload CMS plugin: documents import on save, translations apply back from the admin UI.

## Self-hosting

Requirements: Docker, a Google OAuth client (type *Web application*, redirect URI `${APP_URL}/api/auth/google/callback`), and an OpenAI and/or Anthropic API key.

```sh
cp .env.example .env      # fill in GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OPENAI_API_KEY / ANTHROPIC_API_KEY
docker compose up -d      # Postgres + app on http://localhost:3000
```

Migrations and the built-in layers, prompts and scenarios are applied on startup. Sign in, create a project, then mint an API key on it and sync from a repository:

```sh
npx -p @loqo/adapters loqo-sync request --adapter xcstrings --project my-app \
  --base-url https://translate.example.com --api-key $LOQO_API_KEY
```

Set `APP_URL` to the public origin behind your proxy; cookies are marked secure in production. See `.env.example` for worker tuning (`TRANSLATE_CONCURRENCY`, `TRANSLATE_BATCH_SIZE`, `DATABASE_POOL_SIZE`).

### Local development

```sh
bun install
docker compose up -d postgres
bun dev                   # hot-reloading server + worker on :3000
bun test && bun typecheck
```

## License

MIT
