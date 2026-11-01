# ChessLasso

Personal chess training with a Svelte interface, Hono/TypeScript backend, restricted Pi coach and real Stockfish. Keyboard SAN moves, a position-scoped coach feed, separate lesson boards and a durable private coaching archive. See [PRD](docs/PRD.md), [architecture](docs/ARCHITECTURE.md) and [verification](docs/VALIDATION.md).

## Run

Use Node 24 or newer, npm and Google Chrome for browser checks.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The production build runs with `npm run build && npm start` at http://127.0.0.1:3001. Both bind to loopback. A first run uses deterministic mock coaching. Open **Settings**, choose **Live model + Stockfish**, and save to use the server-side `GEMINI_API_KEY` in `.env`. Keys never enter the frontend. Runtime settings survive restart. `.env.example` documents optional configuration; do not overwrite an existing `.env` containing a key.

The live default is **gemini-3.8-flash**. There is no silent model fallback: Settings shows and changes the exact model/provider. Fireworks is supported by Pi and requires `FIREWORKS_API_KEY`, an available Pi model ID and explicit selection; it has not been live tested.

Enter `Nc3` in the initial position. Stockfish plays the opponent in live mode; the coach decides how to respond. Discuss your plan, ask for an example, request a fresh independent game or ask the coach to set up a position. Only the coach changes activities. **Observe** requests less help; **Hint** requests assistance. All player moves require legal short algebraic notation. Settings can pause practice and change/remove the monthly budget at runtime. Progress supports PGN paste and incremental Chess.com imports; original metadata and bytes are retained, malformed imports are quarantined.

## Private state and backup

Default sibling directories, outside the public checkout:

- `../chesslasso-runtime/`: SQLite operational state, daily job checkpoints, local telemetry and protected supervisor.
- `../ChessLasso-coaching/`: profile, plans, daily diary, annotated timestamped PGNs/index, events, prompt revisions, native Pi JSONL and recoverable workspace checkpoints.

The configured private remote is `nick-boey/ChessLasso-coaching`. Setup created it and verified PRIVATE before the first successful push. Other operators set `CHESSLASSO_ARCHIVE_REPO` and create their own private repository with `gh`. Backups verify visibility and exact remote on every checkpoint, commit dirty files every five minutes and after consolidation, and retry failed pushes without blocking play. They never force-push. The app can recover the board, conversation, usage and archived events from a private workspace checkpoint into a missing SQLite database. Access tokens are excluded from that checkpoint.

Keep both directories private and outside the source repository. Never put telemetry in Git or backup snapshots: operational traces/logs/metrics expire after 90 days; durable teaching records do not. The built-in local collector uses bounded JSONL storage and reports drops at `/api/telemetry/status`. The local telemetry pipeline has no cloud exporter.

## Tailscale access

Use Tailscale Serve HTTPS to the built loopback server, not Funnel. Put the exact HTTPS origin in `CHESSLASSO_ORIGINS` and set a strong `CHESSLASSO_ACCESS_TOKEN` in the server environment. Restart, open that HTTPS origin and enter the token. Same-origin session cookies, Origin/Host checks and bounded requests protect the API. Direct loopback access bootstraps a local session automatically. Never expose the loopback service through an untrusted public proxy.

## Daily meeting and application improvements

The durable scheduler runs at 04:00 Australia/Sydney and catches missed days after wake. A separate assistant session critiques the lead proposal for up to two rounds. Profile/plan/prompt updates remain staged until accepted; unresolved objections preserve the previous strategy. Diary, critique and accepted app proposals remain in the private archive. Mock meetings are explicitly labelled.

```sh
npm run setup:runtime
```

This installs a supervisor/policy outside the coding checkout and preserves existing policy on repeat. **Automatic Codex implementation and deployment are pending**: this machine's Docker daemon is stopped, and an independently isolated runner and trusted release adapter have not been configured or recovery-tested. The installed supervisor can create detached candidates and run configured development, verification, browser and recovery stages; protected changes require approval. It deliberately cannot use a host Codex workspace-write session as a private-data isolation boundary. Settings shows the pending reason. No deployment or restart is claimed, and daily coaching continues. Configure/verify filesystem denial, backup/recovery, active-use gating and executable rollback before enabling the external policy.

Monthly budgets default to uncapped. A hard cap reserves conservatively before every model request, including tool follow-ups and background coaching; warnings do not preferentially defer background work. Costs use Pi's installed model catalog and are estimates, not invoice guarantees. Failed/unknown usage may retain a conservative reservation. Codex subscription usage requires separate accounting in the external runner.

## Checks and tooling

```sh
npm run check
npm run lint
npm test
npm run build
npm run format
npm run verify
```

Oxlint handles JS/TS and Svelte script blocks; Svelte's checker also validates components and accessibility. Oxfmt handles supported source formats; Prettier with the Svelte plugin formats only `.svelte` templates, which Oxfmt does not yet support. All styling is plain modern CSS in `src/style.css`; no CSS framework is installed.

TypeScript 7 is installed as `@typescript/native` and runs through `svelte-check --tsgo` and its own compiler. Current svelte-check additionally needs the TypeScript 6 compiler API, installed as `typescript`. This is its documented compatibility setup, not a downgrade of the compiler used to check the app. The lockfile pins exact versions.

## Browser and live checks

```sh
npm run test:ui
npm run smoke:live
node scripts/check-live.mjs
```

The browser command builds and starts its own mock server with temporary synthetic data, then takes desktop/mobile/demonstration screenshots in ignored `output/playwright/`. It does not use the private training archive or make paid calls. `CHESSLASSO_TEST_URL` can point at another **disposable mock server**; the scenarios change that workspace.

The two live commands intentionally make bounded paid Gemini calls using `.env`: `smoke:live` checks Pi→Stockfish tool calling; `check-live.mjs` checks the full HTTP move, engine, coaching, idempotency and restart path in a temporary archive. Neither prints keys or retains its synthetic history. Normal `npm test` is entirely mocked except for actual local Stockfish execution.

Source is GPL-3.0-or-later; see [THIRD_PARTY.md](THIRD_PARTY.md). The portable Stockfish 19.0.1 lite-single build is supplied by the `stockfish` dependency; native `STOCKFISH_PATH` is optional. Engine skill is not a calibrated human rating. Exposure timing is not measured attention; the coach must report sample counts and uncertainty.

## Known tooling advisory

The latest Svelte Vite plugin currently depends on `deepmerge` with a low-severity prototype-poisoning advisory (GHSA-gcqx-w48m-w2h4); npm counts the dependency and plugin as two affected packages. No patched release was available at verification. This is build tooling using trusted local configuration, not a production API dependency. Keep development servers local.
