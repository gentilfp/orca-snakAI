(() => {
  'use strict'
  const canvas = document.getElementById('game')
  const announcement = document.getElementById('announcement')
  if (!canvas || !announcement) return

  const TURNS = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right'
  }
  // Some webviews and synthesized key events provide key without a physical code.
  const KEY_CODES = { ' ': 'Space', Spacebar: 'Space', p: 'KeyP', P: 'KeyP' }

  let phase = 'ready'
  let score = 0
  let best = 0
  let outcome = null
  let bestBeforeRun = 0

  function updateStatus() {
    if (phase === 'gameover') {
      const head = outcome === 'won' ? 'Board full, you win.' : 'Game over.'
      const record = score > bestBeforeRun ? ' New best!' : ''
      announcement.textContent = `${head} Score ${score}.${record} Press Space to play again.`
      return
    }
    if (phase === 'running') {
      announcement.textContent = `Playing. Score ${score}. Best ${best}.`
      return
    }
    if (phase === 'paused') {
      announcement.textContent = `Paused. Score ${score}. Press Space or P to resume.`
      return
    }
    announcement.textContent = `Ready. Press Space or an arrow key to start. Best ${best}.`
  }

  const game = window.createOrcaSnake({
    canvas,
    onStateChange(next, snapshot) {
      phase = next
      score = snapshot.score
      best = snapshot.best
      outcome = snapshot.result
      if (next === 'running' && snapshot.score === 0) bestBeforeRun = snapshot.best
      updateStatus()
    },
    onScore(nextScore, nextBest) {
      score = nextScore
      best = nextBest
      updateStatus()
    }
  })

  function isFormField(target) {
    if (!target || typeof Element === 'undefined' || !(target instanceof Element)) return false
    if (typeof target.closest !== 'function') return false
    return Boolean(target.closest('button, input, textarea, select, [contenteditable="true"]'))
  }

  function spaceAction() {
    const current = game.getState().phase
    if (current === 'ready' || current === 'paused') game.start()
    else if (current === 'gameover') game.restart()
  }

  function turnAction(direction) {
    const current = game.getState().phase
    if (current === 'ready') game.start()
    if (current === 'ready' || current === 'running') game.queueDirection(direction)
  }

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (isFormField(event.target)) return
    const code = event.code || KEY_CODES[event.key] || event.key
    if (Object.prototype.hasOwnProperty.call(TURNS, code)) {
      event.preventDefault()
      if (event.repeat) return
      turnAction(TURNS[code])
      return
    }
    if (code === 'Space') {
      event.preventDefault()
      if (event.repeat) return
      spaceAction()
      return
    }
    if (code === 'KeyP' || code === 'Escape') {
      event.preventDefault()
      if (event.repeat) return
      const current = game.getState().phase
      if (current === 'running' || current === 'paused') game.togglePause()
    }
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    if (typeof canvas.focus === 'function') canvas.focus({ preventScroll: true })
    spaceAction()
  }

  function pauseAway() {
    game.pause()
  }

  function onVisibilityChange() {
    if (document.hidden) game.pause()
  }

  const darkQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  function currentTheme() {
    const root = document.documentElement
    const classes = root && root.classList
    if (classes && classes.contains('dark')) return 'dark'
    if (classes && classes.contains('light')) return 'light'
    return darkQuery && darkQuery.matches ? 'dark' : 'light'
  }
  function applyTheme() {
    game.setTheme(currentTheme())
  }

  const themeObserver = typeof MutationObserver === 'function' ? new MutationObserver(applyTheme) : null
  if (themeObserver) {
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  }
  if (darkQuery && typeof darkQuery.addEventListener === 'function') {
    darkQuery.addEventListener('change', applyTheme)
  }

  let tornDown = false
  function teardown() {
    if (tornDown) return
    tornDown = true
    document.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('blur', pauseAway)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    canvas.removeEventListener('pointerdown', onPointerDown)
    if (darkQuery && typeof darkQuery.removeEventListener === 'function') {
      darkQuery.removeEventListener('change', applyTheme)
    }
    if (themeObserver) themeObserver.disconnect()
    game.destroy()
  }

  document.addEventListener('keydown', onKeyDown)
  window.addEventListener('blur', pauseAway)
  document.addEventListener('visibilitychange', onVisibilityChange)
  canvas.addEventListener('pointerdown', onPointerDown)
  if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', teardown, { once: true })
  applyTheme()
})()
