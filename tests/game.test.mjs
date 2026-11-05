import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');
const platform = {};
vm.runInNewContext(source, { window: platform });

// Sandbox objects carry the VM realm's prototypes, so compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

function createClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    advance: ms => { time += ms; },
    set: ms => { time = ms; }
  };
}

function createRandom(values = [], fallback = 0) {
  const queue = values.slice();
  return () => (queue.length ? queue.shift() : fallback);
}

function setup({ clock = createClock(), initialState, randomValues = [], fallbackRandom = 0, loadBest, saveBest } = {}) {
  const saved = [];
  const core = platform.createSnakAICore({
    random: createRandom(randomValues, fallbackRandom),
    now: () => clock.now(),
    loadBest: loadBest || (() => 0),
    saveBest: saveBest || (value => saved.push(value)),
    testState: initialState
  });
  return { core, clock, saved };
}

const START = [{ x: 6, y: 8 }, { x: 5, y: 8 }, { x: 4, y: 8 }];
const OPEN_PICKUP = { x: 22, y: 0, kind: 'pi', expiresAt: 10000 };

test('a ready board has three mid-left segments and one pickup on a free cell', () => {
  const { core } = setup({ randomValues: [0, 0] });
  const state = core.getState();
  assert.equal(state.phase, 'ready');
  assert.deepEqual(plain(state.snake), START);
  assert.equal(state.direction, 'right');
  assert.deepEqual(plain(state.queuedDirections), []);
  assert.equal(state.score, 0);
  assert.equal(state.best, 0);
  assert.equal(state.growthPending, 0);
  assert.equal(state.boostUntil, 0);
  assert.equal(state.shieldUntil, 0);
  assert.equal(state.result, null);
  assert.deepEqual(plain(state.pickup), { x: 0, y: 0, kind: 'pi', expiresAt: 8000 });
  assert.ok(!state.snake.some(point => point.x === state.pickup.x && point.y === state.pickup.y));

  // getState hands out copies, never the mutable internals.
  state.snake[0].x = 99;
  state.queuedDirections.push('up');
  state.pickup.kind = 'codex';
  const fresh = core.getState();
  assert.equal(fresh.snake[0].x, 6);
  assert.deepEqual(plain(fresh.queuedDirections), []);
  assert.equal(fresh.pickup.kind, 'pi');
});

test('start moves one cell per step; ready and gameover boards do not advance', () => {
  const moving = setup({ randomValues: [0, 0] });
  moving.core.start();
  assert.equal(moving.core.getState().phase, 'running');
  const moved = moving.core.step();
  assert.deepEqual(plain(moved.snake), [{ x: 7, y: 8 }, { x: 6, y: 8 }, { x: 5, y: 8 }]);
  assert.equal(moved.direction, 'right');
  assert.equal(moved.phase, 'running');

  const idle = setup({ clock: createClock(), randomValues: [0, 0] });
  const initial = idle.core.getState();
  idle.core.step();
  assert.deepEqual(plain(idle.core.getState().snake), plain(initial.snake));
  assert.equal(idle.core.getState().phase, 'ready');
  idle.clock.advance(20000);
  idle.core.step();
  assert.deepEqual(plain(idle.core.getState().pickup), plain(initial.pickup));
  assert.equal(idle.core.getState().phase, 'ready');

  // The pickup clock only starts when the run starts, so idle time does not count.
  idle.core.start();
  assert.equal(idle.core.getState().pickup.expiresAt, 28000);
  for (let i = 0; i < 17; i += 1) idle.core.step();
  assert.equal(idle.core.getState().snake[0].x, 23);
  idle.core.step();
  const dead = idle.core.getState();
  assert.equal(dead.phase, 'gameover');
  assert.equal(dead.result, 'lost');
  idle.core.step();
  assert.deepEqual(plain(idle.core.getState().snake), plain(dead.snake));
  assert.equal(idle.core.getState().result, 'lost');
});

test('at most two turns queue per tick and one applies per step', () => {
  const { core } = setup({ randomValues: [0, 0] });
  core.start();
  assert.equal(core.queueDirection('up'), true);
  assert.equal(core.queueDirection('left'), true);
  assert.equal(core.queueDirection('down'), false);
  assert.deepEqual(plain(core.getState().queuedDirections), ['up', 'left']);
  const first = core.step();
  assert.equal(first.direction, 'up');
  assert.deepEqual(plain(first.snake[0]), { x: 6, y: 7 });
  assert.deepEqual(plain(first.queuedDirections), ['left']);
  const second = core.step();
  assert.equal(second.direction, 'left');
  assert.deepEqual(plain(second.snake[0]), { x: 5, y: 7 });
  assert.deepEqual(plain(second.queuedDirections), []);
});

