(() => {
  'use strict'
  // Scaffold controller: boots the game module and cleans it up when the panel goes away.
  const canvas = document.getElementById('game')
  const announcement = document.getElementById('announcement')
  const game = window.createOrcaSnake({ canvas })
  announcement.textContent = 'Orca Snake scaffold loaded.'
  window.addEventListener('pagehide', () => { game.destroy() }, { once: true })
})()
