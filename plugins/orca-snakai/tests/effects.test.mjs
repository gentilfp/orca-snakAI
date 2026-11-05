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
const TOP = 60;
const FONT_ROWS = 5;

function makeContext() {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: true,
    fillStyle: '#000000',
    globalAlpha: 1,
    fillRect(x, y, width, height) {
      calls.push({ type: 'rect', x, y, width, height, color: this.fillStyle, alpha: this.globalAlpha });
    },
    save() {
      calls.push({ type: 'save' });
    },
    restore() {
      calls.push({ type: 'restore' });
    },
    translate(x, y) {
      calls.push({ type: 'translate', x, y });
    }
  };
  return { ctx, calls };
}

function makeCanvas() {
  const { ctx, calls } = makeContext();
  const canvas = {
    width: COLS * CELL,
    height: TOP + ROWS * CELL,
    focus() {},
    getContext() {
      return ctx;
    }
  };
  return { canvas, calls };
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
    score: 0,
    best: 0,
    growthPending: 0,
    boostUntil: 0,
    shieldUntil: 0,
    result: null,
    ...overrides
  };
}

function makeView(ctx, calls, now, snapshot, previous) {
  return {
    ctx,
    snapshot,
    previous,
    now,
    theme: 'light',
    palette: {
      water: Array.from({ length: ROWS }, () => ['#c5e9f8', '#b8e1f4']),
      sky: '#e6f6fe',
      skyLine: '#8fd0ee',
      ink: '#10273b',
      shadow: '#ffffff',
      scrim: 'rgba(234, 246, 252, 0.82)',
      bodyA: '#3fae5a',
      bodyB: '#2f8f49',
      head: '#5fd07a'
    },
    COLS,
    ROWS,
    CELL,
    ART,
    TOP,
    drawSprite() {},
    fillCell() {},
    drawText(view, text, x, y, color, scale) {
      calls.push({ type: 'text', text, x, y, color, scale });
    }
  };
}

function setup() {
  const { ctx, calls } = makeContext();
  const hooks = Object.create(null);
  const renderer = {
    addHook(slot, fn) {
      if (!hooks[slot]) hooks[slot] = [];
      hooks[slot].push(fn);
    },
    run(slot, view) {
      let busy = false;
      for (const fn of hooks[slot] || []) {
        if (fn(view)) busy = true;
      }
      return busy;
    }
  };
  const effects = platform.installSnakAIEffects(renderer);
  return { ctx, calls, renderer, effects };
}

function renderPair({ renderer, ctx, calls, now, previous, snapshot }) {
  const view = makeView(ctx, calls, now, snapshot, previous);
  const busy = [
    renderer.run('beforeScene', view),
    renderer.run('afterSnake', view),
    renderer.run('afterHud', view)
  ].some(Boolean);
  return { view, busy };
}

const texts = calls => calls.filter(call => call.type === 'text');
const rects = calls => calls.filter(call => call.type === 'rect');
const translates = calls => calls.filter(call => call.type === 'translate');

test('eating each pickup shows its label, a burst and a one-cell flash', () => {
  const cases = [
    ['pi', 10, '+10 PI', '#ff8a7e'],
    ['claude', 25, '+25 CLAUDE', '#f39a4c'],
    ['codex', 50, '+50 CODEX', '#6b7bff'],
    ['orca', 100, '+100 ORCA', '#ffffff']
  ];
  for (const [kind, points, label, color] of cases) {
    const { ctx, calls, renderer } = setup();
    const previous = snap({ score: 0, pickup: { x: 3, y: 4, kind, expiresAt: 10000 } });
    const next = snap({ score: points, pickup: null });
    const { busy } = renderPair({ renderer, ctx, calls, now: 100, previous, snapshot: next });

    assert.equal(busy, true, `${kind} effects keep the renderer busy`);
    const drawn = texts(calls);
    assert.ok(drawn.some(call => call.text === label), `${kind} draws ${label}`);
    assert.ok(drawn.some(call => call.text === label && call.color === color), `${kind} label uses its colour`);

    const flash = rects(calls).filter(call => call.width === CELL && call.height === CELL && call.color === '#ffffff');
    assert.equal(flash.length, 1, `${kind} flashes one cell`);
    assert.deepEqual([flash[0].x, flash[0].y], [6 * CELL, 8 * CELL]);

    const burst = rects(calls).filter(call => call.width === ART && call.height === ART);
    assert.equal(burst.length, 8, `${kind} bursts eight particles`);
    assert.ok(burst.some(call => call.color === color), `${kind} particles use the kind colour`);
  }
});

