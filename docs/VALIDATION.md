# Implementation verification

Verified on 1–2 November 2026 (Australia/Sydney) with Node 26.7.0 and Google Chrome through Playwright. Version 0.2 retains the approved compact prototype and implements the real training path.

## Automated checks

`npm run verify` passes: native TypeScript 7/Svelte checks, zero component warnings, type-aware Oxlint, 30 tests, production build, Oxfmt and the Svelte-only formatter.

Tests cover SAN rejection/immutability, ambiguity/castling/checks/promotions, full-history Stockfish UCI and actual legal engine output, restricted Pi faux tool execution/native JSONL/redaction, authoritative versions/idempotency, archive paths and symlinks, local auth/Origin/control lease, PGN dedup/original bytes, atomic budget reservations, persistence/restart and private-checkpoint recovery (board/conversations/usage/events). Regression checks preserve a changed budget/pause during an engine reply and mark plain-text advice as assistance. Separate question answers are server-validated, persisted and idempotent without changing the main game.

Operations tests exercise QuickJS host/network/loop/memory/output denial, Sydney 04:00/DST, daily two-round critique and crash recovery, month-plus catch-up and independent development retry, real OpenTelemetry client/server traces/logs/metrics, W3C continuity, allowlisted dimensions, exact 90-day cutoff/restart/idle cleanup, dropped diagnostics/full-store behavior, protected candidate changes and preservation of external supervisor policy.

`npm run test:ui` builds and starts an isolated temporary mock server and passes 12 scenarios: icon controls, rejected notation/focus, legal move/reply/flip, move-scoped scrolling/history, demonstrations, separate server-validated board question, durable PGN/settings across reload, dynamic task heading, coach setup/observation, offline retry, mobile instruction reveal and no horizontal overflow at 320/390/760/1024/1440px. No uncaught page errors. Screenshots were visually inspected at desktop/mobile; ignored outputs are `output/playwright/{desktop,mobile,demonstration}.png` and `checks.json`.

## Live verification

- On 2 November, after the user reported adding billing, `gemini-3.8-flash` passed the bounded native Pi→inspect_board→Stockfish analyse_position check (estimated $0.0063). It is restored as the default and the saved live workspace model. The earlier timeout observations below are historical.
- Supplied Gemini key loaded only in the server. Account model discovery succeeded. `gemini-3.8-flash` is listed but repeatedly timed out in direct and Pi generation checks; it is not silently selected or substituted.
- Explicit `gemini-3-flash-preview` passed native Pi→inspect_board→Stockfish analyse_position→coaching response. Synthetic logs were deleted after checking the native session tree.
- `node scripts/check-live.mjs` passed an actual HTTP SAN move, real Stockfish reply, real paid Pi coach response, idempotent replay, independent daily coaching meeting/acceptance protocol, native JSONL and restart recovery in a disposable archive. The meeting left the main game unchanged. Model costs are estimates; the most recent move turn was approximately $0.0054, separate from meeting calls.
- Created `nick-boey/ChessLasso-coaching`, verified PRIVATE, then successfully committed/pushed its initial private checkpoint. The public source remains separate and `.env` is ignored.
- Read-only final defect review identified the in-flight settings race and missing plain-chat assistance provenance; both were fixed with regression tests.

## Operational limits

Automatic Codex implementation and release are **pending**, not operationally complete. Docker's daemon is stopped; no independently isolated coding runner or external active-use/health/rollback release adapter is configured or verified. The copied supervisor/policy remains outside the app checkout, rejects protected changes, records pending work and does not fall back to a host agent that could read private files. No autonomous rollout or rollback is claimed.

Fireworks, live Chess.com account import/throttling, actual phones, screen-reader operation, long-duration load, large archive recovery and 90 days of real elapsed retention have not been tested. Retention uses injected-clock boundary tests. Games currently train without clocks; imported PGNs retain supplied time controls. Small personal samples and foreground exposure cannot establish a calibrated FIDE rating or actual attention.

OpenTelemetry uses official SDKs plus an authenticated in-process normalized JSONL collector, rather than the originally proposed external OTLP Collector. All three signals and their 90-day contract are implemented; a general OTLP replay/query backend is not included.

`npm audit` retains the two low development-tool findings for the existing unpatched deepmerge advisory. New Pi dependency advisories were addressed with compatible Undici 8.12.2 and tested minimatch 11.0.1 overrides; there are no known moderate/high findings in the checked lockfile. Keep development servers local.
