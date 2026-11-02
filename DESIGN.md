---
name: ChessLasso
description: A personal chess study room with a board and coach conversation.
colors:
  green: '#286352'
  green-hover: '#1a4e3f'
  focus: '#2d735e'
  ink: '#243d44'
  muted: '#576a70'
  canvas: '#f1f4f4'
  paper: '#fff'
  line: '#dce4e4'
  field-line: '#c7d3d2'
  placeholder: '#64767a'
  player-message: '#f0f4f3'
  soft: '#e9efed'
  board-frame: '#d6bd99'
  board-light: '#f0d9b5'
  board-dark: '#c0ae91'
  error: '#973e27'
  error-surface: '#f9ede6'
  backdrop: '#16323bc2'
  prototype-surface: '#edf2e7'
  prototype-ink: '#435431'
typography:
  brand:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '23px'
    fontWeight: 800
    letterSpacing: '-0.04em'
  activity-title:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '15px'
    fontWeight: 750
    lineHeight: 1.4
    letterSpacing: '-0.015em'
  activity-subtitle:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '11px'
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '18px'
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.02em'
  dialog-title:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '20px'
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.02em'
  section-title:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '15px'
    fontWeight: 750
    lineHeight: 1.65
  body:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.65
  conversation:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '13px'
    fontWeight: 400
    lineHeight: 1.6
  message-heading:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '13px'
    fontWeight: 800
    lineHeight: 1.5
    letterSpacing: 'normal'
  message-code:
    fontFamily: 'ui-monospace, monospace'
    fontSize: '0.95em'
    fontWeight: 600
  label:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '12px'
    fontWeight: 750
    lineHeight: 1.65
  navigation:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '13px'
    fontWeight: 650
    lineHeight: 1.65
  history-label:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '12px'
    fontWeight: 650
    lineHeight: 1.65
  metadata:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '10px'
    fontWeight: 400
    lineHeight: 1.65
rounded:
  inline-code: '3px'
  tag: '4px'
  board: '5px'
  icon: '6px'
  control: '7px'
  composer: '8px'
  inset: '9px'
  panel: '12px'
  dialog: '14px'
spacing:
  tight: '4px'
  xs: '5px'
  sm: '8px'
  compact: '10px'
  md: '12px'
  lg: '16px'
  xl: '20px'
  panel: '24px'
  section: '28px'
  page: '32px'
components:
  button-primary:
    backgroundColor: '{colors.green}'
    textColor: '{colors.paper}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '11px 17px'
  button-primary-hover:
    backgroundColor: '{colors.green-hover}'
  button-secondary:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '11px 17px'
  button-icon:
    textColor: '{colors.ink}'
    rounded: '{rounded.icon}'
    width: '38px'
    height: '38px'
  play-move:
    backgroundColor: '{colors.green}'
    textColor: '{colors.paper}'
    rounded: '{rounded.icon}'
    width: '40px'
    height: '40px'
  game-history:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.icon}'
    padding: '4px'
  history-control:
    textColor: '{colors.muted}'
    rounded: '{rounded.icon}'
    width: '32px'
    height: '32px'
  history-move:
    textColor: '{colors.muted}'
    typography: '{typography.history-label}'
    rounded: '{rounded.board}'
    padding: '5px 7px'
  history-move-selected:
    backgroundColor: '{colors.green}'
    textColor: '{colors.paper}'
  move-entry:
    textColor: '{colors.ink}'
    height: '40px'
  input:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '12px 14px'
  navigation:
    textColor: '{colors.muted}'
    typography: '{typography.navigation}'
  navigation-active:
    textColor: '{colors.green}'
  quick-action:
    textColor: '#466157'
    rounded: '{rounded.board}'
    padding: '6px 9px'
  prototype-tag:
    backgroundColor: '{colors.prototype-surface}'
    textColor: '{colors.prototype-ink}'
    rounded: '{rounded.tag}'
    padding: '4px 9px'
  coach-panel:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
  message-content:
    textColor: '{colors.ink}'
    typography: '{typography.conversation}'
  board-frame:
    backgroundColor: '{colors.board-frame}'
    rounded: '{rounded.board}'
    padding: '4px'
---

# Design System: ChessLasso

## Overview

**Creative North Star: "The Personal Study Room"**

A tournament scoresheet and a conversation share one quiet workspace. Blue-grey surroundings, white work surfaces, deep petrol ink and muted wood leave the board as the largest visual object. Restrained green marks available actions and current state. The first viewport begins with application controls, a compact coach-controlled task heading and subtitle, and the board. Task copy changes with the lesson; it is working content rather than a promotional introduction.

