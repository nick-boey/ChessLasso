# ChessLasso

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

User-selected TypeScript, Hono, Pi agent runtime, Svelte and Stockfish. A responsive browser app served locally over Tailscale; no native packages or offline coaching in the first release.

## Users

One beginner chess player seeking well-rounded, sustainable improvement. FIDE standard is a reference, not a deadline or an imposed rating target. Most imported results will be from Chess.com across several time controls.

## Product Purpose

An adaptive coach observes attempts and reasoning, identifies evidence-backed weaknesses, teaches, and tests independent retention and transfer. The coach establishes a baseline and negotiates training commitments with the player over time.

## Operating Context

Board and conversation are the core interface on desktop and mobile. All player moves are entered using algebraic notation and validated before play. The coach controls positions, examples, demonstrations and opponents through tools. Exercises and assistance policies can change at runtime.

## Capabilities and Constraints

- Track assistance per event, not rigid game categories. Never equate bot results or accuracy with a calibrated FIDE rating.
- Questions can include a board. Demonstrations have annotated steps in a separate modal board.
- Keep timestamped PGNs, searchable index, profile, diary, prompt versions and Pi-native logs in a separate private data repository.
- Consolidate daily at configurable 04:00 Australia/Sydney, including independent assistant-coach critique, training plans and app backlog.
- Nightly Codex improvements may deploy after checks, with rollback and no restart during active use. Personal data and permissions remain protected.
- No budget cap by default; runtime-configurable warning or hard cap. Do not preferentially defer background improvements.
- Add client/server OpenTelemetry traces, logs and metrics, stored locally outside Git with rolling 90-day retention. Preserve the separate durable coaching archive.
- Public application source is GPL compatible. Deterministic mock mode remains available alongside live Pi/Stockfish coaching. Autonomous code deployment remains pending a verified isolated runner and external release adapter.

## Brand Commitments

Name: ChessLasso. Supportive, clear and specific coaching; a Ted Lasso persona is not required. Simple board and chat, informed by En Croissant interactions.

The interface is a compact application workspace. Coach-controlled task headings/subtitles are dynamic lesson content. No promotional copy, opponent metadata, manual New game or individual-game download controls. Move entry uses icons for play and notation with accessible labels. Group conversation by move and scroll to new coaching instructions after accepted moves.

## Evidence on Hand

The interview in this chat supplies the approved product decisions. Prototype history and progress data are illustrative and must be labelled. Research references and acceptance criteria belong in docs/PRD.md.

## Product Principles

1. Preserve the player's opportunity to think.
2. Separate observed events from explanations and estimates.
3. Teach notation without mistaking typing errors for chess weakness.
4. Evaluate independent transfer, not assisted completion alone.
5. Improve the application without risking the coaching archive.
