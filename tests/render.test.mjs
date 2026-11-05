import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');
const platform = {};
vm.runInNewContext(source, { window: platform });

const COLS = 24;
const ROWS = 16;
const CELL = 30;
const ART = 5;
const HUD_H = 60;
// Board sprites are 10x10 grids of 3px pixels.
const SPRITE_PX = 3;
// Sandbox objects carry the VM realm's prototypes, so compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

function makeCanvas() {
  const calls = [];
  // The fake applies translate, so recorded rectangles are in canvas pixels.
  const stack = [];
  let offsetX = 0;
  let offsetY = 0;
  const ctx = {
    imageSmoothingEnabled: true,
    fillStyle: '#000000',
    fillRect(x, y, width, height) {
      calls.push({ x: x + offsetX, y: y + offsetY, width, height, color: this.fillStyle });
    },
    save() {
      stack.push([offsetX, offsetY]);
      calls.push({ type: 'save' });
    },
    restore() {
      [offsetX, offsetY] = stack.pop();
      calls.push({ type: 'restore' });
    },
    translate(x, y) {
      offsetX += x;
      offsetY += y;
    }
  };
  const canvas = {
    width: 720,
    height: 540,
    focus() {},
    getContext() {
      return ctx;
    }
  };
  return { canvas, ctx, calls };
}

function snap(overrides = {}) {
  return {
    phase: 'running',
    snake: [{ x: 6, y: 8 }, { x: 5, y: 8 }, { x: 4, y: 8 }],
    direction: 'right',
    queuedDirections: [],
    pickup: { x: 3, y: 4, kind: 'pi', expiresAt: 10000 },
    bug: null,
    bugHits: 0,
    bugBlocks: 0,
    cause: null,
    score: 0,
    best: 0,
    growthPending: 0,
    boostUntil: 0,
    shieldUntil: 0,
    result: null,
    ...overrides
  };
}

function makeRenderer(theme = 'light') {
  const { canvas, calls } = makeCanvas();
  const renderer = platform.createSnakAIRenderer(canvas);
  renderer.setTheme(theme);
  return { renderer, canvas, calls };
}

// The pickups are 30x30 art with 1px pixels (merged into runs), so they are the 1px-high rectangles.
function pickupCallsIn(calls, cell) {
  const left = cell.x * CELL;
  const top = HUD_H + cell.y * CELL;
  return calls.filter(call => call.height === 1 && call.width <= CELL
    && call.x >= left && call.x < left + CELL && call.y >= top && call.y < top + CELL);
}

function artCallsIn(calls, cell) {
  const left = cell.x * CELL;
  const top = HUD_H + cell.y * CELL;
  return calls.filter(call => call.width === SPRITE_PX && call.height === SPRITE_PX
    && call.x >= left && call.x < left + CELL
    && call.y >= top && call.y < top + CELL
    && (call.x - left) % SPRITE_PX === 0 && (call.y - top) % SPRITE_PX === 0);
}

test('the board is a 24x16 checker of 30px cells', () => {
  const { renderer, calls } = makeRenderer();
  renderer.render(snap(), 0);
  const board = calls.filter(call => call.width === CELL && call.height === CELL);
  assert.equal(board.length, COLS * ROWS);
  const at = (x, y) => board.find(call => call.x === x * CELL && call.y === HUD_H + y * CELL);
  assert.ok(at(0, 0), 'first cell is drawn');
  assert.ok(at(COLS - 1, ROWS - 1), 'last cell is drawn');
  assert.notEqual(at(0, 0).color, at(1, 0).color);
  assert.equal(at(0, 0).color, at(2, 0).color);
});

test('snake segments and the pickup land on their snapshot cells', () => {
  const { renderer, calls } = makeRenderer();
  const state = snap();
  renderer.render(state, 0);
  for (const segment of state.snake) {
    assert.ok(artCallsIn(calls, segment).length > 0, `segment at ${segment.x},${segment.y} draws art`);
  }
  assert.ok(pickupCallsIn(calls, state.pickup).length > 0, 'the pickup draws art');
});