test('invalid and reversing turns are rejected without changing the queue', () => {
  const { core } = setup({ randomValues: [0, 0] });
  assert.equal(core.queueDirection('up'), false, 'a ready game does not accept turns');
  core.start();
  assert.equal(core.queueDirection('left'), false);
  assert.equal(core.queueDirection('north'), false);
  assert.equal(core.queueDirection(''), false);
  assert.deepEqual(plain(core.getState().queuedDirections), []);
  assert.equal(core.queueDirection('up'), true);
  assert.equal(core.queueDirection('down'), false);
  assert.deepEqual(plain(core.getState().queuedDirections), ['up']);
  core.step();
  assert.equal(core.getState().direction, 'up');
  assert.equal(core.queueDirection('down'), false);
  assert.deepEqual(plain(core.getState().queuedDirections), []);
});

test('pause freezes play and resume shifts pickup and effect deadlines', () => {
  const clock = createClock();
  const { core } = setup({
    clock,
    initialState: {
      phase: 'running',
      snake: START,
      direction: 'right',
      pickup: { x: 0, y: 0, kind: 'pi', expiresAt: 10000 },
      boostUntil: 3000,
      shieldUntil: 5000
    }
  });
  assert.equal(core.pause(), true);
  const paused = core.getState();
  clock.advance(1000);
  core.step();
  assert.equal(core.getState().phase, 'paused');
  assert.deepEqual(plain(core.getState().snake), plain(paused.snake));
  clock.advance(9000);
  core.step();
  assert.equal(core.getState().phase, 'paused');
  assert.deepEqual(plain(core.getState().pickup), plain(paused.pickup));
  assert.equal(core.start(), true);
  assert.equal(core.getState().pickup.expiresAt, 20000);
  assert.equal(core.getState().boostUntil, 13000);
  assert.equal(core.getState().shieldUntil, 15000);
  assert.ok(Math.abs(core.getTickMs() - 105) < 1e-9);
  assert.equal(core.togglePause(), true);
  assert.equal(core.getState().phase, 'paused');
  assert.equal(core.togglePause(), true);
  assert.equal(core.getState().phase, 'running');
  clock.set(19999);
  assert.ok(core.step().pickup);
  clock.set(20000);
  assert.equal(core.step().pickup.expiresAt, 28000);
  const ready = setup();
  assert.equal(ready.core.pause(), false, 'pause on a ready game is a no-op');
  assert.equal(ready.core.getState().phase, 'ready');
});

test('a move into the vacating tail is legal unless growth keeps the tail', () => {
  const snake = [
    { x: 2, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 },
    { x: 3, y: 2 }, { x: 3, y: 1 }, { x: 2, y: 1 }
  ];
  const open = setup({
    initialState: { phase: 'running', snake, direction: 'up', pickup: OPEN_PICKUP }
  });
  const moved = open.core.step();
  assert.equal(moved.phase, 'running');
  assert.deepEqual(plain(moved.snake[0]), { x: 2, y: 1 });
  assert.equal(moved.snake.length, 6);
  assert.deepEqual(plain(moved.snake[5]), { x: 3, y: 1 });

  const growing = setup({
    initialState: { phase: 'running', snake, direction: 'up', pickup: OPEN_PICKUP, growthPending: 1 }
  });
  const blocked = growing.core.step();
  assert.equal(blocked.phase, 'gameover');
  assert.equal(blocked.result, 'lost');
  assert.equal(blocked.snake.length, 6);
});

test('wall and body collisions end the game and restart begins a fresh run', () => {
  const wall = setup({
    initialState: {
      phase: 'running',
      snake: [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }],
      direction: 'left',
      pickup: OPEN_PICKUP
    }
  });
  const state = wall.core.step();
  assert.equal(state.phase, 'gameover');
  assert.equal(state.result, 'lost');
  assert.deepEqual(plain(state.snake), [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }]);
  assert.ok(state.pickup);
  wall.core.restart();
  assert.equal(wall.core.getState().phase, 'running');
  assert.equal(wall.core.getState().result, null);
  assert.deepEqual(plain(wall.core.getState().snake), START);

  const body = setup({
    initialState: {
      phase: 'running',
      snake: [
        { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 },
        { x: 2, y: 3 }, { x: 1, y: 3 }, { x: 0, y: 3 }
      ],
      direction: 'down',
      pickup: OPEN_PICKUP
    }
  });
  const hit = body.core.step();
  assert.equal(hit.phase, 'gameover');
  assert.equal(hit.result, 'lost');
  assert.deepEqual(plain(hit.snake[0]), { x: 1, y: 2 });
});

