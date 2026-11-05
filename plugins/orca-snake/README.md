# Orca Snake

A pixel art Snake for the Orca panel. Steer a little green snake around a 24×16 board and chase
AI-themed pixel icons instead of ordinary food. Opens from the **Orca Snake** (bot) icon in Orca's
right sidebar. Plugin key: `gentilfp.orca-snake`; panel id: `snake`.

## Try it in Orca

Requires Orca **1.4.245 or later**. The panel runs offline in a `sandboxed-ui` frame with **no
requested capabilities**: no worker, dependencies, network requests, or workspace access.

The commands below run from the repository root and use the `orca` CLI bundled with the app
(`/Applications/Orca.app/Contents/Resources/bin/orca`).

```sh
# Build the installable, self-contained panel entry (panel/index.html).
node plugins/orca-snake/scripts/build.mjs

# Check the manifest the way Orca loads it.
orca plugin validate plugins/orca-snake

# Load this folder as a development plugin. If it asks for approval, it prints a fingerprint:
orca plugin dev load plugins/orca-snake
orca plugin dev load plugins/orca-snake --approve sha256-…

# Show the panel in Orca's right sidebar.
orca plugin open gentilfp.orca-snake --panel snake
```

`orca plugin open` does not raise the window or move focus, so click the board once before using the
keyboard. Clicking the board also acts like Space (start, resume or restart). The same folder can be
added by hand under **Settings → Plugins → Development folders**.

## Play without Orca

Open `plugins/orca-snake/dev.html` in a browser. It loads `src/panel.css`, `src/game.js` and
`src/panel.js` directly, so it needs no build step and no Orca. The built `panel/index.html` is the
self-contained entry Orca loads, and it also plays when opened directly.

## Controls

| Input | Action |
| --- | --- |
| Space | Start; resume from pause; play again after game over |
| Arrow keys / WASD | Turn the snake (up to two turns can be queued); from the ready screen, starts the game and turns |
| P / Escape | Pause or resume while playing |
| Click the board | Focus the keyboard, and act like Space |

A direct reversal is ignored. Keys are ignored while Cmd/Ctrl/Alt is held and inside form fields,
auto-repeat is ignored, and the game keys never scroll the page. The game pauses when the window
loses focus or the page is hidden; resume with Space, P or a click. The panel follows Orca's
light/dark theme and the canvas scales to the sidebar width.

## Pickups

One pickup is on the board at a time, never on the snake, chosen with weights 70/25/5. It disappears
after 10 seconds of play and a new one spawns.

| Pickup | Points | Growth | Effect |
| --- | --- | --- | --- |
| Orca | 10 | +1 segment | — |
| Claude Code | 25 | +2 segments | 3-second speed boost (ticks run at 0.7×) |
| Codex | 50 | +3 segments | 5-second shield: one wall or body hit is forgiven by removing the tail segment and play continues |

The tick starts at 150 ms and drops by 5 ms per 50 points, never below 60 ms. A wall or self
collision ends the game, and filling the board wins it. Growth from a pickup is applied over the
next moves, so the tail stays behind until the snake has grown.

## Score and best

The current score and the best score are drawn in the HUD, and the line under the board repeats
them. Best is stored under `orca-snake-best` in the panel's own `localStorage`, with an in-memory
fallback if storage is unavailable.

Observed in Orca 1.4.248 on macOS: the panel frame allowed `localStorage`, so the best score
survived panel reloads and re-opening the panel (a run that ended at 530 showed `BEST 0530` after a
reload). This was checked by reading the stored key from inside the panel and by watching the HUD
across reloads; it was not tested across an Orca app restart, and clearing the panel's stored data
would start the best again from 0.

## Development

Source lives in `src/`. After editing it, rebuild the generated entry and run the tests:

```sh
node plugins/orca-snake/scripts/build.mjs
node --test plugins/orca-snake/tests/*.test.mjs
orca plugin validate plugins/orca-snake
```

The tests use Node's built-in `node:test` runner and need no install step. What is where:

- `src/game.js` — plain browser script: `window.createOrcaSnakeCore` (DOM-free rules),
  `window.createOrcaSnakeBestStore` (storage adapter), `window.createOrcaSnakeRenderer` (canvas
  drawing with hook slots) and `window.createOrcaSnake` (controller and frame loop).
- `src/panel.js` — panel wiring: key handling, click to focus, pause on blur/visibility change,
  theme changes, and teardown on page hide.
- `src/panel.html`, `src/panel.css` — markup and styles with the build markers.
- `scripts/build.mjs` — inlines the CSS, then `game.js`, then `panel.js` into `panel/index.html`.
- `dev.html` — unbundled preview that loads the three source files directly.
- `tests/*.test.mjs` — scaffold, game, renderer and panel tests.

Orca's sandbox allows only inline scripts and styles, so the generated `panel/index.html` is
committed with the source and no build runs at installation. There is no package manifest,
framework or runtime dependency, and the manifest requests no capabilities.

## Known limitations

- The `document.hidden` branch of the pause handler is covered by tests with a fake document and by
  the blur pause in use; minimizing Orca or switching focus pauses the game, but a hidden-page
  transition itself was not reproduced inside the panel.
- Best score belongs to this Orca profile's panel storage. Another profile, or clearing the frame's
  data, starts from 0 (not tested across an app restart).
- Pickup effects are the speed boost and the shield only. Floating labels, particles, screen shake
  and boost/shield indicators are not implemented.
- No sound, touch controls, catalog or marketplace entry. Tested on macOS with Orca 1.4.248.

Licensed under the MIT License; see [LICENSE](LICENSE).
