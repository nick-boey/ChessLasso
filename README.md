# ChessLasso

A Svelte + Hono interaction prototype for a personal chess coach. Read [the PRD](docs/PRD.md) and [architectural notes](docs/ARCHITECTURE.md) for the full production design and delivery boundary.

## Run locally

Use Node 24 or newer and npm. No API keys or Stockfish installation are needed for this prototype. It stays mocked even if `GEMINI_API_KEY` is present in `.env`; that server-only key is reserved for the live-coach implementation after prototyping.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. Vite serves the frontend and proxies `/api` to Hono on port 3001. To use the built version:

```sh
npm run build
npm start
```

Open http://127.0.0.1:3001. Both servers bind to loopback. The prototype has no authentication; keep it local. Tailscale access controls and production authentication are specified in the PRD, not installed by this demo.

## Try the interactions

- Enter `Nc3` in **Your move**. The server validates it and plays a deterministic legal reply. Moves cannot be submitted by clicking or dragging.
- Try `e2e4`, an illegal move, or an ambiguous SAN entry. The board stays put, your text is preserved, and the notation guide opens.
- Select **Example** to open a separate annotated board. Step through it and return to the unchanged game.
- Tell the coach `Set up an endgame` or `Start a new game` to exercise board-setup actions.
- Send `I am considering developing a piece` and open the question board from the reply. Candidate checks leave the main game unchanged.
- Each accepted move creates a position-linked coach conversation and scrolls to its next instructions. Follow-up discussion stays with that position.
- Select **Observe**, request a hint, flip the board, inspect the sample profile/journal, or change the budget preference.
- Tell the coach `Focus on calculation` to change the task heading/subtitle without replacing the board. The coach controls training activities; there is no manual New game or game-download button.

All coaching is deterministic and labelled. `config/mock-coach.json` supplies its responses, demonstration steps and notes. No model or engine analysis runs. The opponent is a legal-move fixture, not Stockfish or a strength-calibrated bot. Budget settings save a preference only; there are no paid calls to enforce a cap against.

The current PGN and preferences recover from browser localStorage. Chat/event history is session-only. Clearing browser storage removes this prototype position. Production PGN recording is automatic. Nothing is written to a private coaching repository.

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

## Browser development and screenshots

Start `npm run dev` in one terminal, then run `npm run test:ui` in another. The browser check uses an isolated headless Google Chrome profile (Google Chrome must be installed), exercises the mock flows, and writes screenshots and `checks.json` to `output/playwright/`. The server remains separate so you can also inspect it interactively. Override `CHESSLASSO_TEST_URL` when checking a built server.

The Playwright CLI can use an isolated browser without model credentials:

```sh
npx @playwright/cli open http://127.0.0.1:5173
npx @playwright/cli resize 1440 1080
npx @playwright/cli snapshot
npx @playwright/cli screenshot --filename output/playwright/desktop.png
npx @playwright/cli resize 390 844
npx @playwright/cli screenshot --filename output/playwright/mobile.png --full-page
```

Create `output/playwright` first. Read fresh snapshot references before clicking/filling controls. Run the notation-error, legal move, stepped demonstration, board question, setup, settings persistence, per-move scrolling and dynamic task-header flows described above. Console errors or horizontal overflow are failures. Use a clean browser profile when repeating scenarios; localStorage restores the last board.

For production Pi integration, replace the fixture dispatcher with the restricted Pi host described in the PRD. Pi's `fauxProvider`/`fauxToolCall` should supply deterministic tool calls through the real host. Development screenshots and tests must use synthetic records and temporary data roots, never a real private coaching archive.

## Source and licensing

Application source is GPL-3.0-or-later. Chessground and its piece art retain their original notices; see [THIRD_PARTY.md](THIRD_PARTY.md). No Stockfish binary is distributed here. This prototype does not create GitHub repositories, schedule coaching, invoke Codex, or deploy updates.

## Known tooling advisory

The latest Svelte Vite plugin currently depends on `deepmerge` with a low-severity prototype-poisoning advisory (GHSA-gcqx-w48m-w2h4); npm counts the dependency and plugin as two affected packages. No patched release was available at verification. This is build tooling using trusted local configuration, not a production API dependency. Keep development servers local.