The interface uses self-hosted Manrope, hairline borders and precise, compact spacing. Styling is ordinary CSS in reset, base, layout and component layers, with imported Chessground board and Cburnett piece styles; there is no styling framework. Functional labels and actual coaching content carry the voice. Prototype and scripted-coach disclosures stay visible where they explain the product's limits.

**Key Characteristics:**

- Board and coach remain the primary working surfaces.
- Flat paper panels, petrol text and restrained green actions.
- Position-scoped conversation sections keep instructions and follow-ups attached to each move.
- Examples use a separate board in a native dialog.
- Responsive stacking preserves the move-entry workflow.

## Colors

The palette combines cool work surfaces with warm board materials; the frontmatter records the normative values.

### Primary

- **Study Green** (`green`): primary actions, selected navigation and history moves, coaching links and author labels.
- **Deep Study Green** (`green-hover`): enabled primary-button hover.
- **Focus Green** (`focus`): visible keyboard outlines.

### Secondary

- **Wood Frame** (`board-frame`): main and demonstration board surrounds.
- **Light Wood** (`board-light`) and **Shaded Wood** (`board-dark`): the imported Chessground brown checker. Shaded Wood is the light square under the asset's 20% black overlay.

### Neutral

- **Petrol Ink** (`ink`): body text, board coordinates and labels.
- **Quiet Slate** (`muted`): supporting text, inactive navigation and metadata.
- **Blue-grey Canvas** (`canvas`): page background.
- **White Paper** (`paper`): header, forms, dialogs and coach panel.
- **Paper Hairline** (`line`): panel edges and section dividers.
- **Field Hairline** (`field-line`) and **Placeholder Slate** (`placeholder`): form boundaries and examples.
- **Player Paper** (`player-message`): inset learner messages.
- **Soft Paper** (`soft`): inline notation and preformatted blocks inside Markdown messages.
- **Dialog Scrim** (`backdrop`): translucent separation around a modal.
- **Prototype Paper** (`prototype-surface`) and **Prototype Ink** (`prototype-ink`): functional prototype disclosure.

Errors use `error` with `error-surface` in the notation guide. Imported Chessground last-move highlighting uses a translucent yellow-green (`rgba(155, 199, 0, 0.41)`); it marks board state rather than a general action accent.

**The State Green Rule.** Green signals actions, coaching identity or current state; it does not decorate large background fields.

## Typography

**Body and UI Font:** self-hosted Manrope Variable, with sans-serif fallback. There is no separate display face or promotional display hierarchy.

### Hierarchy

- **Brand:** the compact wordmark uses the brand token; it reduces to 22px on mobile.
- **Task:** coach-controlled headings use activity-title and subtitles use activity-subtitle. On mobile the task heading uses the current 25px heading rule.
- **Title:** functional section names use the title token; the coach heading is 13px. Dialog titles use dialog-title, reducing to 18px on mobile.
- **Section title:** the section-title token supports reading surfaces; annotated demonstration steps use 17px.
- **Body:** the body token supplies the base. Reading-section paragraphs have a maximum measure of 70ch.
- **Conversation:** the conversation token keeps coaching messages compact and readable. Semantic Markdown headings use message-heading at the same size with heavier weight; inline and fenced code use message-code.
- **Label:** the label token serves controls and move-entry labels. Navigation has its own slightly larger, lighter token.
- **Metadata:** the metadata token supports authors and compact state. Minor disclosures range from 9–11px; these are supporting copy, not primary instructions.

Position-context labels, current-game move buttons and session numbers use tabular numerals. History labels use the history-label role. Mobile candidate inputs and the conversation textarea increase to 16px; the main move field keeps the base 14px size. Keep labels sentence case and concrete.

**The Functional Copy Rule.** Coach-controlled task headings and subtitles describe the current activity. Keep controls, state, disclosures and coaching content specific; do not add promotional copy, motivational filler or website-style introductions.

## Layout

The desktop header is 56px tall. The centered main container has a maximum width of 1160px and padding of 12px 16px. The board/conversation grid uses `minmax(0, 1.1fr) minmax(340px, 1fr)` with a 16px gap. A compact task heading and subtitle sit above the square board, with Flip aligned alongside. A compact current-game history panel follows 8px below the board, then a single input/play/notation row follows 8px below history. Opponent metadata, manual New game and individual-game download controls are absent from this workspace.

The coach panel stretches alongside the board, capped at 840px, with a scrolling transcript and bottom composer. Its header uses 10px 12px padding, the transcript uses 8px 12px with a 160px minimum height, and composer controls use 8px 10px padding. Message spacing is 10px. Position sections use 4px top and 12px bottom padding; a hairline context label precedes each group. Sections retain their natural height; new content scrolls to the bottom.