test('effects stop at their lifetimes and an idle pair draws nothing', () => {
  const { ctx, calls, renderer } = setup();
  const previous = snap();
  const next = snap({ score: 10 });
  renderPair({ renderer, ctx, calls, now: 100, previous, snapshot: next });

  calls.length = 0;
  const alive = renderPair({ renderer, ctx, calls, now: 749, previous: next, snapshot: next });
  assert.equal(alive.busy, true, 'the label is still alive before 800 ms');
  assert.ok(texts(calls).some(call => call.text === '+10 PI'));

  calls.length = 0;
  const blinking = renderPair({ renderer, ctx, calls, now: 899, previous: next, snapshot: next });
  assert.equal(blinking.busy, true, 'the label is alive until its 800 ms deadline');
  assert.equal(texts(calls).length, 0, 'the label blinks off in its last 200 ms');

  calls.length = 0;
  const done = renderPair({ renderer, ctx, calls, now: 900, previous: next, snapshot: next });
  assert.equal(done.busy, false, 'the label expires at 800 ms');
  assert.equal(texts(calls).length, 0, 'nothing is drawn after expiry');
  assert.equal(rects(calls).length, 0, 'burst and flash are gone too');
});

test('unchanged snapshots and the first render never spawn effects', () => {
  const { ctx, calls, renderer } = setup();

  const first = renderPair({ renderer, ctx, calls, now: 0, previous: null, snapshot: snap({ score: 50 }) });
  assert.equal(first.busy, false);
  assert.equal(texts(calls).length + rects(calls).length, 0, 'no previous snapshot means no effects');

  const state = snap({ score: 50 });
  const repeated = renderPair({ renderer, ctx, calls, now: 16, previous: state, snapshot: state });
  assert.equal(repeated.busy, false);
  assert.equal(texts(calls).length + rects(calls).length, 0, 'a re-render spawns nothing');

  const odd = renderPair({ renderer, ctx, calls, now: 32, previous: snap({ score: 50 }), snapshot: snap({ score: 70 }) });
  assert.equal(odd.busy, false, 'a delta that is not a pickup is ignored');
  assert.equal(texts(calls).length + rects(calls).length, 0);
});

test('labels and particles are capped', () => {
  const { ctx, calls, renderer } = setup();
  let previous = snap({ score: 0 });
  for (let step = 1; step <= 6; step += 1) {
    const next = snap({ score: step * 10 });
    renderPair({ renderer, ctx, calls, now: step, previous, snapshot: next });
    previous = next;
  }
  calls.length = 0;
  renderPair({ renderer, ctx, calls, now: 7, previous, snapshot: previous });
  assert.equal(texts(calls).length, 4 * 2, 'four labels at most, each with a shadow');
  assert.equal(rects(calls).filter(call => call.width === ART && call.height === ART).length, 32, '32 particles at most');
});

