/* ══════════════════════════════════════════════════════════════════════
   SNAKE — Neon Edition  |  game.js
   New features: power-ups (Boost / Ghost / Shrink / Shield),
                 obstacle blocks, announce system, snake skin themes,
                 screen shake on death.
   ══════════════════════════════════════════════════════════════════════ */

/* ──────────────────────────────────────────────────────────────────────
   Grid & timing constants
   ────────────────────────────────────────────────────────────────────── */
const COLS = 25, ROWS = 25, CELL = 20;
const CELL_HALF  = CELL / 2;
const CELL_PAD   = 2;
const CELL_INNER = CELL - CELL_PAD * 2;

const FOODS_PER_LEVEL       = 5;
const SPEED_STEP_MS         = 6;
const MIN_INTERVAL          = 45;
const BONUS_LIFETIME        = 8000;
const BONUS_WARN_AT         = 2500;
const BONUS_POINTS          = 3;
const COMBO_WINDOW_MS       = 3000;
const MAX_COMBO             = 8;
const BONUS_CHANCE          = 0.28;
const DIR_BUFFER_SIZE       = 2;
const PARTICLE_POOL_SIZE    = 200;

/* Power-up item lingers on the grid for this many ms before vanishing */
const POWERUP_FIELD_LIFE    = 7000;
/* Probability a power-up item appears after eating normal food */
const POWERUP_SPAWN_CHANCE  = 0.22;
/* Obstacles start appearing at this level and add more each level after */
const OBSTACLE_START_LEVEL  = 3;
const OBSTACLES_PER_LEVEL   = 2;
/* Minimum Manhattan distance from snake head when placing obstacles */
const OBSTACLE_SAFE_RADIUS  = 5;

/* ──────────────────────────────────────────────────────────────────────
   GameState enum
   ────────────────────────────────────────────────────────────────────── */
const STATE = Object.freeze({
  IDLE: 'idle', PLAYING: 'playing', PAUSED: 'paused', OVER: 'over',
});

/* ──────────────────────────────────────────────────────────────────────
   Canvas
   ────────────────────────────────────────────────────────────────────── */
const cvs = document.getElementById('cvs');
const ctx = cvs.getContext('2d');
cvs.width  = COLS * CELL;
cvs.height = ROWS * CELL;

/* ──────────────────────────────────────────────────────────────────────
   Offscreen grid cache (pre-render the dot background once)
   ────────────────────────────────────────────────────────────────────── */
const gridCanvas = document.createElement('canvas');
gridCanvas.width  = cvs.width;
gridCanvas.height = cvs.height;
(function buildGrid() {
  const gc = gridCanvas.getContext('2d');
  gc.fillStyle = '#050810';
  gc.fillRect(0, 0, cvs.width, cvs.height);
  gc.fillStyle = '#0d1220';
  for (let x = 0; x < COLS; x++)
    for (let y = 0; y < ROWS; y++)
      gc.fillRect(x * CELL + CELL_HALF - 1, y * CELL + CELL_HALF - 1, 2, 2);
})();

/* ──────────────────────────────────────────────────────────────────────
   Snake skin presets
   Switching skins updates COLOR and the arena border at runtime.
   ────────────────────────────────────────────────────────────────────── */
const SKINS = {
  green:  { snake: '#00ff88', head: '#b8ffe0' },
  cyan:   { snake: '#00e5ff', head: '#b0f6ff' },
  purple: { snake: '#cc44ff', head: '#eac0ff' },
  gold:   { snake: '#ffaa00', head: '#ffdf80' },
};

/* Live colour palette (mutated when skin changes) */
const COLOR = {
  bg:    '#050810',
  snake: '#00ff88',
  head:  '#b8ffe0',
  food:  '#ff2d55',
  bonus: '#ffe600',
};

/* ──────────────────────────────────────────────────────────────────────
   Power-up configuration
   ────────────────────────────────────────────────────────────────────── */
const POWERUP_CFG = {
  boost:  { color: '#00e5ff', label: 'SPEED BOOST', icon: '⚡', duration: 4000 },
  ghost:  { color: '#cc44ff', label: 'GHOST MODE',  icon: '👻', duration: 5500 },
  shrink: { color: '#ff44aa', label: 'SHRINK',       icon: '✂',  duration: 0    }, // instant
  shield: { color: '#ff8800', label: 'SHIELD',       icon: '🛡', duration: 12000 },
};
const POWERUP_TYPES = Object.keys(POWERUP_CFG);

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
   Occupancy grids  (O(1) collision lookup)
   occupied[]     — snake segments (1 = occupied, 0 = free)
   obstacleMap[]  — static obstacle blocks
   ────────────────────────────────────────────────────────────────────── */
