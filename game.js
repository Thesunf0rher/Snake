/* ══════════════════════════════════════════════════════════════════════
   SNAKE — Neon Edition  |  game.js
   ══════════════════════════════════════════════════════════════════════ */

/* ──────────────────────────────────────────────────────────────────────
   Constants
   ────────────────────────────────────────────────────────────────────── */
const COLS            = 25;      // grid columns
const ROWS            = 25;      // grid rows
const CELL            = 20;      // pixels per cell
const FOODS_PER_LEVEL = 5;       // normal foods eaten to advance one level
const SPEED_STEP_MS   = 6;       // ms shaved off per level
const MIN_INTERVAL    = 45;      // fastest possible tick interval (ms)
const BONUS_LIFETIME  = 8000;    // bonus food expires after 8 s
const BONUS_WARN_AT   = 2500;    // bonus food starts blinking below this ms remaining
const BONUS_POINTS    = 3;       // base points for eating bonus food
const COMBO_WINDOW_MS = 3000;    // max gap between eats to sustain combo chain
const MAX_COMBO       = 8;       // combo multiplier cap
const BONUS_CHANCE    = 0.30;    // probability of bonus food appearing after normal eat
const DIR_BUFFER_SIZE = 2;       // number of direction inputs to buffer ahead

/* ──────────────────────────────────────────────────────────────────────
   Canvas
   ────────────────────────────────────────────────────────────────────── */
const cvs = document.getElementById('cvs');
const ctx = cvs.getContext('2d');
cvs.width  = COLS * CELL;
cvs.height = ROWS * CELL;

/* ──────────────────────────────────────────────────────────────────────
   Colour palette  (mirrors CSS variables, used for canvas drawing)
   ────────────────────────────────────────────────────────────────────── */
const COLOR = {
  bg:        '#050810',
  dot:       '#0d1220',
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
   Mutable game state  (reset by init())
   ────────────────────────────────────────────────────────────────────── */
let snake        = [];   // array of {x,y} segment positions, head at [0]
let dir          = {};   // current movement direction vector
let dirQueue     = [];   // buffered direction inputs (up to DIR_BUFFER_SIZE)
let food         = null; // normal food position {x,y}
let bonusFood    = null; // bonus food position or null when absent
let bonusTimer   = null; // setTimeout handle for bonus expiry
let bonusBorn    = 0;    // timestamp when bonus food was placed

let score        = 0;
let level        = 1;
let foodsEaten   = 0;    // counts only normal food (drives level-up logic)
let combo        = 0;    // current combo chain length
let lastEatTime  = 0;    // timestamp of most recent eat (for combo timing)

let baseSpeed    = 100;  // ms between ticks — set by speed buttons
let gameLoop     = null; // setInterval handle
let running      = false;
let paused       = false;
let wallWrap     = false; // when true, snake passes through walls instead of dying

/* Persistent high score (survives page refresh via localStorage) */
let best = parseInt(localStorage.getItem('snakeBest') || '0');
bestEl.textContent = best;

/* ══════════════════════════════════════════════════════════════════════
   AUDIO ENGINE
   Synthesises all sounds with the Web Audio API — zero external assets.
   The AudioContext is lazily created on the first user gesture to satisfy
   browser autoplay policies.
   ══════════════════════════════════════════════════════════════════════ */
const Audio = (() => {
  let audioCtx = null;

  /* Return (or create) the shared AudioContext */
  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  /* Play a single synthesised tone with an exponential volume envelope */
  function tone({ freq = 440, type = 'square', duration = 0.1, vol = 0.18, delay = 0 }) {
    try {
      const ac   = getCtx();
      const osc  = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain);
      gain.connect(ac.destination);

      osc.type = type;
      osc.frequency.setValueAtTime(freq, ac.currentTime + delay);

      gain.gain.setValueAtTime(0, ac.currentTime + delay);
      gain.gain.linearRampToValueAtTime(vol, ac.currentTime + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + delay + duration);

      osc.start(ac.currentTime + delay);
      osc.stop(ac.currentTime + delay + duration + 0.05);
    } catch (_) { /* silently skip if audio is unavailable */ }
  }

  return {
    /* Short blip when eating normal food */
    eat() {
      tone({ freq: 380, type: 'square', duration: 0.07, vol: 0.15 });
    },

    /* Two-tone chirp for bonus food */
    bonus() {
      tone({ freq: 600, type: 'square', duration: 0.06, vol: 0.15 });
      tone({ freq: 900, type: 'square', duration: 0.09, vol: 0.12, delay: 0.07 });
    },

    /* Ascending arpeggio on level-up */
    levelUp() {
      [330, 440, 550, 660].forEach((f, i) =>
        tone({ freq: f, type: 'sine', duration: 0.13, vol: 0.18, delay: i * 0.09 })
      );
    },

    /* Descending tones on death */
    die() {
      [380, 290, 210, 150].forEach((f, i) =>
        tone({ freq: f, type: 'sawtooth', duration: 0.15, vol: 0.22, delay: i * 0.12 })
      );
    },
  };
})();

