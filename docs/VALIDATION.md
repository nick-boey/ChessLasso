# Prototype verification

Verified on 1 November 2026 with Node 26.7.0 and Google Chrome through Playwright. The application runs locally at http://127.0.0.1:5173 with Hono on port 3001.

## Automated checks

`npm run verify` passes:

- Svelte component/accessibility diagnostics: zero errors and warnings, using TypeScript 7.
- Backend/shared-code type checking: passes.
- Type-aware Oxlint: passes with warnings disallowed.
- Six rules/API tests: pass. Coverage includes rejected-entry immutability, ambiguity, castling, optional check suffixes, promotion, PGN setup/history, legal opponent replies, budget validation and malformed/oversized requests.
- Vite production build: passes.
- Oxfmt and the Svelte-only template formatter: pass.

`npm run test:ui` passes twelve browser scenarios:

1. The coach supplies the task heading; move controls are icon-only, with no opponent/new-game/download controls.
2. Rejected notation opens guidance and preserves input, position and keyboard focus.
3. Keyboard SAN submits a legal move, receives a legal reply and supports flipping the board.
4. Every accepted move creates a position-linked conversation and reveals its instructions, retaining prior discussion.
5. Demonstration steps change their rendered board, including the castled king position, without modifying the game.
6. A separate question board validates a candidate without modifying the game.
7. PGN and budget preferences survive reload.
8. The coach changes the task heading/subtitle independently of board state.
9. Scripted coach actions load a custom position/full game and toggle observation.
10. Failed offline submission preserves state and succeeds after reconnection.
11. Mobile move submission reveals the new coaching instructions.
12. Layout has no horizontal overflow at 320, 390, 760, 1024 and 1440 px.

No uncaught browser page errors occurred. Repeatable checks and screenshot capture live in `scripts/check-ui.mjs`. Artifacts are generated under `output/playwright/`: `desktop.png`, `mobile.png`, `demonstration.png` and `checks.json`. They are intentionally ignored by Git and can be regenerated.

The built application was also started separately with `npm start`; its HTML, bundled JavaScript asset and Hono health endpoint served successfully.

## Toolchain

| Tool                                             | Installed version                        |
| ------------------------------------------------ | ---------------------------------------- |
| Vite                                             | 8.3.5                                    |
| Native TypeScript compiler                       | 7.0.2, installed as `@typescript/native` |
| TypeScript compiler API required by svelte-check | 6.0.3                                    |
| Oxlint                                           | 1.90.0                                   |
| Oxfmt                                            | 0.75.0                                   |
| Svelte                                           | 5.57.3                                   |
| Svelte checker                                   | 4.7.7                                    |

The TypeScript alias follows svelte-check's documented `--tsgo` setup. Oxfmt does not format Svelte templates, so Prettier and its Svelte plugin are scoped to `.svelte` files. Plain CSS uses no styling framework.

## Visual review

The Impeccable detector returned no findings. An independent finish review inspected desktop, mobile and demonstration captures against PRODUCT.md and the direction contract, returning **ship**, with no material fixes. There was no approved image comp or comparative quality-bar card; the direction service ran without catalog challengers. The approved simple application layout and later instruction to remove promotional headings governed the result.

## Limits

These checks establish prototype behavior, not coaching efficacy or production readiness. Real Pi/model calls, Stockfish analysis, durable coaching history, imports, private Git backups, daily meetings, billing enforcement and autonomous deployment are specified in the PRD and are not implemented here. Screenshots use reduced motion to capture settled positions. Actual phones, other browsers, screen-reader operation and long-duration load have not been tested.

`npm audit` reports two low-severity development-tool findings for the same unpatched `deepmerge` advisory, through the latest Svelte Vite plugin: [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4). No patched release was available during verification. The prototype binds to loopback and has no production authentication; keep it local.