const occupied    = new Uint8Array(COLS * ROWS);
const obstacleMap = new Uint8Array(COLS * ROWS);

const idx          = (x, y) => y * COLS + x;
const occupy       = (x, y) => { occupied[idx(x, y)] = 1; };
const vacate       = (x, y) => { occupied[idx(x, y)] = 0; };
const isOccupied   = (x, y) => occupied[idx(x, y)] === 1;
const isObstacle   = (x, y) => obstacleMap[idx(x, y)] === 1;
const clearOccupied = ()    => occupied.fill(0);
const clearObstacles = ()   => obstacleMap.fill(0);

/* ──────────────────────────────────────────────────────────────────────
   Game state
   ────────────────────────────────────────────────────────────────────── */
let snake       = [];
let dir         = { x: 1, y: 0 };
let wallWrap    = false;
let dirQueue    = [];

let food        = null;          // normal food {x,y}
let bonusFood   = null;          // bonus food {x,y} or null
let bonusTimer  = null;
let bonusBorn   = 0;

/* Power-up item sitting on the grid waiting to be collected */
let fieldPowerup = null;         // { x, y, type, born }

/* Currently active power-up effects: Map<string, expiresAt> */
const activePowerups = new Map();

let score       = 0;
let level       = 1;
let foodsEaten  = 0;
let combo       = 0;
let lastEatTime = 0;

let baseSpeed   = 100;
let rafId       = null;
let lastTickAt  = 0;
let lastFrameAt = 0;
let gameState   = STATE.IDLE;

let best = parseInt(localStorage.getItem('snakeBest') || '0');
bestEl.textContent = best;

/* ══════════════════════════════════════════════════════════════════════
   AUDIO ENGINE  (Web Audio API — no external files)
   ══════════════════════════════════════════════════════════════════════ */