Below 1080px the practice grid gap becomes 24px and the coach minimum column is 320px; the header's prototype tag hides. Below 760px the header wraps navigation onto a 38px full-width row and hides the profile avatar. Both practice and reading layouts become a single column with 16px gaps and 12px main gutters. The order is task, board, current-game history, move entry, coach. The coach panel has a 360px minimum and 560px maximum height. The move row's play and notation targets grow from 40px columns to 44px square controls. The 1500px media rule preserves the 12px main top padding.

Reading surfaces retain a `1.65fr / minmax(280px, 1fr)` desktop grid with a 16px gap and 20px paper padding, reducing to 16px padding on mobile. Spacing remains compact and functional, with component-specific optical values rather than a fabricated uniform scale.

## Elevation & Depth

Resting work surfaces are flat: white paper, fine borders and tonal insets create hierarchy without card shadows. Only native dialogs use the ambient shadow `0 16px 60px #152e3b26` and the dark petrol scrim. A dialog arrives over 180ms with `cubic-bezier(0.16, 1, 0.3, 1)`, moving from 8px below at 0.8 opacity to rest. Reduced-motion CSS removes animations and transitions and restores automatic scrolling. Chessground separately disables its 180ms piece animation when reduced motion is requested at mount. Each player message, coach reply, tool update and new position section scrolls the transcript to the bottom immediately. Resizing keeps the bottom anchored when already there. A named Scroll to bottom button floats above the composer while the learner is scrolled up. Mobile also brings the coach panel into view; scrolling does not take keyboard focus from the active input.

**The Flat Workspace Rule.** Reserve ambient elevation and a scrim for dialogs; ordinary panels use borders and tone.

## Shapes

Rectangular paper surfaces have modest, purposeful rounding. Panels use panel rounding; fields use control rounding; learner-message insets use inset rounding. Move entry has no enclosing paper card. Main board frames remain nearly square, using board rounding and a 4px surround on desktop and mobile. Dialogs use the largest corner treatment. The header profile avatar and status dots are circular; the coach header has no avatar; no hard offset shadows or ornamental container shapes are part of this system.

## Components

### Buttons

Dialog and reading-surface actions pair a clear verb with an optional inline SVG icon. Primary and secondary buttons share 11px 17px padding, 12px/750 text, 10px icon gaps and a 44px minimum height. Primary actions use Study Green and White Paper; secondary actions use white with a fine muted green border. Enabled hover darkens the primary or lightly tints the secondary. Icon buttons use a 38px square target and a pale hover surface. The main move action is an icon-only green 40px square with a 6px radius, increasing to 44px on mobile. Play, notation and Flip retain accessible names and title tooltips. Disabled controls use half opacity and default cursors.

### Inputs / Fields

Fields use White Paper, Field Hairline, control rounding and 12px 14px padding. Main move entry uses a screen-reader label, the algebraic placeholder “Nc3”, a 40px input height and 7px 10px padding. The row uses `minmax(0, 1fr) 40px 40px` columns and 4px gaps; its input height and action columns become 44px on mobile. Icon controls submit or open notation help. Inline errors span the row, and rejected input remains intact. Candidate moves in question dialogs retain a visible label and the standard field treatment. The composer uses an 8px rounded outer frame, a resizable textarea with a 44px minimum height, 5px 7px internal padding, and a compact green send action. Enter submits; Shift+Enter preserves a newline. Disabled fields use a pale grey-green surface.

Keyboard focus uses a 3px Focus Green outline offset by 4px. The composer instead outlines its complete frame with a 2px muted green ring offset by 2px; its textarea has no separate outline. Preserve visible labels or accessible names, polite conversation announcements, error alerts and invalid-field state.

### Navigation

Board, Progress and Journal are functional buttons. The active item uses Study Green and a 3px bottom indicator, plus `aria-current="page"`. The header remains visible in the document flow; on mobile its navigation occupies a second full-width row. There is no separate promotional header.

### Current-game history

A flat White Paper panel sits directly below the main board, with a Paper Hairline border, 6px corners, 4px padding and an 8px gap between navigation and moves. First, Previous, Next and Latest use named inline SVG icons in a two-column grid of 32px square controls. Their disabled state marks the beginning/end or an unavailable action. They grow to 44px squares below 760px, with the established keyboard focus outline.

The wrapping SAN move buttons use tabular 12px labels, 5px corners, 5px 7px padding and a 28px minimum height, increasing to 44px on mobile. The selected move uses Study Green and White Paper plus `aria-current="step"`; the starting-position control uses the same selected treatment when appropriate. Unselected moves receive Soft Paper on hover. The list uses 4px gaps and padding, with vertical scrolling beyond 100px on desktop or 148px on mobile. Selection scrolls its button into view.

