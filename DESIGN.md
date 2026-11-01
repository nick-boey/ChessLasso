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
  metadata:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '10px'
    fontWeight: 400
    lineHeight: 1.65
rounded:
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

- **Study Green** (`green`): primary actions, selected navigation, coaching links and author labels.
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
- **Conversation:** the conversation token keeps short coaching messages compact and readable.
- **Label:** the label token serves controls and move-entry labels. Navigation has its own slightly larger, lighter token.
- **Metadata:** the metadata token supports authors and compact state. Minor disclosures range from 9–11px; these are supporting copy, not primary instructions.

Position-context labels and session numbers use tabular numerals. Mobile candidate inputs and the conversation textarea increase to 16px; the main move field keeps the base 14px size. Keep labels sentence case and concrete.

**The Functional Copy Rule.** Coach-controlled task headings and subtitles describe the current activity. Keep controls, state, disclosures and coaching content specific; do not add promotional copy, motivational filler or website-style introductions.

## Layout

The desktop header is 56px tall. The centered main container has a maximum width of 1160px and padding of 12px 16px. The board/conversation grid uses `minmax(0, 1.1fr) minmax(340px, 1fr)` with a 16px gap. A compact task heading and subtitle sit above the square board, with Flip aligned alongside. A single input/play/notation row follows 8px below the board. Opponent metadata, manual New game, board toolbar, move ledger and individual-game download controls are absent from this workspace.

The coach panel stretches alongside the board, capped at 840px, with a scrolling transcript and bottom composer. Its header uses 10px 12px padding, the transcript uses 8px 12px with a 160px minimum height, and composer controls use 8px 10px padding. Message spacing is 10px. Position sections use 4px top and 12px bottom padding; a hairline context label precedes each group. The newest section occupies at least the transcript's full height so its instructions can align at the top.

Below 1080px the practice grid gap becomes 24px and the coach minimum column is 320px; the header's prototype tag hides. Below 760px the header wraps navigation onto a 38px full-width row and hides the profile avatar. Both practice and reading layouts become a single column with 16px gaps and 12px main gutters. The order is task, board, move entry, coach. The coach panel has a 360px minimum and 560px maximum height. The move row's play and notation targets grow from 40px columns to 44px square controls. The 1500px media rule preserves the 12px main top padding.

Reading surfaces retain a `1.65fr / minmax(280px, 1fr)` desktop grid with a 16px gap and 20px paper padding, reducing to 16px padding on mobile. Spacing remains compact and functional, with component-specific optical values rather than a fabricated uniform scale.

## Elevation & Depth

Resting work surfaces are flat: white paper, fine borders and tonal insets create hierarchy without card shadows. Only native dialogs use the ambient shadow `0 16px 60px #152e3b26` and the dark petrol scrim. A dialog arrives over 180ms with `cubic-bezier(0.16, 1, 0.3, 1)`, moving from 8px below at 0.8 opacity to rest. Reduced-motion CSS removes animations and transitions and restores automatic scrolling. Chessground separately disables its 180ms piece animation when reduced motion is requested at mount. After accepted moves, transcript scrolling is smooth by default and instant under reduced motion; mobile also brings the coach panel into view without moving keyboard focus away from move entry.

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

### Quick actions and disclosures

Hint, Observe / Resume coaching and Example are bordered, 5px-rounded action chips with compact 10px text. They wrap when necessary and take a faint green hover fill. The prototype tag is a noninteractive status disclosure, not a section eyebrow. Preserve the scripted-coach disclosure below the composer.

### Coach panel and position conversations

The coach panel is white paper with a hairline boundary and panel rounding. Its simplified header contains a small Coach label, optional Observing state and availability dot. Coach messages remain on the paper; learner messages use a 9px-rounded tonal inset with a 10px left indent and 7px 10px padding. Message text wraps safely at 13px with 1.6 line height.

Each position owns a conversation section, introduced by a tabular move-context label and hairline divider. Accepted moves append a new section and scroll its instruction to the top of the transcript. Earlier discussion remains attached to its original position; subsequent messages and quick actions append to the current section. In Observe mode an empty new section displays Observing. Conversation updates remain polite live announcements, and scroll behavior honors reduced motion.

### Board and demonstration

Chessground supplies the brown checker and Cburnett pieces. Boards are view-only with labeled image semantics, coordinates and last-move highlights; algebraic input remains the move mechanism. Flip changes the main board orientation. The native demonstration dialog holds its own maximum-410px board, an annotated step and Previous / Next controls with named step dots. It preserves the main game, supports Escape and close controls, and returns focus to move entry on closing from the board page. Standard dialogs are at most 560px wide; board dialogs are at most 610px, with 16px padding, viewport gutters and vertical scrolling. Demonstration boards use a 5px frame and 12px vertical margins, reducing those margins to 10px on mobile.

## Do's and Don'ts

### Do:

- **Do** keep the coach-set task, board, compact move entry and position-scoped coach feed as the primary workspace.
- **Do** use green for available actions, coaching identity and current state.
- **Do** preserve keyboard focus, visible or accessible labels and reduced-motion behavior.
- **Do** keep move validation, icon-based notation help and rejected input close to entry.
- **Do** attach follow-ups to their position and reveal new instructions after accepted moves.
- **Do** disclose scripted coaching and illustrative data in functional copy.
- **Do** use the existing plain CSS layers and imported Chessground material.

### Don't:

- **Don't** add promotional copy, motivational filler or website-style introductions; task headings and subtitles are lesson content.
- **Don't** reintroduce opponent metadata, manual New game, a board toolbar, move ledger or individual-game download controls into the practice workspace.
- **Don't** give ordinary paper panels dialog shadows.
- **Don't** replace algebraic move entry with interactive board movement.
- **Don't** let demonstration steps replace or alter the player's game board.
- **Don't** introduce a styling framework or a second visual vocabulary for new screens.
