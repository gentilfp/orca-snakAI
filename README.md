# Orca snakAI 🐍🌊

A tiny Snake game that lives inside Orca, as a side panel plugin.

You steer a little green snake through the ocean and eat coding agents instead of apples.
Watch out for the bugs.

![Orca snakAI gameplay](docs/demo.gif)

## How to play

Click the board once so it gets the keyboard, then:

| Key | What it does |
| --- | --- |
| Arrow keys or W A S D | Steer |
| Space | Start, resume, or play again |
| P or Esc | Pause |

## What's in the water

| Pickup | Points | What it does |
| --- | --- | --- |
| Pi | 10 | Grows you by 1 |
| Claude Code | 25 | Grows you by 2 and gives you a short speed boost |
| Codex | 50 | Grows you by 3 and gives you a shield that forgives one crash |
| Orca (very rare) | 100 | Bonus points, and it chases the bugs away |
| **Bug** | −20 | Cuts your snake in half. A shield squashes it instead. |

Hit a wall or your own tail and it's game over. Your best score is saved in the panel.

## Install

You need Orca 1.4.245 or newer.

In Orca:

1. Open **Settings → Plugins**, choose **Add plugin**, then **From a Git URL…**
2. Paste this and choose **Install**:

   ```
   https://github.com/gentilfp/orca-snakai#v0.1.1
   ```

3. Review the access it asks for (it asks for none beyond its own panel), then enable it.
4. Open **Orca snakAI** from the right sidebar.

Click the board once so it gets the keyboard, and you're playing.

### From source

```sh
git clone https://github.com/gentilfp/orca-snakAI.git
cd orca-snakAI
orca plugin dev load .
orca plugin open gentilfp.snakai --panel snakai
```

Orca may print a fingerprint the first time. Re-run the `load` command with `--approve <fingerprint>`.

No Orca? Open `dev.html` in any browser and play there.

## Hacking on it

The whole game is plain JavaScript in `src/game.js`, with no dependencies. The sprites are
character grids in that file, so you can redraw them by hand.

```sh
node scripts/build.mjs        # rebuild panel/index.html
node --test tests/*.test.mjs  # run the tests
```

The pixel art is hand drawn and is not the official logo of any product. This is a fan project, not
affiliated with Orca, Anthropic or OpenAI.

MIT licensed. See [LICENSE](LICENSE).