Navigation shows the position and last-move highlight after the selected ply without changing the live game. Each move label includes its move number and SAN, and the timeline supports a nonstandard starting position. While reviewing, algebraic entry and Play are disabled and the field says “Return to latest move to play”. Latest restores live entry. The chat placeholder identifies the reviewed move, and coaching requests carry that reviewed position. A new game resets review to its latest position. History remains local to the current game.

### Chat controls and disclosures

The composer has no quick-action chips. Learners request hints, examples and observation through messages. The Scroll to bottom button uses a down-arrow icon, white surface, hairline border, 7px corners and a 44px minimum height. The prototype tag is a noninteractive status disclosure, not a section eyebrow. Preserve the scripted-coach disclosure below the composer.

### Coach panel and position conversations

The coach panel is white paper with a hairline boundary and panel rounding. Its simplified header contains a small Coach label, optional Observing state and availability dot. Coach messages remain on the paper; learner messages use a 9px-rounded tonal inset with a 10px left indent and 7px 10px padding. Message text wraps safely at 13px with 1.6 line height.

Each position owns a conversation section, introduced by a tabular move-context label and hairline divider. Accepted moves append a new section. Conversation updates scroll to the bottom after rendering, including long replies and tool activity. Earlier discussion remains attached to its original position; subsequent messages append to the current section. Each tool call has its own compact row with a status icon and plain-language label, such as Read board or Read coaching notes. Running and failed calls show explicit status text; completed calls show a check. Tool rows persist in conversation history and update in place as the coach works. In Observe mode an empty new section displays Observing. Conversation updates remain polite live announcements, and scroll behavior honors reduced motion.

### Markdown messages

Both player and coach messages render sanitized Markdown with the same compact conversation treatment. Semantic headings retain their structure while all six levels use the message-heading role, normal tracking and wrapping. Top-level blocks have 8px bottom spacing, with no trailing gap after the last block. Lists indent by 20px; adjacent items have 3px spacing and paragraphs inside items have 4px vertical margins.

Blockquotes use muted text with a hairline on the leading edge and 10px inset. Inline code uses Soft Paper, a 3px radius and 1px 4px padding; preformatted blocks use 8px padding, a 5px radius and wrapping whitespace. Links remain green and underlined with the global keyboard-focus treatment. Tables use full width, fixed column layout, collapsed hairlines and 4px 6px cells aligned to the start. Horizontal rules use a single hairline. Text and long notation wrap within the message on desktop and mobile.

Markdown supports emphasis, deletion, lists, quotations, headings, code, links and tables. Rendered HTML is sanitized to the implemented semantic allowlist; preserve this boundary when extending message presentation.

### Board and demonstration

Chessground supplies the brown checker and Cburnett pieces. Boards are view-only with labeled image semantics, coordinates and last-move highlights; algebraic input remains the move mechanism. Flip changes the main board orientation. The native demonstration dialog holds its own maximum-410px board, an annotated step and Previous / Next controls with named step dots. It preserves the main game, supports Escape and close controls, and returns focus to move entry on closing from the board page. Standard dialogs are at most 560px wide; board dialogs are at most 610px, with 16px padding, viewport gutters and vertical scrolling. Demonstration boards use a 5px frame and 12px vertical margins, reducing those margins to 10px on mobile.

## Do's and Don'ts

### Do:

- **Do** keep the coach-set task, board, compact move entry and position-scoped coach feed as the primary workspace.
- **Do** use green for available actions, coaching identity and current state.
- **Do** preserve keyboard focus, visible or accessible labels and reduced-motion behavior.
- **Do** keep move validation, icon-based notation help and rejected input close to entry.
- **Do** keep the selected history move visible and clearly marked, preserve the live game during review, and require Latest before playing.
- **Do** attach follow-ups to their position and scroll to the bottom for new messages and tool updates, with a return button when scrolled up.
- **Do** preserve semantic Markdown structure with compact message typography, wrapping code and readable tables.
- **Do** disclose scripted coaching and illustrative data in functional copy.
- **Do** use the existing plain CSS layers and imported Chessground material.

### Don't:

- **Don't** add promotional copy, motivational filler or website-style introductions; task headings and subtitles are lesson content.
- **Don't** reintroduce opponent metadata, manual New game or individual-game download controls into the practice workspace.
- **Don't** give ordinary paper panels dialog shadows.
- **Don't** replace algebraic move entry with interactive board movement.
- **Don't** let demonstration steps replace or alter the player's game board.
- **Don't** introduce a styling framework or a second visual vocabulary for new screens.
