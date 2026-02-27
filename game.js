/* ══════════════════════════════════════════════════════════════════════
   SNAKE — Neon Edition  |  game.js  (optimized)
   ══════════════════════════════════════════════════════════════════════ */

/* ──────────────────────────────────────────────────────────────────────
   Game constants
   ────────────────────────────────────────────────────────────────────── */
const COLS            = 25;     // grid columns
const ROWS            = 25;     // grid rows
const CELL            = 20;     // pixels per cell

// Precomputed layout values — derived once, referenced everywhere
const CELL_HALF   = CELL / 2;          // pixel centre of a cell
const CELL_PAD    = 2;                 // inset padding inside each cell
const CELL_INNER  = CELL - CELL_PAD * 2; // drawable cell dimension

const FOODS_PER_LEVEL = 5;      // normal foods needed to advance one level
const SPEED_STEP_MS   = 6;      // ms removed from tick interval per level
const MIN_INTERVAL    = 45;     // fastest allowed tick interval (ms)
const BONUS_LIFETIME  = 8000;   // bonus food lifetime (ms)
const BONUS_WARN_AT   = 2500;   // bonus starts blinking below this remaining ms
const BONUS_POINTS    = 3;      // base score for eating bonus food
const COMBO_WINDOW_MS = 3000;   // max gap between eats to sustain a combo
const MAX_COMBO       = 8;      // combo multiplier cap
const BONUS_CHANCE    = 0.30;   // probability bonus food spawns after normal eat
const DIR_BUFFER_SIZE = 2;      // max queued direction inputs per tick
const PARTICLE_POOL   = 200;    // fixed particle pool capacity

/* ──────────────────────────────────────────────────────────────────────
   GameState enum
   Replaces the old running / paused boolean pair.
   Valid transitions:  IDLE → PLAYING → PAUSED → PLAYING → OVER → PLAYING
   ────────────────────────────────────────────────────────────────────── */
const STATE = Object.freeze({
  IDLE:    'idle',
  PLAYING: 'playing',
  PAUSED:  'paused',
  OVER:    'over',
});

/* ──────────────────────────────────────────────────────────────────────
   Canvas — main visible surface
   ────────────────────────────────────────────────────────────────────── */
const cvs = document.getElementById('cvs');
const ctx = cvs.getContext('2d');
cvs.width  = COLS * CELL;
cvs.height = ROWS * CELL;

/* ──────────────────────────────────────────────────────────────────────
   Offscreen grid canvas
   The dot background never changes, so it is rendered once here and then
   blitted with a single drawImage() call instead of 625 fillRect()s.
   ────────────────────────────────────────────────────────────────────── */
const gridCanvas = document.createElement('canvas');
gridCanvas.width  = cvs.width;
gridCanvas.height = cvs.height;

(function buildGridCache() {
  const gc = gridCanvas.getContext('2d');
  gc.fillStyle = '#050810';
  gc.fillRect(0, 0, gridCanvas.width, gridCanvas.height);
  gc.fillStyle = '#0d1220';
  for (let x = 0; x < COLS; x++) {
    for (let y = 0; y < ROWS; y++) {
      gc.fillRect(x * CELL + CELL_HALF - 1, y * CELL + CELL_HALF - 1, 2, 2);
    }
  }
})();

/* ──────────────────────────────────────────────────────────────────────
   Colour palette  (mirrors the CSS variables; used for canvas drawing)
   ────────────────────────────────────────────────────────────────────── */
const COLOR = {
  bg:        '#050810',
  snake:     '#00ff88',
  snakeHead: '#b8ffe0',
  food:      '#ff2d55',
  bonus:     '#ffe600',
};

/* ──────────────────────────────────────────────────────────────────────
   DOM references
   ────────────────────────────────────────────────────────────────────── */
const scoreEl      = document.getElementById('score-display');
const levelEl      = document.getElementById('level-display');
const bestEl       = document.getElementById('best-display');
const comboBadge   = document.getElementById('combo-badge');
const comboCountEl = document.getElementById('combo-count');
const overlay      = document.getElementById('overlay');
const oTitle       = document.getElementById('overlay-title');
const oSub         = document.getElementById('overlay-sub');
const btnStart     = document.getElementById('btn-start');
const arenaEl      = document.getElementById('arena');
const bonusBarWrap = document.getElementById('bonus-bar-wrap');
const bonusFill    = document.getElementById('bonus-fill');
const wrapBtn      = document.getElementById('wrap-btn');