test('a shield forgives one collision by dropping the tail, then is consumed', () => {
  const walled = setup({
    initialState: {
      phase: 'running',
      snake: [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }],
      direction: 'left',
      queuedDirections: ['left'],
      shieldUntil: 5000,
      pickup: OPEN_PICKUP
    }
  });
  const forgiven = walled.core.step();
  assert.equal(forgiven.phase, 'running');
  assert.equal(forgiven.result, null);
  assert.deepEqual(plain(forgiven.snake), [{ x: 0, y: 5 }, { x: 1, y: 5 }]);
  assert.equal(forgiven.direction, 'left');
  assert.deepEqual(plain(forgiven.queuedDirections), []);
  assert.equal(forgiven.shieldUntil, 0);
  assert.deepEqual(plain(forgiven.pickup), OPEN_PICKUP);
  const again = walled.core.step();
  assert.equal(again.phase, 'gameover');
  assert.equal(again.result, 'lost');

  const bodied = setup({
    initialState: {
      phase: 'running',
      snake: [
        { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 },
        { x: 2, y: 3 }, { x: 1, y: 3 }, { x: 0, y: 3 }
      ],
      direction: 'down',
      shieldUntil: 5000,
      pickup: OPEN_PICKUP
    }
  });
  const bounced = bodied.core.step();
  assert.equal(bounced.phase, 'running');
  assert.equal(bounced.result, null);
  assert.equal(bounced.direction, 'down');
  assert.deepEqual(plain(bounced.snake[0]), { x: 1, y: 2 });
  assert.equal(bounced.snake.length, 6);
  assert.equal(bounced.shieldUntil, 0);

  const solo = setup({
    initialState: {
      phase: 'running',
      snake: [{ x: 0, y: 5 }],
      direction: 'left',
      shieldUntil: 5000,
      pickup: OPEN_PICKUP
    }
  });
  const ended = solo.core.step();
  assert.equal(ended.phase, 'gameover');
  assert.equal(ended.result, 'lost');
  assert.equal(ended.snake.length, 0);
  assert.equal(ended.shieldUntil, 0);

  // The shield is inactive at its deadline, not one moment after it.
  const clock = createClock();
  const expired = setup({
    clock,
    initialState: {
      phase: 'running',
      snake: [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }],
      direction: 'left',
      shieldUntil: 5000,
      pickup: OPEN_PICKUP
    }
  });
  clock.set(4999);
  assert.equal(expired.core.step().phase, 'running');
  const late = setup({
    clock: createClock(5000),
    initialState: {
      phase: 'running',
      snake: [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }],
      direction: 'left',
      shieldUntil: 5000,
      pickup: OPEN_PICKUP
    }
  });
  assert.equal(late.core.step().phase, 'gameover');
  assert.equal(late.core.getState().result, 'lost');
});

test('each pickup awards its points, growth and effect', () => {
  const rewards = [
    { kind: 'pi', points: 10, growth: 1, boost: 0, shield: 0 },
    { kind: 'claude', points: 25, growth: 2, boost: 3000, shield: 0 },
    { kind: 'codex', points: 50, growth: 3, boost: 0, shield: 5000 },
    { kind: 'orca', points: 100, growth: 1, boost: 0, shield: 0 }
  ];
  for (const reward of rewards) {
    const { core, saved } = setup({
      initialState: {
        phase: 'running',
        snake: START,
        direction: 'right',
        pickup: { x: 7, y: 8, kind: reward.kind, expiresAt: 10000 }
      }
    });
    const collected = core.step();
    assert.equal(collected.score, reward.points);
    assert.equal(collected.best, reward.points);
    assert.deepEqual(saved, [reward.points]);
    assert.equal(collected.snake.length, 4);
    assert.deepEqual(plain(collected.snake[0]), { x: 7, y: 8 });
    assert.equal(collected.growthPending, reward.growth - 1);
    assert.equal(collected.boostUntil, reward.boost);
    assert.equal(collected.shieldUntil, reward.shield);
    assert.equal(collected.pickup.kind, 'pi');
    assert.equal(collected.pickup.expiresAt, 8000);
    assert.ok(!collected.snake.some(point => point.x === collected.pickup.x && point.y === collected.pickup.y));
    assert.equal(new Set(collected.snake.map(point => `${point.x},${point.y}`)).size, collected.snake.length);

    for (let index = 0; index < reward.growth - 1; index += 1) {
      const following = core.step();
      assert.equal(following.snake.length, 4 + index + 1);
      assert.equal(following.growthPending, reward.growth - 1 - (index + 1));
    }
    const settled = core.step();
    assert.equal(settled.snake.length, 4 + reward.growth - 1);
    assert.equal(settled.growthPending, 0);
  }
});