/* ══════════════════════════════════════════════════════════════════════
   PARTICLE SYSTEM
   Spawned at food positions; animated during draw() each tick.
   ══════════════════════════════════════════════════════════════════════ */
class Particle {
  constructor(x, y, color) {
    this.x     = x;
    this.y     = y;
    const angle = Math.random() * Math.PI * 2;
    const spd   = Math.random() * 3.2 + 0.8;
    this.vx    = Math.cos(angle) * spd;
    this.vy    = Math.sin(angle) * spd;
    this.color = color;
    this.size  = Math.random() * 4 + 1.5;
    this.life  = 1.0;                         // fades from 1 → 0
    this.decay = Math.random() * 0.04 + 0.025;
  }

  update() {
    this.x    += this.vx;
    this.y    += this.vy;
    this.vx   *= 0.91;  // drag
    this.vy   *= 0.91;
    this.life -= this.decay;
  }

  draw() {
    ctx.save();
    ctx.globalAlpha = Math.max(0, this.life);
    ctx.shadowColor = this.color;
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = this.color;
    ctx.fillRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
    ctx.restore();
  }

  get dead() { return this.life <= 0; }
}

const particles = [];

/* Emit particles centred on grid cell (gx, gy) */
function spawnParticles(gx, gy, color, count = 14) {
  const cx = gx * CELL + CELL / 2;
  const cy = gy * CELL + CELL / 2;
  for (let i = 0; i < count; i++) {
    particles.push(new Particle(cx, cy, color));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   FLOATING SCORE POPUPS
   Text labels that float upward and fade out after eating food.
   ══════════════════════════════════════════════════════════════════════ */
class Popup {
  constructor(x, y, text, color) {
    this.x     = x;
    this.y     = y;
    this.text  = text;
    this.color = color;
    this.alpha = 1.0;
    this.vy    = -1.1;  // drift upward
  }

  update() {
    this.y    += this.vy;
    this.alpha -= 0.022;
  }

  draw() {
    ctx.save();
    ctx.globalAlpha = Math.max(0, this.alpha);
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

const popups = [];

/* Spawn a popup above grid cell (gx, gy) */
function spawnPopup(gx, gy, text, color) {
  popups.push(new Popup(gx * CELL + CELL / 2, gy * CELL, text, color));
}

/* ══════════════════════════════════════════════════════════════════════
   OVERLAY HELPERS
   ══════════════════════════════════════════════════════════════════════ */
function showOverlay(title, htmlSub, btnLabel) {
  oTitle.textContent     = title;
  oSub.innerHTML         = htmlSub;
  oSub.style.display     = htmlSub ? 'block' : 'none';
  btnStart.querySelector('span').textContent = btnLabel;
  overlay.classList.remove('hidden');
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════════════════
   FOOD HELPERS
   ══════════════════════════════════════════════════════════════════════ */

/* Return a random grid cell not occupied by the snake or existing food */
function randomEmptyCell() {
  let pos;
  do {
    pos = {
      x: Math.floor(Math.random() * COLS),
      y: Math.floor(Math.random() * ROWS),
    };
  } while (
    snake.some(s => s.x === pos.x && s.y === pos.y)        ||
    (food      && food.x      === pos.x && food.y      === pos.y) ||
    (bonusFood && bonusFood.x === pos.x && bonusFood.y === pos.y)
  );
  return pos;
}

function spawnFood() {
  food = randomEmptyCell();
}

/* Spawn the timed golden bonus food */
function spawnBonusFood() {
  clearTimeout(bonusTimer);
  bonusFood  = randomEmptyCell();
  bonusBorn  = Date.now();
  bonusBarWrap.classList.remove('hidden');
  bonusFill.style.width = '100%';
  bonusTimer = setTimeout(expireBonus, BONUS_LIFETIME);
}

/* Remove bonus food (called on expiry or when the snake eats it) */
function expireBonus() {
  bonusFood = null;
  clearTimeout(bonusTimer);
  bonusBarWrap.classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════════════════
   SPEED CALCULATION
   Effective tick interval shrinks by SPEED_STEP_MS each level,
   floored at MIN_INTERVAL to keep the game playable.
   ══════════════════════════════════════════════════════════════════════ */
function effectiveInterval() {
  return Math.max(MIN_INTERVAL, baseSpeed - (level - 1) * SPEED_STEP_MS);
}

/* ══════════════════════════════════════════════════════════════════════
   INIT / RESTART
   ══════════════════════════════════════════════════════════════════════ */
function init() {
  /* Place snake horizontally in the centre, heading right */
  snake = [
    { x: 13, y: 12 },
    { x: 12, y: 12 },
    { x: 11, y: 12 },
  ];
  dir       = { x: 1, y: 0 };
  dirQueue  = [];

  score      = 0;
  level      = 1;
  foodsEaten = 0;
  combo      = 0;
  lastEatTime = 0;

  scoreEl.textContent = 0;
  levelEl.textContent = 1;
  comboBadge.classList.add('hidden');

  /* Clear particles and popups from any previous round */
  particles.length = 0;
  popups.length    = 0;

  /* Clear bonus food */
  expireBonus();

  spawnFood();
  hideOverlay();

  running = true;
  paused  = false;

  clearInterval(gameLoop);
  gameLoop = setInterval(tick, effectiveInterval());
  draw();
}

/* ══════════════════════════════════════════════════════════════════════
   MAIN GAME TICK
   Called every `effectiveInterval()` ms while running and unpaused.
   ══════════════════════════════════════════════════════════════════════ */
function tick() {
  if (!running || paused) return;

  /* Apply next buffered direction, rejecting a 180° reversal */
  while (dirQueue.length > 0) {
    const candidate = dirQueue.shift();
    if (candidate.x !== -dir.x || candidate.y !== -dir.y) {
      dir = candidate;
      break;
    }
  }

  /* Calculate new head position */
  let head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

  /* Handle wall collision based on current mode */
  if (wallWrap) {
    /* Wrap-around: exit one side, enter the opposite */
    head.x = (head.x + COLS) % COLS;
    head.y = (head.y + ROWS) % ROWS;
  } else {
    /* Solid walls: collision = game over */
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
      return endGame();
    }
  }

  /* Self-collision check */
  if (snake.some(s => s.x === head.x && s.y === head.y)) {
    return endGame();
  }

  snake.unshift(head); // add new head segment

  let ate = false;

  /* ── Check normal food ──────────────────────────────────── */
  if (head.x === food.x && head.y === food.y) {
    ate = true;
    foodsEaten++;
    const pts = getComboPoints(1);
    addScore(pts, food.x, food.y, COLOR.food);
    Audio.eat();
    spawnParticles(food.x, food.y, COLOR.food, 14);
    spawnFood();

    /* Randomly place a bonus food after eating */
    if (!bonusFood && Math.random() < BONUS_CHANCE) spawnBonusFood();

    /* Advance level if threshold crossed */
    handleLevelUp();
  }

  /* ── Check bonus food ───────────────────────────────────── */
  if (bonusFood && head.x === bonusFood.x && head.y === bonusFood.y) {
    ate = true;
    const pts = getComboPoints(BONUS_POINTS);
    addScore(pts, bonusFood.x, bonusFood.y, COLOR.bonus);
    Audio.bonus();
    spawnParticles(bonusFood.x, bonusFood.y, COLOR.bonus, 20);
    expireBonus();
  }

  /* Only shrink tail when nothing was eaten this tick */
  if (!ate) snake.pop();

  /* Keep bonus bar countdown in sync */
  if (bonusFood) {
    const pct = Math.max(0, 1 - (Date.now() - bonusBorn) / BONUS_LIFETIME);
    bonusFill.style.width = `${pct * 100}%`;
  }

  draw();
}

/* ──────────────────────────────────────────────────────────────────────
   Compute points for this eat, factoring in the current combo chain.
   Resets combo if the eat happened too long after the previous one.
   ────────────────────────────────────────────────────────────────────── */
function getComboPoints(base) {
  const now = Date.now();
  if (now - lastEatTime < COMBO_WINDOW_MS) {
    combo = Math.min(combo + 1, MAX_COMBO);
  } else {
    combo = 1;
  }
  lastEatTime = now;

  /* Show / update combo badge */
  if (combo >= 2) {
    comboCountEl.textContent = combo;
    comboBadge.classList.remove('hidden');
  } else {
    comboBadge.classList.add('hidden');
  }

  return base * combo;
}

/* ──────────────────────────────────────────────────────────────────────
   Add score, animate HUD, save high score.
   ────────────────────────────────────────────────────────────────────── */
function addScore(pts, gx, gy, color) {
  score += pts;
  scoreEl.textContent = score;
  popAnim(scoreEl);
  spawnPopup(gx, gy, `+${pts}`, color);

  if (score > best) {
    best = score;
    bestEl.textContent = best;
    localStorage.setItem('snakeBest', best);
  }
}

/* Trigger CSS pop animation (remove + re-add class forces replay) */
function popAnim(el) {
  el.classList.remove('pop');
  void el.offsetWidth; // force reflow
  el.classList.add('pop');
}

/* ──────────────────────────────────────────────────────────────────────
   Advance level when enough food has been eaten; restart tick interval
   at the new (faster) speed.
   ────────────────────────────────────────────────────────────────────── */
function handleLevelUp() {
  const newLevel = Math.floor(foodsEaten / FOODS_PER_LEVEL) + 1;
  if (newLevel > level) {
    level = newLevel;
    levelEl.textContent = level;
    popAnim(levelEl);
    Audio.levelUp();
    /* Re-schedule tick at updated interval */
    clearInterval(gameLoop);
    gameLoop = setInterval(tick, effectiveInterval());
  }
}

/* ══════════════════════════════════════════════════════════════════════
   RENDERER
   Called once per tick (and once on init for the idle frame).
   ══════════════════════════════════════════════════════════════════════ */
function draw() {
  const W = cvs.width, H = cvs.height;

  /* ── Background ──────────────────────────────────────────── */
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, W, H);

  /* ── Dot grid ────────────────────────────────────────────── */
  ctx.fillStyle = COLOR.dot;
  for (let x = 0; x < COLS; x++) {
    for (let y = 0; y < ROWS; y++) {
      ctx.fillRect(x * CELL + CELL / 2 - 1, y * CELL + CELL / 2 - 1, 2, 2);
    }
  }

  /* ── Normal food ─────────────────────────────────────────── */
  if (food) drawCell(food.x, food.y, COLOR.food, 18);

  /* ── Bonus food (blinks when close to expiry) ────────────── */
  if (bonusFood) {
    const remaining = BONUS_LIFETIME - (Date.now() - bonusBorn);
    const visible   = remaining > BONUS_WARN_AT || Math.sin(Date.now() / 110) > 0;
    if (visible) drawCell(bonusFood.x, bonusFood.y, COLOR.bonus, 24);
  }

  /* ── Snake body (tail fades to give motion-trail illusion) ── */
  for (let i = snake.length - 1; i >= 1; i--) {
    const alpha = 0.4 + 0.6 * (1 - i / snake.length);
    drawCell(snake[i].x, snake[i].y, COLOR.snake, 5, alpha);
  }

  /* ── Snake head ──────────────────────────────────────────── */
  if (snake.length > 0) {
    drawCell(snake[0].x, snake[0].y, COLOR.snakeHead, 18);
    drawEyes(snake[0], dir);
  }

  /* ── Particles ───────────────────────────────────────────── */
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].update();
    particles[i].draw();
    if (particles[i].dead) particles.splice(i, 1);
  }

  /* ── Score popups ────────────────────────────────────────── */
  for (let i = popups.length - 1; i >= 0; i--) {
    popups[i].update();
    popups[i].draw();
    if (popups[i].dead) popups.splice(i, 1);
  }
}

/* Draw a single glowing filled cell at grid coordinates (gx, gy) */
function drawCell(gx, gy, color, glowBlur, alpha = 1) {
  const pad = 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = color;
  ctx.shadowBlur  = glowBlur;
  ctx.fillStyle   = color;
  ctx.fillRect(gx * CELL + pad, gy * CELL + pad, CELL - pad * 2, CELL - pad * 2);
  ctx.restore();
}

/* Draw two tiny "eyes" on the snake head so direction is visible */
function drawEyes(head, d) {
  const cx = head.x * CELL + CELL / 2;
  const cy = head.y * CELL + CELL / 2;

  /* Eye offset perpendicular to the movement axis */
  const ex = d.y !== 0 ? 4 : 0;
  const ey = d.x !== 0 ? 4 : 0;

  ctx.fillStyle = COLOR.bg;
  ctx.beginPath();
  ctx.arc(cx + d.x * 4 - ey, cy + d.y * 4 - ex, 2.2, 0, Math.PI * 2);
  ctx.arc(cx + d.x * 4 + ey, cy + d.y * 4 + ex, 2.2, 0, Math.PI * 2);
  ctx.fill();
}

/* ══════════════════════════════════════════════════════════════════════
   GAME OVER
   ══════════════════════════════════════════════════════════════════════ */
function endGame() {
  running = false;
  clearInterval(gameLoop);
  expireBonus();
  Audio.die();

  /* Red flash on the arena border */
  arenaEl.classList.remove('flash');
  void arenaEl.offsetWidth; // force reflow so animation restarts
  arenaEl.classList.add('flash');

  /* Render final frame with any in-flight particles */
  draw();

  /* Build the result summary shown in the overlay */
  const lines = [
    `Score: <strong>${score}</strong>`,
    `Level reached: <strong>${level}</strong>`,
    combo >= 2 ? `Best combo: <strong>x${combo}</strong>` : '',
    score > 0 && score === best ? '🏆 NEW RECORD!' : '',
  ].filter(Boolean).join('<br>');

  setTimeout(() => showOverlay('GAME OVER', lines, 'PLAY AGAIN'), 380);
}

/* ══════════════════════════════════════════════════════════════════════
   KEYBOARD INPUT
   Direction inputs are buffered so rapid presses aren't lost.
   ══════════════════════════════════════════════════════════════════════ */
const KEY_TO_DIR = {
  ArrowUp:    { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
  ArrowDown:  { x: 0, y:  1 }, s: { x: 0, y:  1 }, S: { x: 0, y:  1 },
  ArrowLeft:  { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
  ArrowRight: { x:  1, y: 0 }, d: { x:  1, y: 0 }, D: { x:  1, y: 0 },
};

document.addEventListener('keydown', e => {
  /* Restart shortcut */
  if (e.key === 'r' || e.key === 'R') {
    if (!running || paused) init();
    return;
  }

  /* Pause / resume toggle */
  if ((e.key === 'p' || e.key === 'P') && (running || paused)) {
    if (!running) return;
    paused = !paused;
    if (paused) showOverlay('PAUSED', 'Press P or click Resume', 'RESUME');
    else         hideOverlay();
    return;
  }

  /* Movement — buffer up to DIR_BUFFER_SIZE inputs */
  const d = KEY_TO_DIR[e.key];
  if (!d) return;
  e.preventDefault();
  if (dirQueue.length < DIR_BUFFER_SIZE) dirQueue.push(d);
});

/* ══════════════════════════════════════════════════════════════════════
   TOUCH / SWIPE INPUT  (mobile support)
   ══════════════════════════════════════════════════════════════════════ */
let touchX = 0, touchY = 0;

document.addEventListener('touchstart', e => {
  touchX = e.touches[0].clientX;
  touchY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;

  /* Ignore micro-taps */
  if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;

  /* Choose dominant axis */
  const d = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? { x: 1, y: 0 } : { x: -1, y: 0 })
    : (dy > 0 ? { x: 0, y: 1 } : { x: 0, y: -1 });

  if (dirQueue.length < DIR_BUFFER_SIZE) dirQueue.push(d);
}, { passive: true });

/* ══════════════════════════════════════════════════════════════════════
   UI BUTTON LISTENERS
   ══════════════════════════════════════════════════════════════════════ */

/* Start / Resume overlay button */
btnStart.addEventListener('click', () => {
  if (paused) {
    paused = false;
    hideOverlay();
  } else {
    init();
  }
});

/* Speed option buttons */
document.querySelectorAll('.opt-btn[data-spd]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.opt-btn[data-spd]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    baseSpeed = parseInt(btn.dataset.spd);

    /* Apply immediately if a game is in progress */
    if (running && !paused) {
      clearInterval(gameLoop);
      gameLoop = setInterval(tick, effectiveInterval());
    }
  });
});

/* Wall-wrap toggle button */
wrapBtn.addEventListener('click', () => {
  wallWrap = !wallWrap;
  wrapBtn.querySelector('span').textContent = wallWrap ? 'WRAP' : 'SOLID';
  wrapBtn.classList.toggle('active', wallWrap);
});

/* ══════════════════════════════════════════════════════════════════════
   BOOT — draw idle grid and show the start screen overlay
   ══════════════════════════════════════════════════════════════════════ */
(function boot() {
  /* Render a static dot grid so the canvas isn't blank before first game */
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, cvs.width, cvs.height);
  ctx.fillStyle = COLOR.dot;
  for (let x = 0; x < COLS; x++) {
    for (let y = 0; y < ROWS; y++) {
      ctx.fillRect(x * CELL + CELL / 2 - 1, y * CELL + CELL / 2 - 1, 2, 2);
    }
  }

  showOverlay(
    'SNAKE',
    'Eat food to grow &amp; score.<br>'
    + '⭐ Golden food = bonus points!<br>'
    + '🔥 Eat quickly to build combos.',
    'START GAME'
  );
})();
