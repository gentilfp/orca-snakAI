import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8');
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// Sandbox objects carry the VM realm's prototypes, so compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

class FakeElement {}

class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.removed = [];
  }

  addEventListener(type, fn, options) {
    this.listeners.set(type, { fn, options });
  }

  removeEventListener(type, fn) {
    this.removed.push(type);
    const entry = this.listeners.get(type);
    if (entry && (!fn || entry.fn === fn)) this.listeners.delete(type);
  }

  fire(type, event) {
    const entry = this.listeners.get(type);
    if (!entry) return false;
    entry.fn(event);
    return true;
  }
}

class FakeCanvas extends FakeTarget {
  constructor() {
    super();
    this.focusCalls = [];
  }

  focus(options) {
    this.focusCalls.push(options);
  }
}

class FakeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = null;
    this.disconnected = false;
    FakeObserver.instances.push(this);
  }

  observe(target, options) {
    this.observed = { target, options };
  }

  disconnect() {
    this.disconnected = true;
  }

  trigger() {
    this.callback([]);
  }
}
FakeObserver.instances = [];

function createHarness({ prefersDark = false } = {}) {
  FakeObserver.instances = [];
  const document = new FakeTarget();
  const window = new FakeTarget();
  const canvas = new FakeCanvas();
  const media = new FakeTarget();
  const announcement = { textContent: '' };
  const classes = new Set();
  const documentElement = {
    classList: {
      contains: name => classes.has(name)
    }
  };

  document.hidden = false;
  document.documentElement = documentElement;
  document.getElementById = id => {
    if (id === 'game') return canvas;
    if (id === 'announcement') return announcement;
    return null;
  };
  media.matches = prefersDark;
  window.matchMedia = query => {
    assert.equal(query, '(prefers-color-scheme: dark)');
    return media;
  };

  const game = {
    calls: [],
    state: { phase: 'ready', score: 0, best: 0, result: null },
    options: null,
    start() {
      this.calls.push('start');
    },
    pause() {
      this.calls.push('pause');
    },
    togglePause() {
      this.calls.push('togglePause');
    },
    restart() {
      this.calls.push('restart');
    },
    queueDirection(direction) {
      this.calls.push(`queue:${direction}`);
    },
    getState() {
      return this.state;
    },
    setTheme(name) {
      this.calls.push(`theme:${name}`);
    },
    destroy() {
      this.calls.push('destroy');
    }
  };
  window.createOrcaSnake = options => {
    game.options = options;
    return game;
  };

  vm.runInNewContext(source, {
    window,
    document,
    Element: FakeElement,
    MutationObserver: FakeObserver
  });
  const startup = game.calls.slice();
  game.calls.length = 0;

  return {
    document,
    window,
    canvas,
    media,
    announcement,
    classes,
    game,
    startup,
    observer: FakeObserver.instances[0],
    key(overrides = {}) {
      return Object.assign({
        code: 'ArrowUp',
        key: 'ArrowUp',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        repeat: false,
        target: {},
        prevented: false,
        preventDefault() {
          this.prevented = true;
        }
      }, overrides);
    }
  };
}

test('each arrow and WASD key queues its direction', () => {
  const harness = createHarness();
  harness.game.state.phase = 'running';
  const mapping = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right'
  };
  for (const [code, direction] of Object.entries(mapping)) {
    const event = harness.key({ code, key: '' });
    harness.document.fire('keydown', event);
    assert.deepEqual(harness.game.calls.at(-1), `queue:${direction}`, `${code} queues ${direction}`);
    assert.equal(event.prevented, true);
  }
  assert.equal(harness.game.calls.length, Object.keys(mapping).length);
});

test('a direction key on a ready board starts before queuing', () => {
  const harness = createHarness();
  harness.game.state.phase = 'ready';
  harness.document.fire('keydown', harness.key({ code: 'ArrowLeft', key: 'ArrowLeft' }));
  assert.deepEqual(harness.game.calls, ['start', 'queue:left']);
});