const Audio = (() => {
  let ac = null;
  const getCtx = () => {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    return ac;
  };

  function tone(freq, type, dur, vol, delay = 0) {
    const ctx = getCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    const t = ctx.currentTime + delay;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  return {
    eat()     { tone(380, 'square',   0.07, 0.14); },
    bonus()   { tone(600, 'square',   0.06, 0.14); tone(900, 'square', 0.09, 0.11, 0.07); },
    levelUp() { [330,440,550,660].forEach((f,i) => tone(f,'sine',    0.13, 0.17, i*.09)); },
    die()     { [380,290,210,150].forEach((f,i) => tone(f,'sawtooth',0.15, 0.22, i*.12)); },
    /* Sparkle sweep when collecting a power-up */
    powerup() { [440,550,660,880].forEach((f,i) => tone(f,'sine',    0.1,  0.14, i*.06)); },
    /* Metallic clank when shield absorbs a hit */
    shield()  { tone(200,'square',0.08,0.22); tone(350,'square',0.14,0.14,0.06); },
  };
})();

/* ══════════════════════════════════════════════════════════════════════
   PARTICLE POOL  (pre-allocated, no GC pressure)
   ══════════════════════════════════════════════════════════════════════ */
const particlePool = (() => {
  const slots = Array.from({ length: PARTICLE_POOL_SIZE }, () => ({
    x:0,y:0,vx:0,vy:0,color:'',size:0,life:0,decay:0,alive:false,
  }));
  const byColor = new Map();

  function emit(x, y, color) {
    for (const p of slots) {
      if (p.alive) continue;
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * 3.2 + 0.8;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * s; p.vy = Math.sin(a) * s;
      p.color = color;
      p.size  = Math.random() * 4 + 1.5;
      p.life  = 1.0;
      p.decay = Math.random() * 0.04 + 0.025;
      p.alive = true;
      return;
    }
  }

  function updateAndDraw() {
    byColor.clear();
    for (const p of slots) {
      if (!p.alive) continue;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.91; p.vy *= 0.91;
      p.life -= p.decay;
      if (p.life <= 0) { p.alive = false; continue; }
      if (!byColor.has(p.color)) byColor.set(p.color, []);
      byColor.get(p.color).push(p);
    }
    for (const [color, group] of byColor) {
      ctx.save();
      ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.fillStyle = color;
      for (const p of group) {
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
      }
      ctx.restore();
    }
  }

  return {
    emit,
    updateAndDraw,
    burst(gx, gy, color, n=14) {
      const cx = gx * CELL + CELL_HALF, cy = gy * CELL + CELL_HALF;
      for (let i = 0; i < n; i++) emit(cx, cy, color);
    },
    reset() { for (const p of slots) p.alive = false; },
  };
})();

/* ══════════════════════════════════════════════════════════════════════
   FLOATING SCORE POPUPS
   ══════════════════════════════════════════════════════════════════════ */
const popups = [];

class Popup {
  constructor(x, y, text, color) {
    Object.assign(this, { x, y, text, color, alpha: 1.0 });
  }
  update()  { this.y -= 1.1; this.alpha -= 0.022; }
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
   ANNOUNCE SYSTEM
   Big canvas text that scales in, holds, then fades out.
   Max 2 simultaneous announces; oldest is replaced when queue is full.
   ══════════════════════════════════════════════════════════════════════ */
const announces = [];

class Announce {
  constructor(text, color) {
    this.text    = text;
    this.color   = color;
    this.elapsed = 0;   // ms since spawn
    this.life    = 1800; // total duration ms
  }

  update(dt) { this.elapsed = Math.min(this.life, this.elapsed + dt); }

  draw(cy) {
    const t = this.elapsed / this.life;
    let scale, alpha;
    if      (t < 0.18) { scale = 0.5 + (t / 0.18) * 0.6; alpha = t / 0.18; }
    else if (t < 0.72) { scale = 1.0; alpha = 1.0; }
    else               { scale = 1.0; alpha = 1.0 - (t - 0.72) / 0.28; }

    ctx.save();
    ctx.globalAlpha   = Math.max(0, alpha);
    ctx.translate(cvs.width / 2, cy);
    ctx.scale(scale, scale);
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.font          = 'bold 26px Orbitron, monospace';
    ctx.fillStyle     = this.color;
    ctx.shadowColor   = this.color;
    ctx.shadowBlur    = 26;
    ctx.fillText(this.text, 0, 0);
    ctx.restore();
  }

  get dead() { return this.elapsed >= this.life; }
}

function announce(text, color) {
  if (announces.length >= 2) announces.shift();
  announces.push(new Announce(text, color));
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
   FOOD & ITEM HELPERS
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Return a random empty cell avoiding snake, obstacles, food, bonus, and
 * the power-up field item, and optionally far from the snake head.
 */
function randomEmptyCell(safeRadius = 0) {
  let x, y, attempts = 0;
  const head = snake[0];
  do {
    x = Math.floor(Math.random() * COLS);
    y = Math.floor(Math.random() * ROWS);
    if (++attempts > 500) break; // safety escape for very full grids
  } while (
    isOccupied(x, y) ||
    isObstacle(x, y) ||
    (food        && food.x        === x && food.y        === y) ||
    (bonusFood   && bonusFood.x   === x && bonusFood.y   === y) ||
    (fieldPowerup && fieldPowerup.x === x && fieldPowerup.y === y) ||
    (safeRadius > 0 && head && Math.abs(x - head.x) + Math.abs(y - head.y) < safeRadius)
  );
  return { x, y };
}

function spawnFood()  { food = randomEmptyCell(); }

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
   POWER-UP SYSTEM
   ══════════════════════════════════════════════════════════════════════ */

/** Try to place a random power-up item on the grid. */
function trySpawnFieldPowerup() {
  if (fieldPowerup) return; // only one on screen at a time
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  const pos  = randomEmptyCell();
  fieldPowerup = { x: pos.x, y: pos.y, type, born: performance.now() };
}

/** Expire the field power-up without any pickup effect. */
function expireFieldPowerup() { fieldPowerup = null; }

/** Return true when a power-up effect is currently active (not expired). */
function isPowerupActive(id) {
  const exp = activePowerups.get(id);
  return exp !== undefined && exp > performance.now();
}

/** Consume the shield, returning true if it was active. */
function consumeShield() {
  if (!isPowerupActive('shield')) return false;
  activePowerups.delete('shield');
  return true;
}

/** Activate or refresh a power-up effect (called on pickup). */
function activatePowerup(type, now) {
  const cfg = POWERUP_CFG[type];

  if (type === 'shrink') {
    // Instant effect: remove tail segments
    const toRemove = Math.min(5, snake.length - 1);
    for (let i = 0; i < toRemove; i++) {
      const tail = snake.pop();
      vacate(tail.x, tail.y);
    }
    spawnPopup(fieldPowerup.x, fieldPowerup.y, '✂ SHRINK!', cfg.color);
    particlePool.burst(fieldPowerup.x, fieldPowerup.y, cfg.color, 20);
    return;
  }

  activePowerups.set(type, now + cfg.duration);
  announce(`${cfg.icon} ${cfg.label}`, cfg.color);
  particlePool.burst(fieldPowerup.x, fieldPowerup.y, cfg.color, 20);
}

/* ══════════════════════════════════════════════════════════════════════
   OBSTACLE SYSTEM
   ══════════════════════════════════════════════════════════════════════ */

/** Place `count` new obstacle blocks on the grid. */
function spawnObstacles(count) {
  for (let i = 0; i < count; i++) {
    const pos = randomEmptyCell(OBSTACLE_SAFE_RADIUS);
    if (!pos) break;
    obstacleMap[idx(pos.x, pos.y)] = 1;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SPEED CALCULATION
   ══════════════════════════════════════════════════════════════════════ */
function effectiveInterval(now = performance.now()) {
  const base = Math.max(MIN_INTERVAL, baseSpeed - (level - 1) * SPEED_STEP_MS);
  // Speed Boost halves the effective interval
  return isPowerupActive('boost') ? Math.max(MIN_INTERVAL / 2, base * 0.55) : base;
}

/* ══════════════════════════════════════════════════════════════════════
   INIT / RESTART
   ══════════════════════════════════════════════════════════════════════ */
function init() {
  clearOccupied();
  clearObstacles();

  snake = [
    { x: 13, y: 12 },
    { x: 12, y: 12 },
    { x: 11, y: 12 },
  ];
  snake.forEach(s => occupy(s.x, s.y));

  dir      = { x: 1, y: 0 };
  dirQueue = [];

  score = 0; level = 1; foodsEaten = 0; combo = 0; lastEatTime = 0;
  scoreEl.textContent = 0;
  levelEl.textContent = 1;
  comboBadge.classList.add('hidden');

  activePowerups.clear();
  fieldPowerup = null;
  particlePool.reset();
  popups.length   = 0;
  announces.length = 0;

  expireBonus();
  spawnFood();
  hideOverlay();

  gameState  = STATE.PLAYING;
  lastTickAt = performance.now();
  lastFrameAt = performance.now();

  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(renderLoop);
}

/* ══════════════════════════════════════════════════════════════════════
   RAF RENDER LOOP  (game logic + rendering decoupled by timestamp)
   ══════════════════════════════════════════════════════════════════════ */
function renderLoop(now) {
  rafId = requestAnimationFrame(renderLoop);

  // Clamp dt to avoid massive jumps after tab switches or pauses
  const dt = Math.min(100, now - lastFrameAt);
  lastFrameAt = now;

  if (gameState === STATE.PLAYING) {
    const interval = effectiveInterval(now);
    if (now - lastTickAt >= interval) {
      lastTickAt += interval;
      tick(now);
    }
  }

  draw(now, dt);
}

/* ══════════════════════════════════════════════════════════════════════
   MAIN GAME TICK  (logic only — called at configured interval)
   ══════════════════════════════════════════════════════════════════════ */
function tick(now) {
  /* ── Purge expired active power-ups ────────────────────────── */
  for (const [id, exp] of activePowerups) {
    if (exp <= now) activePowerups.delete(id);
  }

  /* ── Expire field power-up if it has been on the grid too long ── */
  if (fieldPowerup && now - fieldPowerup.born > POWERUP_FIELD_LIFE) {
    expireFieldPowerup();
  }

  /* ── Dequeue next valid direction ──────────────────────────── */
  while (dirQueue.length > 0) {
    const d = dirQueue.shift();
    if (d.x !== -dir.x || d.y !== -dir.y) { dir = d; break; }
  }

  /* ── Compute new head position ─────────────────────────────── */
  let hx = snake[0].x + dir.x;
  let hy = snake[0].y + dir.y;

  /* ── Wall collision ─────────────────────────────────────────── */
  if (wallWrap) {
    hx = (hx + COLS) % COLS;
    hy = (hy + ROWS) % ROWS;
  } else if (hx < 0 || hx >= COLS || hy < 0 || hy >= ROWS) {
    if (consumeShield()) { Audio.shield(); announce('🛡 BLOCKED!', POWERUP_CFG.shield.color); return; }
    return endGame();
  }

  /* ── Self-collision (skipped in Ghost mode) ─────────────────── */
  const ghostOn = isPowerupActive('ghost');
  if (!ghostOn && isOccupied(hx, hy)) {
    if (consumeShield()) { Audio.shield(); announce('🛡 BLOCKED!', POWERUP_CFG.shield.color); return; }
    return endGame();
  }

  /* ── Obstacle collision ──────────────────────────────────────── */
  if (isObstacle(hx, hy)) {
    if (consumeShield()) { Audio.shield(); announce('🛡 BLOCKED!', POWERUP_CFG.shield.color); return; }
    return endGame();
  }

  /* ── Advance snake ──────────────────────────────────────────── */
  snake.unshift({ x: hx, y: hy });
  occupy(hx, hy);

  let ate = false;

  /* ── Normal food ────────────────────────────────────────────── */
  if (hx === food.x && hy === food.y) {
    ate = true;
    foodsEaten++;
    const pts = computeCombo(1, now);
    addScore(pts, food.x, food.y, COLOR.food);
    particlePool.burst(food.x, food.y, COLOR.food, 14);
    Audio.eat();
    spawnFood();
    if (!bonusFood   && Math.random() < BONUS_CHANCE)       spawnBonusFood();
    if (!fieldPowerup && Math.random() < POWERUP_SPAWN_CHANCE) trySpawnFieldPowerup();
    handleLevelUp();
  }

  /* ── Bonus food ─────────────────────────────────────────────── */
  if (bonusFood && hx === bonusFood.x && hy === bonusFood.y) {
    ate = true;
    const pts = computeCombo(BONUS_POINTS, now);
    addScore(pts, bonusFood.x, bonusFood.y, COLOR.bonus);
    particlePool.burst(bonusFood.x, bonusFood.y, COLOR.bonus, 20);
    Audio.bonus();
    expireBonus();
  }

  /* ── Power-up field item ────────────────────────────────────── */
  if (fieldPowerup && hx === fieldPowerup.x && hy === fieldPowerup.y) {
    ate = true;
    activatePowerup(fieldPowerup.type, now);
    Audio.powerup();
    const fp = fieldPowerup; // capture before clearing
    fieldPowerup = null;
    // Shrink already pops the tail — don't grow from collection
    if (POWERUP_CFG[fp.type].duration === 0) ate = false;
  }

  /* Remove tail only when nothing was eaten */
  if (!ate) {
    const tail = snake.pop();
    vacate(tail.x, tail.y);
  }

  /* Sync bonus bar */
  if (bonusFood) {
    bonusFill.style.width =
      `${Math.max(0, 1 - (now - bonusBorn) / BONUS_LIFETIME) * 100}%`;
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Combo-adjusted score computation
   ────────────────────────────────────────────────────────────────────── */
function computeCombo(base, now) {
  combo = (now - lastEatTime < COMBO_WINDOW_MS)
    ? Math.min(combo + 1, MAX_COMBO) : 1;
  lastEatTime = now;

  if (combo >= 2) {
    comboCountEl.textContent = combo;
    comboBadge.classList.remove('hidden');
    if (combo === MAX_COMBO) announce(`🔥 MAX COMBO ×${MAX_COMBO}!`, '#ff2d55');
  } else {
    comboBadge.classList.add('hidden');
  }

  return base * combo;
}

/* ──────────────────────────────────────────────────────────────────────
   Score update + high score persistence
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
    // Announce new record (at most once per food, not every point)
    if (pts >= 1) announce('🏆 NEW RECORD!', '#ffe600');
  }
}

/** Re-trigger a CSS scale-pop animation on a HUD number element. */
function triggerPop(el) {
  el.classList.remove('pop');
  void el.offsetWidth; // force reflow
  el.classList.add('pop');
}

/* ──────────────────────────────────────────────────────────────────────
   Level-up check
   ────────────────────────────────────────────────────────────────────── */
function handleLevelUp() {
  const newLevel = Math.floor(foodsEaten / FOODS_PER_LEVEL) + 1;
  if (newLevel <= level) return;
  level = newLevel;
  levelEl.textContent = level;
  triggerPop(levelEl);
  Audio.levelUp();
  announce(`LEVEL ${level}!`, COLOR.snake);

  // Spawn obstacle blocks starting from OBSTACLE_START_LEVEL
  if (level >= OBSTACLE_START_LEVEL) spawnObstacles(OBSTACLES_PER_LEVEL);
}

/* ══════════════════════════════════════════════════════════════════════
   RENDERER  (called every rAF frame at ~60 fps)
   ══════════════════════════════════════════════════════════════════════ */
function draw(now, dt = 16) {
  /* ── Grid (single drawImage blit) ──────────────────────────── */
  ctx.drawImage(gridCanvas, 0, 0);

  /* ── Obstacles ──────────────────────────────────────────────── */
  drawObstacles();

  /* ── Normal food ────────────────────────────────────────────── */
  if (food) drawCell(food.x, food.y, COLOR.food, 18);

  /* ── Bonus food (blinks near expiry) ────────────────────────── */
  if (bonusFood) {
    const rem = BONUS_LIFETIME - (now - bonusBorn);
    if (rem > BONUS_WARN_AT || Math.sin(now / 110) > 0) {
      drawCell(bonusFood.x, bonusFood.y, COLOR.bonus, 24);
    }
  }

  /* ── Field power-up (pulsing diamond) ──────────────────────── */
  if (fieldPowerup) {
    const cfg = POWERUP_CFG[fieldPowerup.type];
    drawDiamond(fieldPowerup.x, fieldPowerup.y, cfg.color, now);
  }

  /* ── Snake body ─────────────────────────────────────────────── */
  if (snake.length > 1) {
    const len      = snake.length;
    const ghostOn  = isPowerupActive('ghost');
    const bodyColor = ghostOn ? '#cc44ff' : COLOR.snake;
    const baseAlpha = ghostOn ? 0.18       : 0.4;
    const alphaRange = ghostOn ? 0.22      : 0.6;

    ctx.save();
    ctx.shadowColor = bodyColor;
    ctx.shadowBlur  = ghostOn ? 4 : 5;
    ctx.fillStyle   = bodyColor;
    for (let i = len - 1; i >= 1; i--) {
      ctx.globalAlpha = baseAlpha + alphaRange * (1 - i / len);
      const s = snake[i];
      ctx.fillRect(s.x * CELL + CELL_PAD, s.y * CELL + CELL_PAD, CELL_INNER, CELL_INNER);
    }
    ctx.restore();
  }

  /* ── Snake head ─────────────────────────────────────────────── */
  if (snake.length > 0) {
    const boostOn  = isPowerupActive('boost');
    const headGlow = boostOn ? 28 : 18;
    drawCell(snake[0].x, snake[0].y, COLOR.head, headGlow);
    drawEyes(snake[0]);

    /* Shield ring — pulsing orange halo around head */
    if (isPowerupActive('shield')) drawShieldRing(snake[0], now);

    /* Boost trail — fading motion dots behind the head */
    if (boostOn) drawBoostTrail(snake, now);
  }

  /* ── Particles ──────────────────────────────────────────────── */
  particlePool.updateAndDraw();

  /* ── Score popups ───────────────────────────────────────────── */
  for (let i = popups.length - 1; i >= 0; i--) {
    popups[i].update(); popups[i].draw();
    if (popups[i].dead) popups.splice(i, 1);
  }

  /* ── Announce text (stacked, up to 2) ──────────────────────── */
  const announceCenterY = cvs.height * 0.42;
  for (let i = announces.length - 1; i >= 0; i--) {
    announces[i].update(dt);
    announces[i].draw(announceCenterY - (announces.length - 1 - i) * 44);
    if (announces[i].dead) announces.splice(i, 1);
  }

  /* ── Active power-up HUD (canvas overlay, bottom-right) ─────── */
  drawPowerupHUD(now);
}

/* ──────────────────────────────────────────────────────────────────────
   Draw helpers
   ────────────────────────────────────────────────────────────────────── */

/** Solid neon cell at grid position (gx, gy). */
function drawCell(gx, gy, color, glow, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = color;
  ctx.shadowBlur  = glow;
  ctx.fillStyle   = color;
  ctx.fillRect(gx * CELL + CELL_PAD, gy * CELL + CELL_PAD, CELL_INNER, CELL_INNER);
  ctx.restore();
}

/** Rotating, pulsing diamond shape for a field power-up. */
function drawDiamond(gx, gy, color, now) {
  const cx = gx * CELL + CELL_HALF;
  const cy = gy * CELL + CELL_HALF;
  const s  = 6 + Math.sin(now / 250) * 1.2; // subtle size pulse
  const rot = now / 900;                      // slow continuous rotation

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4 + rot);
  ctx.shadowColor = color;
  ctx.shadowBlur  = 16 + Math.sin(now / 200) * 5;
  ctx.fillStyle   = color;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(-s, -s, s * 2, s * 2);
  ctx.restore();
}

/** Two small pupils on the head facing the current direction. */
function drawEyes(head) {
  const dx = dir.x, dy = dir.y;
  const cx = head.x * CELL + CELL_HALF;
  const cy = head.y * CELL + CELL_HALF;
  const ex = dy !== 0 ? 4 : 0;
  const ey = dx !== 0 ? 4 : 0;

  ctx.fillStyle = "red";
  ctx.beginPath();
  ctx.arc(cx + dx*4 - ey, cy + dy*4 - ex, 2.2, 0, Math.PI * 2);
  ctx.arc(cx + dx*4 + ey, cy + dy*4 + ex, 2.2, 0, Math.PI * 2);
  ctx.fill();
}

/** Pulsing orange ring drawn around the head when shield is active. */
function drawShieldRing(head, now) {
  const cx    = head.x * CELL + CELL_HALF;
  const cy    = head.y * CELL + CELL_HALF;
  const color = POWERUP_CFG.shield.color;
  const r     = CELL_HALF + 2 + Math.sin(now / 140) * 2;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur  = 8 + Math.sin(now / 140) * 4;
  ctx.lineWidth   = 2;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Fading cyan circles trailing behind the head when Boost is active. */
function drawBoostTrail(snake, now) {
  const color = POWERUP_CFG.boost.color;
  ctx.save();
  ctx.fillStyle   = color;
  ctx.shadowColor = color;
  ctx.shadowBlur  = 6;
  for (let t = 1; t <= Math.min(4, snake.length - 1); t++) {
    const s = snake[t];
    ctx.globalAlpha = (1 - t / 5) * 0.5;
    const r = (CELL_HALF - CELL_PAD - 1) * (1 - t / 6);
    ctx.beginPath();
    ctx.arc(s.x * CELL + CELL_HALF, s.y * CELL + CELL_HALF, Math.max(1, r), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Draw all obstacle blocks: dark fill + red X mark. */
function drawObstacles() {
  // Collect positions to batch state changes
  const obs = [];
  for (let i = 0; i < obstacleMap.length; i++) {
    if (obstacleMap[i]) obs.push({ x: i % COLS, y: (i / COLS) | 0 });
  }
  if (!obs.length) return;

  // Dark fill pass
  ctx.save();
  ctx.shadowColor = '#ff3300';
  ctx.shadowBlur  = 12;
  ctx.fillStyle   = '#2d0500';
  for (const o of obs)
    ctx.fillRect(o.x * CELL + CELL_PAD, o.y * CELL + CELL_PAD, CELL_INNER, CELL_INNER);

  // X mark pass
  ctx.strokeStyle = '#ff4400';
  ctx.lineWidth   = 1.5;
  ctx.globalAlpha = 0.65;
  for (const o of obs) {
    ctx.beginPath();
    ctx.moveTo(o.x * CELL + 5,          o.y * CELL + 5);
    ctx.lineTo(o.x * CELL + CELL - 5,   o.y * CELL + CELL - 5);
    ctx.moveTo(o.x * CELL + CELL - 5,   o.y * CELL + 5);
    ctx.lineTo(o.x * CELL + 5,          o.y * CELL + CELL - 5);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draw active power-up effect timers as small cards in the bottom-right
 * corner of the canvas.  One card per active effect, stacked vertically.
 */
function drawPowerupHUD(now) {
  const active = [...activePowerups.entries()]
    .filter(([, exp]) => exp > now)
    .map(([id, exp]) => ({ id, exp }));
  if (!active.length) return;

  const cardW  = 104;
  const cardH  = 20;
  const margin = 3;
  const px     = cvs.width  - cardW - 6;
  const pyBase = cvs.height - (active.length * (cardH + margin) - margin) - 6;

  ctx.save();
  active.forEach(({ id, exp }, i) => {
    const cfg = POWERUP_CFG[id];
    const pct = Math.max(0, (exp - now) / cfg.duration);
    const py  = pyBase + i * (cardH + margin);

    // Darkened background
    ctx.fillStyle   = 'rgba(5,8,16,0.72)';
    ctx.fillRect(px, py, cardW, cardH);

    // Colour fill representing remaining time
    ctx.fillStyle   = cfg.color;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(px, py, cardW * pct, cardH);

    // Label text
    ctx.globalAlpha = 0.92;
    ctx.fillStyle   = cfg.color;
    ctx.shadowColor = cfg.color;
    ctx.shadowBlur  = 5;
    ctx.font        = '9px Share Tech Mono, monospace';
    ctx.textAlign   = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${cfg.icon} ${cfg.label}`, px + 5, py + cardH / 2);
  });
  ctx.restore();
}

/* ══════════════════════════════════════════════════════════════════════
   GAME OVER
   ══════════════════════════════════════════════════════════════════════ */
function endGame() {
  gameState = STATE.OVER;
  cancelAnimationFrame(rafId);
  expireBonus();
  Audio.die();

  // CSS death flash
  arenaEl.classList.remove('flash');
  void arenaEl.offsetWidth;
  arenaEl.classList.add('flash');

  // CSS screen shake
  arenaEl.classList.remove('shake');
  void arenaEl.offsetWidth;
  arenaEl.classList.add('shake');
  setTimeout(() => arenaEl.classList.remove('shake'), 500);

  // Keep rAF alive briefly so particles / announces finish
  const endAt = performance.now() + 700;
  function linger(now) {
    draw(now, 16);
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
   KEYBOARD INPUT  (direction inputs are buffered)
   ══════════════════════════════════════════════════════════════════════ */
const KEY_TO_DIR = {
  ArrowUp:    {x:0,y:-1}, w:{x:0,y:-1}, W:{x:0,y:-1},
  ArrowDown:  {x:0,y:1},  s:{x:0,y:1},  S:{x:0,y:1},
  ArrowLeft:  {x:-1,y:0}, a:{x:-1,y:0}, A:{x:-1,y:0},
  ArrowRight: {x:1,y:0},  d:{x:1,y:0},  D:{x:1,y:0},
};

document.addEventListener('keydown', e => {
  const k = e.key;

  if (k === 'r' || k === 'R') {
    if (gameState !== STATE.PLAYING) init();
    return;
  }

  if (k === 'p' || k === 'P') {
    if (gameState === STATE.PLAYING) {
      gameState = STATE.PAUSED;
      showOverlay('PAUSED', 'Press P or click Resume', 'RESUME');
    } else if (gameState === STATE.PAUSED) {
      gameState   = STATE.PLAYING;
      lastTickAt  = performance.now();
      lastFrameAt = performance.now();
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
   TOUCH / SWIPE
   ══════════════════════════════════════════════════════════════════════ */
let touchX = 0, touchY = 0;
document.addEventListener('touchstart', e => {
  touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;
  if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
  const d = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? {x:1,y:0} : {x:-1,y:0})
    : (dy > 0 ? {x:0,y:1} : {x:0,y:-1});
  if (dirQueue.length < DIR_BUFFER_SIZE) dirQueue.push(d);
}, { passive: true });

/* ══════════════════════════════════════════════════════════════════════
   UI BUTTON LISTENERS
   ══════════════════════════════════════════════════════════════════════ */

btnStart.addEventListener('click', () => {
  if (gameState === STATE.PAUSED) {
    gameState   = STATE.PLAYING;
    lastTickAt  = performance.now();
    lastFrameAt = performance.now();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(renderLoop);
    hideOverlay();
  } else {
    init();
  }
});

// Speed + wall buttons via event delegation
document.getElementById('toolbar').addEventListener('click', e => {
  const speedBtn = e.target.closest('.opt-btn[data-spd]');
  if (speedBtn) {
    document.querySelectorAll('.opt-btn[data-spd]').forEach(b => b.classList.remove('active'));
    speedBtn.classList.add('active');
    baseSpeed = parseInt(speedBtn.dataset.spd, 10);
    return;
  }
});

wrapBtn.addEventListener('click', () => {
  wallWrap = !wallWrap;
  wrapBtn.querySelector('span').textContent = wallWrap ? 'WRAP' : 'SOLID';
  wrapBtn.classList.toggle('active', wallWrap);
});

/** Apply a skin preset: update canvas colours and arena border. */
function applySkin(skinId) {
  const skin = SKINS[skinId] || SKINS.green;
  COLOR.snake = skin.snake;
  COLOR.head  = skin.head;
  arenaEl.style.borderColor = skin.snake;
  arenaEl.style.boxShadow   =
    `0 0 14px ${skin.snake}, 0 0 44px ${skin.snake}33, inset 0 0 28px ${skin.snake}0a`;
}

// Skin colour picker
document.querySelectorAll('.skin-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.skin-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applySkin(btn.dataset.skin);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════ */
(function boot() {
  ctx.drawImage(gridCanvas, 0, 0);
  showOverlay(
    'SNAKE',
    'Eat food to grow.<br>'
    + '⭐ Bonus food = more points!<br>'
    + '💎 Diamonds = power-ups!<br>'
    + '🔥 Eat quickly to combo!',
    'START GAME'
  );
})();