test('spawn uses the injected random stream, clamps bad values and stays off the snake', () => {
  const weights = [
    [0, 'pi'], [0.32, 'pi'], [0.34, 'claude'], [0.65, 'claude'], [0.66, 'codex'],
    [0.9799, 'codex'], [0.98, 'orca'], [1, 'orca'], [-1, 'pi'], [Number.NaN, 'pi']
  ];
  for (const [roll, kind] of weights) {
    const state = setup({ randomValues: [0.25, roll] }).core.getState();
    assert.equal(state.pickup.kind, kind);
    assert.deepEqual(plain([state.pickup.x, state.pickup.y]), [23, 3]);
    assert.ok(!state.snake.some(point => point.x === state.pickup.x && point.y === state.pickup.y));
  }
  const last = setup({ randomValues: [5, 0] }).core.getState();
  assert.deepEqual(plain([last.pickup.x, last.pickup.y]), [23, 15]);
  const first = setup({ randomValues: [-5, 0] }).core.getState();
  assert.deepEqual(plain([first.pickup.x, first.pickup.y]), [0, 0]);
  const nanCell = setup({ randomValues: [Number.NaN, 0] }).core.getState();
  assert.deepEqual(plain([nanCell.pickup.x, nanCell.pickup.y]), [0, 0]);
  const populated = setup({ randomValues: [0.5, 0.5] }).core.getState();
  assert.equal(populated.pickup.kind, 'claude');
  assert.ok(!populated.snake.some(point => point.x === populated.pickup.x && point.y === populated.pickup.y));
});

test('a spawn rolls a whole pickup lifetime between 8 and 12 seconds', () => {
  // The lifetime is the third spawn draw, after the cell and the kind.
  const lifetime = roll => {
    const clock = createClock();
    const { core } = setup({ clock, randomValues: [0, 0, roll] });
    return core.getState().pickup.expiresAt - clock.now();
  };
  assert.equal(lifetime(0), 8000);
  assert.equal(lifetime(0.5), 10000);
  assert.equal(lifetime(0.999999), 12000);
  assert.equal(lifetime(1.5), 12000, 'above-range rolls clamp to the maximum');
  assert.equal(lifetime(-1), 8000, 'negative rolls clamp to the minimum');
  assert.equal(lifetime(Number.NaN), 8000, 'non-finite rolls use the minimum');
  for (const roll of [0, 0.1, 0.5, 0.9, 0.999999, 1.5, -1, Number.NaN]) {
    assert.ok(Number.isInteger(lifetime(roll)), 'lifetimes are whole milliseconds');
  }
});

test('pickups expire at their rolled deadline and a respawn rolls again', () => {
  const clock = createClock();
  const shortest = setup({
    clock,
    initialState: {
      phase: 'running',
      snake: START,
      direction: 'right',
      pickup: { x: 0, y: 0, kind: 'pi', expiresAt: 8000 }
    }
  });
  clock.set(7999);
  const early = shortest.core.step();
  assert.ok(early.pickup);
  assert.equal(early.pickup.expiresAt, 8000, 'the shortest pickup is still there at 7999 ms');
  clock.set(8000);
  const replaced = shortest.core.step();
  assert.equal(replaced.pickup.expiresAt, 16000);

  const longestClock = createClock();
  const longest = setup({
    clock: longestClock,
    initialState: {
      phase: 'running',
      snake: START,
      direction: 'right',
      pickup: { x: 0, y: 0, kind: 'pi', expiresAt: 12000 }
    }
  });
  longestClock.set(11999);
  const still = longest.core.step();
  assert.ok(still.pickup);
  assert.equal(still.pickup.expiresAt, 12000, 'the longest pickup is still there at 11999 ms');
  longestClock.set(12000);
  assert.equal(longest.core.step().pickup.expiresAt, 20000);

  // Cell 0.5, kind 0 and lifetime 0.999999 are the three draws of the respawn.
  const rerollClock = createClock();
  const rerolled = setup({
    clock: rerollClock,
    randomValues: [0.5, 0, 0.999999],
    initialState: {
      phase: 'running',
      snake: START,
      direction: 'right',
      pickup: { x: 0, y: 0, kind: 'pi', expiresAt: 8000 }
    }
  });
  rerollClock.set(8000);
  const fresh = rerolled.core.step();
  assert.equal(fresh.pickup.expiresAt, 20000, 'a respawn rolls a fresh 12 second lifetime');
  assert.equal(fresh.pickup.kind, 'pi');
});

