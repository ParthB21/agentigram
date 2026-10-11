---
name: Agentigram Electron Room
description: A monochrome desktop room for agents, their work, and shared decisions.
colors:
  bg: "#f5f5f5"
  surface: "#fff"
  surface-soft: "#fafafa"
  ink: "#171717"
  ink-soft: "#404040"
  muted: "#606060"
  faint: "#666666"
  line: "#dedede"
  line-bright: "#b6b6b6"
  accent: "#171717"
  green: "#404040"
  amber: "#404040"
  red: "#333333"
  active: "#ededed"
  conflict-line: "#a3a3a3"
  conflict-surface: "#f7f7f7"
  conflict-tint: "#e8e8e8"
  contract-line: "#d0d0d0"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "28px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.04em"
  agent-name:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "23px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.035em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "19px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.025em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  transcript:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.5
  task:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.7
  metadata:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  notice: "11px"
spacing:
  tight: "4px"
  small: "8px"
  control: "12px"
  regular: "16px"
  compact-edge: "18px"
  grid: "20px"
  inspector: "22px"
  edge: "24px"
  empty: "32px"
components:
  button-review:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  button-review-hover:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.ink}"
  button-icon:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    size: "32px"
  dock-control:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "3px 9px"
    height: "48px"
  dock-control-active:
    backgroundColor: "{colors.active}"
    textColor: "{colors.accent}"
  volume-input:
    textColor: "{colors.accent}"
    width: "76px"
    height: "18px"
  transcript-tabs:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "3px"
  severity-tag:
    backgroundColor: "{colors.conflict-tint}"
    textColor: "{colors.amber}"
    rounded: "4px"
    padding: "4px 6px"
  agent-tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "44px 24px 18px"
  dialogue-bubble:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.transcript}"
    rounded: "0 8px 8px"
    padding: "11px 12px"
  negotiation-card:
    backgroundColor: "{colors.conflict-surface}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.notice}"
    padding: "16px"
  meeting-controls:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
    height: "68px"
---

# Design System: Agentigram Electron Room

## Overview

**Creative North Star: "The control room"**

Agentigram is a plain black and white desktop room for observing agents working in a shared repository. Neutral gray surrounds white surfaces; black text, fixed runtime logos, and explicit state labels make the active work and negotiated decisions legible. The user's approved monochrome direction and system font are binding.

This document describes the shipped Electron meeting room at source revision `eca8249`. It applies to the native desktop renderer, not the separate web application. Source files in `apps/daemon/ui/` define the system; the macOS review images in `.impeccable/review/` show it at the default window, the native minimum, and with compact details open. Their `TestProject` content is an isolated demonstration fixture. Production renders the attached repository basename.

**Key Characteristics:**

- Monochrome surfaces and readable state text.
- System sans for interface copy; system monospace for tasks and event metadata.
- Fixed Claude, Codex, and Gemini SVG identities.
- Generous agent tiles with compact, centered meeting controls.
- Native window bounds, internal scrolling, and a compact details drawer.

## Colors

All interface colors are grayscale. The frontmatter records the source's actual palette names, including legacy semantic keys.

### Primary

- **Black ink** (`ink`, `accent`): headings, runtime logos, active controls, focus outlines, and the strongest visible state boundaries. Accent is the same black used for text.

### Neutral

- **Canvas gray** (`bg`): the surrounding workspace and segmented-control track.
- **Surface white** (`surface`): titlebar, agent tiles, transcript rail, controls, and contract inset.
- **Soft white** (`surface-soft`): quiet dialogue bubbles, hover surfaces, offline agents, and logo backing.
- **Body gray** (`ink-soft`): tasks, conversation text, captions, and negotiation detail.
- **Metadata grays** (`muted`, `faint`): state labels, runtime names, clocks, and secondary event information.
- **Boundary grays** (`line`, `line-bright`): default borders and stronger hover or dashed boundaries.
- **State gray** (`active`): selected meeting controls and a speaking dialogue bubble.
- **Conflict grays** (`conflict-line`, `conflict-surface`, `conflict-tint`, `contract-line`): the stronger border, lightly tinted review surface, severity tag, and contract inset boundary.
- **Semantic state keys** (`green`, `amber`, `red`): grayscale compatibility tokens for connected, negotiation, mute, error, and contract-change treatments. Their names do not authorize colored success, warning, or error treatments.

### Named Rules

**The Monochrome Rule.** Use grayscale for interface surfaces, controls, runtime marks, and states. Do not introduce a chromatic accent.

**The Written State Rule.** A dot or boundary supports an explicit status label; it never replaces the label.

## Typography

**Interface Font:** the native system sans stack recorded in frontmatter.
**Task / Metadata Font:** the system monospace stack recorded in frontmatter.