/* ──────────────────────────────────────────────────────────────────────
   Occupancy grid  (O(1) snake-collision detection)
   A flat Uint8Array sized COLS × ROWS.
   Cell index: y * COLS + x.  Value: 1 = snake segment, 0 = empty.
   Maintained incrementally — set when head enters, cleared when tail leaves.
   ────────────────────────────────────────────────────────────────────── */
const occupied = new Uint8Array(COLS * ROWS);

const occupy   = (x, y) => { occupied[y * COLS + x] = 1; };
const vacate   = (x, y) => { occupied[y * COLS + x] = 0; };
const isOccupied = (x, y) => occupied[y * COLS + x] === 1;
const clearOccupied = () => occupied.fill(0);

/* ──────────────────────────────────────────────────────────────────────
   Mutable game state  (reset by init())
   ────────────────────────────────────────────────────────────────────── */
let snake       = [];                 // {x,y} segment array; [0] = head
let dir         = { x: 1, y: 0 };   // current direction vector
let wallWrap    = false;              // true = walls are passable
let dirQueue    = [];                 // buffered direction inputs

let food        = null;               // normal food {x,y}
let bonusFood   = null;               // bonus food {x,y} or null
let bonusTimer  = null;               // setTimeout handle for bonus expiry
let bonusBorn   = 0;                  // performance.now() when bonus spawned

let score       = 0;
let level       = 1;
let foodsEaten  = 0;
let combo       = 0;
let lastEatTime = 0;                  // performance.now() of most recent eat

let baseSpeed   = 100;                // base tick interval (ms); set by speed buttons
let rafId       = null;               // requestAnimationFrame handle
let lastTickAt  = 0;                  // performance.now() of last logic tick
let gameState   = STATE.IDLE;

/* Persistent high score */
let best = parseInt(localStorage.getItem('snakeBest') || '0');
bestEl.textContent = best;

/* ══════════════════════════════════════════════════════════════════════
   AUDIO ENGINE
   Pure Web Audio API synthesis — no external assets.
   AudioContext is created lazily on the first user gesture to satisfy
   the browser autoplay policy.
   ══════════════════════════════════════════════════════════════════════ */
const Audio = (() => {
  let audioCtx = null;

  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  /**
   * Schedule a single synthesised tone.
   * @param {number} freq     Hz
   * @param {string} type     OscillatorType
   * @param {number} duration seconds
   * @param {number} vol      peak gain
   * @param {number} [delay]  seconds before start (for arpeggios)
   */
  function tone(freq, type, duration, vol, delay = 0) {
    const ac = getCtx();
    const osc  = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);

    const t = ac.currentTime + delay;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  return {
    eat()    { tone(380, 'square',   0.07, 0.15); },
    bonus()  { tone(600, 'square',   0.06, 0.15);
               tone(900, 'square',   0.09, 0.12, 0.07); },
    levelUp(){ [330,440,550,660].forEach((f,i) => tone(f, 'sine',     0.13, 0.18, i*0.09)); },
    die()    { [380,290,210,150].forEach((f,i) => tone(f, 'sawtooth', 0.15, 0.22, i*0.12)); },
  };
})();

/* ══════════════════════════════════════════════════════════════════════
   PARTICLE POOL
   Pre-allocated fixed-size pool of particle objects.
   Dead slots are reused in-place — no GC allocations during gameplay.
   Canvas state changes (fillStyle, shadowColor) are batched by color.
   ══════════════════════════════════════════════════════════════════════ */