test('filling the board with the last pickup wins the game', () => {
  const path = [];
  for (let y = 0; y < 16; y += 1) {
    for (let column = 0; column < 24; column += 1) {
      path.push({ x: y % 2 === 0 ? column : 23 - column, y });
    }
  }
  const body = path.slice(0, 383).reverse();
  const empty = path[383];
  assert.deepEqual(plain(empty), { x: 0, y: 15 });
  const { core } = setup({
    initialState: {
      phase: 'running',
      snake: body,
      direction: 'left',
      pickup: { x: empty.x, y: empty.y, kind: 'pi', expiresAt: 10000 }
    }
  });
  const won = core.step();
  assert.equal(won.phase, 'gameover');
  assert.equal(won.result, 'won');
  assert.equal(won.pickup, null);
  assert.equal(won.snake.length, 384);
  assert.deepEqual(plain(won.snake[0]), empty);
  assert.equal(new Set(won.snake.map(point => `${point.x},${point.y}`)).size, 384);
  assert.equal(won.score, 10);
  const after = core.step();
  assert.equal(after.phase, 'gameover');
  assert.equal(after.result, 'won');
});

test('tick interval follows the score and the boost expires at its deadline', () => {
  const cases = [[0, 150], [49, 150], [50, 145], [99, 145], [100, 140], [149, 140], [900, 60], [1200, 60]];
  for (const [score, expected] of cases) {
    const state = setup({
      initialState: {
        phase: 'running', snake: START, direction: 'right', score, pickup: OPEN_PICKUP
      }
    });
    assert.equal(state.core.getTickMs(), expected);
  }
  const clock = createClock();
  const boosted = setup({
    clock,
    initialState: {
      phase: 'running', snake: START, direction: 'right', score: 0, boostUntil: 3000, pickup: OPEN_PICKUP
    }
  });
  assert.ok(Math.abs(boosted.core.getTickMs() - 105) < 1e-9);
  clock.set(2999);
  assert.ok(Math.abs(boosted.core.getTickMs() - 105) < 1e-9);
  clock.set(3000);
  assert.equal(boosted.core.getTickMs(), 150);
  const stepped = boosted.core.step();
  assert.equal(stepped.boostUntil, 0);
});

test('restart clears the run while keeping the loaded best score', () => {
  const saved = [];
  const { core } = setup({
    loadBest: () => 42,
    saveBest: value => saved.push(value),
    initialState: {
      phase: 'running',
      snake: START,
      direction: 'right',
      queuedDirections: ['up'],
      score: 42,
      boostUntil: 3000,
      shieldUntil: 5000,
      pickup: { x: 6, y: 7, kind: 'codex', expiresAt: 10000 }
    }
  });
  assert.equal(core.getState().best, 42);
  const collected = core.step();
  assert.equal(collected.score, 92);
  assert.equal(collected.best, 92);
  assert.equal(collected.direction, 'up');
  assert.equal(collected.growthPending, 2);
  assert.deepEqual(saved, [92]);
  core.restart();
  const state = core.getState();
  assert.equal(state.phase, 'running');
  assert.equal(state.score, 0);
  assert.equal(state.best, 92);
  assert.deepEqual(plain(state.snake), START);
  assert.equal(state.direction, 'right');
  assert.deepEqual(plain(state.queuedDirections), []);
  assert.equal(state.growthPending, 0);
  assert.equal(state.boostUntil, 0);
  assert.equal(state.shieldUntil, 0);
  assert.equal(state.result, null);
  assert.deepEqual(plain(state.pickup), { x: 0, y: 0, kind: 'pi', expiresAt: 8000 });
  assert.deepEqual(saved, [92]);
});

