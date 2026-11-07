// Bricks — the panel. All rules live in ./.logic.ts (unit-tested, no DOM); everything here is
// rendering, input and persistence: drawing the canvas, driving the fixed-step simulation off
// real frame time, keyboard/mouse/touch input, power-up visuals, lives/score/best, and pause.

import {
  BALL_RADIUS,
  HEIGHT,
  LIVES_START,
  PADDLE_HEIGHT,
  PADDLE_Y,
  POWERUP_SIZE,
  WIDTH,
  createLevelState,
  stepGame,
  type GameState,
  type PowerUpType,
} from "./.logic.js";

interface Ctx {
  dashboard: string;
  api: { base: string | null; get(path: string): Promise<unknown> };
  panel(title?: string): HTMLElement;
}

const BEST_KEY = "adi.gamebricks.best";

const POWERUP_COLORS: Record<PowerUpType, string> = {
  wide: "#4CB77A",
  multiball: "#E0A84B",
  slow: "#5B9BD5",
};

const POWERUP_LABELS: Record<PowerUpType, string> = {
  wide: "W",
  multiball: "M",
  slow: "S",
};

function brickColor(hp: number, maxHp: number): string {
  // Same hue family as the ADI accent, graded darker->brighter by remaining hit points, so a
  // multi-hit brick visibly changes as it takes damage.
  const palette = ["#6F6C67", "#F2B179", "#F65E3B", "#E8532A"];
  return palette[Math.min(palette.length - 1, hp - 1)] ?? palette[0];
}