test('a lost game shakes the board for 400 ms and wins stay still', () => {
  const lost = setup();
  const previous = snap({ phase: 'running', score: 0 });
  const over = snap({ phase: 'gameover', result: 'lost', score: 0 });
  const start = renderPair({
    renderer: lost.renderer, ctx: lost.ctx, calls: lost.calls, now: 100, previous, snapshot: over
  });
  assert.equal(start.busy, true, 'the shake keeps the renderer animating');
  const first = translates(lost.calls);
  assert.equal(first.length, 1);
  assert.ok(first[0].x !== 0 || first[0].y !== 0, 'the board is translated');

  lost.calls.length = 0;
  const middle = renderPair({
    renderer: lost.renderer, ctx: lost.ctx, calls: lost.calls, now: 200, previous: over, snapshot: over
  });
  assert.equal(middle.busy, true);
  const shifted = translates(lost.calls);
  assert.equal(shifted.length, 1);
  assert.ok(shifted[0].x !== 0 || shifted[0].y !== 0, 'the board still moves within 400 ms');

  lost.calls.length = 0;
  const settled = renderPair({
    renderer: lost.renderer, ctx: lost.ctx, calls: lost.calls, now: 500, previous: over, snapshot: over
  });
  assert.equal(settled.busy, false, 'the shake ends at 400 ms');
  assert.equal(translates(lost.calls).length, 0);

  const won = setup();
  renderPair({
    renderer: won.renderer,
    ctx: won.ctx,
    calls: won.calls,
    now: 100,
    previous: snap({ phase: 'running', score: 40 }),
    snapshot: snap({ phase: 'gameover', result: 'won', score: 50 })
  });
  assert.equal(translates(won.calls).length, 0, 'a win does not shake');
});

test('reduced motion and restart remove the shake', () => {
  const reduced = setup();
  platform.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' });
  try {
    const pair = renderPair({
      renderer: reduced.renderer,
      ctx: reduced.ctx,
      calls: reduced.calls,
      now: 100,
      previous: snap({ phase: 'running', score: 0 }),
      snapshot: snap({ phase: 'gameover', result: 'lost', score: 0 })
    });
    assert.equal(pair.busy, false, 'no shake animation under reduced motion');
    assert.equal(translates(reduced.calls).length, 0);
  } finally {
    delete platform.matchMedia;
  }

  const restarted = setup();
  const previous = snap({ phase: 'running', score: 0 });
  const over = snap({ phase: 'gameover', result: 'lost', score: 0 });
  renderPair({
    renderer: restarted.renderer, ctx: restarted.ctx, calls: restarted.calls, now: 100, previous, snapshot: over
  });
  restarted.calls.length = 0;
  const running = renderPair({
    renderer: restarted.renderer,
    ctx: restarted.ctx,
    calls: restarted.calls,
    now: 150,
    previous: over,
    snapshot: snap({ phase: 'running', score: 0 })
  });
  assert.equal(running.busy, false, 'restart clears the shake');
  assert.equal(translates(restarted.calls).length, 0);
});

