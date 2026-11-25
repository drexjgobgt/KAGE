# KAGE Design System

> Reading this as: Desktop capture and instant replay studio for Windows gamers and creators, in a warm-obsidian editorial-tactical style, dial ENERGY 2 / RHYTHM 2 / MOTION 1.

`antislop` mode: `DURING`

## Brand Identity

- **Name**: KAGE (`KAGE Studio`)
- **Concept**: Silent shadow-buffer capture paired with a sharp diagonal shutter trigger (`Alt + C` instant replay flush, `Alt + R` direct MP4 stream recording, `Alt + Shift + C` arm/disarm buffer).
- **Logo Monogram**: Sharp diagonal blade/shutter **"K"** combining a vertical warm-ivory spine (`#F3ECE4`), a 45-degree diagonal champagne blade (`#E6C29F`), and a crimson shutter accent point (`#E5484D`) on a matte obsidian squircle (`#0A0908` with `#282320` hairline edge).

## Verified WCAG AA Color Palette

All foreground/background pairs were verified with `contrast-check.py`:

| Token | Hex | Role | Verified Contrast |
| --- | --- | --- | --- |
| `--kage-bg` | `#0A0908` | Obsidian Ink app canvas | Base |
| `--kage-surface` | `#12100E` | Smoked Charcoal card core | Base |
| `--kage-elevated` | `#1A1715` | Machined Slate outer bezel / hover | Base |
| `--kage-divider` | `#282320` | Subtle structural seam | Structural |
| `--kage-border-control` | `#6E655E` | Interactive control edge | 3.33:1 on `#12100E` (WCAG 1.4.11 PASS) |
| `--kage-text` | `#F3ECE4` | Warm Ivory primary text | 16.99:1 on `#0A0908`, 16.21:1 on `#12100E` (AAA) |
| `--kage-text-secondary` | `#B5AA9F` | Secondary readable copy | 8.73:1 on `#0A0908`, 8.33:1 on `#12100E` (AAA) |
| `--kage-text-muted` | `#94897E` | Metadata and labels | 5.55:1 on `#12100E` (AA) |
| `--kage-accent` | `#E6C29F` | Warm Champagne primary action | 11.92:1 on `#0A0908`; `#0A0908` text on `#E6C29F` = 11.92:1 (AAA) |
| `--kage-accent-hover` | `#F0D2B4` | Primary action hover | >12:1 |
| `--kage-rec` | `#C92A32` | Deep Crimson REC trigger fill | `#FFFFFF` text on `#C92A32` = 5.44:1 (AA) |
| `--kage-rec-text` | `#FF6B6F` | Crimson active REC indicator text | 6.86:1 on `#12100E` (AA) |
| `--kage-ok` | `#4ADE80` | Armed emerald status | 10.89:1 on `#12100E` (AAA) |
| `--kage-warn` | `#F5B971` | Caution amber status | 10.90:1 on `#12100E` (AAA) |

## Typography

- **Display Face**: `Instrument Serif` (bundled locally in `src/assets/fonts/InstrumentSerif-400-normal.ttf` and `InstrumentSerif-400-italic.ttf`) for primary screen titles and the hero engine state headline.
- **UI & Telemetry Face**: `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` with `font-variant-numeric: tabular-nums` on FPS, bitrate, duration, RAM, and disk readouts.

## Layout & Anti-Slop Design Decisions (R-31)

- **Why warm dark obsidian (`#0A0908`)**: Gamers and video editors alt-tab out of dark games; warm obsidian eliminates bright white glare while avoiding cold blue-purple AI slop.
- **Why champagne (`#E6C29F`) + tactical crimson (`#C92A32` / `#FF6B6F`)**: Champagne anchors the primary replay save action (MIDNIGHT warmth), while crimson is strictly reserved for `Alt + R` live recording state and trigger (LAST tactical urgency).
- **Why diagonal slash motif**: Echoes the shutter blade of the KAGE monogram and the diagonal cut of the second reference image inside the Hero Capture Deck without obstructing text contrast.
- **Why Double-Bezel surfaces**: Outer `#1A1715` machined tray (`p-1.5 rounded-[16px] ring-1 ring-[#282320]`) wrapping an inner `#12100E` core (`rounded-[12px]`) gives tactile hardware depth without generic drop-shadow soup.
- **Why radius hierarchy (`16px / 12px / 6px / full`)**: `rounded-full` is reserved strictly for the primary `Save Replay` CTA pill; the `[ REC Alt+R ]` tactical trigger uses crisp `6px` corners with corner brackets; cards use `16px/12px`.
- **Why minimal glass & zero endless pulse**: `backdrop-blur-md` is used ONLY on the modal Trimmer scrim (1 surface, R-10). Recording indicators mark real live state without infinite CSS pulse animations (R-19), keeping background iGPU compositor cost at zero.
- **Copywriting**: Zero em dashes (`—`) anywhere in UI or Rust user-facing error strings (R-02). Real telemetry only (R-17). Honest empty, loading, and error states on every view (R-27).