test('the head art is rotated for each direction', () => {
  const headArt = direction => {
    const { renderer, calls } = makeRenderer();
    const state = snap({ direction });
    renderer.render(state, 0);
    return artCallsIn(calls, state.snake[0])
      .map(call => `${call.x - state.snake[0].x * CELL},${call.y - HUD_H - state.snake[0].y * CELL},${call.color}`)
      .join('|');
  };
  const right = headArt('right');
  assert.notEqual(right, headArt('up'));
  assert.notEqual(right, headArt('down'));
  assert.notEqual(right, headArt('left'));
  assert.notEqual(headArt('up'), headArt('down'));
});

test('a null pickup draws no pickup art', () => {
  const pickupColors = new Set(['#fd897c', '#4798c2', '#fecc48', '#e86d44', '#f9dcd2', '#947ffb', '#1e3afc', '#8fc4e6']);
  const withPickup = makeRenderer();
  withPickup.renderer.render(snap(), 0);
  assert.ok(withPickup.calls.some(call => pickupColors.has(call.color)), 'a pickup paints its colours');
  const empty = makeRenderer();
  empty.renderer.render(snap({ pickup: null }), 0);
  assert.equal(empty.calls.filter(call => pickupColors.has(call.color)).length, 0);
});

test('hooks run in draw order with the view fields OSN-5 needs', () => {
  const { renderer, calls } = makeRenderer();
  const slots = ['beforeScene', 'afterBoard', 'afterPickup', 'afterSnake', 'afterHud', 'afterOverlay'];
  const order = [];
  const views = [];
  for (const slot of slots) {
    renderer.addHook(slot, view => {
      order.push(slot);
      views.push(view);
      return false;
    });
  }
  const first = snap();
  renderer.render(first, 100);
  assert.deepEqual(order, slots);
  const view = views[0];
  assert.equal(view.snapshot, first);
  assert.equal(view.previous, null);
  assert.equal(view.now, 100);
  assert.equal(view.theme, 'light');
  assert.equal(view.COLS, COLS);
  assert.equal(view.ROWS, ROWS);
  assert.equal(view.CELL, CELL);
  assert.equal(view.ART, ART);
  assert.equal(view.TOP, HUD_H);
  assert.equal(typeof view.drawSprite, 'function');
  assert.equal(typeof view.drawText, 'function');
  assert.equal(typeof view.fillCell, 'function');
  assert.deepEqual(Object.keys(view.palette).sort(),
    ['bodyA', 'bodyB', 'bodyDark', 'crest', 'danger', 'head', 'ink', 'panel', 'scrim', 'shadow', 'sky', 'skyLine', 'water']);
  assert.equal(renderer.isBusy(), false);

  const second = snap({ score: 10 });
  renderer.render(second, 132);
  assert.equal(views[slots.length].previous, first, 'previous is the last rendered snapshot');
});

test('a truthy hook keeps the renderer busy until it settles', () => {
  const { renderer } = makeRenderer();
  let frames = 0;
  renderer.addHook('afterSnake', () => {
    frames += 1;
    return frames < 2;
  });
  renderer.render(snap(), 0);
  assert.equal(renderer.isBusy(), true);
  renderer.render(snap(), 16);
  assert.equal(renderer.isBusy(), false);
});

test('the scrim is drawn only for paused and gameover boards', () => {
  const scrimCalls = state => {
    const { renderer, calls } = makeRenderer();
    let scrim = null;
    renderer.addHook('beforeScene', view => {
      scrim = view.palette.scrim;
      return false;
    });
    renderer.render(state, 0);
    return calls.filter(call => call.color === scrim);
  };
  assert.equal(scrimCalls(snap({ phase: 'running' })).length, 0);
  assert.equal(scrimCalls(snap({ phase: 'ready' })).length, 0);
  const paused = scrimCalls(snap({ phase: 'paused' }));
  assert.ok(paused.some(call => call.width === 720 && call.height === 480), 'paused paints a full scrim');
  const over = scrimCalls(snap({ phase: 'gameover', result: 'lost' }));
  assert.ok(over.some(call => call.width === 720 && call.height === 480), 'gameover paints a full scrim');
});