test('boost and shield badges show only while running and ahead of the clock', () => {
  const full = setup();
  renderPair({
    renderer: full.renderer, ctx: full.ctx, calls: full.calls, now: 0, previous: null,
    snapshot: snap({ boostUntil: 3000 })
  });
  const boostTexts = texts(full.calls);
  assert.equal(boostTexts.filter(call => call.text === 'BOOST').length, 2, 'BOOST has a shadow and a fill');
  const boostBars = rects(full.calls).filter(call => call.color === '#f39a4c');
  assert.deepEqual(boostBars.map(call => call.width), [105], 'a full boost bar is as wide as its label');

  const half = setup();
  renderPair({
    renderer: half.renderer, ctx: half.ctx, calls: half.calls, now: 0, previous: null,
    snapshot: snap({ boostUntil: 1500 })
  });
  assert.deepEqual(rects(half.calls).filter(call => call.color === '#f39a4c').map(call => call.width), [53]);

  const shield = setup();
  renderPair({
    renderer: shield.renderer, ctx: shield.ctx, calls: shield.calls, now: 0, previous: null,
    snapshot: snap({ shieldUntil: 2500 })
  });
  assert.deepEqual(rects(shield.calls)
    .filter(call => call.color === '#6b7bff' && call.height === ART && call.width > CELL)
    .map(call => call.width), [58]);

  const both = setup();
  renderPair({
    renderer: both.renderer, ctx: both.ctx, calls: both.calls, now: 0, previous: null,
    snapshot: snap({ boostUntil: 3000, shieldUntil: 5000 })
  });
  const labels = texts(both.calls);
  const boostX = labels.find(call => call.text === 'BOOST').x;
  const shieldX = labels.find(call => call.text === 'SHIELD').x;
  assert.ok(boostX < shieldX, 'boost sits left of shield');

  for (const phase of ['paused', 'ready', 'gameover']) {
    const idle = setup();
    renderPair({
      renderer: idle.renderer, ctx: idle.ctx, calls: idle.calls, now: 0, previous: null,
      snapshot: snap({ phase, boostUntil: 3000, shieldUntil: 5000 })
    });
    assert.equal(texts(idle.calls).length, 0, `no badges while ${phase}`);
    assert.equal(rects(idle.calls).length, 0, `no bars or outline while ${phase}`);
  }

  const expired = setup();
  renderPair({
    renderer: expired.renderer, ctx: expired.ctx, calls: expired.calls, now: 1000, previous: null,
    snapshot: snap({ boostUntil: 1000, shieldUntil: 1000 })
  });
  assert.equal(texts(expired.calls).length, 0, 'deadlines at now are not active');
});

test('the shield outlines the head only while shielded and running', () => {
  const outline = setup();
  renderPair({
    renderer: outline.renderer, ctx: outline.ctx, calls: outline.calls, now: 0, previous: null,
    snapshot: snap({ shieldUntil: 5000 })
  });
  const edges = rects(outline.calls).filter(call => call.color === '#6b7bff'
    && ((call.width === CELL && call.height === ART) || (call.width === ART && call.height === CELL)));
  assert.equal(edges.length, 4, 'four thin edges outline the head');
  const head = snap().snake[0];
  assert.ok(edges.every(call => call.x >= head.x * CELL && call.x < (head.x + 1) * CELL));
  assert.ok(edges.every(call => call.y >= head.y * CELL && call.y < (head.y + 1) * CELL));

  const plainBoard = setup();
  renderPair({
    renderer: plainBoard.renderer, ctx: plainBoard.ctx, calls: plainBoard.calls, now: 0, previous: null,
    snapshot: snap({ shieldUntil: 0 })
  });
  assert.equal(rects(plainBoard.calls).filter(call => call.color === '#6b7bff').length, 0, 'no outline without a shield');

  const blinking = setup();
  renderPair({
    renderer: blinking.renderer, ctx: blinking.ctx, calls: blinking.calls, now: 150, previous: null,
    snapshot: snap({ shieldUntil: 1000 })
  });
  assert.equal(rects(blinking.calls).filter(call => call.color === '#6b7bff'
    && ((call.width === CELL && call.height === ART) || (call.width === ART && call.height === CELL))).length,
  0, 'the outline blinks in the last second');
});

test('the real renderer stays busy until the effects finish', () => {
  const { canvas, calls } = makeCanvas();
  const renderer = platform.createSnakAIRenderer(canvas);
  const effects = platform.installSnakAIEffects(renderer);

  assert.equal(renderer.isBusy(), false);
  renderer.render(snap({ score: 0 }), 0);
  assert.equal(renderer.isBusy(), false, 'an idle pair is not busy');

  const eaten = snap({ score: 10 });
  renderer.render(eaten, 16);
  assert.equal(renderer.isBusy(), true, 'a score rise animates');
  assert.ok(calls.some(call => call.type === 'rect' && call.color === '#ff8a7e'), 'the label is painted');

  renderer.render(eaten, 800);
  assert.equal(renderer.isBusy(), true, 'still animating before 800 ms');
  renderer.render(eaten, 816);
  assert.equal(renderer.isBusy(), false, 'idle again at 800 ms');

  renderer.render(snap({ score: 0 }), 900);
  renderer.render(eaten, 916);
  assert.equal(renderer.isBusy(), true);
  effects.destroy();
  renderer.render(snap({ score: 0 }), 1000);
  renderer.render(eaten, 1016);
  assert.equal(renderer.isBusy(), false, 'destroy stops the hooks');
  assert.doesNotThrow(() => effects.destroy());
  assert.doesNotThrow(() => renderer.destroy());
});