test('space starts, resumes and restarts, and does nothing while running', () => {
  for (const [phase, expected] of [['ready', ['start']], ['paused', ['start']], ['gameover', ['restart']], ['running', []]]) {
    const harness = createHarness();
    harness.game.state.phase = phase;
    const event = harness.key({ code: 'Space', key: ' ' });
    harness.document.fire('keydown', event);
    assert.deepEqual(harness.game.calls, expected, `Space in ${phase}`);
    assert.equal(event.prevented, true);
  }
  // Synthesized events without a code still map from key.
  const fallback = createHarness();
  fallback.game.state.phase = 'ready';
  fallback.document.fire('keydown', fallback.key({ code: undefined, key: ' ' }));
  assert.deepEqual(fallback.game.calls, ['start']);
});

test('P and Escape toggle only in running and paused', () => {
  for (const code of ['KeyP', 'Escape']) {
    for (const phase of ['running', 'paused']) {
      const harness = createHarness();
      harness.game.state.phase = phase;
      const event = harness.key({ code, key: code });
      harness.document.fire('keydown', event);
      assert.deepEqual(harness.game.calls, ['togglePause'], `${code} in ${phase}`);
      assert.equal(event.prevented, true);
    }
    for (const phase of ['ready', 'gameover']) {
      const harness = createHarness();
      harness.game.state.phase = phase;
      const event = harness.key({ code, key: code });
      harness.document.fire('keydown', event);
      assert.deepEqual(harness.game.calls, [], `${code} in ${phase}`);
      assert.equal(event.prevented, true);
    }
  }
});

test('modifier keys and form fields are ignored without preventing the default', () => {
  for (const flag of ['metaKey', 'ctrlKey', 'altKey']) {
    const harness = createHarness();
    harness.game.state.phase = 'running';
    const event = harness.key({ [flag]: true });
    harness.document.fire('keydown', event);
    assert.deepEqual(harness.game.calls, [], `${flag} skips the game`);
    assert.equal(event.prevented, false);
  }

  const harness = createHarness();
  harness.game.state.phase = 'running';
  const input = new FakeElement();
  input.closest = () => input;
  const event = harness.key({ target: input });
  harness.document.fire('keydown', event);
  assert.deepEqual(harness.game.calls, []);
  assert.equal(event.prevented, false);
});

test('repeated keydowns are ignored', () => {
  const harness = createHarness();
  harness.game.state.phase = 'running';
  for (const code of ['ArrowUp', 'Space', 'KeyP']) {
    const event = harness.key({ code, repeat: true });
    harness.document.fire('keydown', event);
    assert.deepEqual(harness.game.calls, [], `${code} repeat does nothing`);
    assert.equal(event.prevented, true);
  }
});

test('a pointerdown focuses the canvas and runs the Space action', () => {
  const harness = createHarness();
  harness.game.state.phase = 'ready';
  const event = harness.key({ code: undefined, key: undefined, button: 0 });
  harness.canvas.fire('pointerdown', event);
  assert.deepEqual(harness.game.calls, ['start']);
  assert.deepEqual(plain(harness.canvas.focusCalls), [{ preventScroll: true }]);

  harness.game.state.phase = 'paused';
  harness.canvas.fire('pointerdown', harness.key({ button: 0 }));
  assert.deepEqual(harness.game.calls, ['start', 'start']);
});

test('blur and a hidden page pause the game', () => {
  const harness = createHarness();
  harness.window.fire('blur', {});
  assert.deepEqual(harness.game.calls, ['pause']);
  harness.document.hidden = true;
  harness.document.fire('visibilitychange', {});
  assert.deepEqual(harness.game.calls, ['pause', 'pause']);
  harness.document.hidden = false;
  harness.document.fire('visibilitychange', {});
  assert.deepEqual(harness.game.calls, ['pause', 'pause']);
});