test('light and dark themes use different board colours', () => {
  const colorsFor = theme => {
    const { renderer, calls } = makeRenderer(theme);
    renderer.render(snap(), 0);
    return [...new Set(calls.filter(call => call.width === CELL).map(call => call.color))].sort();
  };
  assert.notDeepEqual(colorsFor('light'), colorsFor('dark'));
});

function createClock() {
  return {
    time: 0,
    now() {
      return this.time;
    },
    advance(ms) {
      this.time += ms;
    }
  };
}

function createRaf() {
  let nextId = 1;
  const pending = new Map();
  const cancelled = [];
  return {
    pending,
    cancelled,
    request(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    cancel(id) {
      cancelled.push(id);
      pending.delete(id);
    },
    flush(clock, times = 1) {
      for (let index = 0; index < times; index += 1) {
        const next = pending.entries().next();
        if (next.done) return;
        const [id, fn] = next.value;
        pending.delete(id);
        fn(clock.now());
      }
    }
  };
}

function setupGame() {
  const clock = createClock();
  const raf = createRaf();
  platform.requestAnimationFrame = fn => raf.request(fn);
  platform.cancelAnimationFrame = id => raf.cancel(id);
  const core = platform.createSnakAICore({
    now: () => clock.now(),
    random: () => 0,
    loadBest: () => 0,
    saveBest: () => {}
  });
  const { canvas, calls } = makeCanvas();
  const stateChanges = [];
  const scoreChanges = [];
  const game = platform.createSnakAI({
    canvas,
    core,
    now: () => clock.now(),
    onStateChange: (phase, snapshot) => stateChanges.push([phase, snapshot]),
    onScore: (score, best) => scoreChanges.push([score, best])
  });
  return { game, core, clock, raf, calls, stateChanges, scoreChanges };
}

test('the frame loop steps once per tick on the real core', () => {
  const { game, core, clock, raf, stateChanges, scoreChanges } = setupGame();
  assert.deepEqual(stateChanges.map(entry => entry[0]), ['ready']);
  assert.deepEqual(plain(stateChanges[0][1].snake), [{ x: 6, y: 8 }, { x: 5, y: 8 }, { x: 4, y: 8 }]);
  assert.deepEqual(scoreChanges, [[0, 0]]);
  assert.equal(raf.pending.size, 0, 'a ready board does not animate');

  game.start();
  assert.equal(core.getState().phase, 'running');
  assert.deepEqual(stateChanges.map(entry => entry[0]), ['ready', 'running']);
  assert.equal(raf.pending.size, 1);

  raf.flush(clock);
  assert.equal(core.getState().snake[0].x, 6, 'no step before a full tick');
  clock.advance(150);
  raf.flush(clock);
  assert.equal(core.getState().snake[0].x, 7, 'one step after a full tick');

  game.queueDirection('up');
  clock.advance(150);
  raf.flush(clock);
  assert.equal(core.getState().snake[0].y, 7, 'a queued turn moves the head up');
});

test('pause cancels the frame, double pause is safe and destroy is idempotent', () => {
  const { game, core, clock, raf } = setupGame();
  game.start();
  clock.advance(150);
  raf.flush(clock);
  game.pause();
  game.pause();
  assert.equal(core.getState().phase, 'paused');
  assert.equal(raf.pending.size, 0);
  assert.ok(raf.cancelled.length > 0);
  const head = core.getState().snake[0];
  clock.advance(5000);
  raf.flush(clock);
  assert.deepEqual(plain(core.getState().snake[0]), plain(head));
  game.destroy();
  game.destroy();
  assert.equal(raf.pending.size, 0);
  assert.doesNotThrow(() => {
    game.start();
    game.pause();
    game.queueDirection('up');
    game.setTheme('dark');
    game.getState();
    game.destroy();
  });
});

test('the renderer ignores calls after destroy', () => {
  const { renderer, calls } = makeRenderer();
  renderer.destroy();
  renderer.destroy();
  assert.doesNotThrow(() => renderer.render(snap(), 0));
  assert.equal(renderer.isBusy(), false);
  assert.equal(calls.length, 0, 'nothing is painted after destroy');
});

test('without a core the controller builds one and reads the stored best', () => {
  const values = new Map([['orca-snakai-best', '42']]);
  const storage = {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value))
  };
  const { canvas } = makeCanvas();
  const game = platform.createSnakAI({ canvas, now: () => 0, random: () => 0, storage });
  const state = game.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.best, 42);
  assert.doesNotThrow(() => game.destroy());
});