**Character:** Compact, familiar interface typography. Weight and scale distinguish hierarchy; restrained negative tracking tightens headings without introducing a display face.

### Hierarchy

- **Headline:** the room heading; reduces to 24px at the medium width and 22px in a short window.
- **Agent name:** the session name; reduces to 20px at the medium width and 17px in a short window. Long names wrap.
- **Title:** the transcript heading. Brand text uses 16px / 700; negotiation titles use 14px / 600.
- **Body:** the renderer's base role. Dialogue and supporting details use the smaller transcript role; captions use 13px.
- **Label:** short agent status text; tabs and dialogue speaker names use 12px / 600. Dock labels use 11px with a 16px line height and regular weight.
- **Task:** paths and current work, selectable and allowed to wrap anywhere. Short-window tasks reduce to 11px.
- **Metadata:** clocks, counts, event kinds, sequence numbers, and lease counts. The meeting clock uses a line height of 1 and tabular numerals.

### Named Rules

**The Two Roles Rule.** Keep interface language in system sans and code-related work or event metadata in system monospace.

## Layout

The native Electron window starts at 1240 × 780 and has a minimum of 720 × 500. Body scrolling is disabled; the agent stage and transcript own their scroll areas. The desktop surface has no mandatory mobile-web layout.

The 68px titlebar uses a three-part grid: brand at left, `Working in <project>` at center, connection and elapsed time at right. The project label truncates rather than wrapping. Reserve native controls with 84px left padding on macOS, 24px left and 152px right on Windows, and 24px left on Linux. macOS traffic lights are positioned at x18 / y18; Windows reserves a 64px titlebar overlay. Keep native drag regions and interactive no-drag regions intact.

The workspace has a flexible agent stage and a 340px transcript rail, separated by 20px with 24px outside padding. At widths of 1050px and below, the rail becomes 300px, the gap becomes 16px, and horizontal edges become 18px. At widths of 820px and below, the stage fills the workspace and Details opens a 340px floating transcript drawer, inset 18px from the right, 86px from the top, and 96px from the bottom.

The compact drawer scrolls as a whole. Its heading stays sticky and each visible transcript panel retains a 170px flex basis and minimum height; the negotiation card has no compact max-height. This keeps dialogue and the full contract review reachable within a 720 × 500 window. On the wider rail, the transcript scrolls internally and the negotiation card is independently scrollable with a 50% maximum height.

The agent stage uses two equal columns, 16px gaps, and rows with a 200px minimum. One agent is centered with a 720px maximum column; three agents give the first tile a full-width row. Below 620px in height, rows have a 185px minimum, the heading and tiles compact, and the dock moves from 18px to 12px above the bottom. More agents remain available by scrolling.

The dock is fixed to the window's horizontal center. Its collapsed launcher is 48 × 42; the open dock is 68px high. Workspace bottom padding reserves the dock area, and a visible conflict reserves 105px at the bottom of the stage. Focus mode gives the speaking agent the full width and two rows while quiet agents dim to 0.7 opacity. Presentation hides the inspector and Details control, uses the full stage, and dims the dock until hover or keyboard focus.

## Elevation & Depth

The room is flat at rest. Thin borders and subtle gray surfaces define sections, selections, and conflicts. The speaking tile adds an ink outline; the compact transcript drawer is the only renderer surface with a diffuse shadow. The native window supplies its own shadow.

### Shadow Vocabulary

- **Speaking boundary:** `0 0 0 1px var(--accent)` adds a second ink edge to the current speaker.
- **Compact drawer:** `0 12px 36px #17171720` separates floating details from the stage.

### Named Rules

**The State Depth Rule.** Use the speaking outline for active speech and the diffuse shadow for the floating compact inspector; keep ordinary cards, controls, and toasts flat.

## Shapes

Use the established gently rounded corners: small controls and contract insets use `sm`, launchers and conflict banners use `md`, and agent tiles, the inspector, and the dock use `lg`. Captions, toasts, and negotiation cards use the shared notice radius. Runtime logo backings are 10px at the usual size, while the compact avatar uses 11px. Severity tags use 4px and the selected transcript tab uses 6px.

Borders are normally 1px. Dialogue bubbles retain one square top-left corner. Status dots, task dots, and the dock close control are circular. The empty room uses a dashed border. These shapes support interaction and grouping rather than decoration.

## Components

### Buttons

Small, quiet controls with a visible boundary.

- **Review:** white surface, ink text, small corners, 36px minimum height, 12px horizontal padding, 12px / 600 label, and an inline 18px chevron.
- **Icon:** 32 × 32 for inspector close; agent voice buttons are 30 × 30 with 15px icons. Use inline stroke SVGs and explicit accessible names.
- **Hover:** soft-white surface and the stronger boundary; agent voice buttons strengthen their text color.
- **Focus:** 3px solid accent outline with 3px offset on buttons and inputs. Do not remove the keyboard indicator.