test('pagehide removes every listener, disconnects the observer and destroys once', () => {
  const harness = createHarness();
  const pagehide = harness.window.listeners.get('pagehide');
  assert.ok(pagehide, 'pagehide is registered');
  assert.deepEqual(plain(pagehide.options), { once: true });
  assert.ok(harness.observer, 'theme observer is created');
  assert.deepEqual(plain(harness.observer.observed.options), { attributes: true, attributeFilter: ['class', 'style'] });
  assert.equal(harness.observer.observed.target, harness.document.documentElement);

  harness.window.fire('pagehide', {});
  assert.deepEqual(harness.document.removed.sort(), ['keydown', 'visibilitychange']);
  assert.deepEqual(harness.window.removed, ['blur']);
  assert.deepEqual(harness.canvas.removed, ['pointerdown']);
  assert.deepEqual(harness.media.removed, ['change']);
  assert.equal(harness.observer.disconnected, true);
  assert.equal(harness.game.calls.filter(call => call === 'destroy').length, 1);

  harness.window.fire('pagehide', {});
  assert.equal(harness.game.calls.filter(call => call === 'destroy').length, 1, 'a second pagehide is harmless');
});

test('the theme follows the root classes and the dark preference', () => {
  const light = createHarness();
  assert.deepEqual(light.startup, ['theme:light']);
  light.classes.add('light');
  light.observer.trigger();
  assert.deepEqual(light.game.calls, ['theme:light']);

  const dark = createHarness();
  assert.deepEqual(dark.startup, ['theme:light']);
  dark.classes.add('dark');
  dark.observer.trigger();
  assert.deepEqual(dark.game.calls, ['theme:dark']);

  const media = createHarness({ prefersDark: true });
  assert.deepEqual(media.startup, ['theme:dark']);
  media.media.matches = false;
  media.media.fire('change', {});
  assert.deepEqual(media.game.calls, ['theme:light']);
});

test('status text describes every phase and the new best', () => {
  const harness = createHarness();
  const { onStateChange, onScore } = harness.game.options;

  onStateChange('ready', { phase: 'ready', score: 0, best: 7, result: null });
  assert.equal(harness.announcement.textContent, 'Ready. Press Space or an arrow key to start. Best 7.');

  onStateChange('running', { phase: 'running', score: 0, best: 7, result: null });
  onScore(10, 10);
  assert.equal(harness.announcement.textContent, 'Playing. Score 10. Best 10.');

  onStateChange('paused', { phase: 'paused', score: 20, best: 20, result: null });
  assert.equal(harness.announcement.textContent, 'Paused. Score 20. Press Space or P to resume.');

  onStateChange('gameover', { phase: 'gameover', score: 30, best: 30, result: 'lost' });
  assert.equal(harness.announcement.textContent, 'Game over. Score 30. New best! Press Space to play again.');

  const modest = createHarness();
  modest.game.options.onStateChange('ready', { score: 0, best: 50, result: null });
  modest.game.options.onStateChange('running', { score: 0, best: 50, result: null });
  modest.game.options.onStateChange('gameover', { score: 50, best: 50, result: 'lost' });
  assert.equal(modest.announcement.textContent, 'Game over. Score 50. Press Space to play again.');

  const won = createHarness();
  won.game.options.onStateChange('running', { score: 0, best: 0, result: null });
  won.game.options.onStateChange('gameover', { score: 40, best: 40, result: 'won' });
  assert.equal(won.announcement.textContent, 'Board full, you win. Score 40. New best! Press Space to play again.');
});

test('panel.html and dev.html expose the canvas and the visible live region', () => {
  const tagFor = (html, id) => {
    const match = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
    return match ? match[0] : '';
  };
  for (const [name, html] of [['src/panel.html', read('src/panel.html')], ['dev.html', read('dev.html')]]) {
    const canvasTag = tagFor(html, 'game');
    assert.match(canvasTag, /tabindex="0"/, `${name} canvas is focusable`);
    const announcementTag = tagFor(html, 'announcement');
    assert.match(announcementTag, /aria-live="polite"/, `${name} announces state`);
    assert.ok(!announcementTag.includes('sr-only'), `${name} announcement is visible`);
  }

  const panel = read('src/panel.html');
  assert.match(panel, /Content-Security-Policy/);

  const dev = read('dev.html');
  assert.ok(dev.indexOf('src/game.js') < dev.indexOf('src/panel.js'), 'dev.html loads game.js first');
  assert.ok(!/content-security-policy/i.test(dev), 'dev.html has no CSP');
  assert.match(dev, /<link rel="stylesheet" href="src\/panel.css">/);
});