test('persistence callbacks that throw do not stop play', () => {
  const failingSave = setup({
    saveBest: () => { throw new Error('storage denied'); },
    initialState: {
      phase: 'running', snake: START, direction: 'right',
      pickup: { x: 7, y: 8, kind: 'codex', expiresAt: 10000 }
    }
  });
  const state = failingSave.core.step();
  assert.equal(state.score, 50);
  assert.equal(state.best, 50);
  assert.equal(state.phase, 'running');
  assert.equal(state.snake.length, 4);

  const failingLoad = setup({ loadBest: () => { throw new Error('storage denied'); } });
  assert.equal(failingLoad.core.getState().best, 0);
  assert.equal(failingLoad.core.getState().phase, 'ready');
});

test('best store uses orca-snakai-best and falls back safely when storage fails', () => {
  const values = new Map();
  const storage = {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, value); }
  };
  const store = platform.createSnakAIBestStore({ storage });
  assert.equal(store.loadBest(), 0);
  store.saveBest(12);
  assert.equal(values.get('orca-snakai-best'), '12');
  assert.equal(store.loadBest(), 12);
  store.saveBest(7);
  assert.equal(store.loadBest(), 12);
  assert.equal(values.get('orca-snakai-best'), '12');

  const seeded = platform.createSnakAIBestStore({ storage: { getItem: () => '42', setItem: () => {} } });
  assert.equal(seeded.loadBest(), 42);
  const junk = platform.createSnakAIBestStore({ storage: { getItem: () => 'not-a-number', setItem: () => {} } });
  assert.equal(junk.loadBest(), 0);
  const negative = platform.createSnakAIBestStore({ storage: { getItem: () => '-9', setItem: () => {} } });
  assert.equal(negative.loadBest(), 0);

  const denied = platform.createSnakAIBestStore({
    storage: {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); }
    }
  });
  assert.equal(denied.loadBest(), 0);
  denied.saveBest(8);
  assert.equal(denied.loadBest(), 8);
  denied.saveBest(3);
  assert.equal(denied.loadBest(), 8);

  const writeBroken = platform.createSnakAIBestStore({
    storage: { getItem: () => null, setItem() { throw new Error('quota'); } }
  });
  writeBroken.saveBest(5);
  assert.equal(writeBroken.loadBest(), 5);

  const noStorage = platform.createSnakAIBestStore();
  assert.equal(noStorage.loadBest(), 0);
  noStorage.saveBest(9);
  assert.equal(noStorage.loadBest(), 9);

  const positional = platform.createSnakAIBestStore(storage);
  assert.equal(positional.loadBest(), 12);
});

// ---- Bug hazard and game over cause ------------------------------------------------------------

const LONG_SNAKE = [
  { x: 10, y: 5 }, { x: 9, y: 5 }, { x: 8, y: 5 }, { x: 7, y: 5 },
  { x: 6, y: 5 }, { x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }
];

function bugBoard(overrides = {}) {
  return setup({
    initialState: {
      phase: 'running',
      snake: LONG_SNAKE,
      direction: 'right',
      pickup: OPEN_PICKUP,
      bug: { x: 11, y: 5, expiresAt: 10000 },
      score: 50,
      growthPending: 0,
      ...overrides
    }
  });
}

test('touching a bug costs 20 points and cuts the snake to half', () => {
  const { core, saved } = bugBoard();
  const hit = core.step();
  assert.equal(hit.phase, 'running');
  assert.equal(hit.score, 30);
  assert.equal(hit.snake.length, 4, 'half of eight segments');
  assert.deepEqual(plain(hit.snake[0]), { x: 11, y: 5 });
  assert.deepEqual(plain(hit.snake[3]), { x: 8, y: 5 }, 'the tail is the part that goes');
  assert.equal(hit.growthPending, 0);
  assert.equal(hit.bug, null);
  assert.equal(hit.bugHits, 1);
  assert.equal(hit.bugBlocks, 0);
  assert.equal(hit.best, 0, 'a bug never touches the best score');
  assert.deepEqual(saved, []);
  assert.equal(core.step().bugHits, 1, 'one bug hurts only once');

  // Growth already owed lands first, then the whole snake is halved and the debt is dropped.
  const growing = bugBoard({ growthPending: 2 }).core.step();
  assert.equal(growing.snake.length, 5, 'nine segments keep five');
  assert.equal(growing.growthPending, 0);
});

test('a bug keeps three segments, never goes below zero points and rounds up odd lengths', () => {
  const short = bugBoard({ snake: [{ x: 10, y: 5 }, { x: 9, y: 5 }, { x: 8, y: 5 }], score: 10, growthPending: 0 });
  const small = short.core.step();
  assert.equal(small.snake.length, 3, 'a three segment snake keeps all of them');
  assert.equal(small.score, 0, 'points stop at zero');
  assert.equal(small.bugHits, 1);

  const odd = bugBoard({ snake: LONG_SNAKE.slice(0, 7), growthPending: 0 });
  assert.equal(odd.core.step().snake.length, 4, 'seven segments keep four');

  const four = bugBoard({ snake: LONG_SNAKE.slice(0, 4), growthPending: 0 });
  assert.equal(four.core.step().snake.length, 3, 'never fewer than three');
});

