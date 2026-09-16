(() => {
  "use strict";

  const W = 960;
  const H = 540;
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  // Sprite de la cabeza generado por IA (alta fidelidad). Se dibuja
  // sobre el rig del héroe; si aun no carga, se usa el dibujo vectorial.
  const headSprite = new Image();
  headSprite.onload = () => { headSprite._ready = true; };
  headSprite.src = (window.__HEAD_SPRITE) || "assets/heroe-cabeza.png";
  // Algunos navegadores headless no disparan onload para data URIs grandes;
  // por eso marcamos _ready tan pronto como la imagen este completa.
  const markReady = () => {
    if (headSprite.complete && headSprite.naturalWidth > 0) headSprite._ready = true;
    else setTimeout(markReady, 50);
  };
  setTimeout(markReady, 0);
  window.__headSprite = headSprite;

  // Sprite de la hombrera generado por IA (alta fidelidad).
  const pauldronSprite = new Image();
  pauldronSprite.onload = () => { pauldronSprite._ready = true; };
  pauldronSprite.src = (window.__PAULDRON_SPRITE) || "assets/heroe-hombrera.png";
  const markPauldronReady = () => {
    if (pauldronSprite.complete && pauldronSprite.naturalWidth > 0) pauldronSprite._ready = true;
    else setTimeout(markPauldronReady, 50);
  };
  setTimeout(markPauldronReady, 0);
  window.__pauldronSprite = pauldronSprite;


  // El lienzo lógico mide 960x540, pero el búfer se dibuja a la densidad real
  // de la pantalla para que el detalle vectorial no se pierda al estirarlo.
  let pixelScale = 1;
  // Levanta el suelo sobre el borde inferior para que el piso no quede
  // pegado a la pantalla y se vea un marco de adoquín abajo.
  const VIEW_LIFT = 34;

  function fitBuffer() {
    // Tamaño visible del viewport en CSS px. En móvil girado el viewport
    // no es 16:9, asi que hay que letterboxear (no estirar el lienzo).
    const root = document.documentElement || {};
    const vw = root.clientWidth || window.innerWidth || W;
    const vh = root.clientHeight || window.innerHeight || H;
    // Caja 16:9 que cabe en el viewport (letterbox).
    let scale = Math.min(vw / W, vh / H);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    const dispW = W * scale;
    const dispH = H * scale;
    // Buffer a la densidad real de esa caja (nitido en retina).
    const dpr = window.devicePixelRatio || 1;
    const next = Math.min(3, Math.max(1, Math.round(scale * dpr * 100) / 100));
    if (
      Math.abs(next - pixelScale) < 0.05 &&
      canvas.style.width === dispW + "px" &&
      canvas.style.height === dispH + "px"
    ) return;
    pixelScale = next;
    canvas.width = Math.round(W * pixelScale);
    canvas.height = Math.round(H * pixelScale);
    // Fija el tamaño de presentacion en px (letterbox centrado por #app).
    canvas.style.width = dispW + "px";
    canvas.style.height = dispH + "px";
  }

  // Vuelve al sistema de coordenadas lógico, con el temblor de cámara y el
  // levantamiento del suelo aplicados (lo usan el mundo y el fondo).
  function baseTransform(sx, sy) {
    ctx.setTransform(pixelScale, 0, 0, pixelScale, (sx || 0) * pixelScale, ((sy || 0) - VIEW_LIFT) * pixelScale);
  }

  // Coordenadas de pantalla puras, sin levantar: viñeta y HUD del jefe.
  function screenTransform(sx, sy) {
    ctx.setTransform(pixelScale, 0, 0, pixelScale, (sx || 0) * pixelScale, (sy || 0) * pixelScale);
  }

  const overlay = document.getElementById("overlay");
  const panelStart = document.getElementById("panel-start");
  const panelDead = document.getElementById("panel-dead");
  const panelWin = document.getElementById("panel-win");
  const hud = document.getElementById("hud");
  const heartsEl = document.getElementById("hearts");
  const manaFillEl = document.getElementById("mana-fill");
  const manaValueEl = document.getElementById("mana-value");
  const crossBtnEl = document.getElementById("btn-cross");

  const CROSS_COST = 22;
  const MANA_REGEN = 10.5;
  const CROSS_RANGE = 620;
  const PLAYER_H = 38;
  const SLIDE_H = 21;
  const SWORD_DMG = 2;
  const CROSS_DMG = 1;
  const winStatsEl = document.getElementById("win-stats");
  const touchEl = document.getElementById("touch");

  const keys = Object.create(null);
  const held = { left: false, right: false, jump: false, attack: false, cross: false };
  const edge = { jump: false, attack: false, cross: false };

  let audioCtx = null;
  let state = "menu";
  let lastT = 0;
  let shake = 0;
  let time = 0;
  let world = null;

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function ensureAudio() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
  }

  function tone(freq, dur, type, vol, slide) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type || "square";
    o.frequency.setValueAtTime(freq, audioCtx.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, audioCtx.currentTime + dur);
    g.gain.setValueAtTime(vol || 0.05, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  }

  const sfx = {
    jump: () => tone(320, 0.09, "square", 0.04, 180),
    wings: () => {
      tone(180, 0.22, "sawtooth", 0.05, 420);
      tone(520, 0.16, "triangle", 0.03, 900);
    },
    slash: () => tone(220, 0.08, "sawtooth", 0.045, 80),
    hit: () => tone(90, 0.14, "square", 0.06, 40),
    hurt: () => tone(140, 0.2, "sawtooth", 0.07, 50),
    pickup: () => tone(520, 0.12, "triangle", 0.05, 880),
    cross: () => {
      tone(880, 0.14, "triangle", 0.04, 1320);
      tone(1320, 0.1, "sine", 0.03, 1760);
    },
    empty: () => tone(220, 0.09, "sine", 0.025, 150),
    dash: () => tone(420, 0.16, "sawtooth", 0.035, 140),
    exorcism: () => {
      tone(1046, 0.32, "sine", 0.05, 1568);
      setTimeout(() => tone(1568, 0.4, "triangle", 0.035, 2093), 90);
    },
    death: () => tone(80, 0.4, "sawtooth", 0.07, 30),
    win: () => {
      tone(440, 0.18, "triangle", 0.05, 660);
      setTimeout(() => tone(660, 0.28, "triangle", 0.05, 880), 140);
    },
    boss: () => tone(55, 0.45, "sawtooth", 0.08, 28),
  };

  function makeLevel() {
    const platforms = [
      { x: 0, y: 500, w: 640, h: 74, kind: "street" },
      { x: 780, y: 500, w: 420, h: 74, kind: "street" },
      { x: 700, y: 410, w: 90, h: 22, kind: "balcony" },
      { x: 1260, y: 500, w: 280, h: 74, kind: "street" },
      { x: 1188, y: 360, w: 86, h: 20, kind: "roof" },
      { x: 1580, y: 430, w: 140, h: 22, kind: "balcony" },
      { x: 1760, y: 340, w: 130, h: 22, kind: "roof" },
      { x: 1940, y: 250, w: 220, h: 24, kind: "roof" },
      { x: 1940, y: 500, w: 520, h: 74, kind: "street" },
      { x: 2280, y: 400, w: 130, h: 20, kind: "balcony" },
      { x: 2430, y: 440, w: 80, h: 16, kind: "balcony" },
      { x: 2520, y: 500, w: 120, h: 74, kind: "street" },
      { x: 2660, y: 430, w: 110, h: 20, kind: "balcony" },
      { x: 2800, y: 350, w: 110, h: 20, kind: "roof" },
      { x: 2960, y: 270, w: 160, h: 22, kind: "roof" },
      { x: 3180, y: 500, w: 260, h: 74, kind: "street" },
      { x: 3480, y: 430, w: 120, h: 22, kind: "balcony" },
      { x: 3640, y: 500, w: 860, h: 74, kind: "atrium" },
      { x: 4460, y: 80, w: 40, h: 420, kind: "wall" },
    ];

    const spikes = [
      { x: 640, y: 528, w: 140 },
      { x: 1200, y: 528, w: 60 },
      { x: 2460, y: 528, w: 60 },
      { x: 2600, y: 528, w: 60 },
      { x: 2750, y: 528, w: 50 },
      { x: 3440, y: 528, w: 40 },
    ];

    const enemies = [
      { type: "imp", x: 860, y: 466 },
      { type: "imp", x: 1080, y: 466 },
      { type: "imp", x: 1360, y: 466 },
      { type: "flyer", x: 1700, y: 220 },
      { type: "flyer", x: 2050, y: 140 },
      { type: "imp", x: 2140, y: 466 },
      { type: "imp", x: 2320, y: 466 },
      { type: "flyer", x: 2780, y: 180 },
      { type: "imp", x: 3240, y: 466 },
      { type: "flyer", x: 3380, y: 260 },
    ];

    const pickups = [
      { x: 1218, y: 322, kind: "heart" },
      { x: 2030, y: 212, kind: "heart" },
      { x: 3010, y: 232, kind: "heart" },
    ];

    const signs = [
      { x: 180, y: 430, text: "◀ ▶  recorre las calles de Angelópolis" },
      { x: 520, y: 430, text: "Salto  ·  en el aire, otra vez" },
      { x: 1640, y: 360, text: "Las alas nacen en el segundo salto" },
      { x: 2180, y: 430, text: "✝  lanza cruces y exorciza a distancia" },
      { x: 3240, y: 430, text: "⚔  el acero para los que se acercan" },
      { x: 3760, y: 430, text: "La catedral está profanada" },
    ];

    const props = [
      { type: "lantern", x: 250, y: 500 },
      { type: "stonecross", x: 430, y: 500 },
      { type: "lantern", x: 1000, y: 500 },
      { type: "shrine", x: 1430, y: 500 },
      { type: "lantern", x: 2000, y: 500 },
      { type: "stonecross", x: 2210, y: 500 },
      { type: "lantern", x: 2340, y: 500 },
      { type: "shrine", x: 3300, y: 500 },
      { type: "lantern", x: 3410, y: 500 },
      { type: "lantern", x: 3860, y: 500 },
      { type: "stonecross", x: 4380, y: 500 },
    ];

    return {
      width: 4500,
      height: H,
      spawn: { x: 70, y: 462 },
      platforms,
      spikes,
      enemyBlueprints: enemies,
      pickupBlueprints: pickups,
      signs,
      props,
      arenaX: 3680,
    };
  }

  function spawnEnemies(level) {
    return level.enemyBlueprints.map((e) => {
      if (e.type === "imp") {
        return {
          type: "imp",
          x: e.x,
          y: e.y,
          w: 28,
          h: 34,
          vx: 50 * (Math.random() < 0.5 ? -1 : 1),
          vy: 0,
          hp: 3,
          maxHp: 3,
          hurt: 0,
          alive: true,
          flash: 0,
          home: e.x,
          attackCd: 0,
        };
      }
      return {
        type: "flyer",
        x: e.x,
        y: e.y,
        w: 30,
        h: 24,
        vx: 0,
        vy: 0,
        hp: 2,
        maxHp: 2,
        hurt: 0,
        alive: true,
        flash: 0,
        baseY: e.y,
        phase: Math.random() * Math.PI * 2,
        dive: 0,
      };
    });
  }

  function spawnPickups(level) {
    return level.pickupBlueprints.map((p) => ({
      x: p.x,
      y: p.y,
      w: 16,
      h: 16,
      kind: p.kind,
      taken: false,
      bob: Math.random() * 6,
    }));
  }

  function makeBoss() {
    return {
      type: "boss",
      name: "Vorath, el Umbral",
      x: 4100,
      y: 300,
      w: 78,
      h: 110,
      vx: 0,
      vy: 0,
      hp: 18,
      maxHp: 18,
      alive: true,
      facing: -1,
      hurt: 0,
      flash: 0,
      mode: "intro",
      timer: 1.4,
      slam: 0,
      projectiles: [],
    };
  }

  function makePlayer(level) {
    return {
      x: level.spawn.x,
      y: level.spawn.y,
      w: 22,
      h: PLAYER_H,
      vx: 0,
      vy: 0,
      facing: 1,
      onGround: false,
      jumps: 2,
      jumpHeld: false,
      coyote: 0,
      buffer: 0,
      wings: 0,
      winged: false,
      attack: 0,
      attackCd: 0,
      hp: 4,
      maxHp: 4,
      invuln: 0,
      anim: 0,
      dead: false,
      landDust: 0,
      safeX: level.spawn.x,
      safeY: level.spawn.y,
      mana: 100,
      maxMana: 100,
      crossCd: 0,
      cast: 0,
      shield: 0,
      dash: 0,
      dashCd: 0,
      dashDir: 1,
      tapDir: 0,
      tapTime: -9,
    };
  }

  function resetWorld() {
    const level = makeLevel();
    world = {
      level,
      player: makePlayer(level),
      enemies: spawnEnemies(level),
      pickups: spawnPickups(level),
      particles: [],
      holy: [],
      rings: [],
      exorcised: 0,
      lock: null,
      cam: { x: 0, y: 0 },
      boss: null,
      arenaLock: false,
      winTimer: 0,
    };
    renderHearts();
    renderMana();
  }

  function renderHearts() {
    if (!world) return;
    const p = world.player;
    heartsEl.innerHTML = "";
    for (let i = 0; i < p.maxHp; i++) {
      const d = document.createElement("div");
      d.className = "heart" + (i < p.hp ? "" : " empty");
      d.textContent = "♥";
      heartsEl.appendChild(d);
    }
  }

  let manaShown = -1;

  function renderMana() {
    if (!world) return;
    const p = world.player;
    const pct = Math.round(clamp(p.mana / p.maxMana, 0, 1) * 100);
    if (pct === manaShown) return;
    manaShown = pct;
    manaFillEl.style.width = pct + "%";
    manaValueEl.textContent = String(Math.floor(p.mana));
    if (crossBtnEl) crossBtnEl.classList.toggle("no-mana", p.mana < CROSS_COST);
  }

  function burst(x, y, color, n, speed, life) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(speed * 0.3, speed);
      world.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 40,
        life: life || rand(0.25, 0.7),
        max: life || 0.55,
        size: rand(1.5, 4),
        color,
        g: 420,
      });
    }
  }

  function featherBurst(x, y) {
    for (let i = 0; i < 10; i++) {
      world.particles.push({
        x,
        y,
        vx: rand(-80, 80),
        vy: rand(-160, -20),
        life: rand(0.5, 1),
        max: 0.9,
        size: rand(3, 6),
        color: i % 2 ? "#fff6d8" : "#e8c872",
        g: 180,
      });
    }
  }

  function tryJump(p) {
    p.buffer = 0.12;
    if (p.onGround || p.coyote > 0) {
      p.vy = -700;
      p.onGround = false;
      p.coyote = 0;
      p.jumps = 1;
      p.buffer = 0;
      p.jumpHeld = true;
      p.winged = false;
      sfx.jump();
      burst(p.x + p.w / 2, p.y + p.h, "#cfc6b4", 6, 90, 0.3);
      return;
    }
    if (p.jumps > 0) {
      p.vy = -740;
      p.jumps = 0;
      p.buffer = 0;
      p.jumpHeld = true;
      p.winged = true;
      p.wings = 1.6;
      sfx.wings();
      featherBurst(p.x + p.w / 2, p.y + 10);
    }
  }

  // Doble toque en la misma dirección: derrape para colarse bajo el enemigo.
  function registerTap(dir) {
    if (state !== "play" || !world) return;
    const p = world.player;
    if (p.dead) return;
    if (p.tapDir === dir && time - p.tapTime < 0.32) {
      p.tapTime = -9;
      startDash(p, dir);
    } else {
      p.tapDir = dir;
      p.tapTime = time;
    }
  }

  function setCrouch(p, on) {
    if (on) {
      if (p.h === SLIDE_H) return true;
      p.y += PLAYER_H - SLIDE_H;
      p.h = SLIDE_H;
      return true;
    }
    if (p.h === PLAYER_H) return true;
    const box = { x: p.x, y: p.y - (PLAYER_H - SLIDE_H), w: p.w, h: PLAYER_H };
    for (const pl of world.level.platforms) {
      if (aabb(box, pl)) return false;
    }
    p.y = box.y;
    p.h = PLAYER_H;
    return true;
  }

  function startDash(p, dir) {
    if (p.dash > 0 || p.dashCd > 0) return;
    p.dash = 0.28;
    p.dashCd = 0.62;
    p.dashDir = dir;
    p.facing = dir;
    setCrouch(p, true);
    sfx.dash();
    burst(p.x + p.w / 2 - dir * 10, p.y + p.h - 3, "#cfc6b4", 10, 130, 0.35);
  }

  function damagePlayer(p, srcX, kind) {
    // Durante el derrape atraviesa cuerpos, pero las púas y golpes siguen doliendo.
    if (p.dash > 0 && kind === "contact") return;
    if (p.invuln > 0 || p.dead) return;
    p.hp -= 1;
    p.invuln = 1.05;
    p.shield = 0.55;
    p.vy = -280;
    p.vx = srcX < p.x ? 220 : -220;
    shake = 10;
    sfx.hurt();
    burst(p.x + p.w / 2, p.y + p.h / 2, "#c43c4a", 12, 180, 0.45);
    renderHearts();
    if (p.hp <= 0) {
      p.dead = true;
      p.hp = 0;
      sfx.death();
      burst(p.x + p.w / 2, p.y + p.h / 2, "#f4efe4", 22, 260, 0.8);
      setTimeout(() => {
        if (state === "play" && world && world.player.dead && world.winTimer <= 0) showDead();
      }, 700);
    }
  }

  function killEnemy(e) {
    e.alive = false;
    sfx.hit();
    const col = e.type === "flyer" ? "#7b2d3a" : "#8b1e1e";
    burst(e.x + e.w / 2, e.y + e.h / 2, col, 16, 200, 0.5);
    burst(e.x + e.w / 2, e.y + e.h / 2, "#2a0a10", 8, 120, 0.4);
  }

  function damageEnemy(e, amount, holy, fromX) {
    e.hp -= amount;
    e.hurt = holy ? 0.18 : 0.22;
    e.flash = 0.12;
    e.vx = (e.x + e.w / 2 > fromX ? 1 : -1) * (holy ? 110 : 140);
    if (e.hp <= 0) {
      if (holy) exorcise(e);
      else killEnemy(e);
      return;
    }
    if (holy) {
      sfx.cross();
      holyRing(e.x + e.w / 2, e.y + e.h / 2, 40, "rgba(255,238,186,");
      burst(e.x + e.w / 2, e.y + e.h / 2, "#fff3cf", 10, 160, 0.4);
    } else {
      sfx.hit();
      burst(e.x + e.w / 2, e.y + e.h / 2, "#f4efe4", 7, 150, 0.3);
    }
  }

  // Demonio vivo más cercano en la dirección a la que mira el jugador.
  function nearestDemon(x, y, maxDist, dir) {
    let best = null;
    let bestD = maxDist * maxDist;
    const consider = (t) => {
      const dx = t.x + t.w / 2 - x;
      const dy = t.y + t.h / 2 - y;
      if (dir && dx * dir < -6) return;
      if (Math.abs(dy) > 260) return;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    };
    for (const e of world.enemies) {
      if (e.alive) consider(e);
    }
    const b = world.boss;
    if (b && b.alive && b.mode !== "intro") consider(b);
    return best;
  }

  function holyRing(x, y, radius, color) {
    world.rings.push({ x, y, r: 6, max: radius, life: 0.5, maxLife: 0.5, color });
  }

  function exorcise(e) {
    const cx = e.x + e.w / 2;
    const cy = e.y + e.h / 2;
    e.alive = false;
    world.exorcised += 1;
    sfx.exorcism();
    holyRing(cx, cy, 70, "rgba(255,240,190,");
    burst(cx, cy, "#fff6d8", 18, 210, 0.65);
    burst(cx, cy, "#e8c872", 12, 150, 0.8);
    for (let i = 0; i < 12; i++) {
      world.particles.push({
        x: cx + rand(-8, 8),
        y: cy + rand(-6, 6),
        vx: rand(-24, 24),
        vy: rand(-220, -90),
        life: rand(0.6, 1.1),
        max: 1.1,
        size: rand(2, 5),
        color: i % 3 === 0 ? "#ffffff" : "#ffe9a8",
        g: -40,
      });
    }
  }

  function damageBoss(b, amount, fromX, holy) {
    b.hp -= amount;
    b.hurt = holy ? 0.2 : 0.28;
    b.flash = 0.14;
    b.vx = (b.x > fromX ? 1 : -1) * (holy ? 60 : 90);
    shake = holy ? 9 : 7;
    if (holy) {
      sfx.cross();
      holyRing(b.x + b.w / 2, b.y + 50, 80, "rgba(255,236,180,");
      burst(b.x + b.w / 2, b.y + 46, "#fff3cf", 14, 200, 0.5);
    } else {
      sfx.hit();
      burst(b.x + b.w / 2, b.y + 40, "#ff6a4a", 10, 180, 0.35);
    }
    if (b.hp <= 0) {
      b.hp = 0;
      b.alive = false;
      sfx.boss();
      sfx.exorcism();
      holyRing(b.x + b.w / 2, b.y + b.h / 2, 220, "rgba(255,245,210,");
      burst(b.x + b.w / 2, b.y + b.h / 2, "#c43c4a", 40, 280, 0.9);
      burst(b.x + b.w / 2, b.y + b.h / 2, "#e8c872", 22, 220, 0.9);
      world.exorcised += 1;
      world.winTimer = 1.8;
    }
  }

  function throwCross(p) {
    if (p.crossCd > 0 || p.dead) return;
    if (p.mana < CROSS_COST) {
      p.crossCd = 0.25;
      sfx.empty();
      return;
    }
    p.mana -= CROSS_COST;
    p.crossCd = 0.34;
    p.cast = 0.26;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    // Apunta una sola vez, al lanzarla: después vuela recto.
    const target = nearestDemon(cx, cy, CROSS_RANGE, p.facing);
    let vx = p.facing * 430;
    let vy = 0;
    if (target) {
      const dx = target.x + target.w / 2 - cx;
      const dy = target.y + target.h / 2 - cy;
      const d = Math.hypot(dx, dy) || 1;
      vx = (dx / d) * 430;
      vy = (dy / d) * 430;
    }
    world.holy.push({
      x: cx - 7 + p.facing * 14,
      y: cy - 9,
      w: 15,
      h: 19,
      vx,
      vy,
      dir: vx >= 0 ? 1 : -1,
      spin: 0,
      pierce: 1,
      life: 2.4,
    });
    sfx.cross();
    burst(cx + p.facing * 16, p.y + 14, "#ffeeb8", 7, 90, 0.3);
    renderMana();
  }

  function updateHoly(dt, p) {
    for (const c of world.holy) {
      c.life -= dt;

      // Vuela recta por la línea con la que se lanzó, sin corregir el rumbo.
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.spin += dt * 13 * c.dir;

      if (Math.random() < dt * 40) {
        world.particles.push({
          x: c.x + rand(0, c.w),
          y: c.y + rand(0, c.h),
          vx: rand(-16, 16),
          vy: rand(-10, 30),
          life: 0.4,
          max: 0.4,
          size: rand(1.5, 3.5),
          color: "#ffe9a8",
          g: 20,
        });
      }

      for (const e of world.enemies) {
        if (!e.alive || c.pierce <= 0) continue;
        if (aabb(c, e)) {
          damageEnemy(e, CROSS_DMG, true, c.x + c.w / 2);
          c.pierce -= 1;
        }
      }

      const b = world.boss;
      if (b && b.alive && b.mode !== "intro" && c.pierce > 0 && aabb(c, b)) {
        damageBoss(b, CROSS_DMG, c.x, true);
        c.pierce = 0;
      }

      if (c.pierce > 0) {
        for (const pl of world.level.platforms) {
          if (!aabb(c, pl)) continue;
          c.life = 0;
          holyRing(c.x + c.w / 2, c.y + c.h / 2, 34, "rgba(255,236,180,");
          burst(c.x + c.w / 2, c.y + c.h / 2, "#ffe9a8", 8, 120, 0.35);
          break;
        }
      }

      if (c.x < -60 || c.x > world.level.width + 60) c.life = 0;
    }
    world.holy = world.holy.filter((c) => c.life > 0 && c.pierce > 0);

    for (const r of world.rings) {
      r.life -= dt;
      r.r += (r.max - r.r) * Math.min(1, dt * 9);
    }
    world.rings = world.rings.filter((r) => r.life > 0);

    if (p.crossCd > 0) p.crossCd -= dt;
    if (p.cast > 0) p.cast -= dt;
    if (p.mana < p.maxMana && !p.dead) {
      p.mana = Math.min(p.maxMana, p.mana + MANA_REGEN * dt);
    }
    renderMana();

    world.lock = p.dead
      ? null
      : nearestDemon(p.x + p.w / 2, p.y + p.h / 2, CROSS_RANGE, p.facing);
  }

  function swordHitbox(p) {
    const reach = 52;
    const x = p.facing > 0 ? p.x + p.w - 4 : p.x - reach + 4;
    return { x, y: p.y + 4, w: reach, h: p.h === PLAYER_H ? 26 : 16 };
  }

  function collideWorld(ent, dt, gravity) {
    const plats = world.level.platforms;
    ent.vy += gravity * dt;
    if (ent.vy > 980) ent.vy = 980;

    ent.x += ent.vx * dt;
    for (const pl of plats) {
      if (!aabb(ent, pl)) continue;
      if (ent.vx > 0) ent.x = pl.x - ent.w;
      else if (ent.vx < 0) ent.x = pl.x + pl.w;
      ent.vx = 0;
    }

    let grounded = false;
    ent.y += ent.vy * dt;
    for (const pl of plats) {
      if (!aabb(ent, pl)) continue;
      if (ent.vy > 0) {
        ent.y = pl.y - ent.h;
        ent.vy = 0;
        grounded = true;
      } else if (ent.vy < 0) {
        ent.y = pl.y + pl.h;
        ent.vy = 0;
      }
    }
    return grounded;
  }

  function updatePlayer(p, dt) {
    if (p.dead) return;

    const left = keys.ArrowLeft || keys.a || keys.A || held.left;
    const right = keys.ArrowRight || keys.d || keys.D || held.right;
    const jumpDown = keys[" "] || keys.w || keys.W || keys.ArrowUp || held.jump;
    if (edge.jump) tryJump(p);
    if (!jumpDown) p.jumpHeld = false;
    if (!p.jumpHeld && p.vy < -80) p.vy += 1500 * dt;

    if (p.dashCd > 0) p.dashCd -= dt;
    if (p.dash > 0) {
      p.dash -= dt;
      p.vx = p.dashDir * 610;
      if (p.vy < 0) p.vy *= 0.4;
      if (Math.random() < dt * 40) {
        world.particles.push({
          x: p.x + p.w / 2 - p.dashDir * rand(4, 14),
          y: p.y + p.h - rand(0, 5),
          vx: -p.dashDir * rand(30, 90),
          vy: rand(-30, 10),
          life: 0.32,
          max: 0.32,
          size: rand(1.5, 3.5),
          color: "#d8cfb8",
          g: 180,
        });
      }
    }
    if (p.dash <= 0 && p.h === SLIDE_H) setCrouch(p, false);

    const speed = p.onGround ? 250 : 230;
    if (p.dash > 0) {
      // El derrape manda: nada de frenar ni girar a medio deslizamiento.
    } else if (left && !right) {
      p.vx = -speed;
      p.facing = -1;
    } else if (right && !left) {
      p.vx = speed;
      p.facing = 1;
    } else {
      p.vx *= p.onGround ? Math.pow(0.0008, dt) : Math.pow(0.08, dt);
      if (Math.abs(p.vx) < 8) p.vx = 0;
    }

    if (p.attackCd > 0) p.attackCd -= dt;
    if (p.attack > 0) p.attack -= dt;
    if (edge.attack && p.attackCd <= 0) {
      p.attack = 0.28;
      p.attackCd = 0.36;
      sfx.slash();
    }
    if (edge.cross) throwCross(p);

    p.coyote = p.onGround ? 0.09 : Math.max(0, p.coyote - dt);
    p.buffer = Math.max(0, p.buffer - dt);
    if (p.buffer > 0 && (p.onGround || p.coyote > 0 || p.jumps > 0)) tryJump(p);

    const wasGround = p.onGround;
    const gravity = p.dash > 0 ? 420 : p.winged && p.vy > 0 ? 1050 : 1650;
    p.onGround = collideWorld(p, dt, gravity);
    if (p.onGround) {
      p.jumps = 2;
      p.winged = false;
      p.safeX = p.x;
      p.safeY = p.y;
      if (!wasGround) {
        p.landDust = 0.2;
        burst(p.x + p.w / 2, p.y + p.h, "#9a8f7a", 8, 110, 0.28);
      }
    }
    if (p.wings > 0) p.wings -= dt;
    if (p.invuln > 0) p.invuln -= dt;
    if (p.shield > 0) p.shield = Math.max(0, p.shield - dt * 2.4);
    p.anim += dt * (p.onGround && Math.abs(p.vx) > 20 ? 10 : 6);
    if (p.landDust > 0) p.landDust -= dt;
    updateRig(p, dt);

    if (p.x < 8) p.x = 8;
    if (p.x > world.level.width - p.w - 8) p.x = world.level.width - p.w - 8;

    if (p.winged && p.wings > 0 && Math.random() < dt * 14) {
      world.particles.push({
        x: p.x + p.w / 2 + rand(-10, 10),
        y: p.y + 12,
        vx: rand(-20, 20),
        vy: rand(10, 40),
        life: 0.5,
        max: 0.5,
        size: rand(2, 4),
        color: "#fff4c8",
        g: 40,
      });
    }

    for (const sp of world.level.spikes) {
      const box = { x: sp.x, y: sp.y - 10, w: sp.w, h: 18 };
      if (aabb(p, box)) damagePlayer(p, sp.x);
    }

    if (p.y > H + 40) {
      damagePlayer(p, p.x - 10);
      if (!p.dead) {
        p.x = p.safeX;
        p.y = p.safeY;
        p.vx = 0;
        p.vy = 0;
      }
    }

    if (p.attack > 0.08 && p.attack < 0.26) {
      const hb = swordHitbox(p);
      for (const e of world.enemies) {
        if (!e.alive || e.hurt > 0) continue;
        if (aabb(hb, e)) damageEnemy(e, SWORD_DMG, false, p.x + p.w / 2);
      }
      const b = world.boss;
      if (b && b.alive && b.hurt <= 0 && b.mode !== "intro" && aabb(hb, b)) {
        damageBoss(b, SWORD_DMG, p.x, false);
      }
    }
  }

  function updateImp(e, p, dt) {
    if (e.hurt > 0) e.hurt -= dt;
    if (e.flash > 0) e.flash -= dt;
    const dx = p.x - e.x;
    if (Math.abs(dx) < 260 && Math.abs(p.y - e.y) < 90) {
      e.vx = (dx > 0 ? 1 : -1) * 70;
    } else if (Math.abs(e.x - e.home) > 90) {
      e.vx = e.x > e.home ? -55 : 55;
    }
    const ground = collideWorld(e, dt, 1650);
    if (e.y > H + 50) {
      killEnemy(e);
      return;
    }
    if (ground && Math.random() < dt * 0.4) e.vx *= -1;
    if (aabb(e, p)) damagePlayer(p, e.x, "contact");
  }

  function updateFlyer(e, p, dt) {
    if (e.hurt > 0) e.hurt -= dt;
    if (e.flash > 0) e.flash -= dt;
    e.phase += dt * 2.2;
    const dx = p.x + p.w / 2 - (e.x + e.w / 2);
    const dy = p.y + p.h / 2 - (e.y + e.h / 2);
    const dist = Math.hypot(dx, dy) || 1;
    if (dist < 220 && e.dive <= 0) e.dive = 1.1;
    if (e.dive > 0) {
      e.dive -= dt;
      e.vx = (dx / dist) * 150;
      e.vy = (dy / dist) * 130;
    } else {
      e.vx = Math.sin(e.phase) * 70;
      e.vy = (e.baseY - e.y) * 1.5;
    }
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    if (e.y > H + 50 || e.x < -80 || e.x > world.level.width + 80) {
      killEnemy(e);
      return;
    }
    if (aabb(e, p)) damagePlayer(p, e.x, "contact");
  }

  function spawnBolt(boss, p) {
    const x = boss.x + boss.w / 2;
    const y = boss.y + 42;
    const dx = p.x + p.w / 2 - x;
    const dy = p.y + p.h / 2 - y;
    const d = Math.hypot(dx, dy) || 1;
    boss.projectiles.push({
      x: x - 7,
      y: y - 7,
      w: 14,
      h: 14,
      vx: (dx / d) * 240,
      vy: (dy / d) * 240,
      life: 3,
    });
  }

  function updateBoss(b, p, dt) {
    if (!b.alive) {
      b.projectiles = b.projectiles.filter((pr) => {
        pr.life -= dt;
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        return pr.life > 0;
      });
      return;
    }
    if (b.hurt > 0) b.hurt -= dt;
    if (b.flash > 0) b.flash -= dt;
    b.timer -= dt;
    b.facing = p.x < b.x ? -1 : 1;

    if (b.mode === "intro") {
      collideWorld(b, dt, 1750);
      if (b.timer <= 0) {
        b.mode = "chase";
        b.timer = 2.2;
        sfx.boss();
        shake = 14;
      }
      return;
    }

    if (b.mode === "chase") {
      b.vx = b.facing * (b.hp < 8 ? 110 : 80);
      const g = collideWorld(b, dt, 1750);
      if (g && Math.abs(p.x - b.x) < 70 && Math.abs(p.y - b.y) < 90 && b.timer < 0.4) {
        b.mode = "slash";
        b.timer = 0.45;
        b.vx = 0;
      } else if (b.timer <= 0) {
        b.mode = Math.random() < 0.45 ? "leap" : "cast";
        b.timer = b.mode === "leap" ? 0.2 : 0.55;
        b.vx = 0;
      }
    } else if (b.mode === "slash") {
      b.vx = b.facing * 220;
      collideWorld(b, dt, 1750);
      if (b.timer <= 0) {
        b.mode = "chase";
        b.timer = 1.6;
      }
    } else if (b.mode === "leap") {
      if (b.timer > 0.05 && b.vy === 0) {
        b.vy = -720;
        b.vx = b.facing * 160;
      }
      const g = collideWorld(b, dt, 1750);
      if (g && b.vy >= 0 && b.timer <= 0) {
        b.mode = "slam";
        b.timer = 0.35;
        b.slam = 1;
        shake = 16;
        sfx.boss();
        burst(b.x + b.w / 2, b.y + b.h, "#ff6a4a", 18, 220, 0.4);
      }
    } else if (b.mode === "slam") {
      collideWorld(b, dt, 1750);
      const wave = { x: b.x - 70, y: b.y + b.h - 16, w: b.w + 140, h: 18 };
      if (aabb(p, wave)) damagePlayer(p, b.x);
      if (b.timer <= 0) {
        b.mode = "chase";
        b.timer = 1.4;
        b.slam = 0;
      }
    } else if (b.mode === "cast") {
      collideWorld(b, dt, 1750);
      if (b.timer < 0.28 && b.timer > 0.22) spawnBolt(b, p);
      if (b.hp < 9 && b.timer < 0.12 && b.timer > 0.06) spawnBolt(b, p);
      if (b.timer <= 0) {
        b.mode = "chase";
        b.timer = 1.8;
      }
    }

    if (aabb(b, p)) damagePlayer(p, b.x, "contact");

    for (const pr of b.projectiles) {
      pr.life -= dt;
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      if (aabb(pr, p)) {
        pr.life = 0;
        damagePlayer(p, pr.x);
      }
    }
    b.projectiles = b.projectiles.filter((pr) => pr.life > 0);
  }

  function update(dt) {
    if (state !== "play" || !world) return;
    time += dt;
    const p = world.player;
    updatePlayer(p, dt);
    updateHoly(dt, p);

    for (const e of world.enemies) {
      if (!e.alive) continue;
      if (e.type === "imp") updateImp(e, p, dt);
      else updateFlyer(e, p, dt);
    }

    for (const pk of world.pickups) {
      if (pk.taken) continue;
      pk.bob += dt * 3;
      if (aabb(p, pk) && p.hp < p.maxHp) {
        pk.taken = true;
        p.hp = Math.min(p.maxHp, p.hp + 1);
        sfx.pickup();
        renderHearts();
        burst(pk.x + 8, pk.y + 8, "#c43c4a", 10, 90, 0.4);
      }
    }

    if (!world.arenaLock && p.x > world.level.arenaX) {
      world.arenaLock = true;
      world.boss = makeBoss();
      world.level.platforms.push({ x: 3628, y: 80, w: 36, h: 420, kind: "hell" });
      sfx.boss();
      shake = 12;
    }
    if (world.boss) updateBoss(world.boss, p, dt);

    if (world.winTimer > 0) {
      world.winTimer -= dt;
      if (world.winTimer <= 0 && !p.dead && state === "play") showWin();
    }

    for (const pt of world.particles) {
      pt.life -= dt;
      pt.vy += pt.g * dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
    }
    world.particles = world.particles.filter((pt) => pt.life > 0);

    const targetX = p.x + p.w / 2 - W * 0.38;
    let minX = 0;
    let maxX = world.level.width - W;
    if (world.arenaLock) {
      minX = 3640;
      maxX = 4500 - W;
    }
    const desired = clamp(targetX, minX, maxX);
    world.cam.x += (desired - world.cam.x) * Math.min(1, dt * 7);
    world.cam.y = 0;
    if (shake > 0) shake *= Math.pow(0.02, dt);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Flor de lis: emblema grabado en la armadura y el escudo.
  function fleurDeLis(x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, -6.4);
    ctx.quadraticCurveTo(1.9, -2.4, 1.6, 1.6);
    ctx.quadraticCurveTo(0, 3.2, -1.6, 1.6);
    ctx.quadraticCurveTo(-1.9, -2.4, 0, -6.4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-1.4, -1.4);
    ctx.quadraticCurveTo(-5.6, -3.6, -4.6, 1.9);
    ctx.quadraticCurveTo(-3.2, 0.4, -1.4, 1.3);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(1.4, -1.4);
    ctx.quadraticCurveTo(5.6, -3.6, 4.6, 1.9);
    ctx.quadraticCurveTo(3.2, 0.4, 1.4, 1.3);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(-3.6, 1.7, 7.2, 1.5);
    ctx.beginPath();
    ctx.moveTo(-1.3, 3.2);
    ctx.quadraticCurveTo(0, 6.8, 1.3, 3.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawBackground(camX) {
    const hell = clamp((camX - 2900) / 1000, 0, 1);
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, lerpColor("#161431", "#2c1019", hell));
    sky.addColorStop(0.45, lerpColor("#221a35", "#3a1218", hell));
    sky.addColorStop(0.75, lerpColor("#3d2b3a", "#54181a", hell));
    sky.addColorStop(1, lerpColor("#6b4a44", "#7a2a22", hell));
    ctx.fillStyle = sky;
    ctx.fillRect(0, VIEW_LIFT, W, H);

    ctx.fillStyle = "rgba(255,255,255,0.6)";
    for (let i = 0; i < 46; i++) {
      const sx = ((i * 173 + camX * 0.06) % (W + 40)) - 20;
      const sy = (i * 47) % 190 + 8;
      const tw = 0.45 + 0.55 * Math.abs(Math.sin(time * 1.6 + i));
      ctx.globalAlpha = tw * (1 - hell * 0.7);
      ctx.fillRect(sx, sy, i % 6 === 0 ? 2 : 1, 1);
    }
    ctx.globalAlpha = 1;

    const moonX = 780 - camX * 0.04;
    const halo = ctx.createRadialGradient(moonX, 92, 14, moonX, 92, 120);
    halo.addColorStop(0, "rgba(255,248,222,0.42)");
    halo.addColorStop(1, "rgba(255,248,222,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(moonX - 130, -30, 260, 260);
    const disc = ctx.createRadialGradient(moonX - 10, 82, 6, moonX, 92, 34);
    disc.addColorStop(0, "#fffdf3");
    disc.addColorStop(0.7, "#f2ecd6");
    disc.addColorStop(1, "#ded5bb");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(moonX, 92, 33, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(190,180,155,0.35)";
    ctx.beginPath();
    ctx.arc(moonX + 11, 84, 7, 0, Math.PI * 2);
    ctx.arc(moonX - 8, 101, 5, 0, Math.PI * 2);
    ctx.arc(moonX + 4, 104, 3.5, 0, Math.PI * 2);
    ctx.fill();

    drawHillRidge(camX * 0.12, 318, lerpColor("#1d1930", "#2c1119", hell));

    // La catedral cierra la calle: se dibuja a escala del mundo y las casas se recortan antes de ella.
    const cathX = 3752 - camX;
    const clipRight = clamp(cathX + 54, 0, W);
    if (clipRight > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, clipRight, H);
      ctx.clip();
      drawHouseRow(camX * 0.4, 432, 0.8, hell, 11, 0.85);
      drawHouseRow(camX * 0.72, 504, 1.04, hell, 37, 0.12);
      ctx.restore();
    }
    drawCathedral(cathX, hell);
    drawStreetHaze(hell);
  }

  function drawHillRidge(cam, baseY, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-40, H);
    for (let x = -40; x <= W + 40; x += 40) {
      const n = Math.sin((x + cam) * 0.008) * 34 + Math.sin((x + cam) * 0.02) * 14;
      ctx.lineTo(x, baseY + n);
    }
    ctx.lineTo(W + 40, H);
    ctx.closePath();
    ctx.fill();
  }

  function hash(i, seed) {
    const s = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  // Casas coloniales de Angelópolis: muros encalados, teja de barro y balcones de hierro.
  // depth 0 = pegadas a la calle, 1 = perdidas en la noche.
  function drawHouseRow(cam, baseY, scale, hell, seed, depth) {
    const spacing = 226 * scale;
    const first = Math.floor(cam / spacing) - 1;
    const count = Math.ceil(W / spacing) + 3;
    const night = "#241f36";
    const near = depth < 0.5;
    for (let i = first; i < first + count; i++) {
      const x = i * spacing - cam;
      if (x + spacing < -60 || x > W + 60) continue;
      const r = hash(i, seed);
      const r2 = hash(i, seed + 5);
      const bw = (150 + r * 54) * scale;
      const bh = (150 + r2 * 96) * scale;
      const top = baseY - bh;
      const plinth = 24 * scale;

      const warmBase = r > 0.66 ? "#c9b08d" : r > 0.33 ? "#d9cdb4" : "#b9a894";
      const wall = ctx.createLinearGradient(x, top, x + bw, top + bh);
      wall.addColorStop(0, lerpColor(lerpColor(warmBase, "#6d3a30", hell * 0.7), night, depth * 0.62));
      wall.addColorStop(1, lerpColor(lerpColor("#5d5163", "#3c1417", hell * 0.7), night, depth * 0.62));
      ctx.fillStyle = wall;
      ctx.fillRect(x, top, bw, bh);

      // Manchas de humedad en el estuco.
      ctx.fillStyle = `rgba(0,0,0,${0.1 - depth * 0.05})`;
      for (let s = 0; s < 3; s++) {
        const sx = x + hash(i * 7 + s, seed) * (bw - 20);
        const sw = (8 + hash(i * 3 + s, seed + 2) * 20) * scale;
        ctx.fillRect(sx, top + 10, sw, bh - 16);
      }

      // Cornisa y teja de barro.
      ctx.fillStyle = lerpColor(lerpColor("#8c4b34", "#5a1d19", hell * 0.7), night, depth * 0.55);
      ctx.beginPath();
      ctx.moveTo(x - 10 * scale, top);
      ctx.lineTo(x + bw + 10 * scale, top);
      ctx.lineTo(x + bw + 2 * scale, top - 15 * scale);
      ctx.lineTo(x + 2 * scale, top - 15 * scale);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.lineWidth = 1;
      for (let t = 6; t < bw; t += 13 * scale) {
        ctx.beginPath();
        ctx.moveTo(x + t, top);
        ctx.lineTo(x + t + 3 * scale, top - 15 * scale);
        ctx.stroke();
      }

      // Ventanas con luz de vela y balcones de hierro forjado.
      const cols = Math.max(2, Math.round(bw / (60 * scale)));
      const rows = Math.max(1, Math.round((bh - plinth) / (74 * scale)));
      for (let cx = 0; cx < cols; cx++) {
        for (let cy = 0; cy < rows; cy++) {
          const wx = x + 16 * scale + cx * ((bw - 26 * scale) / cols);
          const wy = top + 22 * scale + cy * ((bh - plinth - 34 * scale) / rows);
          const ww = 24 * scale;
          const wh = 34 * scale;
          if (wy + wh > baseY - plinth) continue;
          const lit = hash(i * 31 + cx * 7 + cy * 3, seed) > 0.42;
          ctx.fillStyle = lit
            ? lerpColor(lerpColor("#f6c979", "#ff7a44", hell), "#6a5335", depth * 0.55)
            : lerpColor("#241d2c", "#160709", hell);
          ctx.beginPath();
          ctx.moveTo(wx, wy + wh);
          ctx.lineTo(wx, wy + ww * 0.5);
          ctx.quadraticCurveTo(wx + ww / 2, wy - ww * 0.28, wx + ww, wy + ww * 0.5);
          ctx.lineTo(wx + ww, wy + wh);
          ctx.closePath();
          ctx.fill();
          if (lit) {
            ctx.fillStyle = `rgba(255,196,110,${0.17 - depth * 0.1})`;
            ctx.fillRect(wx - 8 * scale, wy - 4 * scale, ww + 16 * scale, wh + 14 * scale);
          }
          ctx.strokeStyle = "rgba(24,18,14,0.75)";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(wx + ww / 2, wy + ww * 0.1);
          ctx.lineTo(wx + ww / 2, wy + wh);
          ctx.moveTo(wx, wy + wh * 0.55);
          ctx.lineTo(wx + ww, wy + wh * 0.55);
          ctx.stroke();
          // Repisa de cantera.
          ctx.fillStyle = "rgba(255,246,222,0.18)";
          ctx.fillRect(wx - 3, wy + wh, ww + 6, 2.5 * scale);
          if (near && cy === 0) {
            ctx.strokeStyle = "rgba(16,13,17,0.9)";
            ctx.lineWidth = 2;
            ctx.strokeRect(wx - 4, wy + wh, ww + 8, 12);
            for (let bx = 0; bx <= ww + 8; bx += 5) {
              ctx.beginPath();
              ctx.moveTo(wx - 4 + bx, wy + wh);
              ctx.lineTo(wx - 4 + bx, wy + wh + 12);
              ctx.stroke();
            }
          }
        }
      }

      // Zócalo de cantera y portón a nivel de calle.
      ctx.fillStyle = lerpColor(lerpColor("#4f4757", "#3a1418", hell * 0.6), night, depth * 0.6);
      ctx.fillRect(x, baseY - plinth, bw, plinth);
      if (near) {
        const dw = 40 * scale;
        const dh = 64 * scale;
        const dx = x + 30 * scale + hash(i, seed + 9) * (bw - dw - 60 * scale);
        ctx.fillStyle = "#33210f";
        ctx.beginPath();
        ctx.moveTo(dx, baseY);
        ctx.lineTo(dx, baseY - dh + dw * 0.45);
        ctx.quadraticCurveTo(dx + dw / 2, baseY - dh - dw * 0.12, dx + dw, baseY - dh + dw * 0.45);
        ctx.lineTo(dx + dw, baseY);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(226,196,142,0.28)";
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(dx + dw / 2, baseY - dh + dw * 0.3);
        ctx.lineTo(dx + dw / 2, baseY);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(0,0,0,${0.22 + depth * 0.1})`;
      ctx.fillRect(x + bw - 6 * scale, top, 6 * scale, bh);
    }
  }

  // Catedral barroca al final de la calle: torres, rosetón y cruces de piedra.
﻿  function drawCathedral(x, hell) {
    if (x < -700 || x > W + 400) return;
    const baseY = 500;
    const t = hell * 0.42;
    const cx = x + 210;
    const wall = lerpColor("#f4f0e6", "#7c4a44", t);
    const wallSh = lerpColor("#ddd6c6", "#5e3534", t);
    const wallDk = lerpColor("#c4bcaa", "#4a2622", t);
    const tile = lerpColor("#b23a2a", "#5a1612", t);
    const tileSh = lerpColor("#8a2820", "#3a0e0c", t);
    const tileHi = lerpColor("#d05a3e", "#7a2418", t);
    const wain = lerpColor("#9a5a3c", "#5a2418", t);
    const wainSh = lerpColor("#6e3e26", "#3a160e", t);
    const trim = lerpColor("#c44a3a", "#6a1e16", t);

    ctx.fillStyle = "rgba(10,8,14,0.28)";
    ctx.beginPath();
    ctx.ellipse(cx, baseY + 4, 230, 16, 0, 0, Math.PI * 2);
    ctx.fill();

    const pw = 420, px0 = cx - pw / 2;
    ctx.fillStyle = lerpColor("#8a8276", "#5a3a30", t);
    roundRect(px0, baseY - 14, pw, 18, 4); ctx.fill();
    ctx.fillStyle = lerpColor("#6e665a", "#3e2620", t);
    ctx.fillRect(px0, baseY - 14, pw, 4);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = lerpColor("#9a9286", "#6a4636", t);
      ctx.fillRect(px0 + 18 + i * 8, baseY - 4 + i * 5, pw - 36 - i * 16, 5);
      ctx.fillStyle = lerpColor("#7a7266", "#4a2e24", t);
      ctx.fillRect(px0 + 18 + i * 8, baseY - 4 + i * 5, pw - 36 - i * 16, 2);
    }
    ctx.strokeStyle = lerpColor("#1a1612", "#0a0604", t);
    ctx.lineWidth = 2.4;
    for (const bx of [px0 + 6, px0 + pw - 6]) {
      ctx.beginPath(); ctx.moveTo(bx, baseY - 14); ctx.lineTo(bx, baseY - 30); ctx.stroke();
      for (let by = baseY - 28; by < baseY - 14; by += 7) {
        ctx.beginPath(); ctx.moveTo(bx - 4, by); ctx.lineTo(bx + 4, by); ctx.stroke();
      }
    }

    const bL = x + 30, bR = x + 390, bT = 300, bW = bR - bL;
    const wg = ctx.createLinearGradient(bL, 0, bR, 0);
    wg.addColorStop(0, wallSh); wg.addColorStop(0.18, wall);
    wg.addColorStop(0.7, wall); wg.addColorStop(1, wallDk);
    ctx.fillStyle = wg; ctx.fillRect(bL, bT, bW, baseY - bT);
    const wT = baseY - (baseY - bT) * 0.34;
    const wng = ctx.createLinearGradient(0, wT, 0, baseY);
    wng.addColorStop(0, wain); wng.addColorStop(1, wainSh);
    ctx.fillStyle = wng; ctx.fillRect(bL, wT, bW, baseY - wT);
    ctx.strokeStyle = `rgba(0,0,0,${0.18 + t * 0.2})`; ctx.lineWidth = 1;
    for (let sy = wT + 8; sy < baseY; sy += 10) { ctx.beginPath(); ctx.moveTo(bL, sy); ctx.lineTo(bR, sy); ctx.stroke(); }
    for (let sx = bL + 14; sx < bR; sx += 22) { ctx.beginPath(); ctx.moveTo(sx, wT); ctx.lineTo(sx, baseY); ctx.stroke(); }
    ctx.fillStyle = trim; ctx.fillRect(bL - 4, bT - 6, bW + 8, 7);
    ctx.fillStyle = lerpColor("#9a3a2e", "#4a1410", t); ctx.fillRect(bL - 4, bT, bW + 8, 2);

    ctx.fillStyle = wall;
    ctx.beginPath(); ctx.moveTo(bL - 6, bT + 4); ctx.lineTo(cx, bT - 40); ctx.lineTo(bR + 6, bT + 4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = wallSh;
    ctx.beginPath(); ctx.moveTo(cx, bT - 40); ctx.lineTo(bR + 6, bT + 4); ctx.lineTo(cx, bT + 4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = tile;
    ctx.beginPath(); ctx.moveTo(bL - 10, bT - 2); ctx.lineTo(cx, bT - 44); ctx.lineTo(bR + 10, bT - 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = tileSh;
    ctx.beginPath(); ctx.moveTo(cx, bT - 44); ctx.lineTo(bR + 10, bT - 2); ctx.lineTo(cx, bT - 2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(60,12,8,${0.4 + t * 0.3})`; ctx.lineWidth = 0.8;
    for (let r = 0; r < 4; r++) {
      const yy = bT - 6 - r * 9;
      ctx.beginPath(); ctx.moveTo(bL - 8 + r * 3, yy); ctx.lineTo(cx, yy - 8 - r * 4); ctx.lineTo(bR + 8 - r * 3, yy); ctx.stroke();
    }

    for (const sxp of [bL + 16, bR - 16]) {
      ctx.fillStyle = wg; ctx.fillRect(sxp - 7, bT - 6, 14, 40);
      ctx.fillStyle = wallSh; ctx.fillRect(sxp + 2, bT - 6, 5, 40);
      ctx.fillStyle = tile;
      ctx.beginPath(); ctx.moveTo(sxp - 11, bT - 6); ctx.lineTo(sxp, bT - 30); ctx.lineTo(sxp + 11, bT - 6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = tileSh;
      ctx.beginPath(); ctx.moveTo(sxp, bT - 30); ctx.lineTo(sxp + 11, bT - 6); ctx.lineTo(sxp + 3, bT - 6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = lerpColor("#d8c88f", "#9a6238", t);
      ctx.beginPath(); ctx.arc(sxp, bT - 32, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = lerpColor("#d8c88f", "#9a6238", t); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(sxp, bT - 34); ctx.lineTo(sxp, bT - 40); ctx.stroke();
    }

    const tL = x + 150, tR = x + 270, tW = tR - tL, tT = 150;
    const tg = ctx.createLinearGradient(tL, 0, tR, 0);
    tg.addColorStop(0, wallSh); tg.addColorStop(0.2, wall); tg.addColorStop(0.75, wall); tg.addColorStop(1, wallDk);
    ctx.fillStyle = tg; ctx.fillRect(tL, tT, tW, bT - tT + 6);
    ctx.fillStyle = wng; ctx.fillRect(tL, bT - 34, tW, 40);
    ctx.strokeStyle = `rgba(0,0,0,${0.18 + t * 0.2})`;
    for (let sy = bT - 26; sy < bT + 6; sy += 10) { ctx.beginPath(); ctx.moveTo(tL, sy); ctx.lineTo(tR, sy); ctx.stroke(); }
    ctx.fillStyle = lerpColor("#e8e2d4", "#6a3e38", t); ctx.fillRect(tL - 5, tT - 5, tW + 10, 6);
    ctx.fillStyle = lerpColor("#bcb4a4", "#52302a", t); ctx.fillRect(tL - 5, tT, tW + 10, 2);
    ctx.fillStyle = lerpColor("#e8e2d4", "#6a3e38", t); ctx.fillRect(tL - 5, bT - 10, tW + 10, 6);

    const ckY = tT + 38;
    ctx.fillStyle = lerpColor("#fbf7ee", "#5a3a36", t);
    ctx.beginPath(); ctx.arc(cx, ckY, 17, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = lerpColor("#2a1c16", "#160606", t); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, ckY, 17, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.6;
    for (const h of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(h) * 11, ckY + Math.sin(h) * 11);
      ctx.lineTo(cx + Math.cos(h) * 14, ckY + Math.sin(h) * 14); ctx.stroke();
    }
    ctx.strokeStyle = lerpColor("#1a120c", "#0a0404", t); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, ckY); ctx.lineTo(cx - 6, ckY - 4); ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(cx, ckY); ctx.lineTo(cx + Math.cos(time * 0.5) * 10, ckY + Math.sin(time * 0.5) * 10); ctx.stroke();
    ctx.fillStyle = lerpColor("#b23a2a", "#5a1612", t);
    ctx.beginPath(); ctx.arc(cx, ckY, 1.6, 0, Math.PI * 2); ctx.fill();

    const bfY = tT + 78;
    for (const bx of [cx - 26, cx + 26]) {
      ctx.fillStyle = lerpColor("#1a1410", "#0a0404", t);
      ctx.beginPath(); ctx.moveTo(bx - 12, bfY + 26); ctx.lineTo(bx - 12, bfY);
      ctx.quadraticCurveTo(bx, bfY - 12, bx + 12, bfY); ctx.lineTo(bx + 12, bfY + 26); ctx.closePath(); ctx.fill();
      ctx.fillStyle = lerpColor("#d8b04a", "#8a4a1e", t);
      ctx.beginPath(); ctx.moveTo(bx - 5, bfY + 4); ctx.quadraticCurveTo(bx, bfY - 2, bx + 5, bfY + 4);
      ctx.lineTo(bx + 5, bfY + 12); ctx.lineTo(bx - 5, bfY + 12); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = lerpColor("#9a7220", "#5a2e10", t); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, bfY - 2); ctx.lineTo(bx, bfY - 8); ctx.stroke();
    }

    const rB = tT - 4, rA = rB - 78;
    ctx.fillStyle = tile;
    ctx.beginPath(); ctx.moveTo(tL - 10, rB); ctx.lineTo(cx, rA); ctx.lineTo(tR + 10, rB); ctx.closePath(); ctx.fill();
    ctx.fillStyle = tileSh;
    ctx.beginPath(); ctx.moveTo(cx, rA); ctx.lineTo(tR + 10, rB); ctx.lineTo(cx, rB); ctx.closePath(); ctx.fill();
    ctx.fillStyle = tileHi;
    ctx.beginPath(); ctx.moveTo(tL - 10, rB); ctx.lineTo(cx, rA); ctx.lineTo(cx, rB); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(60,12,8,${0.4 + t * 0.3})`; ctx.lineWidth = 0.8;
    for (let r = 0; r < 5; r++) {
      const yy = rB - 6 - r * 14;
      ctx.beginPath(); ctx.moveTo(tL - 8 + r * 4, yy); ctx.lineTo(cx, yy - 12 - r * 5); ctx.lineTo(tR + 8 - r * 4, yy); ctx.stroke();
    }
    ctx.strokeStyle = lerpColor("#d8c88f", "#9a6238", t); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, rA - 8); ctx.lineTo(cx, rA - 34);
    ctx.moveTo(cx - 7, rA - 22); ctx.lineTo(cx + 7, rA - 22); ctx.stroke();

    const dL = cx - 26, dR = cx + 26, dT = baseY - 96;
    const spill = ctx.createRadialGradient(cx, baseY - 40, 8, cx, baseY - 40, 150);
    spill.addColorStop(0, `rgba(255,208,138,${0.22 - hell * 0.1})`);
    spill.addColorStop(1, "rgba(255,190,110,0)");
    ctx.fillStyle = spill; ctx.fillRect(dL - 20, dT - 30, 92, 130);
    const dg = ctx.createLinearGradient(dL, dT, dR, baseY);
    dg.addColorStop(0, lerpColor("#4a3524", "#40120f", hell));
    dg.addColorStop(1, lerpColor("#1d150f", "#1c0607", hell));
    ctx.fillStyle = dg;
    ctx.beginPath(); ctx.moveTo(dL, baseY); ctx.lineTo(dL, dT + 18);
    ctx.quadraticCurveTo(cx, dT - 8, dR, dT + 18); ctx.lineTo(dR, baseY); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(0,0,0,${0.4 + t * 0.2})`; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(cx, dT + 4); ctx.lineTo(cx, baseY); ctx.stroke();
    for (const lx of [dL + 8, dL + 18, dR - 8, dR - 18]) {
      ctx.beginPath(); ctx.moveTo(lx, dT + 20); ctx.lineTo(lx, baseY - 2); ctx.stroke();
    }
    ctx.fillStyle = lerpColor("#3a2c20", "#1a0c08", t);
    roundRect(cx - 3, baseY - 44, 6, 8, 2); ctx.fill();

    if (hell > 0.15) {
      ctx.fillStyle = `rgba(220,60,40,${0.1 + hell * 0.2 + Math.sin(time * 4) * 0.04})`;
      ctx.beginPath(); ctx.moveTo(dL, baseY); ctx.lineTo(dL, dT + 18);
      ctx.quadraticCurveTo(cx, dT - 8, dR, dT + 18); ctx.lineTo(dR, baseY); ctx.closePath(); ctx.fill();
    }

    const nL = bL + 56, nR = nL + 30, nT = baseY - 74;
    ctx.fillStyle = lerpColor("#1a1410", "#0a0404", t);
    ctx.beginPath(); ctx.moveTo(nL, baseY); ctx.lineTo(nL, nT + 14);
    ctx.quadraticCurveTo(nL + 15, nT - 6, nR, nT + 14); ctx.lineTo(nR, baseY); ctx.closePath(); ctx.fill();
    ctx.fillStyle = lerpColor("#e8e2d4", "#6a3e38", t);
    ctx.beginPath(); ctx.ellipse(nL + 15, nT + 30, 6, 11, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = lerpColor("#f4f0e6", "#7c4a44", t);
    ctx.beginPath(); ctx.arc(nL + 15, nT + 18, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = lerpColor("#bcb4a4", "#52302a", t); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(nL + 15, nT + 22); ctx.lineTo(nL + 15, nT + 34); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(nL + 9, nT + 40); ctx.lineTo(nL + 21, nT + 40); ctx.stroke();
    // Alas de angel.
    ctx.fillStyle = lerpColor("#f4f0e6", "#7c4a44", t);
    ctx.beginPath(); ctx.moveTo(nL + 6, nT + 26); ctx.quadraticCurveTo(nL + 15, nT + 20, nL + 24, nT + 26); ctx.closePath(); ctx.fill();
  }

  function drawStreetHaze(hell) {
    const g = ctx.createLinearGradient(0, 380, 0, H);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(${Math.round(40 + hell * 30)},${Math.round(32 - hell * 14)},${Math.round(48 - hell * 32)},0.52)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 380, W, H - 380 + VIEW_LIFT);
  }

  function lerpColor(a, b, t) {
    const pa = parseColor(a);
    const pb = parseColor(b);
    const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
    const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
    const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
    return `rgb(${r},${g},${bl})`;
  }

  // Acepta "#rgb", "#rrggbb" y "rgb()/rgba()" para poder anidar mezclas.
  function parseColor(c) {
    if (c[0] === "#") {
      const h = c.slice(1);
      if (h.length === 3) {
        return [
          parseInt(h[0] + h[0], 16),
          parseInt(h[1] + h[1], 16),
          parseInt(h[2] + h[2], 16),
        ];
      }
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
    const m = c.match(/-?\d+(?:\.\d+)?/g) || [0, 0, 0];
    return [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0];
  }

  function drawPlatform(pl, camX) {
    const x = pl.x - camX;
    const y = pl.y;
    if (x + pl.w < -20 || x > W + 20) return;

    if (pl.kind === "street" || pl.kind === "atrium") {
      const holy = pl.kind === "atrium";
      const base = ctx.createLinearGradient(x, y, x, y + pl.h);
      base.addColorStop(0, holy ? "#6a5850" : "#5b5566");
      base.addColorStop(0.35, holy ? "#4a3630" : "#3f3a4c");
      base.addColorStop(1, holy ? "#2a1a18" : "#221f2c");
      ctx.fillStyle = base;
      ctx.fillRect(x, y, pl.w, pl.h);

      // Adoquines mojados con brillo de farol.
      const cw = holy ? 34 : 26;
      for (let i = 0; i < pl.w; i += cw) {
        for (let row = 0; row < 2; row++) {
          const cx = x + i + (row % 2 ? cw / 2 : 0);
          const cy = y + 3 + row * 13;
          ctx.fillStyle = row === 0 ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.035)";
          roundRect(cx + 1.5, cy, cw - 3, 11, 3);
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.35)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      ctx.fillStyle = holy
        ? `rgba(255,120,70,${0.14 + Math.sin(time * 3) * 0.05})`
        : "rgba(226,196,142,0.09)";
      ctx.fillRect(x, y, pl.w, 2);
      if (holy) {
        ctx.fillStyle = `rgba(220,70,44,${0.12 + Math.sin(time * 5) * 0.05})`;
        ctx.fillRect(x, y - 7, pl.w, 7);
      }
      return;
    }

    if (pl.kind === "roof") {
      // Tejado de teja de barro.
      const tile = ctx.createLinearGradient(x, y, x, y + pl.h);
      tile.addColorStop(0, "#a85c3c");
      tile.addColorStop(0.5, "#7d3f2b");
      tile.addColorStop(1, "#4a2118");
      ctx.fillStyle = tile;
      ctx.fillRect(x, y, pl.w, pl.h);
      ctx.strokeStyle = "rgba(255,196,150,0.28)";
      ctx.lineWidth = 1.4;
      for (let i = 4; i < pl.w; i += 12) {
        ctx.beginPath();
        ctx.arc(x + i, y + 3, 5, Math.PI, 0);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x, y + pl.h - 4, pl.w, 4);
      return;
    }

    if (pl.kind === "wall") {
      const wallGrad = ctx.createLinearGradient(x, y, x + pl.w, y);
      wallGrad.addColorStop(0, "#3a2a2e");
      wallGrad.addColorStop(1, "#1e1216");
      ctx.fillStyle = wallGrad;
      ctx.fillRect(x, y, pl.w, pl.h);
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      for (let i = 0; i < pl.h; i += 22) {
        ctx.beginPath();
        ctx.moveTo(x, y + i);
        ctx.lineTo(x + pl.w, y + i);
        ctx.stroke();
      }
      return;
    }

    // Balcón de madera con barandal de hierro forjado.
    const wood = ctx.createLinearGradient(x, y, x, y + pl.h);
    wood.addColorStop(0, "#7c5a3c");
    wood.addColorStop(0.4, "#54381f");
    wood.addColorStop(1, "#2c1b10");
    ctx.fillStyle = wood;
    ctx.fillRect(x, y, pl.w, pl.h);
    ctx.fillStyle = "rgba(255,214,158,0.2)";
    ctx.fillRect(x, y, pl.w, 2);
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    for (let i = 10; i < pl.w; i += 16) {
      ctx.beginPath();
      ctx.moveTo(x + i, y + 3);
      ctx.lineTo(x + i, y + pl.h);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(18,14,18,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 16);
    ctx.lineTo(x + pl.w, y - 16);
    ctx.stroke();
    ctx.lineWidth = 1.4;
    for (let i = 0; i <= pl.w; i += 9) {
      ctx.beginPath();
      ctx.moveTo(x + i, y - 16);
      ctx.lineTo(x + i, y);
      ctx.stroke();
    }
  }

  // Faroles, cruces de muro y capillas al borde de la calle.
  function drawProps(camX, hell) {
    for (const pr of world.level.props) {
      const x = pr.x - camX;
      if (x < -120 || x > W + 120) continue;

      if (pr.type === "lantern") {
        const flick = 0.74 + Math.sin(time * 7 + pr.x) * 0.14;
        // Charco de luz sobre los adoquines.
        const pool = ctx.createRadialGradient(x + 20, pr.y + 6, 4, x + 20, pr.y + 6, 96);
        pool.addColorStop(0, `rgba(255,206,132,${0.3 * flick})`);
        pool.addColorStop(1, "rgba(255,190,110,0)");
        ctx.fillStyle = pool;
        ctx.fillRect(x - 80, pr.y - 40, 200, 70);
        const g = ctx.createRadialGradient(x + 20, pr.y - 108, 3, x + 20, pr.y - 108, 108);
        g.addColorStop(0, `rgba(255,222,154,${0.62 * flick})`);
        g.addColorStop(0.45, `rgba(255,196,110,${0.2 * flick})`);
        g.addColorStop(1, "rgba(255,190,110,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x - 90, pr.y - 216, 220, 240);

        ctx.strokeStyle = "#16121a";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(x, pr.y);
        ctx.lineTo(x, pr.y - 104);
        ctx.quadraticCurveTo(x, pr.y - 126, x + 20, pr.y - 126);
        ctx.stroke();
        ctx.fillStyle = "#16121a";
        ctx.beginPath();
        ctx.ellipse(x, pr.y - 2, 9, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // Fanal de vidrio con remate.
        ctx.fillStyle = "#1d181f";
        ctx.beginPath();
        ctx.moveTo(x + 8, pr.y - 122);
        ctx.lineTo(x + 32, pr.y - 122);
        ctx.lineTo(x + 20, pr.y - 134);
        ctx.closePath();
        ctx.fill();
        const lampGlass = ctx.createLinearGradient(x + 8, pr.y - 120, x + 32, pr.y - 88);
        lampGlass.addColorStop(0, `rgba(255,248,214,${flick})`);
        lampGlass.addColorStop(0.5, `rgba(255,214,132,${flick})`);
        lampGlass.addColorStop(1, `rgba(238,166,74,${flick * 0.85})`);
        ctx.fillStyle = lampGlass;
        ctx.beginPath();
        ctx.moveTo(x + 9, pr.y - 120);
        ctx.lineTo(x + 31, pr.y - 120);
        ctx.lineTo(x + 34, pr.y - 90);
        ctx.lineTo(x + 6, pr.y - 90);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "#100d12";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 20, pr.y - 120);
        ctx.lineTo(x + 20, pr.y - 90);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,252,226,${flick})`;
        ctx.beginPath();
        ctx.ellipse(x + 20, pr.y - 103, 4, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      // Cruz atrial de piedra sobre pedestal, al borde de la calle.
      if (pr.type === "stonecross") {
        const g = ctx.createRadialGradient(x, pr.y - 96, 6, x, pr.y - 96, 96);
        g.addColorStop(0, "rgba(255,242,205,0.26)");
        g.addColorStop(1, "rgba(255,242,205,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x - 96, pr.y - 192, 192, 200);
        const rock = ctx.createLinearGradient(x - 16, pr.y - 40, x + 16, pr.y);
        rock.addColorStop(0, "#8b8272");
        rock.addColorStop(0.5, "#b9b09a");
        rock.addColorStop(1, "#514a41");
        ctx.fillStyle = rock;
        ctx.beginPath();
        ctx.moveTo(x - 20, pr.y);
        ctx.lineTo(x - 14, pr.y - 34);
        ctx.lineTo(x + 14, pr.y - 34);
        ctx.lineTo(x + 20, pr.y);
        ctx.closePath();
        ctx.fill();
        const stone = ctx.createLinearGradient(x - 9, pr.y - 118, x + 9, pr.y - 34);
        stone.addColorStop(0, "#d9d1bd");
        stone.addColorStop(0.6, "#a79d88");
        stone.addColorStop(1, "#6d6557");
        ctx.fillStyle = stone;
        ctx.fillRect(x - 5, pr.y - 118, 10, 84);
        ctx.fillRect(x - 19, pr.y - 100, 38, 10);
        ctx.fillStyle = "rgba(255,252,235,0.4)";
        ctx.fillRect(x - 5, pr.y - 118, 2.5, 84);
        continue;
      }

      // Capilla votiva de esquina.
      ctx.fillStyle = "#c9b79a";
      roundRect(x - 22, pr.y - 74, 44, 74, 4);
      ctx.fill();
      ctx.fillStyle = lerpColor("#8c4b34", "#5a1d19", hell * 0.6);
      ctx.beginPath();
      ctx.moveTo(x - 28, pr.y - 74);
      ctx.lineTo(x, pr.y - 100);
      ctx.lineTo(x + 28, pr.y - 74);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#cbb173";
      ctx.fillRect(x - 3, pr.y - 122, 6, 24);
      ctx.fillRect(x - 11, pr.y - 114, 22, 6);
      const inner = ctx.createRadialGradient(x, pr.y - 40, 2, x, pr.y - 40, 30);
      inner.addColorStop(0, `rgba(255,226,160,${0.7 + Math.sin(time * 4) * 0.1})`);
      inner.addColorStop(1, "rgba(120,70,30,0.15)");
      ctx.fillStyle = inner;
      ctx.beginPath();
      ctx.moveTo(x - 14, pr.y - 8);
      ctx.lineTo(x - 14, pr.y - 46);
      ctx.quadraticCurveTo(x, pr.y - 66, x + 14, pr.y - 46);
      ctx.lineTo(x + 14, pr.y - 8);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Rejas de hierro forjado de la calle, con puntas de lanza.
  function drawSpikes(sp, camX) {
    const x = sp.x - camX;
    const n = Math.max(2, Math.floor(sp.w / 14));
    ctx.fillStyle = "#15121a";
    ctx.fillRect(x, sp.y + 8, sp.w, 6);
    for (let i = 0; i < n; i++) {
      const sx = x + (i + 0.5) * (sp.w / n);
      const iron = ctx.createLinearGradient(sx - 5, sp.y, sx + 5, sp.y);
      iron.addColorStop(0, "#2a2530");
      iron.addColorStop(0.45, "#6f7681");
      iron.addColorStop(1, "#1c1922");
      ctx.fillStyle = iron;
      ctx.beginPath();
      ctx.moveTo(sx - 5, sp.y + 12);
      ctx.lineTo(sx - 2.4, sp.y - 6);
      ctx.lineTo(sx, sp.y - 16);
      ctx.lineTo(sx + 2.4, sp.y - 6);
      ctx.lineTo(sx + 5, sp.y + 12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(226,196,142,0.5)";
      ctx.fillRect(sx - 0.7, sp.y - 14, 1.4, 22);
    }
  }

  // Una pluma: forma de hoja con raquis, del encaje al extremo.
  function drawFeather(rx, ry, tx, ty, width) {
    const dx = tx - rx;
    const dy = ty - ry;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const mx = rx + dx * 0.52;
    const my = ry + dy * 0.52;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.quadraticCurveTo(mx + nx * width, my + ny * width, tx, ty);
    ctx.quadraticCurveTo(mx - nx * width * 0.62, my - ny * width * 0.62, rx, ry);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.quadraticCurveTo(mx + nx * width * 0.2, my + ny * width * 0.2, tx, ty);
    ctx.stroke();
  }

  // Punto sobre el hueso del ala, del encaje del hombro a la punta.
  function wingBonePoint(t) {
    const mt = 1 - t;
    return [
      mt * mt * 7 + 2 * mt * t * -24 + t * t * -72,
      mt * mt * 10 + 2 * mt * t * -32 + t * t * -54,
    ];
  }

  // Hilera de plumas insertadas a lo largo del hueso y solapadas como tejas.
  function drawFeatherRow(t0, t1, count, deg0, deg1, len0, len1, width, phase) {
    for (let i = count - 1; i >= 0; i--) {
      const k = count > 1 ? i / (count - 1) : 0;
      const root = wingBonePoint(t0 + (t1 - t0) * k);
      const flutter = Math.sin(time * 9 + phase + i * 0.55) * 1.8;
      const a = ((deg0 + (deg1 - deg0) * k + flutter) * Math.PI) / 180;
      const len = len0 + (len1 - len0) * k;
      drawFeather(root[0], root[1], root[0] + Math.cos(a) * len, root[1] + Math.sin(a) * len, width);
    }
  }

  // Alas de ángel: plumas primarias, secundarias y cobertoras en capas.
  function drawWings(p) {
    const flap = Math.sin(time * 11) * 0.14;
    const alpha = clamp(p.wings * 2.4, 0, 1);
    ctx.save();
    ctx.globalAlpha = 0.72 + 0.28 * alpha;
    ctx.translate(-2, -40);

    // Resplandor santo detrás del plumaje.
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const halo = ctx.createRadialGradient(0, -8, 8, 0, -8, 104);
    halo.addColorStop(0, `rgba(255,246,206,${0.3 + 0.16 * alpha})`);
    halo.addColorStop(1, "rgba(255,214,132,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(-108, -112, 216, 168);
    ctx.restore();

    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(side, 1);
      ctx.rotate(-0.12 + flap);
      ctx.lineWidth = 0.8;
      const phase = side > 0 ? 0 : 1.4;

      // Manto del ala: evita huecos entre plumas.
      const membrane = ctx.createLinearGradient(8, 10, -66, -50);
      membrane.addColorStop(0, "#efe4cc");
      membrane.addColorStop(1, "#fbf5e6");
      ctx.fillStyle = membrane;
      ctx.beginPath();
      ctx.moveTo(8, 12);
      ctx.quadraticCurveTo(-24, -32, -72, -54);
      ctx.quadraticCurveTo(-50, -20, -28, -4);
      ctx.quadraticCurveTo(-10, 8, 8, 12);
      ctx.closePath();
      ctx.fill();

      // Primarias largas del borde exterior.
      ctx.fillStyle = "#fbf4e2";
      ctx.strokeStyle = "rgba(198,170,110,0.45)";
      drawFeatherRow(0.54, 1, 7, 120, 158, 48, 68, 9.2, phase);
      // Secundarias.
      ctx.fillStyle = "#fefcf3";
      ctx.strokeStyle = "rgba(208,182,124,0.42)";
      drawFeatherRow(0.2, 0.62, 6, 99, 124, 31, 43, 8.6, phase + 0.9);
      // Cobertoras del hombro.
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "rgba(218,194,140,0.4)";
      drawFeatherRow(0, 0.32, 5, 90, 110, 17, 25, 7.2, phase + 1.8);

      // Hueso del ala con brillo cálido.
      ctx.strokeStyle = "rgba(236,214,158,0.6)";
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(7, 10);
      ctx.quadraticCurveTo(-24, -32, -72, -54);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // ========================= Rig del héroe =========================
  // El personaje ya no se dibuja de corrido. Cada pieza vive en coordenadas
  // locales, con el origen en su propia articulación, y el esqueleto de
  // updateRig decide los ángulos de cada fotograma. Así se puede detallar una
  // pieza sin tocar la animación, y animar sin volver a dibujar.
  //
  // Jerarquía: pies → cadera → (piernas) y cadera → torso → (brazos, cabeza,
  // capa). Los ángulos van en radianes; positivo gira hacia donde mira.

  const HERO_SCALE = 1.36;
  const HIP_Y = -30;          // cadera respecto a los pies
  const THIGH = 15;
  const SHIN = 12.5;
  const SH_Y = -13;           // hombros en coordenadas del torso
  const UPPER_ARM = 10;
  const FOREARM = 9;
  const CAPE_LEN = [9, 8.5, 8, 7];
  const CAPE_W = [13, 12.5, 11, 8.5, 5.5];

  const SKIN = "#e9b791";
  const SKIN_DK = "#d79c76";
  const HAIR = "#6d3a1f";
  const HAIR_HI = "#a55f33";
  const CLOTH = "#2b3565";
  const CLOTH_HI = "#3c4884";
  const CLOTH_DK = "#1a2144";
  const LEATHER = "#6b4a2f";
  const LEATHER_HI = "#8d6639";
  const LEATHER_DK = "#3c2617";
  const GEM = "#3f7ad6";
  const SHADOW = "#2c3448";

  function approach(cur, target, rate, dt) {
    return cur + (target - cur) * Math.min(1, rate * dt);
  }

  // Sombreado de materiales de alta fidelidad. La luz principal viene de
  // arriba-izquierda (la luna), así cada pieza lleva un reflejo especular
  // cerca de ese borde, un núcleo en sombra y oclusión en la base.
  // dim oscurece la pieza para las que quedan del lado lejano del cuerpo.
  function steelFill(path, x0, y0, x1, y1, dim) {
    const d = dim || 0;
    // Contorno oscuro: separa cada placa de la vecina.
    path();
    ctx.strokeStyle = "rgba(18,24,36,0.7)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Base metálica de 5 paradas: borde iluminado, núcleo y oclusión.
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, lerpColor("#fbffff", SHADOW, d));
    g.addColorStop(0.16, lerpColor("#e6edef", SHADOW, d));
    g.addColorStop(0.46, lerpColor("#c2ccd4", SHADOW, d));
    g.addColorStop(0.74, lerpColor("#828d97", SHADOW, d));
    g.addColorStop(1, lerpColor("#3e4853", SHADOW, d));
    ctx.fillStyle = g;
    ctx.fill();
    // Reflejo especular de la luna sobre la placa (recortado a la pieza).
    ctx.save();
    path();
    ctx.clip();
    const sx = x0 + (x1 - x0) * 0.26;
    const sy = y0 + (y1 - y0) * 0.2;
    const rad = Math.max(x1 - x0, y1 - y0) * 0.6;
    const spec = ctx.createRadialGradient(sx, sy, 0.4, sx, sy, rad);
    spec.addColorStop(0, `rgba(255,255,255,${0.55 - d * 0.32})`);
    spec.addColorStop(0.45, `rgba(255,255,255,${0.14 - d * 0.08})`);
    spec.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = spec;
    ctx.fillRect(x0 - 3, y0 - 3, (x1 - x0) + 6, (y1 - y0) + 6);
    ctx.restore();
    // Filo iluminado.
    path();
    ctx.strokeStyle = `rgba(250,254,252,${0.9 - d * 0.5})`;
    ctx.lineWidth = 0.55;
    ctx.stroke();
  }

  function clothFill(path, x0, y0, x1, y1, dim) {
    const d = dim || 0;
    path();
    ctx.strokeStyle = "rgba(10,14,24,0.6)";
    ctx.lineWidth = 1.3;
    ctx.stroke();
    // Tela con pliegues: degradado más profundo y doble sombra.
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, lerpColor(CLOTH_HI, SHADOW, d));
    g.addColorStop(0.4, lerpColor(CLOTH, SHADOW, d));
    g.addColorStop(0.75, lerpColor(CLOTH_DK, SHADOW, d));
    g.addColorStop(1, lerpColor("#101630", SHADOW, d));
    ctx.fillStyle = g;
    ctx.fill();
    // Trama de tela: líneas tenues alternadas.
    ctx.save();
    path();
    ctx.clip();
    ctx.strokeStyle = `rgba(255,255,255,${0.05 - d * 0.03})`;
    ctx.lineWidth = 0.4;
    for (let ty = y0 + 2; ty < y1 - 1; ty += 3) {
      ctx.beginPath(); ctx.moveTo(x0, ty); ctx.lineTo(x1, ty); ctx.stroke();
    }
    ctx.restore();
  }

  function leatherFill(path, x0, y0, x1, y1, dim) {
    const d = dim || 0;
    path();
    ctx.strokeStyle = "rgba(18,10,6,0.65)";
    ctx.lineWidth = 1.3;
    ctx.stroke();
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, lerpColor(LEATHER_HI, SHADOW, d));
    g.addColorStop(0.55, lerpColor(LEATHER, SHADOW, d));
    g.addColorStop(1, lerpColor(LEATHER_DK, SHADOW, d));
    ctx.fillStyle = g;
    ctx.fill();
    // Grano del cuero y brillo satinado.
    ctx.save();
    path();
    ctx.clip();
    ctx.fillStyle = `rgba(40,22,12,${0.25 + d * 0.15})`;
    for (let gy = y0 + 2; gy < y1 - 1; gy += 2.4) {
      for (let gx = x0 + 2; gx < x1 - 1; gx += 2.4) {
        if (((gx + gy) | 0) % 3 === 0) {
          ctx.beginPath(); ctx.arc(gx, gy, 0.45, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    const sat = ctx.createLinearGradient(x0, y0, x1, y1);
    sat.addColorStop(0, `rgba(255,236,200,${0.18 - d * 0.1})`);
    sat.addColorStop(0.5, "rgba(255,236,200,0)");
    ctx.fillStyle = sat;
    ctx.fillRect(x0, y0, x1 - x0, (y1 - y0) * 0.5);
    ctx.restore();
  }

  function rivets(points, r, dim) {
    ctx.fillStyle = lerpColor("#e6ecee", SHADOW, dim || 0);
    for (const pt of points) {
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function makeRig() {
    return {
      lean: 0.05,
      crouch: 0,
      bob: 0,
      hipB: -0.05,
      kneeB: 0.12,
      ankleB: 0,
      hipF: 0.05,
      kneeF: 0.12,
      ankleF: 0,
      shB: -0.12,
      elB: -0.95,
      shF: 0.3,
      elF: -0.45,
      head: 0.02,
      grip: 1.35,
      hair: 0,
      hairV: 0,
      cape: [0.3, 0.12, 0.09, 0.06],
      capeV: [0, 0, 0, 0],
    };
  }

  // Traduce el estado del jugador a ángulos de articulación y los persigue
  // con suavizado, para que los cambios de pose no salgan a saltos.
  function updateRig(p, dt) {
    const r = p.rig || (p.rig = makeRig());
    const ph = p.anim;
    const speed = Math.abs(p.vx);
    const slide = p.dash > 0;
    const air = !p.onGround && !slide;
    const run = p.onGround && !slide && speed > 30;

    let lean = 0.05;
    let crouch = 0;
    let hipF = 0.07;
    let kneeF = 0.14;
    let hipB = -0.07;
    let kneeB = 0.14;
    let shF = -0.2;
    let elF = -0.4;
    let shB = -0.1;
    let elB = -1.15;
    let head = 0.02;

    // Reposo: respiracion lenta. El cuerpo se asienta y la cabeza y los
    // brazos oscilan apenas; da vida sin que se vea rigido.
    if (!slide && !air && !run) {
      const br = Math.sin(time * 2.2);
      crouch = 0.04 + br * 0.03;
      head += br * 0.04;
      shF += br * 0.05;
      shB -= br * 0.05;
      lean += br * 0.02;
    }

    if (slide) {
      // Derrape: cadera baja, pierna de adelante estirada, torso echado.
      crouch = 1;
      lean = 0.85;
      hipF = 1.35;
      kneeF = 0.25;
      hipB = 0.35;
      kneeB = 1.9;
      shF = 0.75;
      elF = -0.2;
      shB = 0.35;
      elB = -1.3;
      head = -0.34;
    } else if (air) {
      const rising = p.vy < 0;
      lean = rising ? 0.13 : -0.03;
      hipF = rising ? 0.66 : 0.38;
      kneeF = rising ? 1 : 0.5;
      hipB = rising ? -0.3 : -0.52;
      kneeB = rising ? 0.6 : 1;
      shF = rising ? -0.75 : 0.15;
      elF = -0.5;
      shB = -0.05;
      elB = -1.1;
      head = rising ? -0.07 : 0.06;
    } else if (run) {
      // Ciclo de carrera humano: la cadera balancea poco y la rodilla
      // es la que levanta el pie. Cuando la pierna balancea hacia ADELANTE
      // (hip negativo) la rodilla se DOBLA y el pie queda DETRAS de la
      // rodilla (no como carnera); la pierna de atras queda estirada para
      // empujar. s = sin(ph): s>0 => pierna cerca atras (apoyo); s<0 =>
      // pierna cerca adelante (balanceo).
      const s = Math.sin(ph);
      lean = 0.17;
      hipF = 0.5 * s;
      kneeF = 0.65 - 0.4 * s;
      hipB = -0.5 * s;
      kneeB = 0.65 + 0.4 * s;
      shF = -0.2 - 0.34 * s;
      elF = -0.4 - 0.18 * (0.5 + 0.5 * Math.cos(ph));
      // El brazo del escudo va casi fijo en guardia: apenas balancea
      // para que el escudo no clipee ni baile durante la carrera.
      shB = -0.1 + 0.1 * s;
      elB = -1.15;
      head = 0.05;
    }

    // Aterrizaje: absorbe el golpe doblando las rodillas (flexion positiva).
    if (p.landDust > 0) {
      const k = clamp(p.landDust / 0.2, 0, 1) * 0.55;
      kneeF += k;
      kneeB += k;
      crouch = Math.max(crouch, k * 0.5);
    }

    // El espadazo manda sobre el brazo delantero: anticipacion, tajo y
    // follow-through. El cuerpo lungea hacia adelante en el golpe.
    if (p.attack > 0) {
      const t = clamp(1 - p.attack / 0.28, 0, 1);
      if (t < 0.2) {
        // Anticipacion: arma atras, cuerpo se carga y escudo sube.
        const a = t / 0.2;
        shF = 0.4 + a * 1.0;
        elF = -0.5 - a * 0.7;
        lean -= a * 0.12;
        head -= a * 0.08;
        shB += a * 0.3;
        crouch = Math.max(crouch, a * 0.15);
      } else if (t < 0.55) {
        // Tajo: descarga rapida hacia adelante con lunge del cuerpo.
        const k = (t - 0.2) / 0.35;
        const e = Math.sin((k) * Math.PI);           // impulso que sube y baja
        shF = 1.4 - k * 2.7;
        elF = -1.2 + k * 1.0;
        lean += 0.18 * e;                            // lunge adelante en el pico
        head += 0.12 * e;
        crouch = Math.max(crouch, 0.12 * e);
        kneeF += 0.25 * e;                          // pierna adelantada carga el golpe
      } else {
        // Follow-through: la hoja sigue su inercia, el cuerpo se recupera.
        const k = (t - 0.55) / 0.45;
        shF = -1.3 + k * 0.5;
        elF = -0.2 - k * 0.3;
        lean -= (1 - k) * 0.06;
      }
      head += Math.sin(t * Math.PI) * 0.05;
    }
    if (p.cast > 0) {
      shF = -1.85;
      elF = -0.1;
      head = -0.14;
    }
    // Al recibir daño levanta el escudo.
    if (p.shield > 0) {
      shB -= p.shield * 0.55;
      elB -= p.shield * 0.4;
    }

    const rate = 17;
    r.lean = approach(r.lean, lean, rate, dt);
    r.crouch = approach(r.crouch, crouch, slide ? 26 : 13, dt);
    r.hipF = approach(r.hipF, hipF, rate, dt);
    r.kneeF = approach(r.kneeF, kneeF, rate, dt);
    r.hipB = approach(r.hipB, hipB, rate, dt);
    r.kneeB = approach(r.kneeB, kneeB, rate, dt);
    r.shF = approach(r.shF, shF, p.attack > 0 ? 34 : rate, dt);
    r.elF = approach(r.elF, elF, p.attack > 0 ? 34 : rate, dt);
    r.shB = approach(r.shB, shB, rate, dt);
    r.elB = approach(r.elB, elB, rate, dt);
    r.head = approach(r.head, head, 12, dt);
    // Agarre: en reposo la hoja cuelga; al golpear se alinea con el antebrazo.
    r.grip = approach(r.grip, p.attack > 0 ? 0.35 : p.cast > 0 ? 0.95 : 1.35, 26, dt);
    // El pie busca quedar plano en el suelo pese al giro de la pierna.
    r.ankleF = approach(r.ankleF, clamp(-(r.hipF + r.kneeF) * 0.55, -0.5, 0.5), rate, dt);
    r.ankleB = approach(r.ankleB, clamp(-(r.hipB + r.kneeB) * 0.55, -0.5, 0.5), rate, dt);

    // Respiración en reposo, rebote al correr.
    r.bob = run ? Math.abs(Math.sin(ph)) * 1.5 : Math.sin(time * 3) * 0.4;

    // Capa: cadena de cuatro eslabones con resorte, empujada por la carrera.
    const drive = clamp(speed / 250, 0, 1.5) + (p.onGround ? 0 : 0.45) + (slide ? 0.8 : 0);
    const base = [0.42, 0.2, 0.16, 0.12];
    const lift = [0.5, 0.2, 0.14, 0.1];
    for (let i = 0; i < 4; i++) {
      const flap = Math.sin(time * 5.5 - i * 0.8) * (0.04 + drive * 0.05);
      const target = base[i] + drive * lift[i] + flap;
      const stiff = 70 - i * 9;
      const damp = 2 * Math.sqrt(stiff) * 0.62;
      r.capeV[i] += ((target - r.cape[i]) * stiff - r.capeV[i] * damp) * dt;
      r.cape[i] += r.capeV[i] * dt;
    }

    // Mechones con retardo: reaccionan a la velocidad y al salto.
    const hairTarget = clamp(-p.vx / 320, -1, 1) * 0.55 + clamp(p.vy / 800, -0.6, 0.6) * 0.4;
    r.hairV += ((hairTarget - r.hair) * 70 - r.hairV * 10) * dt;
    r.hair += r.hairV * dt;
  }

  // --- Bota: suela, caña de cuero, correas y puntera de acero ---------
  function drawBoot(dim) {
    leatherFill(() => {
      ctx.beginPath();
      ctx.moveTo(-4.2, -4.6);
      ctx.lineTo(3, -4.6);
      ctx.quadraticCurveTo(4.4, -2, 6.2, 1.2);
      ctx.lineTo(6.2, 3.2);
      ctx.lineTo(-4.2, 3.2);
      ctx.closePath();
    }, -4, -5, 5, 3, dim);
    ctx.fillStyle = lerpColor(LEATHER_HI, SHADOW, dim);
    ctx.fillRect(-4.2, -3.4, 9.4, 1.4);
    ctx.fillRect(-4.2, -0.8, 8.6, 1.3);
    ctx.fillStyle = lerpColor("#cfd6d8", SHADOW, dim);
    ctx.fillRect(1.4, -3.8, 2.2, 2.2);
    // Puntera y suela.
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(2.6, 0.2);
      ctx.quadraticCurveTo(6.4, 0.6, 6.6, 3.2);
      ctx.lineTo(2.6, 3.2);
      ctx.closePath();
    }, 2, 0, 7, 3, dim);
    ctx.fillStyle = lerpColor("#241a12", SHADOW, dim * 0.5);
    roundRect(-4.6, 3, 11.6, 2.1, 0.9);
    ctx.fill();
  }

  // --- Pierna completa: muslo, quijote, rodillera, greba y bota -------
  function drawLeg(rig, front) {
    const dim = front ? 0 : 0.32;
    const hip = front ? rig.hipF : rig.hipB;
    const knee = front ? rig.kneeF : rig.kneeB;
    const ankle = front ? rig.ankleF : rig.ankleB;
    ctx.save();
    ctx.rotate(hip);
    clothFill(() => {
      ctx.beginPath();
      ctx.moveTo(-4.6, -1.5);
      ctx.lineTo(4.6, -1.5);
      ctx.lineTo(3.8, THIGH);
      ctx.lineTo(-3.8, THIGH);
      ctx.closePath();
    }, -4, -1, 4, THIGH, dim);
    ctx.strokeStyle = `rgba(158,180,232,${0.2 - dim * 0.1})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(-1.8, 1);
    ctx.quadraticCurveTo(0.6, 5.5, -0.9, THIGH - 1);
    ctx.stroke();
    // Quijote: placa del muslo.
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(-4.7, 0.6);
      ctx.quadraticCurveTo(0, -1.6, 4.7, 0.6);
      ctx.lineTo(4.2, 4.8);
      ctx.quadraticCurveTo(0, 6.6, -4.2, 4.8);
      ctx.closePath();
    }, -4, -1, 4, 5.5, dim);
    ctx.fillStyle = `rgba(255,255,255,${0.35 - dim * 0.2})`;
    ctx.fillRect(-2.4, 1.4, 1.5, 3);

    ctx.save();
    ctx.translate(0, THIGH);
    ctx.rotate(knee);
    // Rodillera con flor de lis grabada.
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(-4.7, -2.4);
      ctx.quadraticCurveTo(0, -5, 4.7, -2.4);
      ctx.quadraticCurveTo(5.4, 1.4, 3.4, 3.2);
      ctx.quadraticCurveTo(0, 1.6, -3.4, 3.2);
      ctx.quadraticCurveTo(-5.4, 1.4, -4.7, -2.4);
      ctx.closePath();
    }, -4, -5, 4, 3, dim);
    ctx.fillStyle = lerpColor("rgba(96,110,124,0.8)", SHADOW, dim);
    fleurDeLis(0, -0.2, 0.36);
    // Greba con nervio central.
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(-4.2, 1.8);
      ctx.lineTo(4.2, 1.8);
      ctx.lineTo(3.4, SHIN);
      ctx.lineTo(-3.4, SHIN);
      ctx.closePath();
    }, -4, 2, 4, SHIN, dim);
    ctx.fillStyle = `rgba(255,255,255,${0.42 - dim * 0.25})`;
    ctx.fillRect(-1.5, 3, 1.6, SHIN - 4.4);
    rivets([[-3, 2.8], [3, 2.8]], 0.5, dim);

    ctx.save();
    ctx.translate(0, SHIN);
    ctx.rotate(ankle);
    drawBoot(dim);
    ctx.restore();
    ctx.restore();
    ctx.restore();
  }

  // --- Cadera: cinturón, hebilla, faldones y sobreveste --------------
  function drawPelvis(rig, pelvisY) {
    ctx.save();
    ctx.translate(0, pelvisY);
    ctx.rotate(rig.lean * 0.4);
    // Sobreveste azul con ribete y flor de lis.
    clothFill(() => {
      ctx.beginPath();
      ctx.moveTo(-7.5, -3);
      ctx.lineTo(7.5, -3);
      ctx.lineTo(6, 8);
      ctx.lineTo(0.6, 5);
      ctx.lineTo(-4.6, 8);
      ctx.closePath();
    }, -7, -3, 7, 8);
    ctx.strokeStyle = "rgba(196,206,224,0.75)";
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.fillStyle = "#ccd5db";
    fleurDeLis(1, 3, 0.62);
    // Faldones de placas a los lados.
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.scale(s, 1);
      steelFill(() => {
        ctx.beginPath();
        ctx.moveTo(4.6, -3.4);
        ctx.lineTo(8.6, -2.6);
        ctx.lineTo(7.8, 3.4);
        ctx.quadraticCurveTo(6, 4.6, 4.4, 3.2);
        ctx.closePath();
      }, 4, -3, 8.6, 4, s > 0 ? 0 : 0.3);
      ctx.restore();
    }
    // Cinturón de cuero con hebilla cuadrada.
    leatherFill(() => {
      roundRect(-8.6, -5.4, 17.2, 4.4, 1.6);
    }, -8, -5, 8, -1);
    ctx.fillStyle = LEATHER_DK;
    ctx.fillRect(-8.6, -2.2, 17.2, 0.8);
    ctx.fillStyle = "#cfd6d8";
    roundRect(-2.2, -5.8, 4.8, 5, 1);
    ctx.fill();
    ctx.fillStyle = LEATHER;
    ctx.fillRect(-1, -4.4, 2.4, 2.2);
    ctx.restore();
  }

  // --- Capa: cadena de eslabones dibujada como una sola tela ---------
  function drawCape(rig) {
    const ax = -3.5;
    const ay = SH_Y - 1;
    const pts = [];
    let cx = ax;
    let cy = ay;
    let ang = 0;
    for (let i = 0; i < CAPE_LEN.length; i++) {
      ang += rig.cape[i];
      pts.push({ x: cx, y: cy, ang });
      cx += -Math.sin(ang) * CAPE_LEN[i];
      cy += Math.cos(ang) * CAPE_LEN[i];
    }
    pts.push({ x: cx, y: cy, ang });

    const left = [];
    const right = [];
    for (let i = 0; i < pts.length; i++) {
      const w = CAPE_W[i] / 2;
      const nx = Math.cos(pts[i].ang);
      const ny = Math.sin(pts[i].ang);
      left.push([pts[i].x - nx * w, pts[i].y - ny * w]);
      right.push([pts[i].x + nx * w, pts[i].y + ny * w]);
    }

    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(left[0][0], left[0][1]);
      for (let i = 1; i < left.length; i++) {
        const mx = (left[i - 1][0] + left[i][0]) / 2;
        const my = (left[i - 1][1] + left[i][1]) / 2;
        ctx.quadraticCurveTo(left[i - 1][0], left[i - 1][1], mx, my);
      }
      ctx.lineTo(left[left.length - 1][0], left[left.length - 1][1]);
      ctx.lineTo(right[right.length - 1][0], right[right.length - 1][1]);
      for (let i = right.length - 2; i >= 0; i--) {
        const mx = (right[i + 1][0] + right[i][0]) / 2;
        const my = (right[i + 1][1] + right[i][1]) / 2;
        ctx.quadraticCurveTo(right[i + 1][0], right[i + 1][1], mx, my);
      }
      ctx.closePath();
    };

    const tip = pts[pts.length - 1];
    const g = ctx.createLinearGradient(ax, ay, tip.x, tip.y);
    g.addColorStop(0, "#5877e8");
    g.addColorStop(0.45, "#2a44a6");
    g.addColorStop(1, "#111a46");
    ctx.fillStyle = g;
    outline();
    ctx.fill();
    // Pliegues internos siguiendo la cadena.
    ctx.strokeStyle = "rgba(150,180,255,0.3)";
    ctx.lineWidth = 0.8;
    for (const off of [-0.3, 0.15]) {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const w = (CAPE_W[i] / 2) * off;
        const x = pts[i].x + Math.cos(pts[i].ang) * w;
        const y = pts[i].y + Math.sin(pts[i].ang) * w;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Filo iluminado del borde exterior.
    ctx.strokeStyle = "rgba(190,214,255,0.5)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1]);
    ctx.stroke();
  }

  // --- Torso: gambesón, coraza en tres lamas, correa y gola ----------
  function drawTorso(rig, p) {
    // Gambesón azul que asoma bajo la coraza.
    clothFill(() => {
      ctx.beginPath();
      ctx.moveTo(-7.4, -16.5);
      ctx.quadraticCurveTo(0, -19.5, 8, -16);
      ctx.lineTo(7, 1);
      ctx.quadraticCurveTo(0, 4, -7, 1);
      ctx.closePath();
    }, -7, -17, 7, 2);

    // Coraza: tres lamas superpuestas con nervio central.
    const plates = [
      [-15.6, -8.6, 7.4, 8],
      [-9.4, -3.4, 7.8, 8.4],
      [-4, 1.6, 7.4, 8.2],
    ];
    for (let i = 0; i < plates.length; i++) {
      const [top, bottom, halfTop, halfBottom] = plates[i];
      steelFill(() => {
        ctx.beginPath();
        ctx.moveTo(-halfTop, top);
        ctx.quadraticCurveTo(0.6, top - 2.4, halfTop, top);
        ctx.lineTo(halfBottom, bottom);
        ctx.quadraticCurveTo(0.4, bottom + 1.6, -halfBottom, bottom);
        ctx.closePath();
      }, -halfTop, top, halfTop, bottom, 0);
      ctx.strokeStyle = "rgba(88,98,108,0.55)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(-halfBottom, bottom);
      ctx.quadraticCurveTo(0.4, bottom + 1.6, halfBottom, bottom);
      ctx.stroke();
    }
    // Nervio central y flor de lis grabada.
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.fillRect(-0.4, -15, 1.4, 15);
    ctx.fillStyle = "rgba(96,110,124,0.85)";
    fleurDeLis(3.2, -9, 1);
    ctx.fillStyle = "rgba(246,250,248,0.5)";
    fleurDeLis(2.8, -9.6, 1);

    // Correa de cuero cruzada, con costura y hebilla.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-8, -17);
    ctx.quadraticCurveTo(0, -20, 8.4, -16.4);
    ctx.lineTo(7.4, 2);
    ctx.quadraticCurveTo(0, 4.6, -7.4, 2);
    ctx.closePath();
    ctx.clip();
    ctx.rotate(0.5);
    leatherFill(() => {
      roundRect(-22, -12.4, 44, 3.2, 0.6);
    }, -20, -12, 20, -9);
    ctx.strokeStyle = "rgba(230,206,168,0.45)";
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    ctx.moveTo(-22, -11.6);
    ctx.lineTo(22, -11.6);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#cfd6d8";
    roundRect(4.4, -12.4, 3, 3, 0.8);
    ctx.fill();

    // Gola y cuello de la capa con broche.
    ctx.fillStyle = "#222b57";
    roundRect(-6.6, -19.4, 13.6, 4.4, 2);
    ctx.fill();
    ctx.fillStyle = "#2b45a8";
    ctx.beginPath();
    ctx.moveTo(-7.2, -19.8);
    ctx.quadraticCurveTo(0, -22.4, 7.4, -19.4);
    ctx.lineTo(7, -15.6);
    ctx.quadraticCurveTo(0, -18.4, -7, -16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(164,196,255,0.32)";
    ctx.fillRect(-6, -19.6, 12.4, 1.3);
    ctx.fillStyle = "#cdd6dc";
    ctx.beginPath();
    ctx.arc(-4.4, -16.6, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7d8891";
    ctx.beginPath();
    ctx.arc(-4.4, -16.6, 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    ctx.arc(-5, -17.2, 0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Hombrera de tres lamas ----------------------------------------
  function drawPauldron(dim) {
    if (pauldronSprite.complete && pauldronSprite.naturalWidth > 0) {
      // Sprite de la hombrera en alta fidelidad. Se ancla en el hombro
      // del rig (centro de la hombrera vectorial). dim oscurece la
      // hombrera lejana para dar profundidad. Tamano reducido para que
      // concuerde con el cuerpo del personaje.
      const w = 12, h = 12 * pauldronSprite.naturalHeight / pauldronSprite.naturalWidth;
      ctx.save();
      if (dim > 0) {
        // Hombrera lejana: un poco mas oscura y azulada (atmosfera).
        ctx.filter = "none";
        ctx.globalAlpha = 1 - dim * 0.45;
      }
      ctx.drawImage(pauldronSprite, -w / 2, -h * 0.62, w, h);
      if (dim > 0) {
        // Tinte azul oscuro por encima para diferenciarla del brazo cercano.
        ctx.globalAlpha = dim * 0.5;
        ctx.fillStyle = "#1a2238";
        ctx.fillRect(-w / 2, -h * 0.62, w, h);
      }
      ctx.restore();
      return;
    }
    steelFill(() => {
      ctx.beginPath();
      ctx.ellipse(0, 0, 7.6, 5.4, 0.22, 0, Math.PI * 2);
    }, -7, -5, 7, 5, dim);
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(-6.4, 1.4);
      ctx.quadraticCurveTo(0, 5.4, 6.2, 0.6);
      ctx.quadraticCurveTo(2, 3.8, -5.4, 3.4);
      ctx.closePath();
    }, -6, 0, 6, 4, dim);
    ctx.strokeStyle = `rgba(104,114,124,${0.7 - dim * 0.4})`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(0, 0.6, 4.8, 0.2, Math.PI - 0.2);
    ctx.stroke();
    ctx.fillStyle = lerpColor("rgba(104,118,130,0.8)", SHADOW, dim);
    fleurDeLis(0.4, -1.4, 0.42);
  }

  // --- Brazo genérico: manga, brazal, codo y guantelete --------------
  function drawArm(shoulder, elbow, dim, hand) {
    ctx.save();
    ctx.rotate(shoulder);
    clothFill(() => {
      roundRect(-2.9, -2.6, 5.8, 9, 2.8);
    }, -3, -2, 3, 6, dim);
    // Brazal: sólo cubre la mitad exterior de la manga.
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(-2.6, 3.4);
      ctx.quadraticCurveTo(0.4, 2.2, 3, 3.4);
      ctx.lineTo(2.7, UPPER_ARM);
      ctx.quadraticCurveTo(0, UPPER_ARM + 1.2, -2.4, UPPER_ARM);
      ctx.closePath();
    }, -2.6, 3, 3, UPPER_ARM, dim);
    ctx.fillStyle = `rgba(255,255,255,${0.3 - dim * 0.18})`;
    ctx.fillRect(-1.4, 4.6, 1.2, UPPER_ARM - 5.6);

    ctx.save();
    ctx.translate(0, UPPER_ARM);
    ctx.rotate(elbow);
    // Codo y antebrazo.
    steelFill(() => {
      ctx.beginPath();
      ctx.ellipse(0, 0.4, 3.2, 2.7, 0, 0, Math.PI * 2);
    }, -3, -2, 3, 3, dim);
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(-2.9, 1.4);
      ctx.quadraticCurveTo(0, 0.4, 2.9, 1.4);
      ctx.lineTo(2.7, FOREARM);
      ctx.quadraticCurveTo(0, FOREARM + 1.1, -2.7, FOREARM);
      ctx.closePath();
    }, -2.9, 1, 2.9, FOREARM, dim);
    ctx.fillStyle = lerpColor("#e4eaea", SHADOW, dim);
    ctx.fillRect(-2.9, FOREARM - 2.4, 5.8, 1.4);
    // Guantelete de cuero con nudillos de acero.
    ctx.save();
    ctx.translate(0, FOREARM);
    leatherFill(() => {
      roundRect(-3.4, -0.4, 6.8, 6.4, 2);
    }, -3, 0, 3, 6, dim + 0.25);
    ctx.fillStyle = lerpColor("#c8d0d2", SHADOW, dim);
    for (const kx of [-2.2, 0, 2.2]) {
      roundRect(kx - 0.9, 0.6, 1.8, 1.6, 0.6);
      ctx.fill();
    }
    if (hand) hand();
    ctx.restore();
    ctx.restore();
    ctx.restore();
  }

  // --- Escudo cometa: borde, campo azul, cruz plateada y gema -------
  // upright compensa el giro del brazo: el escudo se sostiene casi vertical
  // aunque el hombro y el codo se muevan.
  function drawShield(p, upright) {
    ctx.save();
    // Va embrazado al antebrazo, no colgando de la mano: se compensa el giro
    // del brazo y se desplaza hacia el costado del cuerpo.
    ctx.translate(0, -FOREARM * 0.45);
    ctx.rotate(upright + 0.12 - p.shield * 0.4);
    ctx.translate(-6.5, 4);
    ctx.scale(0.72, 0.72);
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(-12.5, -15.5);
      ctx.quadraticCurveTo(0, -21.5, 12.5, -15.5);
      ctx.lineTo(10.5, 7);
      ctx.quadraticCurveTo(0, 24, -10.5, 7);
      ctx.closePath();
    }, -12, -20, 12, 20, 0);
    const field = ctx.createLinearGradient(-9, -14, 8, 14);
    field.addColorStop(0, "#3c4d9c");
    field.addColorStop(0.55, "#243066");
    field.addColorStop(1, "#141c42");
    ctx.fillStyle = field;
    ctx.beginPath();
    ctx.moveTo(-9.4, -12.4);
    ctx.quadraticCurveTo(0, -17.6, 9.4, -12.4);
    ctx.lineTo(7.8, 5);
    ctx.quadraticCurveTo(0, 18.6, -7.8, 5);
    ctx.closePath();
    ctx.fill();
    // Cruz plateada con perfil.
    ctx.fillStyle = "#dbe3e7";
    ctx.fillRect(-1.8, -14.4, 3.8, 27.6);
    ctx.fillRect(-7.2, -6.2, 14.4, 3.8);
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillRect(-1.8, -14.4, 1.3, 27.6);
    ctx.fillRect(-7.2, -6.2, 14.4, 1.2);
    ctx.fillStyle = "rgba(70,84,104,0.5)";
    ctx.fillRect(1.4, -14.4, 0.7, 27.6);
    ctx.fillStyle = "#9fabb3";
    fleurDeLis(0.1, -9.6, 0.46);
    // Umbo con gema azul.
    ctx.fillStyle = "#cfd7da";
    ctx.beginPath();
    ctx.arc(0.1, -4.2, 3.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = GEM;
    ctx.beginPath();
    ctx.arc(0.1, -4.2, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(214,238,255,0.9)";
    ctx.beginPath();
    ctx.arc(-0.6, -4.9, 0.8, 0, Math.PI * 2);
    ctx.fill();
    rivets([[-9, -11.4], [9, -11.4], [0.1, 14.4]], 1.2, 0);
    ctx.restore();
  }

  // --- Espada: pomo, empuñadura, guarda con gema y hoja acanalada ----
  function drawSword(p, grip) {
    ctx.save();
    ctx.translate(1.2, 3);
    ctx.rotate(grip);

    // Pomo: esfera dorada con realce.
    const pommel = ctx.createRadialGradient(-7, -0.7, 0.3, -6.4, 0, 2.4);
    pommel.addColorStop(0, "#ffe9a8");
    pommel.addColorStop(0.5, "#d9b25a");
    pommel.addColorStop(1, "#7a5a22");
    ctx.fillStyle = pommel;
    ctx.beginPath();
    ctx.arc(-6.4, 0, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.beginPath();
    ctx.arc(-7, -0.8, 0.7, 0, Math.PI * 2);
    ctx.fill();

    // Empuñadura: cuero oscuro con vueltas de cordel.
    ctx.fillStyle = "#2a1d10";
    roundRect(-5.4, -1.7, 8, 3.4, 1);
    ctx.fill();
    ctx.strokeStyle = "rgba(180,150,90,0.65)";
    ctx.lineWidth = 0.5;
    for (const gx of [-4.2, -2.6, -1, 0.6]) {
      ctx.beginPath();
      ctx.moveTo(gx, -1.7);
      ctx.lineTo(gx + 0.9, 1.7);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(-5.4, -1.7); ctx.lineTo(-5.4, 1.7);
    ctx.moveTo(2.6, -1.7); ctx.lineTo(2.6, 1.7);
    ctx.stroke();

    // Guarda: quillones curvos que se ensanchan hacia las puntas.
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(4.4, -7.6);
      ctx.quadraticCurveTo(8.4, -4.4, 8.8, -3);
      ctx.lineTo(7.4, -1.4);
      ctx.lineTo(2.8, -4.8);
      ctx.closePath();
    }, 2, -7, 7, 7, 0);
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(4.4, 7.6);
      ctx.quadraticCurveTo(8.4, 4.4, 8.8, 3);
      ctx.lineTo(7.4, 1.4);
      ctx.lineTo(2.8, 4.8);
      ctx.closePath();
    }, 2, -7, 7, 7, 0);
    // Centro de la guarda.
    steelFill(() => {
      ctx.beginPath();
      ctx.moveTo(2.8, -4.8);
      ctx.lineTo(7.4, -1.4);
      ctx.lineTo(7.4, 1.4);
      ctx.lineTo(2.8, 4.8);
      ctx.closePath();
    }, 2, -7, 7, 7, 0);

    // Gema azul diamantada en la guarda con brillo.
    ctx.fillStyle = GEM;
    ctx.beginPath();
    ctx.moveTo(4, 0);
    ctx.lineTo(5.6, -2.1);
    ctx.lineTo(7.2, 0);
    ctx.lineTo(5.6, 2.1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(214,238,255,0.9)";
    ctx.beginPath();
    ctx.moveTo(4.6, -0.4); ctx.lineTo(5.6, -1.6); ctx.lineTo(6.2, -0.4); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(120,160,220,0.7)";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(4, 0); ctx.lineTo(5.6, -2.1); ctx.lineTo(7.2, 0); ctx.lineTo(5.6, 2.1); ctx.closePath();
    ctx.stroke();

    // Hoja: mas larga, con acanaladura (fuller) central y filos brillantes.
    const blade = ctx.createLinearGradient(7, -3, 42, 3);
    blade.addColorStop(0, "#7e8a94");
    blade.addColorStop(0.35, "#eef4f6");
    blade.addColorStop(0.6, "#ffffff");
    blade.addColorStop(0.8, "#c6cfd4");
    blade.addColorStop(1, "#8fa0ab");
    ctx.fillStyle = blade;
    ctx.beginPath();
    ctx.moveTo(7.4, -2.9);
    ctx.lineTo(33, -1.7);
    ctx.lineTo(41, 0);
    ctx.lineTo(33, 1.7);
    ctx.lineTo(7.4, 2.9);
    ctx.closePath();
    ctx.fill();

    // Acanaladura central (fuller): sombra fina a lo largo de la hoja.
    const fuller = ctx.createLinearGradient(7, 0, 41, 0);
    fuller.addColorStop(0, "rgba(60,70,82,0.45)");
    fuller.addColorStop(0.5, "rgba(120,134,148,0.25)");
    fuller.addColorStop(1, "rgba(60,70,82,0.45)");
    ctx.strokeStyle = fuller;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(32, 0);
    ctx.stroke();

    // Filos brillantes en ambos lados.
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(7.6, -2.7); ctx.lineTo(32.6, -1.55);
    ctx.moveTo(7.6, 2.7); ctx.lineTo(32.6, 1.55);
    ctx.stroke();
    // Punta afilada.
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.moveTo(33, -1.7); ctx.lineTo(41, 0); ctx.lineTo(33, 1.7); ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  // Estela del tajo: va anclada al pecho, no al brazo, para que el arco se
  // lea como el recorrido de la hoja y no gire con el hombro.
  function drawSlashArc(p) {
    const t = clamp(1 - p.attack / 0.28, 0, 1);
    if (t < 0.2) return;
    const k = (t - 0.2) / 0.8;
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.translate(7, -9);
    // El arco barre desde atras-arriba hacia adelante-abajo con el tajo.
    ctx.rotate(-1.0 + k * 2.0);
    // Estela exterior tenue y ancha.
    ctx.globalAlpha = (1 - k) * 0.5;
    ctx.strokeStyle = "rgba(180,210,255,0.7)";
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.arc(0, 0, 26, -1.1, 0.9);
    ctx.stroke();
    // Estela media brillante.
    ctx.globalAlpha = (1 - k) * 0.85;
    ctx.strokeStyle = "rgba(224,240,255,0.95)";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(0, 0, 23, -0.95, 0.8);
    ctx.stroke();
    // Nucleo blanco fino (el filo).
    ctx.globalAlpha = (1 - k);
    ctx.strokeStyle = "rgba(255,255,255,0.98)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 29, -0.78, 0.66);
    ctx.stroke();
    // Chispa en la punta del arco al inicio del tajo.
    if (k < 0.35) {
      ctx.globalAlpha = (1 - k / 0.35) * 0.9;
      ctx.fillStyle = "rgba(255,250,230,1)";
      const sx = 23 * Math.cos(0.8), sy = 23 * Math.sin(0.8);
      ctx.beginPath();
      ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // --- Cabeza: cráneo, oreja, rostro, lentes y pelo en tres capas ----
  // --- Cabeza: sprite de alta fidelidad generado por IA -------------
  // Se dibuja la cabeza real (cara + pelo + lentes) sobre el rig; si
  // la imagen aun no carga, se cae al dibujo vectorial.
  function drawHead(rig, p) {
    ctx.save();
    ctx.translate(0.6, SH_Y - 8.5);
    ctx.rotate(rig.head);
    ctx.scale(0.93, 0.93);

    // Cuello: se mantiene vectorial para empalmar con el torso.
    // Un poco mas largo para subir la cara sobre la hombrera sin hueco.
    ctx.fillStyle = SKIN_DK;
    roundRect(-2.6, 2, 5.6, 7, 2); ctx.fill();
    ctx.fillStyle = "rgba(150,96,70,0.3)";
    ctx.fillRect(-2.6, 6, 5.6, 2.5);

    if (headSprite.complete && headSprite.naturalWidth > 0) {
      // Sprite de la cabeza: cara + pelo + lentes en alta fidelidad.
      const w = 34;                       // cabeza pequena y proporcionada
      const sh = 760, sy = 20;           // recorte vertical (sin bufanda)
      const h = w * sh / 1024;
      ctx.translate(0.4, -3.4);
      // Pequeno cizallamiento horizontal del pelo (rig.hair); ojo: el
      // componente "d" DEBE ser 1, si es 0 colapsa el eje Y y la cabeza
      // se aplasta a una linea invisible (bug que hacia que no se viera).
      ctx.transform(1, 0, rig.hair * 0.10, 1, 0, 0);
      // La cabeza (pelo 10% .. barbilla 70%) esta ~51% del recorte.
      ctx.drawImage(headSprite, 0, sy, 1024, sh, -w / 2, -h * 0.51, w, h);
      ctx.restore();
      return;
    }

    // --- Respaldo vectorial si el sprite no ha cargado ---
    const sway = rig.hair;
    const skin = ctx.createLinearGradient(-6, -10, 7, 4);
    skin.addColorStop(0, lerpColor("#dcb094", SHADOW, 0.12));
    skin.addColorStop(0.5, SKIN);
    skin.addColorStop(1, "#f0c9a6");
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(0.4, -3.4, 8, 9.4, 0.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(170,108,80,0.22)";
    ctx.beginPath();
    ctx.ellipse(-3.2, -2.4, 5.4, 8.4, 0.06, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(150,92,68,0.28)";
    ctx.beginPath();
    ctx.ellipse(-2, 3.6, 4.6, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,236,214,0.5)";
    ctx.beginPath();
    ctx.ellipse(4.6, -2.4, 2.6, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = lerpColor(HAIR, SHADOW, 0.25);
    ctx.beginPath();
    ctx.moveTo(-7.4, -6);
    ctx.quadraticCurveTo(-9.4, 1.4, -5.4, 3.4);
    ctx.quadraticCurveTo(-3.4, 0.4, -3.8, -5);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = SKIN_DK;
    ctx.beginPath(); ctx.ellipse(-4, -3.4, 1.7, 2.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(150,96,70,0.7)"; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.arc(-4, -3.4, 0.9, -1, 1.8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-4.6, -3.8); ctx.quadraticCurveTo(-4, -2.6, -3.4, -2.6); ctx.stroke();
    ctx.strokeStyle = "rgba(150,92,70,0.7)"; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(5.2, -5.2); ctx.quadraticCurveTo(7, -4, 7.2, -2.6); ctx.stroke();
    ctx.fillStyle = "rgba(150,92,70,0.3)";
    ctx.beginPath(); ctx.ellipse(7.4, -2.2, 1.1, 0.9, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(120,70,52,0.5)";
    ctx.beginPath(); ctx.arc(7.6, -2.2, 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,236,220,0.6)";
    ctx.beginPath(); ctx.ellipse(7, -3.4, 0.7, 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(132,76,54,0.85)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(3.4, -0.6); ctx.quadraticCurveTo(5, 0.4, 6.6, -0.4); ctx.stroke();
    ctx.fillStyle = "rgba(196,108,92,0.4)";
    ctx.beginPath(); ctx.moveTo(3.4, -0.6); ctx.quadraticCurveTo(5, 0.2, 6.6, -0.4); ctx.quadraticCurveTo(5, -0.2, 3.4, -0.6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = lerpColor(HAIR, "#2a1408", 0.4); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(2.4, -8); ctx.quadraticCurveTo(4.4, -8.6, 6.4, -8.2); ctx.stroke();
    ctx.fillStyle = "rgba(248,240,228,0.95)";
    ctx.beginPath(); ctx.ellipse(4.6, -4.8, 1.5, 1.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#6e4a2c";
    ctx.beginPath(); ctx.ellipse(4.9, -4.7, 1.1, 1.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1a0e08";
    ctx.beginPath(); ctx.ellipse(5, -4.6, 0.6, 0.9, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath(); ctx.arc(4.8, -4.9, 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#3a241a"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(3.2, -6); ctx.quadraticCurveTo(4.6, -6.4, 6, -6); ctx.stroke();
    ctx.strokeStyle = "rgba(40,24,16,0.6)"; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(3.6, -5.6); ctx.lineTo(3.8, -4.4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(5.2, -5.5); ctx.lineTo(5.4, -4.2); ctx.stroke();
    ctx.fillStyle = "rgba(190,224,255,0.1)";
    roundRect(2, -6.8, 5.8, 4.6, 1.4); ctx.fill();
    ctx.strokeStyle = "rgba(40,48,60,0.92)"; ctx.lineWidth = 0.9;
    roundRect(2, -6.8, 5.8, 4.6, 1.4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(7.8, -5.9); ctx.lineTo(9.4, -6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(2, -5.9); ctx.lineTo(-2.4, -6.2); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(3, -6.3); ctx.lineTo(5, -6.6); ctx.stroke();
    ctx.fillStyle = HAIR;
    ctx.beginPath();
    ctx.moveTo(-7.6, -5.4);
    ctx.quadraticCurveTo(-9.4, -16.8, 0.4, -17.4);
    ctx.quadraticCurveTo(11.2, -16, 9.6, -5);
    ctx.lineTo(6.4, -10.2);
    ctx.lineTo(3.6, -5);
    ctx.lineTo(0.2, -10.8);
    ctx.lineTo(-2.8, -5);
    ctx.lineTo(-4.8, -9.6);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = lerpColor(HAIR_HI, "#3a1a0e", 0.3);
    ctx.beginPath();
    ctx.moveTo(-5.4, -11.4); ctx.quadraticCurveTo(0, -16.4, 6.4, -12.4);
    ctx.quadraticCurveTo(2, -14.4, -2, -13.4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = HAIR;
    ctx.beginPath();
    ctx.moveTo(-6.2, -12.6);
    ctx.quadraticCurveTo(-10.6 - sway * 3.4, -12.8, -11.4 - sway * 4, -7.6);
    ctx.quadraticCurveTo(-8.6, -9, -6.8, -7.2); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(6.4, -12.6);
    ctx.quadraticCurveTo(10.4 - sway * 1.8, -11.6, 10 - sway * 2.2, -7.4);
    ctx.quadraticCurveTo(8.4, -9.4, 7, -8); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = HAIR_HI; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-5, -12); ctx.quadraticCurveTo(0.2, -16.6, 7.4, -11);
    ctx.moveTo(-3, -14.6); ctx.quadraticCurveTo(2, -17.2, 6, -14.6);
    ctx.stroke();
    ctx.restore();
  }

  // --- Efectos ligados al héroe --------------------------------------
  function drawGroundShadow(p, rig) {
    if (!p.onGround) return;
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "#04060e";
    ctx.beginPath();
    ctx.ellipse(0, 0, 12 + rig.crouch * 4, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSlideStreak(p) {
    ctx.save();
    ctx.globalAlpha = clamp(p.dash / 0.28, 0, 1) * 0.32;
    ctx.fillStyle = "#dce6ff";
    for (const off of [11, 19, 27]) {
      ctx.beginPath();
      ctx.ellipse(-off, -8, 3.5, 7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCastGlow(p) {
    const amount = clamp(p.cast / 0.26, 0, 1);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = amount;
    ctx.translate(10, -22);
    const halo = ctx.createRadialGradient(0, 0, 1, 0, 0, 24);
    halo.addColorStop(0, "rgba(255,248,220,0.9)");
    halo.addColorStop(1, "rgba(255,214,120,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(-26, -26, 52, 52);
    ctx.fillStyle = "#fff8e2";
    ctx.fillRect(-1.8, -12, 3.6, 22);
    ctx.fillRect(-7.5, -4, 15, 3.6);
    ctx.restore();
  }

  // --- Ensamblaje: de las piezas de atrás a las de adelante ----------
  function drawPlayer(p, camX) {
    if (p.dead) return;
    const blink = p.invuln > 0 && Math.floor(time * 18) % 2 === 0;
    if (blink) return;
    const rig = p.rig || (p.rig = makeRig());

    ctx.save();
    ctx.translate(p.x - camX + p.w / 2, p.y + p.h);
    ctx.scale(p.facing, 1);
    if (p.winged) drawWings(p);
    ctx.scale(HERO_SCALE, HERO_SCALE);

    if (p.dash > 0) drawSlideStreak(p);
    drawGroundShadow(p, rig);

    // Con los pies en el suelo la cadera se calcula desde el alcance de la
    // pierna más estirada: al doblar rodillas el cuerpo baja de verdad, y el
    // rebote de la carrera o el derrape salen solos.
    let pelvisY = HIP_Y + rig.bob * 0.4;
    if (p.onGround) {
      const reach = (hip, knee) => THIGH * Math.cos(hip) + SHIN * Math.cos(hip + knee) + 2.6;
      pelvisY = -Math.max(reach(rig.hipF, rig.kneeF), reach(rig.hipB, rig.kneeB));
    }
    const torsoY = pelvisY - 3;

    // Capa, detrás de todo.
    ctx.save();
    ctx.translate(0, torsoY);
    ctx.rotate(rig.lean);
    drawCape(rig);
    ctx.restore();

    // Piernas.
    ctx.save();
    ctx.translate(-2.4, pelvisY);
    drawLeg(rig, false);
    ctx.restore();
    ctx.save();
    ctx.translate(2.8, pelvisY);
    drawLeg(rig, true);
    ctx.restore();

    drawPelvis(rig, pelvisY);

    // Torso y lo que cuelga de él.
    ctx.save();
    ctx.translate(0, torsoY);
    ctx.rotate(rig.lean);

    // Hombro lejano y su brazo, por detrás del pecho.
    ctx.save();
    ctx.translate(-4.6, SH_Y);
    drawPauldron(0.32);
    ctx.restore();

    drawTorso(rig, p);

    // Brazo del escudo, cruzado por delante del pecho.
    ctx.save();
    ctx.translate(-4.6, SH_Y + 0.6);
    drawArm(rig.shB, rig.elB, 0.28, () => drawShield(p, -(rig.shB + rig.elB)));
    ctx.restore();

    // Orden de capas pedido: Cabeza (fondo) -> Brazo -> Hombrera (encima).
    // La cabeza se dibuja antes que el brazo y la hombrera cercanas para
    // que la hombrera quede por encima del brazo y la cabeza.
    drawHead(rig, p);

    // Brazo de la espada, sobre la cabeza.
    ctx.save();
    ctx.translate(5.4, SH_Y + 0.8);
    drawArm(rig.shF, rig.elF, 0, () => drawSword(p, rig.grip));
    ctx.restore();

    // Hombrera de la espada, la pieza mas cercana: queda encima del brazo
    // y de la cabeza, como pide el usuario.
    ctx.save();
    ctx.translate(5.4, SH_Y);
    drawPauldron(0);
    ctx.restore();

    if (p.attack > 0) drawSlashArc(p);

    if (p.cast > 0) drawCastGlow(p);
    ctx.restore();
    ctx.restore();
  }

  // Marca el demonio al que irá la próxima cruz y su fe restante.
  function drawLock(camX, p) {
    const t = world.lock;
    if (!t || !t.alive || p.dead) return;
    const ready = p.mana >= CROSS_COST;
    const cx = t.x + t.w / 2 - camX;
    const cy = t.y + t.h / 2;
    const r = Math.max(t.w, t.h) * 0.62 + 6;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(time * 0.8);
    ctx.globalAlpha = ready ? 1 : 0.45;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0
        ? "rgba(20,14,8,0.55)"
        : ready ? "#ffe6a4" : "#c3cbdb";
      ctx.lineWidth = pass === 0 ? 4 : 2;
      ctx.save();
      for (let i = 0; i < 4; i++) {
        ctx.rotate(Math.PI / 2);
        ctx.beginPath();
        ctx.arc(0, 0, r, -0.32, 0.32);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();

    if (t.type === "boss") return;
    const pips = t.maxHp || 1;
    const total = pips * 5 + (pips - 1) * 2;
    const px0 = cx - total / 2;
    const py = t.y - 13;
    ctx.fillStyle = "rgba(14,10,6,0.6)";
    roundRect(px0 - 2, py - 2, total + 4, 7, 2);
    ctx.fill();
    for (let i = 0; i < pips; i++) {
      ctx.fillStyle = i < t.hp ? "#ffe8aa" : "#4a4234";
      ctx.fillRect(px0 + i * 7, py, 5, 3);
    }
  }

  function drawHoly(camX) {
    for (const c of world.holy) {
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.translate(c.x - camX + c.w / 2, c.y + c.h / 2);

      // Estela de luz en sentido contrario al vuelo.
      const sp = Math.hypot(c.vx, c.vy) || 1;
      const tx = (-c.vx / sp) * 40;
      const ty = (-c.vy / sp) * 40;
      const trail = ctx.createLinearGradient(0, 0, tx, ty);
      trail.addColorStop(0, "rgba(255,244,200,0.55)");
      trail.addColorStop(1, "rgba(255,214,120,0)");
      ctx.strokeStyle = trail;
      ctx.lineWidth = 7;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      const halo = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
      halo.addColorStop(0, "rgba(255,247,214,0.85)");
      halo.addColorStop(0.5, "rgba(255,214,130,0.32)");
      halo.addColorStop(1, "rgba(255,200,90,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(-28, -28, 56, 56);
      ctx.rotate(c.spin);
      ctx.fillStyle = "#fff8e2";
      ctx.fillRect(-2.4, -10.5, 4.8, 21);
      ctx.fillRect(-8, -3.4, 16, 4.8);
      ctx.fillStyle = "rgba(240,208,120,0.95)";
      ctx.fillRect(-0.8, -10.5, 1.4, 21);
      ctx.restore();
    }
  }

  function drawRings(camX) {
    for (const r of world.rings) {
      const a = clamp(r.life / r.maxLife, 0, 1);
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.strokeStyle = `${r.color}${(a * 0.85).toFixed(3)})`;
      ctx.lineWidth = 3 + (1 - a) * 4;
      ctx.beginPath();
      ctx.arc(r.x - camX, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Demonio callejero: encorvado, cuernos de cabra y ojos de brasa.
  function drawImp(e, camX) {
    const x = e.x - camX + e.w / 2;
    const y = e.y + e.h;
    const step = Math.sin(time * 9 + e.home) * 0.5;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale((e.vx >= 0 ? 1 : -1) * 1.3, 1.3);
    if (e.flash > 0) ctx.globalAlpha = 0.5;

    const aura = ctx.createRadialGradient(0, -14, 2, 0, -14, 26);
    aura.addColorStop(0, "rgba(220,50,40,0.25)");
    aura.addColorStop(1, "rgba(220,50,40,0)");
    ctx.fillStyle = aura;
    ctx.fillRect(-28, -42, 56, 50);

    // Cola.
    ctx.strokeStyle = "#4a0e18";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-7, -14);
    ctx.quadraticCurveTo(-20, -12 + step * 3, -17, -2);
    ctx.stroke();
    ctx.fillStyle = "#4a0e18";
    ctx.beginPath();
    ctx.moveTo(-20, -4);
    ctx.lineTo(-14, -1);
    ctx.lineTo(-19, 2);
    ctx.closePath();
    ctx.fill();

    // Piernas digitígradas.
    ctx.fillStyle = "#3a0a12";
    ctx.beginPath();
    ctx.moveTo(-5, -13);
    ctx.lineTo(-2 + step, -5);
    ctx.lineTo(-8 + step, 0);
    ctx.lineTo(-1, 0);
    ctx.lineTo(1, -12);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(3, -13);
    ctx.lineTo(6 - step, -5);
    ctx.lineTo(1 - step, 0);
    ctx.lineTo(9, 0);
    ctx.lineTo(9, -12);
    ctx.closePath();
    ctx.fill();

    // Torso encorvado.
    const skin = ctx.createLinearGradient(-10, -30, 10, -8);
    skin.addColorStop(0, "#a02330");
    skin.addColorStop(0.55, "#6d1420");
    skin.addColorStop(1, "#380810");
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.moveTo(-9, -12);
    ctx.quadraticCurveTo(-13, -26, -3, -30);
    ctx.quadraticCurveTo(9, -32, 11, -22);
    ctx.quadraticCurveTo(12, -14, 8, -11);
    ctx.closePath();
    ctx.fill();

    // Brazo con garras.
    ctx.strokeStyle = "#7d1a26";
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(6, -24);
    ctx.quadraticCurveTo(15, -18, 13, -9);
    ctx.stroke();
    ctx.strokeStyle = "#e8dcc8";
    ctx.lineWidth = 1.1;
    for (const c of [-2.5, 0, 2.5]) {
      ctx.beginPath();
      ctx.moveTo(13 + c * 0.5, -9);
      ctx.lineTo(15 + c, -3);
      ctx.stroke();
    }

    // Cabeza y cuernos.
    ctx.fillStyle = "#7d1a26";
    ctx.beginPath();
    ctx.ellipse(4, -34, 8, 7, 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#2b1a14";
    ctx.beginPath();
    ctx.moveTo(-2, -39);
    ctx.quadraticCurveTo(-9, -48, -3, -49);
    ctx.quadraticCurveTo(-2, -44, 1, -40);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(9, -39);
    ctx.quadraticCurveTo(16, -48, 11, -50);
    ctx.quadraticCurveTo(9, -44, 7, -40);
    ctx.fill();

    // Ojos y fauces.
    ctx.fillStyle = "#ffd24a";
    ctx.beginPath();
    ctx.ellipse(2, -35, 2.3, 1.5, 0.3, 0, Math.PI * 2);
    ctx.ellipse(8, -35, 2.3, 1.5, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#160408";
    ctx.beginPath();
    ctx.moveTo(2, -30);
    ctx.lineTo(11, -30);
    ctx.lineTo(6, -26);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Demonio volador: alas membranosas y cráneo encendido.
  function drawFlyer(e, camX) {
    const x = e.x - camX + e.w / 2;
    const y = e.y + e.h / 2;
    const flap = Math.sin(time * 12 + e.phase) * 0.45;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1.3, 1.3);
    if (e.flash > 0) ctx.globalAlpha = 0.5;

    const aura = ctx.createRadialGradient(0, 0, 2, 0, 0, 30);
    aura.addColorStop(0, "rgba(200,40,60,0.22)");
    aura.addColorStop(1, "rgba(200,40,60,0)");
    ctx.fillStyle = aura;
    ctx.fillRect(-32, -26, 64, 52);

    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(side, 1);
      ctx.rotate(flap * 0.5);
      const wing = ctx.createLinearGradient(0, 0, -22, 6);
      wing.addColorStop(0, "#7b2130");
      wing.addColorStop(1, "#2a070f");
      ctx.fillStyle = wing;
      ctx.beginPath();
      ctx.moveTo(-1, -5);
      ctx.quadraticCurveTo(-16, -18, -26, -8);
      ctx.quadraticCurveTo(-19, -5, -24, 3);
      ctx.quadraticCurveTo(-16, 1, -20, 10);
      ctx.quadraticCurveTo(-9, 4, -1, 5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(255,170,150,0.28)";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-2, -3);
      ctx.lineTo(-22, -7);
      ctx.moveTo(-2, 0);
      ctx.lineTo(-21, 3);
      ctx.stroke();
      ctx.restore();
    }

    const body = ctx.createLinearGradient(-8, -8, 8, 8);
    body.addColorStop(0, "#9c2434");
    body.addColorStop(1, "#3c0a12");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, 7.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e6dbc4";
    ctx.beginPath();
    ctx.ellipse(2, -1, 5.5, 4.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ff5a2a";
    ctx.beginPath();
    ctx.arc(0.6, -2, 1.5, 0, Math.PI * 2);
    ctx.arc(4.4, -2, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2a1810";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(0, 2.4);
    ctx.lineTo(5.4, 2.4);
    ctx.stroke();
    ctx.restore();
  }

  function drawBoss(b, camX) {
    if (!b.alive && b.hp <= 0) return;
    const x = b.x - camX + b.w / 2;
    const y = b.y + b.h;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(b.facing * 1.25, 1.25);
    if (b.flash > 0) ctx.globalAlpha = 0.5;
    const idle = Math.sin(time * 3) * 2.5;
    const flap = Math.sin(time * 4) * 0.12;

    // Bruma infernal a sus pies.
    const smoke = ctx.createRadialGradient(0, -10, 4, 0, -10, 70);
    smoke.addColorStop(0, "rgba(200,40,20,0.35)");
    smoke.addColorStop(1, "rgba(120,10,10,0)");
    ctx.fillStyle = smoke;
    ctx.fillRect(-80, -80, 160, 90);

    // Alas membranosas de demonio.
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(side, 1);
      ctx.rotate(flap * side);
      const wing = ctx.createLinearGradient(0, -70, -64, -10);
      wing.addColorStop(0, "#5c1018");
      wing.addColorStop(0.6, "#38080f");
      wing.addColorStop(1, "#1a0408");
      ctx.fillStyle = wing;
      ctx.beginPath();
      ctx.moveTo(0, -86 + idle);
      ctx.quadraticCurveTo(-64, -128, -104, -86);
      ctx.quadraticCurveTo(-82, -76, -98, -52);
      ctx.quadraticCurveTo(-72, -56, -84, -24);
      ctx.quadraticCurveTo(-56, -40, -34, -18);
      ctx.quadraticCurveTo(-30, -44, -4, -48);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(255,120,90,0.24)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-8, -80);
      ctx.lineTo(-92, -80);
      ctx.moveTo(-8, -68);
      ctx.lineTo(-86, -50);
      ctx.moveTo(-8, -56);
      ctx.lineTo(-72, -24);
      ctx.stroke();
      ctx.restore();
    }

    // Piernas de macho cabrío con pezuñas.
    for (const lx of [-16, 12]) {
      const legGrad = ctx.createLinearGradient(lx - 10, -34, lx + 12, 0);
      legGrad.addColorStop(0, "#7a1723");
      legGrad.addColorStop(0.6, "#4a0d16");
      legGrad.addColorStop(1, "#20060a");
      ctx.fillStyle = legGrad;
      ctx.beginPath();
      ctx.moveTo(lx - 8, -36);
      ctx.lineTo(lx + 8, -36);
      ctx.lineTo(lx + 10, -12);
      ctx.lineTo(lx + 13, -3);
      ctx.lineTo(lx - 11, -3);
      ctx.lineTo(lx - 8, -12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#1b1310";
      roundRect(lx - 12, -5, 25, 6, 2);
      ctx.fill();
      ctx.fillStyle = "rgba(230,219,196,0.35)";
      ctx.fillRect(lx - 10, -4.5, 21, 1.4);
    }

    // Torso acorazado con costillas expuestas.
    const flesh = ctx.createLinearGradient(-34, -104, 30, -30);
    flesh.addColorStop(0, "#a72433");
    flesh.addColorStop(0.45, "#71121f");
    flesh.addColorStop(1, "#320710");
    ctx.fillStyle = flesh;
    ctx.beginPath();
    ctx.moveTo(-30, -34);
    ctx.quadraticCurveTo(-40, -84, -22, -100 + idle);
    ctx.quadraticCurveTo(0, -110 + idle, 24, -100 + idle);
    ctx.quadraticCurveTo(38, -80, 28, -34);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(240,190,160,0.3)";
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(-20, -84 + i * 12 + idle * 0.4);
      ctx.quadraticCurveTo(0, -76 + i * 12, 20, -84 + i * 12 + idle * 0.4);
      ctx.stroke();
    }
    // Vientre oscuro y placas de hueso en los hombros.
    ctx.fillStyle = "rgba(20,4,8,0.45)";
    ctx.beginPath();
    ctx.moveTo(-24, -52);
    ctx.quadraticCurveTo(0, -34, 24, -52);
    ctx.quadraticCurveTo(0, -44, -24, -52);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#1e0c10";
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(side, 1);
      ctx.beginPath();
      ctx.ellipse(26, -92 + idle, 12, 9, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e6dbc4";
      ctx.beginPath();
      ctx.moveTo(22, -98 + idle);
      ctx.lineTo(36, -116 + idle);
      ctx.lineTo(32, -94 + idle);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#1e0c10";
      ctx.restore();
    }

    // Sigilo invertido que brilla en el pecho.
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const sig = 0.5 + Math.sin(time * 5) * 0.2;
    ctx.fillStyle = `rgba(255,90,40,${sig})`;
    ctx.fillRect(-2.5, -92 + idle, 5, 34);
    ctx.fillRect(-13, -70 + idle, 26, 5);
    ctx.restore();

    // Brazo con hoja de hueso.
    ctx.strokeStyle = "#6d1420";
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(22, -92 + idle);
    ctx.quadraticCurveTo(44, -74, 38, -46);
    ctx.stroke();
    const bone = ctx.createLinearGradient(36, -50, 62, -8);
    bone.addColorStop(0, "#e6dbc4");
    bone.addColorStop(1, "#8a7f6a");
    ctx.fillStyle = bone;
    ctx.beginPath();
    ctx.moveTo(34, -48);
    ctx.quadraticCurveTo(64, -34, 58, 2);
    ctx.quadraticCurveTo(44, -20, 30, -40);
    ctx.closePath();
    ctx.fill();

    // Cabeza de macho cabrío.
    ctx.fillStyle = "#7d1a26";
    ctx.beginPath();
    ctx.ellipse(2, -114 + idle, 18, 15, 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1e0f0c";
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(side, 1);
      ctx.beginPath();
      ctx.moveTo(8, -124 + idle);
      ctx.quadraticCurveTo(34, -146 + idle, 26, -160 + idle);
      ctx.quadraticCurveTo(20, -150 + idle, 6, -130 + idle);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = "#ff9a3a";
    ctx.beginPath();
    ctx.ellipse(-6, -116 + idle, 4.6, 3, 0.25, 0, Math.PI * 2);
    ctx.ellipse(10, -116 + idle, 4.6, 3, -0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#150406";
    ctx.beginPath();
    ctx.moveTo(-8, -106 + idle);
    ctx.lineTo(14, -106 + idle);
    ctx.lineTo(4, -98 + idle);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#e6dbc4";
    for (const tx of [-5, 0, 5, 10]) {
      ctx.beginPath();
      ctx.moveTo(tx, -106 + idle);
      ctx.lineTo(tx + 2, -101 + idle);
      ctx.lineTo(tx + 4, -106 + idle);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();

    if (b.slam > 0) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,90,50,0.7)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(b.x - camX + b.w / 2, b.y + b.h, 90, 12, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    for (const pr of b.projectiles) {
      ctx.save();
      ctx.translate(pr.x - camX + 7, pr.y + 7);
      const g = ctx.createRadialGradient(0, 0, 1, 0, 0, 12);
      g.addColorStop(0, "#ffe9a0");
      g.addColorStop(0.4, "#ff5a2a");
      g.addColorStop(1, "rgba(80,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPickup(pk, camX) {
    if (pk.taken) return;
    const x = pk.x - camX + 8;
    const y = pk.y + Math.sin(pk.bob) * 5;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(196,60,74,0.25)";
    ctx.beginPath();
    ctx.arc(0, 0, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c43c4a";
    ctx.beginPath();
    ctx.moveTo(0, 7);
    ctx.bezierCurveTo(-12, -2, -6, -11, 0, -4);
    ctx.bezierCurveTo(6, -11, 12, -2, 0, 7);
    ctx.fill();
    ctx.restore();
  }

  function drawSigns(camX, p) {
    ctx.font = "13px Cinzel, serif";
    ctx.textAlign = "center";
    for (const s of world.level.signs) {
      if (Math.abs(p.x - s.x) > 160) continue;
      const x = s.x - camX;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      const w = ctx.measureText(s.text).width + 16;
      ctx.fillRect(x - w / 2, s.y - 18, w, 22);
      ctx.fillStyle = "#e8c872";
      ctx.fillText(s.text, x, s.y);
    }
  }

  function drawHudCanvas() {
    const b = world.boss;
    if (!b || !world.arenaLock) return;
    const x = 220;
    const y = 18;
    const w = 520;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(x, y, w, 28);
    ctx.fillStyle = "#e8c872";
    ctx.font = "11px Cinzel, serif";
    ctx.textAlign = "left";
    ctx.fillText(b.alive ? b.name : "Vorath sellado", x + 8, y + 11);
    const ratio = b.alive ? b.hp / b.maxHp : 0;
    ctx.fillStyle = "#3a1820";
    ctx.fillRect(x + 8, y + 15, w - 16, 8);
    ctx.fillStyle = "#c43c4a";
    ctx.fillRect(x + 8, y + 15, (w - 16) * ratio, 8);
  }

  function drawParticles(camX) {
    for (const pt of world.particles) {
      ctx.globalAlpha = clamp(pt.life / pt.max, 0, 1);
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - camX, pt.y, pt.size, pt.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(W / 2, H / 2, 180, W / 2, H / 2, 520);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function draw() {
    const camX = world ? world.cam.x : 0;
    const sx = shake > 0.4 ? rand(-shake, shake) : 0;
    const sy = shake > 0.4 ? rand(-shake, shake) * 0.4 : 0;
    baseTransform(sx, sy);
    drawBackground(camX);
    if (!world) {
      screenTransform();
      return;
    }
    const p = world.player;
    const hell = clamp((camX - 2900) / 1000, 0, 1);
    drawProps(camX, hell);
    for (const pl of world.level.platforms) drawPlatform(pl, camX);
    for (const sp of world.level.spikes) drawSpikes(sp, camX);
    for (const pk of world.pickups) drawPickup(pk, camX);
    for (const e of world.enemies) {
      if (!e.alive) continue;
      if (e.type === "imp") drawImp(e, camX);
      else drawFlyer(e, camX);
    }
    if (world.boss) drawBoss(world.boss, camX);
    drawLock(camX, p);
    drawPlayer(p, camX);
    drawHoly(camX);
    drawParticles(camX);
    drawRings(camX);
    drawSigns(camX, p);
    screenTransform();
    drawVignette();
    drawHudCanvas();
  }

  function loop(ts) {
    if (!lastT) lastT = ts;
    let dt = (ts - lastT) / 1000;
    lastT = ts;
    if (dt > 0.05) dt = 0.05;
    fitBuffer();
    update(dt);
    draw();
    edge.jump = false;
    edge.attack = false;
    edge.cross = false;
    requestAnimationFrame(loop);
  }

  function showPlay() {
    state = "play";
    overlay.hidden = true;
    hud.hidden = false;
    touchEl.hidden = false;
  }

  function showDead() {
    state = "dead";
    overlay.hidden = false;
    panelStart.hidden = true;
    panelDead.hidden = false;
    panelWin.hidden = true;
  }

  function showWin() {
    state = "win";
    sfx.win();
    if (winStatsEl && world) {
      const n = world.exorcised;
      winStatsEl.textContent = n === 1 ? "1 demonio exorcizado" : `${n} demonios exorcizados`;
    }
    overlay.hidden = false;
    panelStart.hidden = true;
    panelDead.hidden = true;
    panelWin.hidden = false;
  }

  function startGame() {
    ensureAudio();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    resetWorld();
    edge.jump = false;
    edge.attack = false;
    edge.cross = false;
    showPlay();
  }

  document.getElementById("btn-start").addEventListener("click", startGame);
  document.getElementById("btn-retry").addEventListener("click", startGame);
  document.getElementById("btn-again").addEventListener("click", startGame);

  window.addEventListener("keydown", (e) => {
    keys[e.key] = true;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) e.preventDefault();
    if (state !== "play") {
      if ((e.key === "Enter" || e.key === " ") && (state === "menu" || state === "dead" || state === "win")) {
        e.preventDefault();
        startGame();
      }
      return;
    }
    if (e.key === " " || e.key === "w" || e.key === "W" || e.key === "ArrowUp") {
      if (!e.repeat) edge.jump = true;
    }
    if (["j", "J", "x", "X"].includes(e.key) && !e.repeat) edge.attack = true;
    if (["k", "K", "c", "C"].includes(e.key) && !e.repeat) edge.cross = true;
    if (!e.repeat) {
      if (["ArrowLeft", "a", "A"].includes(e.key)) registerTap(-1);
      if (["ArrowRight", "d", "D"].includes(e.key)) registerTap(1);
    }
  });
  window.addEventListener("keyup", (e) => {
    keys[e.key] = false;
  });

  function bindButton(btn) {
    const action = btn.dataset.action;
    const press = (ev) => {
      ev.preventDefault();
      btn.setPointerCapture(ev.pointerId);
      btn.classList.add("is-down");
      held[action] = true;
      if (action === "jump") edge.jump = true;
      if (action === "attack") edge.attack = true;
      if (action === "cross") edge.cross = true;
      if (action === "left") registerTap(-1);
      if (action === "right") registerTap(1);
    };
    const release = (ev) => {
      btn.classList.remove("is-down");
      held[action] = false;
      if (ev && btn.hasPointerCapture?.(ev.pointerId)) {
        try {
          btn.releasePointerCapture(ev.pointerId);
        } catch (_) {}
      }
    };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("lostpointercapture", () => release());
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  for (const btn of touchEl.querySelectorAll(".btn")) bindButton(btn);

  window.addEventListener("blur", () => {
    held.left = held.right = held.jump = held.attack = held.cross = false;
  });

  resetWorld();
  requestAnimationFrame(loop);
})();