const particlePool = (() => {
  // Allocate all slots once at startup
  const slots = Array.from({ length: PARTICLE_POOL }, () => ({
    x: 0, y: 0, vx: 0, vy: 0, color: '',
    size: 0, life: 0, decay: 0, alive: false,
  }));

  // Reusable Map for color-grouping during draw (avoids allocation each frame)
  const byColor = new Map();

  /** Activate the next free slot as a new particle; silently drops if pool full. */
  function emit(x, y, color) {
    for (const p of slots) {
      if (p.alive) continue;
      const angle = Math.random() * Math.PI * 2;
      const spd   = Math.random() * 3.2 + 0.8;
      p.x     = x;  p.y     = y;
      p.vx    = Math.cos(angle) * spd;
      p.vy    = Math.sin(angle) * spd;
      p.color = color;
      p.size  = Math.random() * 4 + 1.5;
      p.life  = 1.0;
      p.decay = Math.random() * 0.04 + 0.025;
      p.alive = true;
      return;
    }
  }

  /** Advance physics and draw all live particles, grouped by color. */
  function updateAndDraw() {
    byColor.clear();

    for (const p of slots) {
      if (!p.alive) continue;
      p.x    += p.vx;  p.y  += p.vy;
      p.vx   *= 0.91;  p.vy *= 0.91;  // drag
      p.life -= p.decay;
      if (p.life <= 0) { p.alive = false; continue; }

      if (!byColor.has(p.color)) byColor.set(p.color, []);
      byColor.get(p.color).push(p);
    }

    // One save/restore per color group instead of one per particle
    for (const [color, group] of byColor) {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur  = 8;
      ctx.fillStyle   = color;
      for (const p of group) {
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.restore();
    }
  }

  function reset() { for (const p of slots) p.alive = false; }

  return { emit, updateAndDraw, reset };
})();

/** Emit `count` particles centred on grid cell (gx, gy). */
function spawnParticles(gx, gy, color, count = 14) {
  const cx = gx * CELL + CELL_HALF;
  const cy = gy * CELL + CELL_HALF;
  for (let i = 0; i < count; i++) particlePool.emit(cx, cy, color);
}

/* ══════════════════════════════════════════════════════════════════════
   FLOATING SCORE POPUPS
   Lightweight text labels that drift upward and fade out.
   ══════════════════════════════════════════════════════════════════════ */
const popups = [];

class Popup {
  constructor(x, y, text, color) {
    this.x = x; this.y = y; this.text = text;
    this.color = color; this.alpha = 1.0;
  }
  update() { this.y -= 1.1; this.alpha -= 0.022; }
  draw() {
    if (this.alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.fillStyle   = this.color;
    ctx.shadowColor = this.color;
    ctx.shadowBlur  = 10;
    ctx.font        = 'bold 13px Orbitron, monospace';
    ctx.textAlign   = 'center';
    ctx.fillText(this.text, this.x, this.y);
    ctx.restore();
  }
  get dead() { return this.alpha <= 0; }
}

function spawnPopup(gx, gy, text, color) {
  popups.push(new Popup(gx * CELL + CELL_HALF, gy * CELL, text, color));
}

/* ══════════════════════════════════════════════════════════════════════
   OVERLAY HELPERS
   ══════════════════════════════════════════════════════════════════════ */
function showOverlay(title, htmlSub, btnLabel) {
  oTitle.textContent = title;
  oSub.innerHTML     = htmlSub;
  oSub.style.display = htmlSub ? 'block' : 'none';
  btnStart.querySelector('span').textContent = btnLabel;
  overlay.classList.remove('hidden');
}

function hideOverlay() { overlay.classList.add('hidden'); }

/* ══════════════════════════════════════════════════════════════════════
   FOOD HELPERS
   ══════════════════════════════════════════════════════════════════════ */

/** Find a grid cell not occupied by the snake or existing food. */
function randomEmptyCell() {
  let x, y;
  do {
    x = Math.floor(Math.random() * COLS);
    y = Math.floor(Math.random() * ROWS);
  } while (
    isOccupied(x, y) ||
    (food      && food.x      === x && food.y      === y) ||
    (bonusFood && bonusFood.x === x && bonusFood.y === y)
  );
  return { x, y };
}

function spawnFood() { food = randomEmptyCell(); }

function spawnBonusFood() {
  clearTimeout(bonusTimer);
  bonusFood = randomEmptyCell();
  bonusBorn = performance.now();
  bonusBarWrap.classList.remove('hidden');
  bonusFill.style.width = '100%';
  bonusTimer = setTimeout(expireBonus, BONUS_LIFETIME);
}

function expireBonus() {
  bonusFood = null;
  clearTimeout(bonusTimer);
  bonusBarWrap.classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════════════════
   SPEED CALCULATION
   ══════════════════════════════════════════════════════════════════════ */
function effectiveInterval() {
  return Math.max(MIN_INTERVAL, baseSpeed - (level - 1) * SPEED_STEP_MS);
}

/* ══════════════════════════════════════════════════════════════════════
   INIT / RESTART
   ══════════════════════════════════════════════════════════════════════ */
function init() {
  clearOccupied();

  snake = [
    { x: 13, y: 12 },
    { x: 12, y: 12 },
    { x: 11, y: 12 },
  ];
  snake.forEach(s => occupy(s.x, s.y));

  dir         = { x: 1, y: 0 };
  dirQueue    = [];
  score       = 0;
  level       = 1;
  foodsEaten  = 0;
  combo       = 0;
  lastEatTime = 0;

  scoreEl.textContent = 0;
  levelEl.textContent = 1;
  comboBadge.classList.add('hidden');

  particlePool.reset();
  popups.length = 0;
  expireBonus();
  spawnFood();
  hideOverlay();

  gameState  = STATE.PLAYING;
  lastTickAt = performance.now();

  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(renderLoop);
}

/* ══════════════════════════════════════════════════════════════════════
   UNIFIED rAF RENDER LOOP
   Decouples visual frame rate (~60 fps) from game-logic tick rate.
   A timestamp accumulator fires the game tick when enough time has elapsed,
   while particles and popups are updated every visual frame.
   ══════════════════════════════════════════════════════════════════════ */
function renderLoop(now) {
  rafId = requestAnimationFrame(renderLoop);

  if (gameState === STATE.PLAYING) {
    const interval = effectiveInterval();
    if (now - lastTickAt >= interval) {
      lastTickAt += interval; // fixed step — prevents drift on slow frames
      tick(now);
    }
  }

  draw(now); // always draw to keep effects smooth
}

/* ══════════════════════════════════════════════════════════════════════
   GAME TICK  (logic only, called at configured interval)
   ══════════════════════════════════════════════════════════════════════ */
function tick(now) {
  /* Dequeue the next valid direction; skip any 180° reversal */
  while (dirQueue.length > 0) {
    const candidate = dirQueue.shift();
    if (candidate.x !== -dir.x || candidate.y !== -dir.y) {
      dir = candidate;
      break;
    }
  }

  /* Compute new head position */
  let hx = snake[0].x + dir.x;
  let hy = snake[0].y + dir.y;

  if (wallWrap) {
    hx = (hx + COLS) % COLS;
    hy = (hy + ROWS) % ROWS;
  } else {
    if (hx < 0 || hx >= COLS || hy < 0 || hy >= ROWS) return endGame();
  }

  /* O(1) self-collision check via occupancy grid */
  if (isOccupied(hx, hy)) return endGame();

  /* Advance snake */
  snake.unshift({ x: hx, y: hy });
  occupy(hx, hy);

  let ate = false;

  /* Normal food */
  if (hx === food.x && hy === food.y) {
    ate = true;
    foodsEaten++;
    const pts = computeCombo(1, now);
    addScore(pts, food.x, food.y, COLOR.food);
    spawnParticles(food.x, food.y, COLOR.food, 14);
    Audio.eat();
    spawnFood();
    if (!bonusFood && Math.random() < BONUS_CHANCE) spawnBonusFood();
    handleLevelUp();
  }

  /* Bonus food */
  if (bonusFood && hx === bonusFood.x && hy === bonusFood.y) {
    ate = true;
    const pts = computeCombo(BONUS_POINTS, now);
    addScore(pts, bonusFood.x, bonusFood.y, COLOR.bonus);
    spawnParticles(bonusFood.x, bonusFood.y, COLOR.bonus, 20);
    Audio.bonus();
    expireBonus();
  }

  /* Remove tail when nothing was eaten */
  if (!ate) {
    const tail = snake.pop();
    vacate(tail.x, tail.y);
  }

  /* Sync bonus bar progress */
  if (bonusFood) {
    bonusFill.style.width =
      `${Math.max(0, (1 - (now - bonusBorn) / BONUS_LIFETIME)) * 100}%`;
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Compute combo-adjusted score.  Uses rAF timestamp for consistency.
   ────────────────────────────────────────────────────────────────────── */
function computeCombo(base, now) {
  combo = (now - lastEatTime < COMBO_WINDOW_MS)
    ? Math.min(combo + 1, MAX_COMBO) : 1;
  lastEatTime = now;

  if (combo >= 2) {
    comboCountEl.textContent = combo;
    comboBadge.classList.remove('hidden');
  } else {
    comboBadge.classList.add('hidden');
  }

  return base * combo;
}

/* ──────────────────────────────────────────────────────────────────────
   Add score, animate HUD, persist high score.
   ────────────────────────────────────────────────────────────────────── */
function addScore(pts, gx, gy, color) {
  score += pts;
  scoreEl.textContent = score;
  triggerPop(scoreEl);
  spawnPopup(gx, gy, `+${pts}`, color);

  if (score > best) {
    best = score;
    bestEl.textContent = best;
    localStorage.setItem('snakeBest', best);
  }
}

/** Re-trigger the CSS scale-pop animation on a HUD element. */
function triggerPop(el) {
  el.classList.remove('pop');
  void el.offsetWidth; // force reflow so the animation restarts cleanly
  el.classList.add('pop');
}

/* ──────────────────────────────────────────────────────────────────────
   Level-up check after each food eat.
   ────────────────────────────────────────────────────────────────────── */
function handleLevelUp() {
  const newLevel = Math.floor(foodsEaten / FOODS_PER_LEVEL) + 1;
  if (newLevel <= level) return;
  level = newLevel;
  levelEl.textContent = level;
  triggerPop(levelEl);
  Audio.levelUp();
}

/* ══════════════════════════════════════════════════════════════════════
   RENDERER  (called every rAF frame)
   Canvas state mutations are batched by colour group to minimise the
   number of save/restore and property-assignment calls per frame.
   ══════════════════════════════════════════════════════════════════════ */
function draw(now = performance.now()) {
  /* ── Blit pre-rendered grid (single drawImage vs 625 fillRects) ── */
  ctx.drawImage(gridCanvas, 0, 0);

  /* ── Normal food ─────────────────────────────────────────────────── */
  if (food) drawCell(food.x, food.y, COLOR.food, 18);

  /* ── Bonus food (blinks near expiry) ────────────────────────────── */
  if (bonusFood) {
    const remaining = BONUS_LIFETIME - (now - bonusBorn);
    if (remaining > BONUS_WARN_AT || Math.sin(now / 110) > 0) {
      drawCell(bonusFood.x, bonusFood.y, COLOR.bonus, 24);
    }
  }

  /* ── Snake body — batch all segments in one save/restore block ─── */
  if (snake.length > 1) {
    const len = snake.length;
    ctx.save();
    ctx.shadowColor = COLOR.snake;
    ctx.shadowBlur  = 5;
    ctx.fillStyle   = COLOR.snake;
    for (let i = len - 1; i >= 1; i--) {
      ctx.globalAlpha = 0.4 + 0.6 * (1 - i / len); // fade towards tail
      const s = snake[i];
      ctx.fillRect(s.x * CELL + CELL_PAD, s.y * CELL + CELL_PAD, CELL_INNER, CELL_INNER);
    }
    ctx.restore();
  }

  /* ── Snake head (drawn on top of body) ──────────────────────────── */
  if (snake.length > 0) {
    drawCell(snake[0].x, snake[0].y, COLOR.snakeHead, 18);
    drawEyes(snake[0]);
  }

  /* ── Particles (pool handles update + colour-batched draw) ───────── */
  particlePool.updateAndDraw();

  /* ── Score popups ────────────────────────────────────────────────── */
  for (let i = popups.length - 1; i >= 0; i--) {
    popups[i].update();
    popups[i].draw();
    if (popups[i].dead) popups.splice(i, 1);
  }
}

/** Draw one neon-glowing filled cell at grid position (gx, gy). */
function drawCell(gx, gy, color, glowBlur, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = color;
  ctx.shadowBlur  = glowBlur;
  ctx.fillStyle   = color;
  ctx.fillRect(gx * CELL + CELL_PAD, gy * CELL + CELL_PAD, CELL_INNER, CELL_INNER);
  ctx.restore();
}

/** Draw two tiny pupils on the head segment to indicate facing direction. */
function drawEyes(head) {
  const dx = dir.x, dy = dir.y;
  const cx = head.x * CELL + CELL_HALF;
  const cy = head.y * CELL + CELL_HALF;
  // Perpendicular offset: swap axes relative to movement direction
  const ex = dy !== 0 ? 4 : 0;
  const ey = dx !== 0 ? 4 : 0;

  ctx.fillStyle = COLOR.bg;
  ctx.beginPath();
  ctx.arc(cx + dx * 4 - ey, cy + dy * 4 - ex, 2.2, 0, Math.PI * 2);
  ctx.arc(cx + dx * 4 + ey, cy + dy * 4 + ex, 2.2, 0, Math.PI * 2);
  ctx.fill();
}

/* ══════════════════════════════════════════════════════════════════════
   GAME OVER
   ══════════════════════════════════════════════════════════════════════ */
function endGame() {
  gameState = STATE.OVER;
  cancelAnimationFrame(rafId);
  expireBonus();
  Audio.die();

  // CSS animation: border flashes red
  arenaEl.classList.remove('flash');
  void arenaEl.offsetWidth;
  arenaEl.classList.add('flash');

  // Keep rAF running briefly so in-flight particles finish
  const endAt = performance.now() + 600;
  function linger(now) {
    draw(now);
    if (now < endAt) {
      rafId = requestAnimationFrame(linger);
    } else {
      const lines = [
        `Score: <strong>${score}</strong>`,
        `Level reached: <strong>${level}</strong>`,
        combo >= 2 ? `Best combo: <strong>×${combo}</strong>` : '',
        score > 0 && score === best ? '🏆 NEW RECORD!' : '',
      ].filter(Boolean).join('<br>');
      showOverlay('GAME OVER', lines, 'PLAY AGAIN');
    }
  }
  rafId = requestAnimationFrame(linger);
}

/* ══════════════════════════════════════════════════════════════════════
   KEYBOARD INPUT
   Inputs are buffered (up to DIR_BUFFER_SIZE) so rapid key sequences
   are not silently dropped between ticks.
   ══════════════════════════════════════════════════════════════════════ */
const KEY_TO_DIR = {
  ArrowUp:    { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
  ArrowDown:  { x: 0, y:  1 }, s: { x: 0, y:  1 }, S: { x: 0, y:  1 },
  ArrowLeft:  { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
  ArrowRight: { x:  1, y: 0 }, d: { x:  1, y: 0 }, D: { x:  1, y: 0 },
};

document.addEventListener('keydown', e => {
  const k = e.key;

  // R — restart from any non-playing state
  if (k === 'r' || k === 'R') {
    if (gameState !== STATE.PLAYING) init();
    return;
  }

  // P — pause / resume
  if (k === 'p' || k === 'P') {
    if (gameState === STATE.PLAYING) {
      gameState = STATE.PAUSED;
      showOverlay('PAUSED', 'Press P or click Resume', 'RESUME');
    } else if (gameState === STATE.PAUSED) {
      gameState  = STATE.PLAYING;
      lastTickAt = performance.now(); // reset timer — prevents burst of missed ticks
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(renderLoop);
      hideOverlay();
    }
    return;
  }

  const d = KEY_TO_DIR[k];
  if (!d) return;
  e.preventDefault();
  if (dirQueue.length < DIR_BUFFER_SIZE) dirQueue.push(d);
});

/* ══════════════════════════════════════════════════════════════════════
   TOUCH / SWIPE (mobile)
   ══════════════════════════════════════════════════════════════════════ */
let touchX = 0, touchY = 0;

document.addEventListener('touchstart', e => {
  touchX = e.touches[0].clientX;
  touchY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;
  if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return; // ignore taps

  const d = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? { x: 1, y: 0 } : { x: -1, y: 0 })
    : (dy > 0 ? { x: 0, y: 1 } : { x: 0, y: -1 });

  if (dirQueue.length < DIR_BUFFER_SIZE) dirQueue.push(d);
}, { passive: true });

/* ══════════════════════════════════════════════════════════════════════
   UI BUTTON LISTENERS
   ══════════════════════════════════════════════════════════════════════ */

// Start / Resume overlay button
btnStart.addEventListener('click', () => {
  if (gameState === STATE.PAUSED) {
    gameState  = STATE.PLAYING;
    lastTickAt = performance.now();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(renderLoop);
    hideOverlay();
  } else {
    init();
  }
});

// Speed buttons — event delegation avoids multiple listener registrations
document.getElementById('toolbar').addEventListener('click', e => {
  const btn = e.target.closest('.opt-btn[data-spd]');
  if (!btn) return;
  document.querySelectorAll('.opt-btn[data-spd]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  baseSpeed = parseInt(btn.dataset.spd, 10);
  // No interval handle to restart; effectiveInterval() is re-evaluated each rAF tick
});

// Wall-wrap toggle
wrapBtn.addEventListener('click', () => {
  wallWrap = !wallWrap;
  wrapBtn.querySelector('span').textContent = wallWrap ? 'WRAP' : 'SOLID';
  wrapBtn.classList.toggle('active', wallWrap);
});

/* ══════════════════════════════════════════════════════════════════════
   BOOT — render idle frame, show welcome overlay
   ══════════════════════════════════════════════════════════════════════ */
(function boot() {
  ctx.drawImage(gridCanvas, 0, 0);
  showOverlay(
    'SNAKE',
    'Eat food to grow &amp; score.<br>'
    + '⭐ Golden food = bonus points!<br>'
    + '🔥 Eat quickly to build combos.',
    'START GAME'
  );
})();
