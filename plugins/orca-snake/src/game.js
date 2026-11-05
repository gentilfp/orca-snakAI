/* Orca Snake — original canvas game. Copyright (c) 2026 gentilfp. MIT. */
(function () {
  'use strict';
  // Scaffold only: paints the board and its grid so the panel can be checked in Orca.
  // OSN-2 adds the pure game logic here; OSN-3 adds the renderer and the loop.
  const COLUMNS = 24;
  const ROWS = 16;
  const CELL = 30;
  const BOARD = '#1d6fa5';
  const GRID = '#2a86c0';

  window.createOrcaSnake = function ({ canvas, onStateChange = function () {}, onScore = function () {} }) {
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.fillStyle = BOARD;
    context.fillRect(0, 0, COLUMNS * CELL, ROWS * CELL);
    // A lighter tint on alternating cells keeps the 24x16 grid visible on any panel width.
    context.fillStyle = GRID;
    for (let row = 0; row < ROWS; row += 1) {
      for (let column = (row % 2); column < COLUMNS; column += 2) {
        context.fillRect(column * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
      }
    }
    return { destroy() {} };
  };
})();