// ---- Score strip, ocean, bug and game over panel ------------------------------------------------

test('the score strip sits above the board and nothing on the board reaches it', () => {
  // A pickup in the top-left cell is the worst case for the old in-board HUD.
  const { renderer, calls } = makeRenderer();
  const state = snap({ pickup: { x: 0, y: 0, kind: 'claude', expiresAt: 10000 }, score: 120, best: 300 });
  renderer.render(state, 0);
  const rects = calls.filter(call => call.width !== undefined);

  const strip = rects.find(call => call.x === 0 && call.y === 0 && call.width === 720 && call.height === HUD_H);
  assert.ok(strip, 'the strip is a full-width block at the top');
  assert.ok(rects.some(call => call.width === ART && call.height === ART && call.y + call.height <= HUD_H),
    'score and best are drawn as text inside the strip');

  const boardArt = rects.filter(call => call.width === SPRITE_PX || call.width === CELL || call.height === 1);
  assert.ok(boardArt.length > 0);
  assert.ok(boardArt.every(call => call.y >= HUD_H), 'board art starts below the strip');
  assert.ok(pickupCallsIn(calls, { x: 0, y: 0 }).length > 0, 'the pickup in the top row is still drawn');
});

test('the board is water: it gets deeper toward the bottom and drifts with the clock', () => {
  const { renderer, calls } = makeRenderer();
  renderer.render(snap({ pickup: null, snake: [] }), 0);
  const cells = calls.filter(call => call.width === CELL && call.height === CELL);
  const top = cells.find(call => call.x === 0 && call.y === HUD_H);
  const bottom = cells.find(call => call.x === 0 && call.y === HUD_H + (ROWS - 1) * CELL);
  assert.notEqual(top.color, bottom.color, 'rows change colour from shallow to deep');

  const crestsAt = at => {
    const run = makeRenderer();
    run.renderer.render(snap({ pickup: null, snake: [] }), at);
    return run.calls.filter(call => call.width === 6 && call.height === 6).map(call => call.x).join(',');
  };
  assert.ok(crestsAt(0).length > 0, 'wave crests are drawn');
  assert.equal(crestsAt(0), crestsAt(599), 'a crest holds still within a drift step');
  assert.notEqual(crestsAt(0), crestsAt(600), 'a crest moves after a drift step');
});

test('the bug is drawn on its cell, alternates two frames and is absent without one', () => {
  const bugColors = new Set(['#ef4b57', '#4a0d14', '#ff8f98']);
  const bugAt = at => {
    const { renderer, calls } = makeRenderer();
    renderer.render(snap({ pickup: null, bug: { x: 15, y: 9, expiresAt: 9999 } }), at);
    return artCallsIn(calls, { x: 15, y: 9 }).filter(call => bugColors.has(call.color))
      .map(call => `${call.x},${call.y},${call.color}`).join('|');
  };
  assert.ok(bugAt(0).length > 0, 'the bug paints its colours');
  assert.equal(bugAt(0), bugAt(279));
  assert.notEqual(bugAt(0), bugAt(280), 'the legs change on the next frame');
  assert.equal(bugAt(0), bugAt(560), 'and change back');

  const none = makeRenderer();
  none.renderer.render(snap({ pickup: null, bug: null }), 0);
  assert.equal(none.calls.filter(call => bugColors.has(call.color)).length, 0);
  const legacy = makeRenderer();
  const withoutBug = snap({ pickup: null });
  delete withoutBug.bug;
  assert.doesNotThrow(() => legacy.renderer.render(withoutBug, 0), 'snapshots without a bug field still render');
});