test('a live shield squashes the bug and is used up', () => {
  const { core } = bugBoard({ shieldUntil: 5000, growthPending: 0 });
  const blocked = core.step();
  assert.equal(blocked.phase, 'running');
  assert.equal(blocked.score, 50, 'no points lost');
  assert.equal(blocked.snake.length, 8, 'no segments lost');
  assert.equal(blocked.shieldUntil, 0);
  assert.equal(blocked.bug, null);
  assert.equal(blocked.bugBlocks, 1);
  assert.equal(blocked.bugHits, 0);

  const clock = createClock(5000);
  const late = setup({
    clock,
    initialState: {
      phase: 'running', snake: LONG_SNAKE, direction: 'right', pickup: OPEN_PICKUP,
      bug: { x: 11, y: 5, expiresAt: 20000 }, score: 50, shieldUntil: 5000
    }
  });
  assert.equal(late.core.step().bugHits, 1, 'an expired shield no longer protects');
});

test('a bug expires at its deadline and a respawning pickup avoids it', () => {
  const clock = createClock();
  const { core } = setup({
    clock,
    initialState: {
      phase: 'running',
      snake: START,
      direction: 'right',
      pickup: { x: 22, y: 0, kind: 'pi', expiresAt: 9000 },
      bug: { x: 0, y: 0, expiresAt: 8000 }
    }
  });
  clock.set(7999);
  assert.ok(core.step().bug, 'still there at 7999 ms');
  clock.set(8000);
  assert.equal(core.step().bug, null, 'gone at its deadline');

  // The respawn would pick the first free cell, which the bug occupies, so it takes the next one.
  const crowded = setup({
    clock: createClock(9000),
    initialState: {
      phase: 'running',
      snake: START,
      direction: 'right',
      pickup: { x: 22, y: 0, kind: 'pi', expiresAt: 9000 },
      bug: { x: 0, y: 0, expiresAt: 20000 }
    }
  });
  const next = crowded.core.step();
  assert.deepEqual([next.pickup.x, next.pickup.y], [1, 0]);
  assert.ok(next.bug);

  // Pause shifts the bug deadline like every other one.
  const pauseClock = createClock();
  const paused = setup({
    clock: pauseClock,
    initialState: {
      phase: 'running', snake: START, direction: 'right', pickup: OPEN_PICKUP,
      bug: { x: 0, y: 0, expiresAt: 9000 }
    }
  });
  paused.core.pause();
  pauseClock.advance(5000);
  paused.core.start();
  assert.equal(paused.core.getState().bug.expiresAt, 14000);
});

test('collecting an agent can spawn one bug, away from the head and the pickup', () => {
  const state = (randomValues, fallbackRandom = 0) => setup({
    randomValues,
    fallbackRandom,
    initialState: {
      phase: 'running',
      snake: START,
      direction: 'right',
      pickup: { x: 7, y: 8, kind: 'pi', expiresAt: 10000 }
    }
  });
  // New pickup: cell 0, kind 0, lifetime 0. Then bug: chance 0.5, cell 0, lifetime 0.5.
  const spawned = state([0, 0, 0, 0.5, 0, 0.5]).core.step();
  assert.deepEqual([spawned.pickup.x, spawned.pickup.y], [0, 0]);
  assert.deepEqual(plain(spawned.bug), { x: 1, y: 0, expiresAt: 10000 }, 'skips the pickup cell');

  assert.equal(state([0, 0, 0, 0.4999]).core.step().bug, null, 'a low chance roll spawns nothing');
  assert.equal(state([]).core.step().bug, null, 'a zero random stream never spawns a bug');

  for (let step = 0; step < 100; step += 1) {
    const roll = step / 100;
    const board = state([0.3, 0, 0, 0.99, roll, roll]).core.step();
    assert.ok(board.bug, 'a high chance roll spawns a bug');
    const head = board.snake[0];
    assert.ok(Math.abs(board.bug.x - head.x) + Math.abs(board.bug.y - head.y) >= 4, 'never next to the head');
    assert.ok(!board.snake.some(point => point.x === board.bug.x && point.y === board.bug.y));
    assert.ok(board.bug.x !== board.pickup.x || board.bug.y !== board.pickup.y);
  }

  // Only one bug at a time: a second collection keeps the first.
  const twice = setup({
    fallbackRandom: 0.99,
    initialState: {
      phase: 'running',
      snake: START,
      direction: 'right',
      pickup: { x: 7, y: 8, kind: 'pi', expiresAt: 10000 },
      bug: { x: 20, y: 14, expiresAt: 10000 }
    }
  });
  assert.deepEqual(plain(twice.core.step().bug), { x: 20, y: 14, expiresAt: 10000 });
});