test('the installer rejects a missing renderer', () => {
  assert.throws(() => platform.installSnakAIEffects(null), /renderer/);
});

test('a bug hit shows a red label, shakes the board and is not mistaken for a restart', () => {
  const { ctx, calls, renderer } = setup();
  // The score fell by 20 and the hit counter rose, so this is a bug, not a new run.
  const previous = snap({ score: 120 });
  const next = snap({ score: 100, bugHits: 1 });
  const { busy } = renderPair({ renderer, ctx, calls, now: 100, previous, snapshot: next });
  assert.equal(busy, true);
  assert.ok(texts(calls).some(call => call.text === '-20 BUG' && call.color === '#ff5d6c'));
  assert.equal(translates(calls).length, 1, 'the board shakes');
  assert.equal(rects(calls).filter(call => call.width === ART && call.height === ART).length, 8, 'eight particles');

  // A bug at score 0 changes no points but is still seen through the counter.
  const zero = setup();
  renderPair({
    renderer: zero.renderer, ctx: zero.ctx, calls: zero.calls, now: 0,
    previous: snap({ score: 0 }), snapshot: snap({ score: 0, bugHits: 1 })
  });
  assert.ok(texts(zero.calls).some(call => call.text === '-20 BUG'));

  // The same snapshot again adds nothing.
  calls.length = 0;
  renderPair({ renderer, ctx, calls, now: 120, previous: next, snapshot: next });
  assert.equal(texts(calls).filter(call => call.text === '-20 BUG').length, 2, 'one label, drawn with its shadow');
});

test('a squashed bug shows its own label without a shake, and reduced motion drops the bug shake', () => {
  const { ctx, calls, renderer } = setup();
  renderPair({
    renderer, ctx, calls, now: 100, previous: snap({ score: 50 }), snapshot: snap({ score: 50, bugBlocks: 1 })
  });
  assert.ok(texts(calls).some(call => call.text === 'SQUASHED' && call.color === '#6b7bff'));
  assert.equal(translates(calls).length, 0, 'a squashed bug does not shake');

  platform.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' });
  try {
    const calm = setup();
    renderPair({
      renderer: calm.renderer, ctx: calm.ctx, calls: calm.calls, now: 100,
      previous: snap({ score: 50 }), snapshot: snap({ score: 30, bugHits: 1 })
    });
    assert.equal(translates(calm.calls).length, 0);
    assert.ok(texts(calm.calls).some(call => call.text === '-20 BUG'), 'the label still shows');
  } finally {
    delete platform.matchMedia;
  }
});

test('labels never rise into the score strip', () => {
  const { ctx, calls, renderer } = setup();
  // The head sits in the top board row, where the label would otherwise climb into the strip.
  const top = [{ x: 3, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }];
  renderPair({
    renderer, ctx, calls, now: 0, previous: snap({ snake: top }), snapshot: snap({ snake: top, score: 10 })
  });
  calls.length = 0;
  renderPair({ renderer, ctx, calls, now: 400, previous: snap({ snake: top, score: 10 }), snapshot: snap({ snake: top, score: 10 }) });
  const labels = texts(calls).filter(call => call.text === '+10 PI');
  assert.ok(labels.length > 0);
  assert.ok(labels.every(call => call.y >= TOP), 'the label stays below the strip');
});
