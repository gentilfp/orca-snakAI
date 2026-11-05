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
// Sandbox objects carry the VM realm's prototypes, so compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

function makeCanvas() {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: true,
    fillStyle: '#000000',
    fillRect(x, y, width, height) {
      calls.push({ x, y, width, height, color: this.fillStyle });
    },
    save() {
      calls.push({ type: 'save' });
    },
    restore() {
      calls.push({ type: 'restore' });
    }
  };
  const canvas = {
    width: 720,
    height: 480,
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
    pickup: { x: 3, y: 4, kind: 'orca', expiresAt: 10000 },
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
  const renderer = platform.createOrcaSnakeRenderer(canvas);
  renderer.setTheme(theme);
  return { renderer, canvas, calls };
}

function artCallsIn(calls, cell) {
  const left = cell.x * CELL;
  const top = cell.y * CELL;
  return calls.filter(call => call.width === ART && call.height === ART
    && call.x >= left && call.x < left + CELL
    && call.y >= top && call.y < top + CELL
    && (call.x - left) % ART === 0 && (call.y - top) % ART === 0);
}

test('the board is a 24x16 checker of 30px cells', () => {
  const { renderer, calls } = makeRenderer();
  renderer.render(snap(), 0);
  const board = calls.filter(call => call.width === CELL && call.height === CELL);
  assert.equal(board.length, COLS * ROWS);
  const at = (x, y) => board.find(call => call.x === x * CELL && call.y === y * CELL);
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
  assert.ok(artCallsIn(calls, state.pickup).length > 0, 'the pickup draws art');
});

test('the head art is rotated for each direction', () => {
  const headArt = direction => {
    const { renderer, calls } = makeRenderer();
    const state = snap({ direction });
    renderer.render(state, 0);
    return artCallsIn(calls, state.snake[0])
      .map(call => `${call.x - state.snake[0].x * CELL},${call.y - state.snake[0].y * CELL},${call.color}`)
      .join('|');
  };
  const right = headArt('right');
  assert.notEqual(right, headArt('up'));
  assert.notEqual(right, headArt('down'));
  assert.notEqual(right, headArt('left'));
  assert.notEqual(headArt('up'), headArt('down'));
});

test('a null pickup draws no pickup art', () => {
  const pickupColors = new Set(['#10263a', '#f4fbff', '#d97757', '#f6c992', '#19a89b', '#ccfff9']);
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
  assert.equal(typeof view.drawSprite, 'function');
  assert.equal(typeof view.drawText, 'function');
  assert.equal(typeof view.fillCell, 'function');
  assert.deepEqual(Object.keys(view.palette).sort(),
    ['boardA', 'boardB', 'bodyA', 'bodyB', 'head', 'ink', 'scrim', 'shadow']);
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
  const core = platform.createOrcaSnakeCore({
    now: () => clock.now(),
    random: () => 0,
    loadBest: () => 0,
    saveBest: () => {}
  });
  const { canvas, calls } = makeCanvas();
  const stateChanges = [];
  const scoreChanges = [];
  const game = platform.createOrcaSnake({
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
  const values = new Map([['orca-snake-best', '42']]);
  const storage = {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value))
  };
  const { canvas } = makeCanvas();
  const game = platform.createOrcaSnake({ canvas, now: () => 0, random: () => 0, storage });
  const state = game.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.best, 42);
  assert.doesNotThrow(() => game.destroy());
});