test('game over records why the run ended and restart clears the bug', () => {
  const wall = setup({
    initialState: {
      phase: 'running', snake: [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }], direction: 'left', pickup: OPEN_PICKUP
    }
  });
  const hitWall = wall.core.step();
  assert.equal(hitWall.result, 'lost');
  assert.equal(hitWall.cause, 'wall');

  const body = setup({
    initialState: {
      phase: 'running',
      snake: [
        { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 },
        { x: 2, y: 3 }, { x: 1, y: 3 }, { x: 0, y: 3 }
      ],
      direction: 'down',
      pickup: OPEN_PICKUP
    }
  });
  assert.equal(body.core.step().cause, 'body');

  // A solo shielded snake that bounces off a wall still ends with the wall as the cause.
  const solo = setup({
    initialState: {
      phase: 'running', snake: [{ x: 0, y: 5 }], direction: 'left', shieldUntil: 5000, pickup: OPEN_PICKUP
    }
  });
  assert.equal(solo.core.step().cause, 'wall');

  const full = [];
  for (let y = 0; y < 16; y += 1) {
    for (let column = 0; column < 24; column += 1) full.push({ x: y % 2 === 0 ? column : 23 - column, y });
  }
  const winning = setup({
    initialState: {
      phase: 'running',
      snake: full.slice(0, 383).reverse(),
      direction: 'left',
      pickup: { x: 0, y: 15, kind: 'pi', expiresAt: 10000 },
      bug: { x: 5, y: 5, expiresAt: 10000 }
    }
  });
  const won = winning.core.step();
  assert.equal(won.result, 'won');
  assert.equal(won.cause, 'full');
  assert.equal(won.bug, null, 'a won board has no bug left');

  const hurt = bugBoard();
  hurt.core.step();
  hurt.core.restart();
  const fresh = hurt.core.getState();
  assert.equal(fresh.bug, null);
  assert.equal(fresh.bugHits, 0);
  assert.equal(fresh.bugBlocks, 0);
  assert.equal(fresh.cause, null);
});

test('the orca bonus clears the bug and no new bug follows it', () => {
  const orcaBoard = (bug, randomValues = [], fallbackRandom = 0) => setup({
    randomValues,
    fallbackRandom,
    initialState: {
      phase: 'running',
      snake: START,
      direction: 'right',
      pickup: { x: 7, y: 8, kind: 'orca', expiresAt: 10000 },
      bug,
      score: 20
    }
  });
  const cleared = orcaBoard({ x: 20, y: 14, expiresAt: 10000 }).core.step();
  assert.equal(cleared.score, 120);
  assert.equal(cleared.bug, null, 'the orca chases the bug away');
  assert.equal(cleared.bugHits, 0);
  // Every random draw is high, so any other pickup would roll a bug; the orca must not.
  const quiet = orcaBoard(null, [0, 0, 0], 0.99).core.step();
  assert.equal(quiet.bug, null, 'no bug spawns right after an orca');
  const other = setup({
    randomValues: [0, 0, 0],
    fallbackRandom: 0.99,
    initialState: {
      phase: 'running', snake: START, direction: 'right', pickup: { x: 7, y: 8, kind: 'claude', expiresAt: 10000 }
    }
  });
  assert.ok(other.core.step().bug, 'the same stream does spawn a bug after any other pickup');
});

test('the three agents are equally likely and the orca is rare', () => {
  const counts = { pi: 0, claude: 0, codex: 0, orca: 0 };
  const draws = 10000;
  for (let index = 0; index < draws; index += 1) {
    counts[setup({ randomValues: [0, (index + 0.5) / draws] }).core.getState().pickup.kind] += 1;
  }
  assert.equal(counts.orca, 200, 'two percent are orcas');
  assert.ok(Math.abs(counts.pi - counts.claude) <= 1 && Math.abs(counts.claude - counts.codex) <= 1,
    `the agents split evenly: ${JSON.stringify(counts)}`);
});
