/* snakAI — original canvas game. Copyright (c) 2026 gentilfp. MIT. */
(function () {
  'use strict';
  const COLUMNS = 24;
  const ROWS = 16;
  const CELL = 30;
  // Text and effects use 5px art pixels. Board sprites are 10x10 grids, so each sprite pixel is 3px.
  const ART = 5;
  // The score strip sits above the board, so nothing on the board can ever cover it.
  const HUD_H = 60;
  const BOARD_W = COLUMNS * CELL;
  const BOARD_H = ROWS * CELL;

  // Fixed simulation constants. OSN-3 renders 720x480 as a 24x16 grid of 30px cells.
  const DIRECTIONS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };
  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const PHASES = ['ready', 'running', 'paused', 'gameover'];
  const START_SNAKE = [{ x: 6, y: 8 }, { x: 5, y: 8 }, { x: 4, y: 8 }];
  const PICKUPS = {
    pi: { points: 10, growth: 1, boostMs: 0, shieldMs: 0 },
    claude: { points: 25, growth: 2, boostMs: 3000, shieldMs: 0 },
    codex: { points: 50, growth: 3, boostMs: 0, shieldMs: 5000 },
    // A rare bonus: worth a lot and it chases every bug off the board.
    orca: { points: 100, growth: 1, boostMs: 0, shieldMs: 0, clearsBug: true }
  };
  // A bug is a hazard, not a pickup: touching it costs points and cuts the snake in half.
  // A live shield squashes the bug instead and is used up.
  const AGENTS = ['pi', 'claude', 'codex'];
  const ORCA_CHANCE = 0.02;
  const BUG_PENALTY = 20;
  const MIN_LENGTH = START_SNAKE.length;
  // It appears after an agent is collected, when the roll is at least 1 - BUG_CHANCE, and keeps away from the head.
  const BUG_CHANCE = 0.5;
  const BUG_MIN_DISTANCE = 4;
  // OSN-5: a spawned pickup expires after a random whole number of milliseconds in [8000, 12000].
  const PICKUP_TTL_MIN_MS = 8000;
  const BOOST_FACTOR = 0.7;
  const BEST_KEY = 'snakai-best';

  function toInteger(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function parseStoredBest(raw) {
    if (typeof raw === 'number') return toInteger(raw, 0);
    if (typeof raw !== 'string') return 0;
    const text = raw.trim();
    if (!/^\d+$/.test(text)) return 0;
    return toInteger(Number.parseInt(text, 10), 0);
  }

  function readBest(loadBest) {
    try {
      return toInteger(loadBest(), 0);
    } catch (error) {
      return 0;
    }
  }

  // Injected random values are clamped so a pathological source still yields a valid cell/weight.
  function unitRandom(random) {
    const value = Number(random());
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value >= 1) return 0.999999999;
    return value;
  }

  function pickKind(random) {
    const roll = unitRandom(random);
    // The Orca is the rare bonus. The other 98% is split evenly between the three agents.
    if (roll >= 1 - ORCA_CHANCE) return 'orca';
    return AGENTS[Math.floor((roll / (1 - ORCA_CHANCE)) * AGENTS.length)];
  }

  // The lifetime roll is the third and last draw of a spawn, so cell and kind stay deterministic.
  function pickupTtl(random) {
    const value = Number(random());
    const roll = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999) : 0;
    return PICKUP_TTL_MIN_MS + Math.floor(roll * 4001);
  }

  function copyPoint(point) {
    return { x: point.x, y: point.y };
  }

  // Pure Snake simulation. No canvas, DOM, storage, timers or global randomness:
  // OSN-3 owns rendering, input, frames and persistence wiring.
  window.createSnakAICore = function (options) {
    const settings = options || {};
    const random = typeof settings.random === 'function' ? settings.random : Math.random;
    const now = typeof settings.now === 'function' ? settings.now : Date.now;
    const loadBest = typeof settings.loadBest === 'function' ? settings.loadBest : function () { return 0; };
    const saveBest = typeof settings.saveBest === 'function' ? settings.saveBest : function () {};
    // Test-only seed for awkward board states (full board, one-segment snake). Production omits it.
    const testState = settings.testState;

    let snake;
    let direction;
    let queuedDirections;
    let pickup;
    let bug;
    let bugHits;
    let bugBlocks;
    let cause;
    let score;
    let best;
    let growthPending;
    let boostUntil;
    let shieldUntil;
    let phase;
    let result;
    let readyAt;
    let pausedAt;

    function snapshot() {
      return {
        phase: phase,
        snake: snake.map(copyPoint),
        direction: direction,
        queuedDirections: queuedDirections.slice(),
        pickup: pickup ? { x: pickup.x, y: pickup.y, kind: pickup.kind, expiresAt: pickup.expiresAt } : null,
        bug: bug ? { x: bug.x, y: bug.y, expiresAt: bug.expiresAt } : null,
        bugHits: bugHits,
        bugBlocks: bugBlocks,
        score: score,
        best: best,
        growthPending: growthPending,
        boostUntil: boostUntil,
        shieldUntil: shieldUntil,
        result: result,
        cause: cause
      };
    }

    function finish(outcome, reason) {
      phase = 'gameover';
      result = outcome;
      cause = reason;
      queuedDirections = [];
      readyAt = null;
      pausedAt = null;
      if (outcome === 'won') {
        pickup = null;
        bug = null;
      }
    }

    function persistBest(value) {
      try {
        saveBest(value);
      } catch (error) {
        // A broken persistence callback must not stop play.
      }
    }

    function bodyHas(x, y, ignoreTail) {
      const limit = ignoreTail ? snake.length - 1 : snake.length;
      for (let index = 0; index < limit; index += 1) {
        if (snake[index].x === x && snake[index].y === y) return true;
      }
      return false;
    }

    function freeCells() {
      const cells = [];
      for (let y = 0; y < ROWS; y += 1) {
        for (let x = 0; x < COLUMNS; x += 1) {
          if (!bodyHas(x, y, false)) cells.push({ x: x, y: y });
        }
      }
      return cells;
    }

    function spawnPickup(at) {
      let cells = freeCells().filter(function (cell) { return !bug || bug.x !== cell.x || bug.y !== cell.y; });
      // A bug must never be the reason the board looks full.
      if (!cells.length && bug) {
        bug = null;
        cells = freeCells();
      }
      if (!cells.length) {
        finish('won', 'full');
        return;
      }
      const index = Math.floor(unitRandom(random) * cells.length);
      const cell = cells[index];
      // Cell, kind, then lifetime: a scripted random stream still picks the same cell and kind.
      const kind = pickKind(random);
      pickup = { x: cell.x, y: cell.y, kind: kind, expiresAt: at + pickupTtl(random) };
    }

    // Cell, then lifetime, drawn only when the chance roll passes, so a zero stream never spawns a bug.
    function maybeSpawnBug(at) {
      if (bug || phase !== 'running') return;
      if (unitRandom(random) < 1 - BUG_CHANCE) return;
      const head = snake[0];
      const cells = freeCells().filter(function (cell) {
        if (pickup && pickup.x === cell.x && pickup.y === cell.y) return false;
        return Math.abs(cell.x - head.x) + Math.abs(cell.y - head.y) >= BUG_MIN_DISTANCE;
      });
      if (!cells.length) return;
      const cell = cells[Math.floor(unitRandom(random) * cells.length)];
      bug = { x: cell.x, y: cell.y, expiresAt: at + pickupTtl(random) };
    }

    function hurtByBug() {
      score = Math.max(0, score - BUG_PENALTY);
      growthPending = 0;
      const keep = Math.max(MIN_LENGTH, Math.ceil(snake.length / 2));
      if (snake.length > keep) snake.length = keep;
    }

    function shiftDeadlines(elapsed) {
      if (elapsed <= 0) return;
      if (pickup && pickup.expiresAt > 0) pickup.expiresAt += elapsed;
      if (bug && bug.expiresAt > 0) bug.expiresAt += elapsed;
      if (boostUntil > 0) boostUntil += elapsed;
      if (shieldUntil > 0) shieldUntil += elapsed;
    }

    function clearExpiredEffects(at) {
      if (boostUntil > 0 && at >= boostUntil) boostUntil = 0;
      if (shieldUntil > 0 && at >= shieldUntil) shieldUntil = 0;
    }

    function resetRun(at) {
      snake = START_SNAKE.map(copyPoint);
      direction = 'right';
      queuedDirections = [];
      score = 0;
      growthPending = 0;
      boostUntil = 0;
      shieldUntil = 0;
      result = null;
      cause = null;
      bug = null;
      bugHits = 0;
      bugBlocks = 0;
      readyAt = null;
      pausedAt = null;
      phase = 'ready';
      pickup = null;
      spawnPickup(at);
    }

    function seedTestState(state, at) {
      const seed = state || {};
      snake = Array.isArray(seed.snake) && seed.snake.length
        ? seed.snake.map(function (point) {
          return { x: toInteger(point && point.x, 0), y: toInteger(point && point.y, 0) };
        })
        : START_SNAKE.map(copyPoint);
      direction = DIRECTIONS[seed.direction] ? seed.direction : 'right';
      queuedDirections = Array.isArray(seed.queuedDirections)
        ? seed.queuedDirections.filter(function (turn) { return DIRECTIONS[turn]; }).slice(0, 2)
        : [];
      pickup = seed.pickup
        ? {
          x: toInteger(seed.pickup.x, 0),
          y: toInteger(seed.pickup.y, 0),
          kind: PICKUPS[seed.pickup.kind] ? seed.pickup.kind : 'pi',
          expiresAt: toInteger(seed.pickup.expiresAt, at + PICKUP_TTL_MIN_MS)
        }
        : null;
      bug = seed.bug
        ? {
          x: toInteger(seed.bug.x, 0),
          y: toInteger(seed.bug.y, 0),
          expiresAt: toInteger(seed.bug.expiresAt, at + PICKUP_TTL_MIN_MS)
        }
        : null;
      bugHits = toInteger(seed.bugHits, 0);
      bugBlocks = toInteger(seed.bugBlocks, 0);
      cause = typeof seed.cause === 'string' ? seed.cause : null;
      score = toInteger(seed.score, 0);
      growthPending = toInteger(seed.growthPending, 0);
      boostUntil = toInteger(seed.boostUntil, 0);
      shieldUntil = toInteger(seed.shieldUntil, 0);
      phase = PHASES.indexOf(seed.phase) >= 0 ? seed.phase : 'ready';
      result = seed.result === 'won' || seed.result === 'lost' ? seed.result : null;
      readyAt = phase === 'ready' ? at : null;
      pausedAt = null;
    }

    function start() {
      if (phase === 'running') return true;
      const at = now();
      if (phase === 'ready') {
        if (readyAt !== null) shiftDeadlines(at - readyAt);
        readyAt = null;
        phase = 'running';
        return true;
      }
      if (phase === 'paused') {
        if (pausedAt !== null) shiftDeadlines(at - pausedAt);
        pausedAt = null;
        phase = 'running';
        return true;
      }
      return false;
    }

    function pause() {
      if (phase !== 'running') return false;
      phase = 'paused';
      pausedAt = now();
      return true;
    }

    function togglePause() {
      if (phase === 'running') return pause();
      if (phase === 'paused') return start();
      return false;
    }

    function restart() {
      resetRun(now());
      phase = 'running';
      return true;
    }

    function queueDirection(turn) {
      if (phase !== 'running') return false;
      if (!DIRECTIONS[turn]) return false;
      if (queuedDirections.length >= 2) return false;
      const previous = queuedDirections.length ? queuedDirections[queuedDirections.length - 1] : direction;
      if (OPPOSITE[turn] === previous) return false;
      queuedDirections.push(turn);
      return true;
    }

    function getTickMs() {
      const at = now();
      const interval = Math.max(60, 150 - 5 * Math.floor(score / 50));
      return boostUntil > 0 && at < boostUntil ? interval * BOOST_FACTOR : interval;
    }

    function step() {
      if (phase !== 'running') return snapshot();

      const at = now();
      clearExpiredEffects(at);
      // A pickup left past its deadline respawns before the move; paused boards never reach here.
      if (bug && at >= bug.expiresAt) bug = null;
      if (pickup && at >= pickup.expiresAt) spawnPickup(at);
      if (phase !== 'running') return snapshot();

      const proposed = queuedDirections.length ? queuedDirections[0] : direction;
      const vector = DIRECTIONS[proposed];
      const nextX = snake[0].x + vector.x;
      const nextY = snake[0].y + vector.y;
      const collects = pickup !== null && pickup.x === nextX && pickup.y === nextY;
      const touchesBug = bug !== null && bug.x === nextX && bug.y === nextY;
      let orcaEaten = false;
      // Growth keeps the tail, so entering the tail cell is only legal when nothing grows.
      const grows = collects || growthPending > 0;
      const hitsWall = nextX < 0 || nextX >= COLUMNS || nextY < 0 || nextY >= ROWS;
      const hitsBody = !hitsWall && bodyHas(nextX, nextY, !grows);

      if (hitsWall || hitsBody) {
        if (shieldUntil > 0 && at < shieldUntil) {
          shieldUntil = 0;
          queuedDirections = [];
          snake.pop();
          if (!snake.length) finish('lost', hitsWall ? 'wall' : 'body');
        } else {
          finish('lost', hitsWall ? 'wall' : 'body');
        }
        return snapshot();
      }

      if (queuedDirections.length) queuedDirections.shift();
      direction = proposed;
      snake.unshift({ x: nextX, y: nextY });

      let growth = growthPending;
      if (collects) {
        const reward = PICKUPS[pickup.kind];
        score += reward.points;
        growth += reward.growth;
        if (reward.boostMs) boostUntil = at + reward.boostMs;
        if (reward.shieldMs) shieldUntil = at + reward.shieldMs;
        if (reward.clearsBug) {
          bug = null;
          orcaEaten = true;
        }
        if (score > best) {
          best = score;
          persistBest(best);
        }
        pickup = null;
      }

      if (growth > 0) {
        // The tail stays for this move; any remaining segments follow on later safe moves.
        growthPending = growth - 1;
      } else {
        growthPending = 0;
        snake.pop();
      }

      if (touchesBug) {
        bug = null;
        if (shieldUntil > 0 && at < shieldUntil) {
          shieldUntil = 0;
          bugBlocks += 1;
        } else {
          hurtByBug();
          bugHits += 1;
        }
      }

      if (pickup === null) {
        spawnPickup(at);
        // The orca just cleared the water, so no new bug right behind it.
        if (!orcaEaten) maybeSpawnBug(at);
      }
      if (phase === 'running' && snake.length >= COLUMNS * ROWS) finish('won', 'full');
      return snapshot();
    }

    if (testState) {
      seedTestState(testState, now());
    } else {
      const startedAt = now();
      resetRun(startedAt);
      readyAt = startedAt;
    }
    best = readBest(loadBest);

    return {
      start: start,
      pause: pause,
      togglePause: togglePause,
      restart: restart,
      queueDirection: queueDirection,
      step: step,
      getState: snapshot,
      getTickMs: getTickMs
    };
  };

  // Best-score adapter for OSN-3: the frame may deny localStorage, so keep the value in memory too.
  window.createSnakAIBestStore = function (options) {
    const provided = options !== undefined && options !== null;
    let storage = null;
    if (provided) {
      storage = typeof options.getItem === 'function' ? options : (options.storage || null);
    } else {
      try {
        storage = window.localStorage || null;
      } catch (error) {
        storage = null;
      }
    }

    let best = 0;
    if (storage) {
      try {
        best = parseStoredBest(storage.getItem(BEST_KEY));
      } catch (error) {
        best = 0;
      }
    }

    function loadBest() {
      return best;
    }

    function saveBest(value) {
      const next = toInteger(value, 0);
      if (next > best) best = next;
      if (!storage) return;
      try {
        storage.setItem(BEST_KEY, String(best));
      } catch (error) {
        // Keep the in-memory best when storage is denied or full.
      }
    }

    return { loadBest: loadBest, saveBest: saveBest };
  };

  // ---- Renderer -----------------------------------------------------------------------------
  // One character per sprite pixel; '.' is transparent. The snake and the bug are 10x10 grids of 3px
  // pixels. The pickups are the author's own 8-bit art on 30x30 grids of 1px pixels.
  const HEAD_ART = [
    '..gggggg..',
    '.gggggggg.',
    'ggggggwwkg',
    'ggggggwwkg',
    'gggggggggg',
    'gggggggggg',
    'ggggggwwkg',
    'ggggggwwkg',
    '.gggggggg.',
    '..gggggg..'
  ];
  const BODY_ART = [
    '..gggggg..',
    '.gggggggg.',
    'ghhggggggg',
    'ghgggggggg',
    'gggggddggg',
    'gggggddggg',
    'gggggggggg',
    'gggggggggg',
    '.gggggggg.',
    '..gggggg..'
  ];
  const PICKUP_ART = {
    // Pi: the author's own 8-bit art, on a 30x30 grid of 1px pixels.
    pi: {
      rows: [
        '...aaaaaaaaaaaaaaaaaaaa.......',
        '...aaaaaaaaaaaaaaaaaaaa.......',
        '...aaaaaaaaaaaaaaaaaaaa.......',
        'aaaaaaaaaaaaaaaaaaaaaaaaa.....',
        'aaaaaaaaaaaaaaaaaaaaaaaaa.....',
        'aaaaaaaaaaaaaaaaaaaaaaaaa.....',
        'aaaaaaaaaaaaaaaaaaaaaaaaa.....',
        'aaaaaaaaaaaaaaaaaaaaaaaaa.....',
        'bbbbbbbb........aaaaaaaaa.....',
        'cccccccc........aaaaaaaaa.....',
        'cccccccc........aaaaaaaaa.....',
        'cccccccc........aaaaaaaaa.....',
        'cccccccc........aaaaaaaaa.....',
        'cccccccc........aaaaaaaaa.....',
        'cccccccc........aaaaaaaaa.....',
        'cccccccc........baaaaaaaad....',
        'cccccccccccccccc......dddddddd',
        'cccccccccccccccc......dddddddd',
        'cccccccccccccccc......dddddddd',
        'cccccccccccccccc......dddddddd',
        'cccccccccccccccc......dddddddd',
        'cccccccccccccccc......dddddddd',
        'cccccccccccccccc......dddddddd',
        'cccccccc..............dddddddd',
        'cccccccc..............dddddddd',
        'cccccccc..............dddddddd',
        'cccccccc..............dddddddd',
        'cccccccc..............dddddddd',
        'cccccccc..............dddddddd',
        'cccccccc..............dddddddd'
      ],
      colors: {'a': '#fd897c', 'b': '#e38e89', 'c': '#4798c2', 'd': '#fecc48'}
    },
    // Claude Code: the author's own 8-bit art, on a 30x30 grid of 1px pixels.
    claude: {
      rows: [
        '..............................',
        '..............................',
        '..............................',
        '..............................',
        '..............................',
        '..............................',
        '.....aaaaaaaaaaaaaaaaaaaab....',
        '...bbaaaaaaaaaaaaaaaaaaaabb...',
        '...aaaaaaaaaaaaaaaaaaaaaaaa...',
        '...aaaacdcaaaaaaaaaacdcaaaa...',
        '...aaaaddcaaaaaaaaaaddcaaaa...',
        '...aaaaddcaaaaaaaaaaddcaaaa...',
        '...aaaaddcaaaaaaaaaaddcaaaa...',
        'bbbaaaabcbaaaaaaaaaabcbaaaabbb',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaab',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaab',
        'bbbaaaaaaaaaaaaaaaaaaaaaaaabbb',
        '...aaaaaaaaaaaaaaaaaaaaaaaa...',
        '...aaaaaaaaaaaaaaaaaaaaaaaa...',
        '...aaaaaaaaaaaaaaaaaaaaaaaa...',
        '...bbaabbaabbbbbbbaaabbaabb...',
        '.....aa..aab......bab..aa.....',
        '.....aa..aab......baa..aa.....',
        '.....aa..aab......bab..aa.....',
        '..............................',
        '..............................',
        '..............................',
        '..............................',
        '..............................',
        '..............................'
      ],
      colors: {'a': '#e86d44', 'b': '#e9744c', 'c': '#ef9b7e', 'd': '#f9dcd2'}
    },
    // Codex: the author's own 8-bit art, on a 30x30 grid of 1px pixels.
    codex: {
      rows: [
        '..............................',
        '.........aaaaaaaa.............',
        '........aaaaaaaaaa............',
        '........aaaaaaaaaaa...........',
        '......aaaaaaaaaaaaaaaaaa......',
        '......aaaaaaaaaaaaaaaaaaa.....',
        '......aaaaaaaaaaaaaaaaaaaa....',
        '......aaaaaaaaaaaaaaaaaaab....',
        '....bbbbbbbbbbbbbbbbbbbbbb....',
        '...bbbbbbbbbbbbbbbbbbbbbbbb...',
        '..cccccbbbcccccccccccccccccc..',
        'cccccccdddcccccccccccccccccc..',
        'cccccccddddccccccccccccccccc..',
        'eeeeeeebdddbceeeeeeeeeeeeeeeee',
        'eeeeeeeeadddaeeeeeeeeeeeeeeeee',
        'fffffffffbddafffffffffffffffff',
        'ffffffffadddaffbbbbbbbcfffffff',
        '..fffffbdddefffddddddddgffffgg',
        '..fffffdddbffffddddddddgggggff',
        '..gggggddagggggffffffffggggg..',
        '..gggggggggggggggggggggggggg..',
        '..gggggggggggggggggggggggggg..',
        '....hhhhhhhhhhhhhhhhhhhhhhg...',
        '....hhhhhhhhhhhhhhhhhhhhhh....',
        '......hhhhhhhhhhhhhhhhhhh.....',
        '......hhhhhhhhhhhhhhhhhhh.....',
        '...........hhhhhhhhhh.........',
        '............hhhhhhhh..........',
        '.............hhhhhh...........',
        '..............................'
      ],
      colors: {'a': '#947ffb', 'b': '#7d79fc', 'c': '#6e6efc', 'd': '#eef0fe', 'e': '#5b64fc', 'f': '#485afc', 'g': '#334cfc', 'h': '#1e3afc'}
    },
    // Orca (rare bonus): the author's own 8-bit art, on a 30x30 grid of 1px pixels.
    orca: {
      rows: [
        'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
        'raaaaaaaaaaaaaaaaaaaaaaaaaaaar',
        'raaaaaaaaaaaaaaaaaaaaaaaaaaaar',
        'raaaaaaaaaaaaaaaaaaaaaaaaaaaar',
        'raaaaaaaaaaaaaaaaaaaaaaaaaaaar',
        'raaaaaaaaaaaaaaaaaaaaaaaaaaaar',
        'raaaaaaaaaaaaaaaabcaaaaaaaaaar',
        'raaaaaaaaaaaaaaaabcaacdbaaaaar',
        'raaaaaaaaaaaaaaaadaadeedaaaaar',
        'raaaaaaaaaaaaaaaadaabbbaaaaaar',
        'raaaaaaaaaaaaaaacaaaaabbdeeear',
        'raaaaaaaaaaaaaaadaaabbeeeeecar',
        'raaaaaaaaaaaaaaadaabdeeeecbaar',
        'raaaaaaaaaaaaaadaabdeedbbaaaar',
        'raaaaaaaaaaaaaadabdeebbaaaaaar',
        'raaaaaaaaaaaaacbaceebaaaaaaaar',
        'raaaaaaaaaaaabeabdebaaaaaaaaar',
        'raaaabbaaaabbecabecaaaaaaaaaar',
        'raabceecbbbeedbbecaaaaaaaaaaar',
        'raceeeeeeeeecbabebaaaaaaaaaaar',
        'raccccccccccaaadcaaaaaaaaaaaar',
        'raaaaaaaaaaaaaaebaaaaaaaaaaaar',
        'raaaaaaaaaaaaabdaaaaaaaaaaaaar',
        'raaaaaaaaaaaaaeaaaaaaaaaaaaaar',
        'raaaaaaaaaaaaabaaaaaaaaaaaaaar',
        'raaaaaaaaaaaaaaaaaaaaaaaaaaaar',
        'raaaaaaaaaaaaaaaaaaaaaaaaaaaar',
        'raaaaaaaaaaaaaaaaaaaaaaaaaaaar',
        'raaaaaaaaaaaaaaaaaaaaaaaaaaaar',
        'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrr'
      ],
      colors: {'a': '#0c0b0d', 'b': '#6b6b6c', 'c': '#a9a8a9', 'd': '#dddcdd', 'e': '#fcfbfc', 'r': '#8fc4e6'}
    }
  };
  // The bug is a hazard. Two frames alternate so it visibly crawls.
  const BUG_FRAMES = [
    [
      '..l....l..',
      '...l..l...',
      '...kkkk...',
      '.lrrkkrrl.',
      '.rrrkkrrr.',
      'lrkrkkrkrl',
      '.rrrkkrrr.',
      '.lrrkkrrl.',
      '...rkkr...',
      '....rr....'
    ],
    [
      '...l..l...',
      '...l..l...',
      '..lkkkkl..',
      '..rrkkrr..',
      'lrrrkkrrrl',
      '.rkrkkrkr.',
      'lrrrkkrrrl',
      '..rrkkrr..',
      '...rkkr...',
      '....rr....'
    ]
  ];
  const BUG_COLORS = { r: '#ef4b57', k: '#4a0d14', l: '#ff8f98' };
  const BUG_FRAME_MS = 280;
  // 3x5 pixel font in the runner's style for the HUD, panels and effect labels.
  const FONT = {
    '0': ['###', '#.#', '#.#', '#.#', '###'], '1': ['.#.', '##.', '.#.', '.#.', '###'],
    '2': ['###', '..#', '###', '#..', '###'], '3': ['###', '..#', '.##', '..#', '###'],
    '4': ['#.#', '#.#', '###', '..#', '..#'], '5': ['###', '#..', '###', '..#', '###'],
    '6': ['###', '#..', '###', '#.#', '###'], '7': ['###', '..#', '..#', '.#.', '.#.'],
    '8': ['###', '#.#', '###', '#.#', '###'], '9': ['###', '#.#', '###', '..#', '###'],
    ' ': ['..', '..', '..', '..', '..'],
    A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'],
    C: ['.##', '#..', '#..', '#..', '.##'], D: ['##.', '#.#', '#.#', '#.#', '##.'],
    E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'],
    G: ['.##.', '#...', '#.##', '#..#', '.##.'], H: ['#.#', '#.#', '###', '#.#', '#.#'],
    I: ['###', '.#.', '.#.', '.#.', '###'], J: ['..#', '..#', '..#', '#.#', '.#.'],
    K: ['#.#', '#.#', '##.', '#.#', '#.#'], L: ['#..', '#..', '#..', '#..', '###'],
    M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'], N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
    O: ['.##.', '#..#', '#..#', '#..#', '.##.'], P: ['##.', '#.#', '##.', '#..', '#..'],
    Q: ['.##.', '#..#', '#..#', '#.##', '.###'], R: ['##.', '#.#', '##.', '#.#', '#.#'],
    S: ['.##', '#..', '.#.', '..#', '##.'], T: ['###', '.#.', '.#.', '.#.', '.#.'],
    U: ['#.#', '#.#', '#.#', '#.#', '###'], V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
    W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'], X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
    Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], Z: ['###', '..#', '.#.', '#..', '###'],
    '+': ['...', '.#.', '###', '.#.', '...'], '-': ['...', '...', '###', '...', '...'],
    '!': ['#', '#', '#', '.', '#'], '.': ['.', '.', '.', '.', '#']
  };

  function hexToRgb(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  function mixHex(from, to, amount) {
    const a = hexToRgb(from);
    const b = hexToRgb(to);
    const channel = function (index) { return Math.round(a[index] + (b[index] - a[index]) * amount); };
    return 'rgb(' + channel(0) + ', ' + channel(1) + ', ' + channel(2) + ')';
  }

  // Shallow water at the top of the board, deeper water at the bottom. Each row keeps a two tone
  // checker so players can still read single cells.
  function waterRows(shallowA, shallowB, deepA, deepB) {
    const rows = [];
    for (let y = 0; y < ROWS; y += 1) {
      const amount = y / (ROWS - 1);
      rows.push([mixHex(shallowA, deepA, amount), mixHex(shallowB, deepB, amount)]);
    }
    return rows;
  }

  // Light and dark are the only themes. Both keep the water calm so the snake reads clearly.
  const PALETTES = {
    light: {
      water: waterRows('#c5e9f8', '#b8e1f4', '#78bde3', '#6cb2da'),
      crest: 'rgba(255, 255, 255, 0.55)',
      sky: '#e6f6fe',
      skyLine: '#8fd0ee',
      ink: '#10273b',
      shadow: '#ffffff',
      scrim: 'rgba(12, 44, 70, 0.55)',
      panel: '#f4fbff',
      danger: '#d92d3a',
      bodyA: '#2fa84f',
      bodyB: '#238a3f',
      bodyDark: '#176b2e',
      head: '#58d27a'
    },
    dark: {
      water: waterRows('#14405c', '#113a54', '#06182a', '#05141f'),
      crest: 'rgba(150, 215, 255, 0.2)',
      sky: '#071723',
      skyLine: '#1d5f87',
      ink: '#eaf6fc',
      shadow: '#03101a',
      scrim: 'rgba(2, 10, 18, 0.62)',
      panel: '#0c2233',
      danger: '#ff6b76',
      bodyA: '#54cf74',
      bodyB: '#3aa85a',
      bodyDark: '#2a8546',
      head: '#8cf0a8'
    }
  };
  const CAUSE_TEXT = {
    wall: 'YOU HIT THE WALL',
    body: 'YOU BIT YOUR OWN TAIL',
    full: 'YOU FILLED THE OCEAN'
  };
  // Fixed wave crests, spread over the board. They drift sideways with the frame clock.
  const CRESTS = (function () {
    const list = [];
    for (let index = 0; index < 18; index += 1) {
      list.push({
        x: (index * 167 + (index % 3) * 41) % BOARD_W,
        y: ((index * 7 + 3) % ROWS) * CELL + 9 + (index % 2) * 9
      });
    }
    return list;
  })();
  const CREST_UNIT = 6;
  const TURN_STEPS = { right: 0, down: 1, left: 2, up: 3 };

  function rotateClockwise(rows) {
    const size = rows.length;
    return rows.map(function (unused, y) {
      let line = '';
      for (let x = 0; x < size; x += 1) line += rows[size - 1 - x][y];
      return line;
    });
  }

  // The head art faces right; rotate it in 90 degree steps for the other directions.
  function orient(rows, direction) {
    let grid = rows;
    const steps = TURN_STEPS[direction] || 0;
    for (let step = 0; step < steps; step += 1) grid = rotateClockwise(grid);
    return grid;
  }

  window.createSnakAIRenderer = function (canvas) {
    const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) throw new Error('snakAI needs a 2D canvas.');
    ctx.imageSmoothingEnabled = false;

    const hooks = Object.create(null);
    let theme = 'light';
    let palette = PALETTES.light;
    let previous = null;
    let busy = false;
    let destroyed = false;

    function fillCell(view, x, y, color) {
      view.ctx.fillStyle = color;
      view.ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }

    // Each grid pixel is CELL / grid size wide: 3px for 10x10 sprites, 1px for 30x30 ones.
    // Fine grids merge a run of equal pixels into one rectangle to keep the per-frame work small.
    function drawSprite(view, grid, colors, cellX, cellY) {
      const unit = CELL / grid.length;
      const merge = unit < 3;
      for (let row = 0; row < grid.length; row += 1) {
        const line = grid[row];
        for (let column = 0; column < line.length; column += 1) {
          const color = colors[line[column]];
          if (!color) continue;
          let length = 1;
          if (merge) {
            while (column + length < line.length && line[column + length] === line[column]) length += 1;
          }
          view.ctx.fillStyle = color;
          view.ctx.fillRect(cellX * CELL + column * unit, cellY * CELL + row * unit, unit * length, unit);
          column += length - 1;
        }
      }
    }

    function drawText(view, text, x, y, color, scale) {
      const unit = ART * (scale || 1);
      let penX = x;
      for (const character of String(text)) {
        const glyph = FONT[character] || FONT[' '];
        for (let row = 0; row < glyph.length; row += 1) {
          const line = glyph[row];
          for (let column = 0; column < line.length; column += 1) {
            if (line[column] !== '#') continue;
            view.ctx.fillStyle = color;
            view.ctx.fillRect(penX + column * unit, y + row * unit, unit, unit);
          }
        }
        penX += (glyph[0].length + 1) * unit;
      }
    }

    function textWidth(text, scale) {
      const unit = ART * (scale || 1);
      let width = 0;
      for (const character of String(text)) width += ((FONT[character] || FONT[' '])[0].length + 1) * unit;
      return width - unit;
    }

    function shadowed(view, text, x, y, color, scale) {
      drawText(view, text, x + ART, y + ART, view.palette.shadow, scale);
      drawText(view, text, x, y, color, scale);
    }

    function drawBoard(view) {
      const water = view.palette.water;
      for (let y = 0; y < ROWS; y += 1) {
        for (let x = 0; x < COLUMNS; x += 1) {
          fillCell(view, x, y, water[y][(x + y) % 2]);
        }
      }
      // Slow drifting wave crests: a little ripple shape, snapped to the sprite pixel grid.
      const ctx2 = view.ctx;
      const drift = Math.floor(Math.max(0, view.now) / 600) * CREST_UNIT;
      const span = BOARD_W + 4 * CREST_UNIT * 2;
      ctx2.fillStyle = view.palette.crest;
      for (let index = 0; index < CRESTS.length; index += 1) {
        const crest = CRESTS[index];
        const x = ((crest.x + drift) % span) - 4 * CREST_UNIT;
        ctx2.fillRect(x + CREST_UNIT, crest.y, 2 * CREST_UNIT, CREST_UNIT);
        ctx2.fillRect(x, crest.y + CREST_UNIT, CREST_UNIT, CREST_UNIT);
        ctx2.fillRect(x + 3 * CREST_UNIT, crest.y + CREST_UNIT, CREST_UNIT, CREST_UNIT);
      }
    }

    function drawPickup(view) {
      const pickup = view.snapshot.pickup;
      if (!pickup) return;
      const art = PICKUP_ART[pickup.kind] || PICKUP_ART.pi;
      drawSprite(view, art.rows, art.colors, pickup.x, pickup.y);
    }

    function drawBug(view) {
      const bug = view.snapshot.bug;
      if (!bug) return;
      const frame = BUG_FRAMES[Math.floor(Math.max(0, view.now) / BUG_FRAME_MS) % BUG_FRAMES.length];
      drawSprite(view, frame, BUG_COLORS, bug.x, bug.y);
    }

    function drawSnake(view) {
      const snake = view.snapshot.snake || [];
      for (let index = snake.length - 1; index >= 1; index -= 1) {
        const segment = snake[index];
        drawSprite(view, BODY_ART, {
          g: index % 2 === 0 ? view.palette.bodyA : view.palette.bodyB,
          h: view.palette.head,
          d: view.palette.bodyDark
        }, segment.x, segment.y);
      }
      if (!snake.length) return;
      const head = snake[0];
      drawSprite(view, orient(HEAD_ART, view.snapshot.direction), {
        g: view.palette.head,
        w: '#f2fbff',
        k: '#10273b'
      }, head.x, head.y);
    }

    // The score strip is the water surface above the board, so no pickup or panel can hide it.
    function drawHud(view) {
      const palette2 = view.palette;
      view.ctx.fillStyle = palette2.sky;
      view.ctx.fillRect(0, 0, BOARD_W, HUD_H);
      view.ctx.fillStyle = palette2.skyLine;
      view.ctx.fillRect(0, HUD_H - ART, BOARD_W, ART);
      const shift = (Math.floor(Math.max(0, view.now) / 250) * ART) % (8 * ART);
      for (let x = -8 * ART + shift; x < BOARD_W; x += 8 * ART) {
        view.ctx.fillRect(x, HUD_H - 2 * ART, 4 * ART, ART);
      }
      const scoreText = 'SCORE ' + String(view.snapshot.score).padStart(4, '0');
      const bestText = 'BEST ' + String(view.snapshot.best).padStart(4, '0');
      const top = 3 * ART;
      shadowed(view, scoreText, 3 * ART, top, palette2.ink, 1);
      shadowed(view, bestText, BOARD_W - 3 * ART - textWidth(bestText, 1), top, palette2.ink, 1);
    }

    function drawOverlay(view) {
      const snapshot = view.snapshot;
      const palette2 = view.palette;
      const centerX = BOARD_W / 2;
      const centerY = BOARD_H / 2;

      function centered(text, y, color, scale) {
        shadowed(view, text, Math.round(centerX - textWidth(text, scale) / 2), y, color, scale);
      }

      if (snapshot.phase !== 'paused' && snapshot.phase !== 'gameover') return;
      view.ctx.save();
      // Overlays are laid out in board coordinates, below the score strip.
      view.ctx.translate(0, HUD_H);

      view.ctx.fillStyle = palette2.scrim;
      view.ctx.fillRect(0, 0, BOARD_W, BOARD_H);

      if (snapshot.phase === 'paused') {
        centered('PAUSED', Math.round(centerY - 50), '#ffffff', 2);
        centered('PRESS SPACE', Math.round(centerY + 20), '#ffffff', 1);
        view.ctx.restore();
        return;
      }

      // Game over: a bordered panel with the title, why it ended, the score and how to retry.
      const won = snapshot.result === 'won';
      const panelWidth = 560;
      const panelHeight = 260;
      const left = Math.round(centerX - panelWidth / 2);
      const top = Math.round(centerY - panelHeight / 2);
      view.ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      view.ctx.fillRect(left + ART, top + ART, panelWidth, panelHeight);
      view.ctx.fillStyle = palette2.ink;
      view.ctx.fillRect(left, top, panelWidth, panelHeight);
      view.ctx.fillStyle = palette2.panel;
      view.ctx.fillRect(left + ART, top + ART, panelWidth - 2 * ART, panelHeight - 2 * ART);

      let y = top + 3 * ART;
      centered(won ? 'WELL DONE' : 'GAME OVER', y, won ? palette2.bodyA : palette2.danger, 2);
      y += 10 * ART + 4 * ART;
      const reason = CAUSE_TEXT[snapshot.cause] || '';
      if (reason) centered(reason, y, palette2.ink, 1);
      y += 5 * ART + 3 * ART;
      centered('SCORE ' + String(snapshot.score).padStart(4, '0'), y, palette2.ink, 1);
      y += 5 * ART + 2 * ART;
      if (snapshot.score === snapshot.best && snapshot.score > 0) {
        centered('NEW BEST!', y, palette2.bodyA, 1);
      } else {
        centered('BEST ' + String(snapshot.best).padStart(4, '0'), y, palette2.ink, 1);
      }
      centered('PRESS SPACE TO RETRY', top + panelHeight - 3 * ART - 5 * ART, palette2.ink, 1);
      view.ctx.restore();
    }

    // Drawn on the water, under the pickup and the snake, so the first pickup is never hidden by it.
    function drawReadyPrompt(view) {
      if (view.snapshot.phase !== 'ready') return;
      const text = 'PRESS SPACE TO START';
      // Above the starting snake, which sits in the middle row.
      shadowed(view, text, Math.round((BOARD_W - textWidth(text, 1)) / 2), Math.round(BOARD_H * 0.28), view.palette.ink, 1);
    }

    function runHooks(slot, view) {
      const list = hooks[slot];
      if (!list || !list.length) return false;
      let animating = false;
      for (let index = 0; index < list.length; index += 1) {
        if (list[index](view)) animating = true;
      }
      return animating;
    }

    function makeView(snapshot, at) {
      return {
        ctx: ctx,
        snapshot: snapshot,
        previous: previous,
        now: at,
        theme: theme,
        palette: palette,
        COLS: COLUMNS,
        ROWS: ROWS,
        CELL: CELL,
        ART: ART,
        TOP: HUD_H,
        drawSprite: drawSprite,
        drawText: drawText,
        fillCell: fillCell
      };
    }

    return {
      render: function (snapshot, at) {
        if (destroyed || !snapshot) return;
        const view = makeView(snapshot, at);
        busy = false;
        view.ctx.save();
        // The shake translates here, before the board moves below the strip.
        if (runHooks('beforeScene', view)) busy = true;
        view.ctx.translate(0, HUD_H);
        drawBoard(view);
        drawReadyPrompt(view);
        if (runHooks('afterBoard', view)) busy = true;
        drawPickup(view);
        drawBug(view);
        if (runHooks('afterPickup', view)) busy = true;
        drawSnake(view);
        if (runHooks('afterSnake', view)) busy = true;
        view.ctx.restore();
        drawHud(view);
        if (runHooks('afterHud', view)) busy = true;
        drawOverlay(view);
        if (runHooks('afterOverlay', view)) busy = true;
        previous = snapshot;
      },
      setTheme: function (name) {
        theme = name === 'dark' ? 'dark' : 'light';
        palette = PALETTES[theme];
      },
      addHook: function (slot, fn) {
        if (destroyed || typeof slot !== 'string' || typeof fn !== 'function') return;
        if (!hooks[slot]) hooks[slot] = [];
        hooks[slot].push(fn);
      },
      isBusy: function () {
        return busy && !destroyed;
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        busy = false;
        previous = null;
        for (const slot of Object.keys(hooks)) delete hooks[slot];
      }
    };
  };

  // ---- OSN-5 effects -----------------------------------------------------------------------
  // Copy and colours per pickup; effects only read rendered snapshots, so the core stays untouched.
  const EFFECT_KINDS = {
    pi: { text: '+10 PI', primary: '#ff8a7e', secondary: '#4798c2' },
    claude: { text: '+25 CLAUDE', primary: '#f39a4c', secondary: '#ffd86b' },
    codex: { text: '+50 CODEX', primary: '#6b7bff', secondary: '#6b7bff' },
    orca: { text: '+100 ORCA', primary: '#ffffff', secondary: '#8fc4e6' },
    bug: { text: '-' + BUG_PENALTY + ' BUG', primary: '#ff5d6c', secondary: '#ffb3ba' },
    block: { text: 'SQUASHED', primary: '#6b7bff', secondary: '#dfe3ff' }
  };
  const SCORE_KINDS = { 10: 'pi', 25: 'claude', 50: 'codex', 100: 'orca' };
  const LABEL_MS = 800;
  const LABEL_BLINK_MS = 200;
  const BURST_MS = 450;
  const FLASH_MS = 140;
  const SHAKE_MS = 400;
  const MAX_LABELS = 4;
  const MAX_PARTICLES = 32;
  const MAX_FLASHES = 8;
  const BURST_DIRECTIONS = [
    { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
    { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }
  ];
  const BOOST_COLOR = '#f39a4c';
  const SHIELD_COLOR = '#6b7bff';

  // The renderer keeps its width helper private, so measure the same way its drawText lays out.
  function artTextWidth(text, scale) {
    const unit = ART * (scale || 1);
    let width = 0;
    for (const character of String(text)) width += ((FONT[character] || FONT[' '])[0].length + 1) * unit;
    return width - unit;
  }

  // Effects age from the frame clock; a render before the effect started counts as age 0.
  function effectAge(effect, at) {
    return Math.max(0, at - effect.at);
  }

  // Blink off on alternating slices near the end of an effect's life.
  function effectVisible(age, duration, blinkFrom, slice) {
    if (age >= duration) return false;
    if (age < blinkFrom) return true;
    return Math.floor((age - blinkFrom) / slice) % 2 === 0;
  }

  function prefersReducedMotion() {
    try {
      const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      return Boolean(query && query.matches);
    } catch (error) {
      return false;
    }
  }

  // Registers three render hooks. Idle hooks draw nothing and return false, so OSN-3 is unaffected.
  window.installSnakAIEffects = function (renderer) {
    if (!renderer || typeof renderer.addHook !== 'function') {
      throw new Error('snakAI effects need a renderer.');
    }

    let labels = [];
    let particles = [];
    let flashes = [];
    let shake = null;
    let destroyed = false;

    function clear() {
      labels = [];
      particles = [];
      flashes = [];
      shake = null;
    }

    function hasEffects() {
      return labels.length > 0 || particles.length > 0 || flashes.length > 0 || shake !== null;
    }

    function prune(at) {
      labels = labels.filter(function (label) { return effectAge(label, at) < LABEL_MS; });
      particles = particles.filter(function (particle) { return effectAge(particle, at) < BURST_MS; });
      flashes = flashes.filter(function (flash) { return effectAge(flash, at) < FLASH_MS; });
      if (shake !== null && effectAge(shake, at) >= SHAKE_MS) shake = null;
    }

    function addPickupEffects(view, kind) {
      const head = view.snapshot.snake && view.snapshot.snake[0];
      if (!head) return;
      const art = EFFECT_KINDS[kind];
      labels.push({ kind: kind, x: head.x, y: head.y, at: view.now });
      while (labels.length > MAX_LABELS) labels.shift();
      flashes.push({ x: head.x, y: head.y, at: view.now });
      while (flashes.length > MAX_FLASHES) flashes.shift();
      const centerX = head.x * view.CELL + view.CELL / 2;
      const centerY = head.y * view.CELL + view.CELL / 2;
      for (let index = 0; index < BURST_DIRECTIONS.length; index += 1) {
        const direction = BURST_DIRECTIONS[index];
        particles.push({
          x: centerX,
          y: centerY,
          dx: direction.x,
          dy: direction.y,
          color: index % 2 === 0 ? art.primary : art.secondary,
          at: view.now
        });
      }
      while (particles.length > MAX_PARTICLES) particles.shift();
    }

    // Compare consecutive snapshots, so a re-render cannot spawn a second set of effects.
    function detect(view) {
      const previous = view.previous;
      const snapshot = view.snapshot;
      if (!previous || !snapshot) return;
      const bugHit = (snapshot.bugHits || 0) > (previous.bugHits || 0);
      const bugBlocked = (snapshot.bugBlocks || 0) > (previous.bugBlocks || 0);
      // A bug lowers the score mid-run, so a drop alone does not mean a restart.
      const restarted = (snapshot.score < previous.score && !bugHit)
        || snapshot.phase === 'ready'
        || (previous.phase === 'gameover' && snapshot.phase === 'running');
      if (restarted) clear();
      if (snapshot.score > previous.score) {
        const kind = SCORE_KINDS[snapshot.score - previous.score];
        if (kind) addPickupEffects(view, kind);
      }
      if (bugHit) {
        addPickupEffects(view, 'bug');
        if (!prefersReducedMotion()) shake = { at: view.now };
      }
      if (bugBlocked) addPickupEffects(view, 'block');
      if (previous.phase === 'running' && snapshot.phase === 'gameover'
        && snapshot.result === 'lost' && !prefersReducedMotion()) {
        shake = { at: view.now };
      }
    }

    function drawShake(view) {
      if (shake === null) return;
      const age = effectAge(shake, view.now);
      if (age >= SHAKE_MS) return;
      const amplitude = ART * (1 - age / SHAKE_MS);
      // Screen space, so the HUD and overlay drawn after the renderer's restore stay still.
      view.ctx.fillStyle = view.palette.water[Math.floor(view.ROWS / 2)][0];
      view.ctx.fillRect(0, view.TOP, view.COLS * view.CELL, view.ROWS * view.CELL);
      view.ctx.translate(
        Math.round(Math.sin(age * 0.11) * amplitude),
        Math.round(Math.cos(age * 0.17) * amplitude * 0.6)
      );
    }

    function drawFlashAndBurst(view) {
      const ctx = view.ctx;
      ctx.save();
      for (let index = 0; index < flashes.length; index += 1) {
        const flash = flashes[index];
        const age = effectAge(flash, view.now);
        if (age >= FLASH_MS) continue;
        ctx.globalAlpha = 1 - age / FLASH_MS;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(flash.x * view.CELL, flash.y * view.CELL, view.CELL, view.CELL);
      }
      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index];
        const age = effectAge(particle, view.now);
        if (!effectVisible(age, BURST_MS, BURST_MS * 0.7, 50)) continue;
        const progress = age / BURST_MS;
        const distance = 2.2 * view.CELL * (1 - (1 - progress) * (1 - progress));
        ctx.globalAlpha = 1;
        ctx.fillStyle = particle.color;
        ctx.fillRect(
          Math.round(particle.x + particle.dx * distance - ART / 2),
          Math.round(particle.y + particle.dy * distance - ART / 2),
          ART,
          ART
        );
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    function drawShieldOutline(view) {
      const snapshot = view.snapshot;
      if (snapshot.phase !== 'running') return;
      if (!(snapshot.shieldUntil > view.now)) return;
      const head = snapshot.snake && snapshot.snake[0];
      if (!head) return;
      if (snapshot.shieldUntil - view.now <= 1000 && Math.floor(view.now / 150) % 2 === 1) return;
      const ctx = view.ctx;
      const left = head.x * view.CELL;
      const top = head.y * view.CELL;
      ctx.save();
      ctx.fillStyle = SHIELD_COLOR;
      ctx.fillRect(left, top, view.CELL, ART);
      ctx.fillRect(left, top + view.CELL - ART, view.CELL, ART);
      ctx.fillRect(left, top, ART, view.CELL);
      ctx.fillRect(left + view.CELL - ART, top, ART, view.CELL);
      ctx.restore();
    }

    function drawBadge(view, badge, x, y) {
      view.drawText(view, badge.text, x + ART, y + ART, view.palette.shadow, 1);
      view.drawText(view, badge.text, x, y, badge.color, 1);
      const width = artTextWidth(badge.text, 1);
      const barTop = y + 5 * ART + ART;
      // The bar track is the strip's own wave colour, so it reads in both themes.
      view.ctx.fillStyle = view.palette.skyLine;
      view.ctx.fillRect(x, barTop, width, ART);
      view.ctx.fillStyle = badge.color;
      view.ctx.fillRect(x, barTop, Math.round(width * Math.min(Math.max(badge.fraction, 0), 1)), ART);
    }

    function drawIndicators(view) {
      const snapshot = view.snapshot;
      // Paused boards shift deadlines on resume, so wall-clock time would be wrong here.
      if (snapshot.phase !== 'running') return;
      const badges = [];
      if (snapshot.boostUntil > view.now) {
        badges.push({ text: 'BOOST', color: BOOST_COLOR, fraction: (snapshot.boostUntil - view.now) / 3000 });
      }
      if (snapshot.shieldUntil > view.now) {
        badges.push({ text: 'SHIELD', color: SHIELD_COLOR, fraction: (snapshot.shieldUntil - view.now) / 5000 });
      }
      if (!badges.length) return;
      const gap = ART * 2;
      let total = gap * (badges.length - 1);
      for (let index = 0; index < badges.length; index += 1) total += artTextWidth(badges[index].text, 1);
      let penX = Math.round((view.COLS * view.CELL - total) / 2);
      for (let index = 0; index < badges.length; index += 1) {
        // Inside the score strip: 25px of text, a 5px gap and a 5px bar, centred above the wave line.
        drawBadge(view, badges[index], penX, 2 * ART);
        penX += artTextWidth(badges[index].text, 1) + gap;
      }
    }

    function drawLabels(view) {
      for (let index = 0; index < labels.length; index += 1) {
        const label = labels[index];
        const age = effectAge(label, view.now);
        if (!effectVisible(age, LABEL_MS, LABEL_MS - LABEL_BLINK_MS, 100)) continue;
        const progress = age / LABEL_MS;
        const kind = EFFECT_KINDS[label.kind];
        const width = artTextWidth(kind.text, 1);
        const left = label.x * view.CELL + view.CELL / 2 - width / 2;
        const x = Math.min(Math.max(Math.round(left), 0), view.COLS * view.CELL - width);
        // Labels live in screen space, below the score strip, and never rise into it.
        const rising = view.TOP + label.y * view.CELL + view.CELL / 2 - (5 * ART) / 2 - view.CELL * progress;
        const y = Math.max(Math.round(rising), view.TOP);
        view.ctx.save();
        view.ctx.globalAlpha = Math.min(1, (1 - progress) * 2);
        view.drawText(view, kind.text, x + ART, y + ART, view.palette.shadow, 1);
        view.drawText(view, kind.text, x, y, kind.primary, 1);
        view.ctx.restore();
      }
    }

    function beforeScene(view) {
      if (destroyed) return false;
      prune(view.now);
      detect(view);
      drawShake(view);
      return hasEffects();
    }

    function afterSnake(view) {
      if (destroyed) return false;
      drawFlashAndBurst(view);
      drawShieldOutline(view);
      return hasEffects();
    }

    function afterHud(view) {
      if (destroyed) return false;
      drawLabels(view);
      drawIndicators(view);
      return hasEffects();
    }

    renderer.addHook('beforeScene', beforeScene);
    renderer.addHook('afterSnake', afterSnake);
    renderer.addHook('afterHud', afterHud);

    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        clear();
      }
    };
  };

  // Canvas game on top of the OSN-2 core: input methods, callbacks and the frame loop.
  window.createSnakAI = function (options) {
    const settings = options || {};
    const onStateChange = typeof settings.onStateChange === 'function' ? settings.onStateChange : function () {};
    const onScore = typeof settings.onScore === 'function' ? settings.onScore : function () {};
    const now = typeof settings.now === 'function' ? settings.now : Date.now;
    const random = typeof settings.random === 'function' ? settings.random : Math.random;

    const renderer = window.createSnakAIRenderer(settings.canvas);
    // OSN-5 effects only add render hooks, so the core and the renderer stay untouched.
    const effects = window.installSnakAIEffects(renderer);
    let core = settings.core;
    if (!core) {
      // An explicit `storage: null` disables persistence; omitting it auto-detects localStorage.
      const hasStorage = Object.prototype.hasOwnProperty.call(settings, 'storage');
      const store = hasStorage
        ? window.createSnakAIBestStore({ storage: settings.storage || null })
        : window.createSnakAIBestStore();
      core = window.createSnakAICore({ now: now, random: random, loadBest: store.loadBest, saveBest: store.saveBest });
    }

    let destroyed = false;
    let frame = null;
    let lastStep = now();
    let lastPhase = null;
    let lastScore = -1;
    let lastBest = -1;

    function cancelFrame() {
      if (frame === null) return;
      window.cancelAnimationFrame(frame);
      frame = null;
    }

    function scheduleFrame() {
      if (destroyed || frame !== null) return;
      frame = window.requestAnimationFrame(onFrame);
    }

    function sync() {
      const snapshot = core.getState();
      if (snapshot.phase !== lastPhase) {
        lastPhase = snapshot.phase;
        onStateChange(snapshot.phase, snapshot);
      }
      if (snapshot.score !== lastScore || snapshot.best !== lastBest) {
        lastScore = snapshot.score;
        lastBest = snapshot.best;
        onScore(snapshot.score, snapshot.best);
      }
      renderer.render(snapshot, now());
      return snapshot;
    }

    function keepFrames() {
      if (destroyed) return;
      if (core.getState().phase === 'running' || renderer.isBusy()) scheduleFrame();
    }

    function onFrame() {
      frame = null;
      if (destroyed) return;
      if (core.getState().phase === 'running') {
        const at = now();
        const tick = core.getTickMs();
        if (at - lastStep >= tick) {
          // After a stall, restart the clock instead of replaying the missed steps.
          if (at - lastStep >= tick * 2) lastStep = at;
          else lastStep += tick;
          core.step();
          sync();
        } else {
          renderer.render(core.getState(), now());
        }
      } else {
        renderer.render(core.getState(), now());
      }
      keepFrames();
    }

    function start() {
      if (destroyed) return;
      if (core.getState().phase === 'gameover') {
        restart();
        return;
      }
      if (core.start()) lastStep = now();
      sync();
      keepFrames();
    }

    function pause() {
      if (destroyed) return;
      if (core.getState().phase !== 'running') return;
      core.pause();
      cancelFrame();
      sync();
      keepFrames();
    }

    function togglePause() {
      if (destroyed) return;
      const phase = core.getState().phase;
      if (phase === 'running') pause();
      else if (phase === 'paused') start();
    }

    function restart() {
      if (destroyed) return;
      core.restart();
      lastStep = now();
      sync();
      keepFrames();
    }

    function queueDirection(direction) {
      if (destroyed) return;
      core.queueDirection(direction);
      sync();
      keepFrames();
    }

    function getState() {
      return core.getState();
    }

    function setTheme(name) {
      if (destroyed) return;
      renderer.setTheme(name);
      renderer.render(core.getState(), now());
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelFrame();
      effects.destroy();
      renderer.destroy();
    }

    sync();
    keepFrames();

    return {
      start: start,
      pause: pause,
      togglePause: togglePause,
      restart: restart,
      queueDirection: queueDirection,
      getState: getState,
      setTheme: setTheme,
      destroy: destroy
    };
  };
})();
