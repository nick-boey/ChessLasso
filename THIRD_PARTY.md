# Third party notices

- [Chessground](https://github.com/lichess-org/chessground), Lichess contributors, GPL-3.0-or-later. The board uses the bundled Cburnett piece artwork and stylesheet; retain their source/license notices when redistributing. See its package LICENSE and asset comments.
- [chess.js](https://github.com/jhlywa/chess.js), Jeff Hlywa and contributors, BSD-2-Clause. Used for rules and PGN processing.
- [Manrope](https://github.com/sharanda/manrope), its authors and contributors, SIL Open Font License 1.1. Self-hosted via Fontsource.
- [Marked](https://github.com/markedjs/marked), MIT, parses chat Markdown; [DOMPurify](https://github.com/cure53/DOMPurify), Apache-2.0 or MPL-2.0, sanitizes the rendered content. Retain their bundled license notices.
- Svelte, Hono, Vite and the development tools retain the licenses distributed with their packages.

En Croissant was studied for architecture and interaction patterns. Its React/Tauri components were not copied into the prototype. Stockfish is specified for production but no engine binary is included.

Stockfish is used via `stockfish@19.0.1`, GPL-3.0. The portable lite-single build's corresponding source and build instructions are available at https://github.com/nmrugg/stockfish.js/releases/tag/v19.0.1 and https://github.com/nmrugg/stockfish.js. Upstream engine source: https://github.com/official-stockfish/Stockfish. Keep the installed package's license/source notices if distributing its binary/WASM. Engine searches record build/network provenance.