function loadBest(): number {
  const raw = Number(localStorage.getItem(BEST_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function saveBest(value: number) {
  localStorage.setItem(BEST_KEY, String(value));
}

export default async function gameBricks(ctx: Ctx) {
  const root = ctx.panel("Bricks");
  root.classList.add("gbricks");
  injectStyles();

  root.innerHTML = `
    <div class="gbricks__head">
      <div class="gbricks__scores">
        <div class="gbricks__score"><span>score</span><strong data-score>0</strong></div>
        <div class="gbricks__score"><span>best</span><strong data-best>0</strong></div>
        <div class="gbricks__score"><span>level</span><strong data-level>1</strong></div>
        <div class="gbricks__score"><span>lives</span><strong data-lives>3</strong></div>
      </div>
      <div class="gbricks__actions">
        <button type="button" class="gbricks__btn" data-pause>Pause</button>
        <button type="button" class="gbricks__btn" data-new>New game</button>
      </div>
    </div>
    <p class="gbricks__hint">Arrows / A D or drag to move. Space to pause.</p>
    <div class="gbricks__stage">
      <canvas data-canvas></canvas>
      <div class="gbricks__overlay" data-overlay hidden>
        <div class="gbricks__overlay-card">
          <p data-overlay-text></p>
          <div class="gbricks__overlay-actions">
            <button type="button" data-resume hidden>Resume</button>
            <button type="button" data-restart>New game</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const scoreEl = root.querySelector<HTMLElement>("[data-score]")!;
  const bestEl = root.querySelector<HTMLElement>("[data-best]")!;
  const levelEl = root.querySelector<HTMLElement>("[data-level]")!;
  const livesEl = root.querySelector<HTMLElement>("[data-lives]")!;
  const stageEl = root.querySelector<HTMLElement>(".gbricks__stage")!;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-canvas]")!;
  const overlayEl = root.querySelector<HTMLElement>("[data-overlay]")!;
  const overlayTextEl = root.querySelector<HTMLElement>("[data-overlay-text]")!;
  const resumeBtn = root.querySelector<HTMLButtonElement>("[data-resume]")!;
  const pauseBtn = root.querySelector<HTMLButtonElement>("[data-pause]")!;
  const g = canvas.getContext("2d")!;

  let best = loadBest();
  bestEl.textContent = String(best);

  let state: GameState = createLevelState(0, 0, LIVES_START, Math.random);
  let paddleTargetX = state.paddle.x;
  let running = false; // the simulation is advancing
  let paused = false;
  let over = false;
  let flashUntil = 0; // brief screen flash timestamp, for a life lost

  function showOverlay(text: string, offerResume: boolean) {
    overlayTextEl.textContent = text;
    resumeBtn.hidden = !offerResume;
    overlayEl.hidden = false;
  }

  function hideOverlay() {
    overlayEl.hidden = true;
  }

  function start() {
    state = createLevelState(0, 0, LIVES_START, Math.random);
    paddleTargetX = state.paddle.x;
    over = false;
    paused = false;
    running = true;
    pauseBtn.textContent = "Pause";
    hideOverlay();
    refreshHud();
  }

  function refreshHud() {
    scoreEl.textContent = String(state.score);
    levelEl.textContent = String(state.level + 1);
    livesEl.textContent = String(state.lives);
    if (state.score > best) {
      best = state.score;
      bestEl.textContent = String(best);
      saveBest(best);
    }
  }

  function setPaused(next: boolean) {
    if (over) return;
    paused = next;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    if (paused) showOverlay("Paused", true);
    else hideOverlay();
  }

  // --- Canvas sizing: the simulation runs in a fixed WIDTH x HEIGHT board; the canvas scales to
  // whatever the panel's actual width is, keeping the board's aspect ratio. ---
  function resize() {
    const cssWidth = stageEl.clientWidth;
    const scale = cssWidth / WIDTH;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssWidth * (HEIGHT / WIDTH)}px`;
    canvas.width = Math.round(WIDTH * scale * dpr);
    canvas.height = Math.round(HEIGHT * scale * dpr);
    g.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  }

  // --- Input ---
  function isTyping(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }

  const heldKeys = new Set<string>();
  function onKeydown(ev: KeyboardEvent) {
    if (!root.isConnected) return;
    if (isTyping()) return;
    if (ev.key === " ") {
      ev.preventDefault();
      if (!over) setPaused(!paused);
      return;
    }
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (["ArrowLeft", "ArrowRight", "a", "d"].includes(key)) {
      ev.preventDefault();
      heldKeys.add(key);
    }
  }
  function onKeyup(ev: KeyboardEvent) {
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    heldKeys.delete(key);
  }

  function boardXFromClientX(clientX: number): number {
    const rect = canvas.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return ratio * WIDTH;
  }

  function onPointerMove(ev: PointerEvent) {
    paddleTargetX = boardXFromClientX(ev.clientX);
  }
  function onTouchMove(ev: TouchEvent) {
    const t = ev.touches[0];
    if (!t) return;
    paddleTargetX = boardXFromClientX(t.clientX);
  }

  window.addEventListener("keydown", onKeydown);
  window.addEventListener("keyup", onKeyup);
  stageEl.addEventListener("pointermove", onPointerMove);
  stageEl.addEventListener("touchmove", onTouchMove as EventListener, { passive: true });
  stageEl.addEventListener(
    "touchstart",
    ((ev: TouchEvent) => {
      const t = ev.touches[0];
      if (t) paddleTargetX = boardXFromClientX(t.clientX);
    }) as EventListener,
    { passive: true },
  );
  window.addEventListener("resize", resize);

  root.querySelector("[data-new]")!.addEventListener("click", start);
  root.querySelector("[data-restart]")!.addEventListener("click", start);
  pauseBtn.addEventListener("click", () => setPaused(!paused));
  resumeBtn.addEventListener("click", () => setPaused(false));

  const KEY_SPEED = 320; // board units/second when steering by keyboard

  // --- The loop. requestAnimationFrame gives real elapsed time, clamped so a backgrounded tab
  // (or a debugger pause) resuming after seconds away doesn't fling the ball across half the
  // board in one giant step — stepGame's own substepping handles ordinary frame variance, this
  // guards the pathological case of a multi-second gap. ---
  let lastTime: number | null = null;
  const MAX_DT = 1 / 15;

  function frame(now: number) {
    if (!root.isConnected) return; // panel was torn down
    const dt = lastTime === null ? 0 : Math.min(MAX_DT, (now - lastTime) / 1000);
    lastTime = now;

    if (running && !paused && !over && dt > 0) {
      if (heldKeys.has("ArrowLeft") || heldKeys.has("a")) paddleTargetX -= KEY_SPEED * dt;
      if (heldKeys.has("ArrowRight") || heldKeys.has("d")) paddleTargetX += KEY_SPEED * dt;

      const before = state;
      const { state: nextState, events } = stepGame(state, dt, paddleTargetX);
      state = nextState;
      refreshHud();

      for (const event of events) {
        if (event.type === "lifeLost") {
          flashUntil = now + 220;
        } else if (event.type === "levelCleared") {
          state = createLevelState(state.level + 1, state.score, state.lives, Math.random);
          paddleTargetX = state.paddle.x;
          refreshHud();
        } else if (event.type === "gameOver") {
          over = true;
          running = false;
          showOverlay(`Game over — score ${before.score}`, false);
        }
      }
    }

    draw(now);
    requestAnimationFrame(frame);
  }

  function draw(now: number) {
    g.clearRect(0, 0, WIDTH, HEIGHT);

    const flashing = now < flashUntil;
    g.fillStyle = flashing ? "rgba(226,92,92,0.15)" : "transparent";
    if (flashing) g.fillRect(0, 0, WIDTH, HEIGHT);

    // Bricks
    for (const brick of state.bricks) {
      g.fillStyle = brickColor(brick.hp, brick.maxHp);
      g.beginPath();
      roundRect(g, brick.x, brick.y, brick.w, brick.h, 3);
      g.fill();
    }

    // Power-ups
    for (const powerUp of state.powerUps) {
      g.fillStyle = POWERUP_COLORS[powerUp.type];
      g.beginPath();
      roundRect(
        g,
        powerUp.x - POWERUP_SIZE / 2,
        powerUp.y - POWERUP_SIZE / 2,
        POWERUP_SIZE,
        POWERUP_SIZE,
        4,
      );
      g.fill();
      g.fillStyle = "#101010";
      g.font = "700 10px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(POWERUP_LABELS[powerUp.type], powerUp.x, powerUp.y + 0.5);
    }

    // Paddle
    g.fillStyle = "#ECEAE6";
    roundRectPath(g, state.paddle.x - state.paddle.width / 2, PADDLE_Y, state.paddle.width, PADDLE_HEIGHT, 4);
    g.fill();

    // Balls
    g.fillStyle = "#E8532A";
    for (const ball of state.balls) {
      g.beginPath();
      g.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
      g.fill();
    }
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    roundRectPath(ctx, x, y, w, h, r);
  }

  function roundRectPath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  resize();
  start();
  requestAnimationFrame(frame);
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .gbricks__head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      margin-bottom: 4px; flex-wrap: wrap;
    }
    .gbricks__scores { display: flex; gap: 10px; flex-wrap: wrap; }
    .gbricks__score {
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      min-width: 52px; padding: 6px 10px; border-radius: var(--r, 6px);
      background: var(--bg-raise, #1E1E1E); border: 1px solid var(--line, rgba(255,255,255,.07));
    }
    .gbricks__score span {
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
      color: var(--ink-3, #6F6C67);
    }
    .gbricks__score strong {
      font: 600 16px var(--mono, ui-monospace, monospace); color: var(--ink, #ECEAE6);
      font-variant-numeric: tabular-nums;
    }
    .gbricks__actions { display: flex; gap: 8px; }
    .gbricks__btn {
      border: 1px solid var(--line-strong, rgba(255,255,255,.13)); background: var(--bg-raise, #1E1E1E);
      color: var(--ink, #ECEAE6); border-radius: var(--r, 6px); padding: 8px 14px;
      font: 500 13.5px var(--sans, system-ui, sans-serif); cursor: pointer;
    }
    .gbricks__btn:hover { background: var(--bg-active, #232323); }
    .gbricks__hint { margin: 0 0 12px; color: var(--ink-3, #6F6C67); font-size: 12.5px; }
    .gbricks__stage {
      position: relative; width: 100%; max-width: 420px; aspect-ratio: ${WIDTH} / ${HEIGHT};
      margin: 0 auto; touch-action: none; user-select: none;
      background: var(--bg-side, #101010); border-radius: 10px; overflow: hidden;
    }
    .gbricks__stage canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
    .gbricks__overlay {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      background: color-mix(in srgb, var(--bg-side, #101010) 72%, transparent);
      border-radius: 10px;
    }
    /* \`display: flex\` above has the same specificity as the UA's \`[hidden] { display: none }\`,
       and an author rule always outranks a UA one regardless of order — so without this the
       overlay would render permanently, \`hidden\` or not (shipped as a real bug in game-2048). */
    .gbricks__overlay[hidden] { display: none; }
    .gbricks__overlay-card { text-align: center; padding: 0 16px; }
    .gbricks__overlay-card p {
      margin: 0 0 14px; font: 600 20px var(--sans, system-ui, sans-serif); color: var(--ink, #ECEAE6);
    }
    .gbricks__overlay-actions { display: flex; gap: 8px; justify-content: center; }
    .gbricks__overlay-actions button {
      border: 1px solid var(--line-strong, rgba(255,255,255,.13)); background: var(--accent, #E8532A);
      color: #fff; border-radius: var(--r, 6px); padding: 8px 14px; cursor: pointer;
      font: 500 13.5px var(--sans, system-ui, sans-serif);
    }
    .gbricks__overlay-actions button[data-restart] { background: var(--bg-raise, #1E1E1E); color: var(--ink, #ECEAE6); }
  `;
  document.head.append(style);
}