### Meeting Controls

A centered group of labeled tools rather than an unlabeled icon strip.

Dock controls have a 70px minimum width, 48px height, small corners, and icons above 11px labels. Hover lightens the surface; active controls use the active gray and ink text; pressing uses the normal boundary gray. The launcher and dock switch opacity, visibility, and transform so collapsed controls leave the tab order. Opening transfers focus to Voice; closing or Escape returns focus to the launcher. Keep Voice mode, Volume, Captions, Focus, Present, and compact Details connected to their existing behavior.

The volume control is a native range input inside a 130 × 48 group, with an 18px input height and accent-colored track/thumb. Preserve its 0–1 range and 0.05 step.

### Transcript Navigation

Two equal tabs on a gray track with a white, bordered selection indicator. Labels use 12px / 600. The selection indicator moves horizontally over 180ms. Preserve the tab and panel relationships, selected state, and hidden inactive panel. The drawer's close button is available at compact widths.

### Agent Tiles

Status at the top-left, per-agent voice at the top-right, then runtime mark, name, runtime/model, and current task. Main content is left-aligned within the tile. Default padding is 44px 24px 18px; short windows use 42px at the top and 28px at the bottom. Task copy follows the identity closely and remains selectable.

Use the shipped Claude, Codex, and Gemini SVGs unchanged for recognized runtime hosts. Marks are 28px inside a 40px backing, or 20px inside a 28px transcript avatar. Unknown runtimes use the session's initials; do not assign a known runtime logo arbitrarily.

Keep the actual text states: Ready, Working, Offline, In negotiation, Blocked, Waiting to speak, Preparing voice, and Speaking. Offline surfaces soften; conflict surfaces strengthen their gray boundary; speech adds the ink outline and waveform. Lease counts sit at the lower-right only when leases exist.

### Dialogue and Activity

Dialogue combines runtime avatar, speaker, time, and a soft-white bubble. Text wraps anywhere and remains selectable; the bubble uses the transcript type role and 11px 12px padding. A speaking bubble uses active gray. Activity is a compact divided list with a dot, monospace event kind, detail, and sequence number. State dots remain grayscale.

### Conflict Review

The stage banner and negotiation card use the stronger conflict boundary and lightly tinted surface. Conflict classification is meaningful state text: the predicted tier reads `Predicted conflict`. The severity tag uses regular 11px text and does not convey meaning through color alone. Review opens details and scrolls the negotiation into view.

The contract inset contains a selectable symbol, previous value with a strike-through, proposed value, and optional constraint. Keep negotiation state explicit in text. At compact widths, let the outer drawer scroll far enough to expose the entire contract and negotiation status.

### Captions, Empty States, and Feedback

Captions are centered within the stage on a white notice surface, with a bold speaker name and 13px text. Conflict presence raises the caption above the banner. Empty states explain connection or conversation state in plain text with the existing waveform mark. Toasts use white surfaces, notice corners, and thin boundaries; errors strengthen the boundary with the grayscale error token.

Motion reports state changes: short panel entrances and control transitions, tile entry/exit/reflow, working task pulse, and speech waveform. Exact easing and duration values are in the sidecar. Respect `prefers-reduced-motion`: disable the existing CSS animations/transitions and skip tile Web Animations. The current Review action separately uses smooth `scrollIntoView`; its remaining reduced-motion behavior is recorded as a limitation, not a motion rule to inherit.

## Do's and Don'ts

### Do:

- **Do** use the grayscale source tokens and the Written State Rule.
- **Do** keep the approved system sans and system monospace roles.
- **Do** use the shipped runtime SVGs unchanged, with initials for unknown runtimes.
- **Do** render `Working in <project>` from the attached repository basename.
- **Do** center the meeting dock and preserve focus transfer when it opens or closes.
- **Do** verify internal stage scrolling and full compact contract reachability at 720 × 500.
- **Do** retain selectable task, transcript, and contract text, visible keyboard focus, and reduced-motion handling.

### Don't:

- **Don't** introduce chromatic accents, gradients, decorative display fonts, or colored runtime marks.
- **Don't** replace state labels with dots, glow, or animation alone.
- **Don't** hardcode `TestProject` or demonstration agents into production project identity.
- **Don't** add decorative kickers or turn the semantic conflict classification into a promotional eyebrow.
- **Don't** add diffuse shadows to ordinary tiles, controls, or notices.
- **Don't** clip the compact transcript or enforce a height cap on its negotiation card.
- **Don't** change preload security, renderer IDs, structured events, or IPC contracts to implement visual styling.
