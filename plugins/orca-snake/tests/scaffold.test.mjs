import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const CSP = "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
const MARKERS = ['/* PANEL_STYLES */', '/* GAME_ENGINE */', '/* PANEL_CONTROLLER */'];

test('manifest describes the sandboxed orca-snake panel', () => {
  const manifest = JSON.parse(read('orca-plugin.json'));
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.id, 'orca-snake');
  assert.equal(manifest.publisher, 'gentilfp');
  assert.equal(manifest.execution, 'sandboxed-ui');
  assert.deepEqual(manifest.capabilities, []);
  const panels = manifest.contributes.panels;
  assert.equal(panels.length, 1);
  assert.equal(panels[0].id, 'snake');
  assert.equal(panels[0].entry, 'panel/index.html');
});

test('scaffold files and build markers exist', () => {
  for (const file of ['LICENSE', 'README.md', 'src/panel.html', 'src/panel.css', 'src/game.js', 'src/panel.js']) {
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} exists`);
  }
  const template = read('src/panel.html');
  for (const marker of MARKERS) assert.ok(template.includes(marker), `${marker} is in src/panel.html`);
  assert.ok(template.includes(CSP), 'inline-only CSP is in src/panel.html');
  assert.ok(!read('src/game.js').includes('</script>'), 'game.js must not close the inline script');
});

test('build inlines styles and scripts into panel/index.html', () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build.mjs', import.meta.url))], {
    encoding: 'utf8'
  });
  assert.match(output, /Built panel\/index\.html/);
  const entry = new URL('../panel/index.html', import.meta.url);
  assert.ok(existsSync(entry), 'panel/index.html was generated');
  const html = readFileSync(entry, 'utf8');
  for (const marker of MARKERS) assert.ok(!html.includes(marker), `${marker} was replaced`);
  assert.ok(html.includes(CSP), 'the CSP survives the build');
  assert.ok(html.includes('createOrcaSnake'), 'the game module is inlined');
  const gameAt = html.indexOf('createOrcaSnake');
  const controllerAt = html.indexOf('announcement.textContent');
  assert.ok(controllerAt > gameAt, 'game.js is inlined before panel.js');
});
