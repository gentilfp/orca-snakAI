// Orca frames accept inline scripts/styles only. Keep the installable entry self-contained.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const html = read('src/panel.html')
  .replace('/* PANEL_STYLES */', () => read('src/panel.css'))
  .replace('/* GAME_ENGINE */', () => read('src/game.js'))
  .replace('/* PANEL_CONTROLLER */', () => read('src/panel.js'))
mkdirSync(new URL('panel/', root), { recursive: true })
writeFileSync(new URL('panel/index.html', root), html)
console.log('Built panel/index.html (self-contained, no runtime dependencies)')