test('game over draws a framed panel inside the board with a line for each cause', () => {
  const panelFor = (theme, overrides) => {
    const { renderer, calls } = makeRenderer(theme);
    let panel = null;
    renderer.addHook('beforeScene', view => {
      panel = view.palette.panel;
      return false;
    });
    renderer.render(snap({ phase: 'gameover', result: 'lost', cause: 'wall', score: 50, best: 50, ...overrides }), 0);
    return { calls, panel };
  };
  for (const theme of ['light', 'dark']) {
    const { calls, panel } = panelFor(theme, {});
    const fill = calls.find(call => call.color === panel && call.width > 400);
    assert.ok(fill, `${theme} game over has a panel fill`);
    assert.ok(fill.y >= HUD_H && fill.y + fill.height <= HUD_H + ROWS * CELL, 'the panel stays below the strip');
    assert.ok(fill.x > 0 && fill.x + fill.width < COLS * CELL, 'the panel stays inside the board');
  }
  const signature = overrides => panelFor('light', overrides).calls
    .filter(call => call.width === ART && call.height === ART).map(call => `${call.x},${call.y},${call.color}`).join('|');
  assert.notEqual(signature({ cause: 'wall' }), signature({ cause: 'body' }), 'each cause has its own line');
  assert.notEqual(signature({ result: 'lost' }), signature({ result: 'won', cause: 'full' }), 'a win reads differently');
  assert.notEqual(signature({ score: 50, best: 50 }), signature({ score: 50, best: 90 }), 'new best differs from best');
  assert.notEqual(signature({ cause: 'wall' }), signature({ cause: null }), 'an unknown cause just omits the line');
});

test('the start prompt is drawn under the pickup so it never hides it', () => {
  const run = phase => {
    const { renderer, calls } = makeRenderer();
    // A pickup right where the prompt is drawn.
    renderer.render(snap({ phase, pickup: { x: 12, y: 4, kind: 'codex', expiresAt: 10000 } }), 0);
    return calls;
  };
  const ready = run('ready');
  const ink = ready.filter(call => call.color === '#10273b' && call.width === ART && call.y >= HUD_H);
  assert.ok(ink.length > 0, 'a ready board shows the prompt');
  assert.equal(run('running').filter(call => call.color === '#10273b' && call.width === ART && call.y > HUD_H).length, 0,
    'a running board has no prompt');
  const lastPrompt = ready.lastIndexOf(ink[ink.length - 1]);
  const firstSprite = ready.findIndex(call => call.height === 1 && call.color === '#1e3afc');
  assert.ok(firstSprite > lastPrompt, 'the pickup is painted after the prompt');
});

test('the pickup sprites are the author art: four kinds, each with its own colours', () => {
  const colorsOf = kind => {
    const { renderer, calls } = makeRenderer();
    renderer.render(snap({ pickup: { x: 10, y: 6, kind, expiresAt: 10000 } }), 0);
    return [...new Set(pickupCallsIn(calls, { x: 10, y: 6 }).map(call => call.color))].sort().join();
  };
  const seen = ['pi', 'claude', 'codex', 'orca'].map(colorsOf);
  assert.ok(seen.every(colors => colors.length > 0), 'every kind draws');
  assert.equal(new Set(seen).size, 4, 'no two kinds share a palette');
  // 1px sprites are merged into runs: far fewer rectangles than the 900 pixels of a full 30x30 grid.
  const { renderer, calls } = makeRenderer();
  renderer.render(snap({ pickup: { x: 10, y: 6, kind: 'orca', expiresAt: 10000 } }), 0);
  assert.ok(pickupCallsIn(calls, { x: 10, y: 6 }).length < 300);
});
