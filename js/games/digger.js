/* Multiplayer Digger for browserP2P.
 * Host owns the shared mine. Clients send compact actions; the host broadcasts snapshots.
 */
(function () {
  "use strict";

  const COLS = 18;
  const SURFACE_Y = 0;
  const SKY_ROWS = 2;
  const TOPSOIL = 6;
  const STARTER_LOOT = 120;
  const ENTER_DELAY_MS = 160;
  const SNAPSHOT_HZ = 12;
  const FULL_SNAPSHOT_MARGIN_ROWS = 12;

  const T = {
    EMPTY: 0,
    DIRT: 1,
    ROCK: 2,
    DENSE: 3,
    OBSID: 4,
    HAZARD: 5,
    LADDER: 6,
    BEDROCK: 9,
  };

  const HARD = { [T.DIRT]: 1, [T.ROCK]: 2, [T.DENSE]: 3, [T.OBSID]: 4, [T.HAZARD]: 1 };
  const DIG_MS = {
    [T.DIRT]: 500,
    [T.ROCK]: 800,
    [T.DENSE]: 1100,
    [T.OBSID]: 1500,
    [T.HAZARD]: 300,
  };
  const PICKAXE_SPEED = [1, 1.35, 1.75, 2.25];
  const HARDNESS_SPEED_PENALTY = {
    [T.DIRT]: 0.86,
    [T.ROCK]: 1,
    [T.DENSE]: 1.12,
    [T.OBSID]: 1.28,
    [T.HAZARD]: 0.75,
  };
  const LOOT = { coin: 3, gold: 9, gem: 22, diamond: 60 };
  const SHOP = [
    { key: "dig", name: "Pickaxe", emoji: "⛏️", desc: "Break harder rock", costs: [25, 60, 140], max: 4 },
    { key: "bag", name: "Big Bag", emoji: "🎒", desc: "+30 carry capacity", costs: [30, 85, 180], max: 4 },
    { key: "stam", name: "Battery", emoji: "🔋", desc: "+8 stamina", costs: [30, 70, 140], max: 4 },
    { key: "hp", name: "Armor", emoji: "🛡️", desc: "+1 heart", costs: [50, 120, 250], max: 4 },
    { key: "ladder", name: "Ladders", emoji: "🪜", desc: "+5 ladders", cost: 20, consumable: true },
  ];

  function create(host, initialState) {
    const canvas = host.canvas;
    const ctx = canvas.getContext("2d");
    const myId = host.myId;

    let rafId = 0;
    let lastTs = 0;
    let lastSnapshotAt = 0;
    let cell = 40;
    let topPad = 72;
    let camX = COLS / 2;
    let camY = 0;
    let latest = null;
    let drag = null;
    let activePointerId = null;
    let shopOpen = false;
    let shopRects = [];
    let buttonRects = {};
    let message = "Dig together. Swipe or use WASD.";
    let messageUntil = 0;
    let particles = [];
    let audioCtx = null;

    const world = new Map();
    const miners = new Map();
    const dirtyTiles = new Set();
    let generatedMaxY = SURFACE_Y - SKY_ROWS - 1;
    let lastFullSnapshot = null;
    let lastFullSnapshotDirty = true;

    function key(x, y) { return x + "," + y; }
    function fromKey(k) {
      const p = k.split(",");
      return { x: Number(p[0]), y: Number(p[1]) };
    }
    function now() { return performance.now(); }
    function isHost() { return !!host.isHost(); }

    function playSound(kind) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const t = audioCtx.currentTime;
        const tones = {
          dig: [180, 0.045, 0.035],
          break: [95, 0.08, 0.055],
          treasure: [520, 0.09, 0.06],
          ladder: [330, 0.06, 0.04],
          buy: [620, 0.08, 0.05],
          wrong: [120, 0.10, 0.045],
          hurt: [80, 0.16, 0.06],
        };
        const [freq, dur, vol] = tones[kind] || tones.dig;
        osc.type = kind === "treasure" || kind === "buy" ? "triangle" : "square";
        osc.frequency.setValueAtTime(freq, t);
        if (kind === "break") osc.frequency.exponentialRampToValueAtTime(55, t + dur);
        gain.gain.setValueAtTime(vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + dur);
      } catch {}
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      topPad = Math.max(64, Math.min(86, rect.height * 0.12));
      cell = Math.max(28, Math.floor(rect.width / 9));
    }

    function genTile(x, y) {
      if (x < 0 || x >= COLS) return { type: T.BEDROCK, loot: 0 };
      if (y <= SURFACE_Y) return { type: T.EMPTY, loot: 0 };
      if (y <= TOPSOIL) return { type: T.DIRT, loot: 0 };

      const depth = y;
      const r = Math.random();
      if (r < Math.min(0.12, 0.018 + depth * 0.0035)) return { type: T.HAZARD, loot: 0 };

      let type = T.DIRT;
      const rr = Math.random();
      if (depth > 24 && rr < 0.24) type = T.OBSID;
      else if (depth > 13 && rr < 0.38) type = T.DENSE;
      else if (depth > 5 && rr < 0.50) type = T.ROCK;
      else if (rr < 0.25) type = T.ROCK;

      let loot = 0;
      if (Math.random() < Math.min(0.34, 0.07 + depth * 0.006)) {
        const t = Math.random();
        if (depth > 26 && t < 0.06) loot = LOOT.diamond;
        else if (depth > 15 && t < 0.16) loot = LOOT.gem;
        else if (depth > 7 && t < 0.40) loot = LOOT.gold;
        else loot = LOOT.coin;
      }
      return { type, loot };
    }

    function tileAt(x, y) {
      const k = key(x, y);
      let tile = world.get(k);
      if (!tile) {
        tile = genTile(x, y);
        world.set(k, tile);
        dirtyTiles.add(k);
        lastFullSnapshotDirty = true;
      }
      if (y > generatedMaxY && x >= -1 && x <= COLS) generatedMaxY = y;
      return tile;
    }

    function setTile(x, y, tile) {
      world.set(key(x, y), tile);
      dirtyTiles.add(key(x, y));
      lastFullSnapshotDirty = true;
    }

    function spawnTileParticles(col, row, color, count = 10) {
      const px = screenX(col) + cell / 2;
      const py = screenY(row) + cell / 2;
      for (let i = 0; i < count; i++) {
        particles.push({
          x: px,
          y: py,
          vx: (Math.random() - 0.5) * 3.2,
          vy: -Math.random() * 2.8 - 0.5,
          life: 24 + Math.random() * 18,
          color,
        });
      }
      if (particles.length > 180) particles.splice(0, particles.length - 180);
    }

    function updateParticles() {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.18;
        p.life--;
        if (p.life <= 0) particles.splice(i, 1);
      }
    }

    function cavernNoise(x, y, salt = 0) {
      const n = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
      return n - Math.floor(n);
    }

    function drawCavernBackground(col, row, x, y, size) {
      if (row <= SURFACE_Y) return;
      const depth = Math.min(1, row / 42);
      const baseAlpha = 0.18 + depth * 0.28;
      ctx.fillStyle = `rgba(4,3,10,${baseAlpha})`;
      ctx.fillRect(x, y, size + 1, size + 1);

      const n = cavernNoise(col, row);
      if (n > 0.42) {
        ctx.fillStyle = `rgba(0,0,0,${0.10 + depth * 0.18})`;
        ctx.beginPath();
        ctx.ellipse(x + size * (0.25 + cavernNoise(col, row, 1) * 0.5), y + size * 0.52, size * (0.35 + n * 0.22), size * 0.34, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      if (row > 8 && cavernNoise(col, row, 2) > 0.74) {
        ctx.strokeStyle = `rgba(18,16,28,${0.35 + depth * 0.25})`;
        ctx.lineWidth = Math.max(1, size * 0.035);
        ctx.beginPath();
        const cx = x + size * (0.25 + cavernNoise(col, row, 3) * 0.5);
        ctx.moveTo(cx, y - 1);
        ctx.lineTo(cx + size * 0.08, y + size * 0.35);
        ctx.lineTo(cx - size * 0.03, y + size * 0.72);
        ctx.lineTo(cx + size * 0.10, y + size + 1);
        ctx.stroke();
      }

      if (row > 5 && cavernNoise(col, row - 1, 4) > 0.78) {
        ctx.fillStyle = `rgba(35,32,46,${0.20 + depth * 0.18})`;
        ctx.beginPath();
        ctx.moveTo(x + size * 0.18, y);
        ctx.lineTo(x + size * 0.35, y + size * (0.25 + cavernNoise(col, row, 5) * 0.35));
        ctx.lineTo(x + size * 0.48, y);
        ctx.closePath();
        ctx.fill();
      }

      if (row > 6 && cavernNoise(col, row + 1, 6) > 0.78) {
        ctx.fillStyle = `rgba(30,28,40,${0.18 + depth * 0.18})`;
        ctx.beginPath();
        ctx.moveTo(x + size * 0.52, y + size);
        ctx.lineTo(x + size * 0.68, y + size * (0.58 - cavernNoise(col, row, 7) * 0.20));
        ctx.lineTo(x + size * 0.82, y + size);
        ctx.closePath();
        ctx.fill();
      }

      if (row > 12 && cavernNoise(col, row, 8) > 0.86) {
        const hue = 175 + Math.floor(cavernNoise(col, row, 9) * 100);
        const alpha = 0.06 + depth * 0.10;
        const grad = ctx.createRadialGradient(x + size * 0.5, y + size * 0.55, 1, x + size * 0.5, y + size * 0.55, size * 0.65);
        grad.addColorStop(0, `hsla(${hue}, 90%, 62%, ${alpha})`);
        grad.addColorStop(1, `hsla(${hue}, 90%, 45%, 0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, size, size);
      }
    }

    function drawParticles() {
      for (const p of particles) {
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 32));
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      }
      ctx.globalAlpha = 1;
    }

    function tileColor(type) {
      switch (type) {
        case T.DIRT: return "#7a4a28";
        case T.ROCK: return "#69707a";
        case T.DENSE: return "#46515d";
        case T.OBSID: return "#2a2238";
        case T.HAZARD: return "#2d7a48";
        default: return "#7a4a28";
      }
    }

    function ensureGeneratedTo(maxY) {
      if (maxY <= generatedMaxY) return;
      for (let y = Math.max(SURFACE_Y - SKY_ROWS, generatedMaxY + 1); y <= maxY; y++) {
        for (let x = -1; x <= COLS; x++) tileAt(x, y);
      }
    }

    function seedTopsoil() {
      const cells = [];
      for (let y = 1; y <= TOPSOIL; y++) {
        for (let x = 0; x < COLS; x++) {
          world.set(key(x, y), { type: T.DIRT, loot: 0 });
          generatedMaxY = Math.max(generatedMaxY, y);
          cells.push({ x, y });
        }
      }
      for (let i = cells.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cells[i], cells[j]] = [cells[j], cells[i]];
      }
      let budget = STARTER_LOOT;
      let i = 0;
      while (budget > 0 && i < cells.length) {
        const c = cells[i++];
        const loot = budget >= LOOT.gold && Math.random() < 0.4 ? LOOT.gold : LOOT.coin;
        world.get(key(c.x, c.y)).loot = loot;
        budget -= loot;
      }
    }

    function maxHp(m) { return 3 + m.hpLvl; }
    function maxStam(m) { return 20 + m.stamLvl * 8; }
    function bagCap(m) { return 30 + m.bagLvl * 30; }

    function profileFor(id) {
      return host.getProfile(id) || { name: id === myId ? "You" : "Player", color: "#7cfc9b", icon: "⛏️" };
    }

    function ensureMiner(id) {
      if (!id) return null;
      let m = miners.get(id);
      const pf = profileFor(id);
      if (!m) {
        const spawnSlots = [8, 9, 7, 10, 6, 11, 5, 12, 4, 13, 3, 14, 2, 15, 1, 16, 0, 17];
        const used = new Set([...miners.values()].map((p) => p.x));
        const spawnX = spawnSlots.find((x) => !used.has(x)) ?? Math.floor(COLS / 2);
        m = {
          id,
          x: spawnX,
          y: SURFACE_Y,
          facing: 1,
          carry: 0,
          banked: 0,
          depthBest: 0,
          dig: 1,
          digLvl: 0,
          bagLvl: 0,
          stamLvl: 0,
          hpLvl: 0,
          hp: 3,
          stam: 20,
          ladders: 5,
          moveLockUntil: 0,
          mining: null,
          dead: false,
          msg: "Ready",
          msgUntil: 0,
        };
        miners.set(id, m);
      }
      m.name = pf.name;
      m.color = pf.color;
      m.icon = pf.icon || "⛏️";
      return m;
    }

    function resetHostState() {
      world.clear();
      miners.clear();
      dirtyTiles.clear();
      generatedMaxY = SURFACE_Y - SKY_ROWS - 1;
      lastFullSnapshot = null;
      lastFullSnapshotDirty = true;
      seedTopsoil();
      for (const p of host.getPlayers()) ensureMiner(p.id);
      latest = makeSnapshot(true);
    }

    function syncPlayerList() {
      if (!isHost()) return;
      let changed = false;
      const ids = new Set(host.getPlayers().map((p) => p.id));
      ids.add(myId);
      for (const id of ids) {
        if (!miners.has(id)) changed = true;
        ensureMiner(id);
      }
      for (const id of [...miners.keys()]) {
        if (!ids.has(id)) {
          miners.delete(id);
          changed = true;
        }
      }
      if (changed) lastFullSnapshotDirty = true;
    }

    function setMsg(m, text, ms) {
      if (m) {
        m.msg = text;
        m.msgUntil = now() + (ms || 1800);
      }
      if (m?.id === myId || !m) {
        message = text;
        messageUntil = now() + (ms || 1800);
      }
    }

    function isOpen(x, y) {
      if (x < 0 || x >= COLS) return false;
      const t = tileAt(x, y).type;
      return t === T.EMPTY || t === T.LADDER;
    }

    function digTimeFor(m, type) {
      const base = DIG_MS[type] || 500;
      const speed = PICKAXE_SPEED[Math.max(0, Math.min(PICKAXE_SPEED.length - 1, m.digLvl || 0))] || 1;
      const penalty = HARDNESS_SPEED_PENALTY[type] || 1;
      return Math.max(140, Math.round((base * penalty) / speed));
    }

    function diagClear(m, dx, dy) {
      if (dx === 0 || dy === 0) return true;
      if (dy < 0) return isOpen(m.x, m.y + dy);
      return isOpen(m.x + dx, m.y);
    }

    function settle(m) {
      let fell = 0;
      while (m.y > SURFACE_Y && tileAt(m.x, m.y).type !== T.LADDER && tileAt(m.x, m.y + 1).type === T.EMPTY) {
        m.y++;
        fell++;
      }
      if (fell >= 2) damage(m, 1, "Hard landing");
      enterTile(m);
      return fell;
    }

    function settleAll(exceptId = null) {
      for (const other of miners.values()) {
        if (other.dead || other.id === exceptId) continue;
        if (settle(other) > 0) lastFullSnapshotDirty = true;
      }
    }

    function enterTile(m) {
      if (m.y > m.depthBest) m.depthBest = m.y;
      if (m.y <= SURFACE_Y) {
        if (m.carry > 0) {
          m.banked += m.carry;
          setMsg(m, "+" + m.carry + " coins banked", 1800);
          m.carry = 0;
        }
        m.hp = maxHp(m);
        m.stam = maxStam(m);
      }
    }

    function damage(m, n, text) {
      m.hp -= n;
      setMsg(m, text || "Ouch", 1500);
      if (m.hp <= 0) {
        m.dead = true;
        m.carry = 0;
        setMsg(m, "Out of hearts. Tap restart.", 3000);
      }
      if (m.id === myId) playSound("hurt");
    }

    function collect(m, amount) {
      const room = bagCap(m) - m.carry;
      if (room <= 0) {
        setMsg(m, "Bag full. Return to surface.", 1800);
        return;
      }
      const got = Math.min(room, amount);
      m.carry += got;
      setMsg(m, "+" + got + " treasure", 1000);
      if (m.id === myId) playSound("treasure");
    }

    function moveMiner(id, dx, dy) {
      const m = ensureMiner(id);
      if (!m || m.dead) return;
      dx = Math.max(-1, Math.min(1, Number(dx) || 0));
      dy = Math.max(-1, Math.min(1, Number(dy) || 0));
      if (!dx && !dy) return;
      if (dx) m.facing = dx;

      const nx = m.x + dx;
      const ny = m.y + dy;
      if (nx < 0 || nx >= COLS || ny < SURFACE_Y) return;

      if (m.mining && (m.mining.dx !== dx || m.mining.dy !== dy)) m.mining = null;

      if (ny <= SURFACE_Y) {
        m.mining = null;
        m.x = nx;
        m.y = ny;
        enterTile(m);
        return;
      }

      const t = tileAt(nx, ny);

      if (dx === 0 && dy === -1 && t.type === T.EMPTY && tileAt(m.x, m.y).type !== T.LADDER) {
        const ry = ny - 1;
        if (ry > SURFACE_Y && !isOpen(nx, ry)) mineTile(m, nx, ry, false);
        return;
      }

      if (dx !== 0 && dy !== 0 && !diagClear(m, dx, dy)) {
        mineTile(m, m.x, ny, false);
        return;
      }

      if (isOpen(nx, ny)) {
        m.mining = null;
        m.x = nx;
        m.y = ny;
        enterTile(m);
        settle(m);
        m.moveLockUntil = now() + ENTER_DELAY_MS;
        return;
      }

      mineTile(m, nx, ny, true);
    }

    function placeLadder(id) {
      const m = ensureMiner(id);
      if (!m || m.dead) return;
      if (m.ladders <= 0) {
        setMsg(m, "No ladders. Buy more at surface.", 1800);
        return;
      }
      let ty = m.y - 1;
      while (ty > SURFACE_Y && tileAt(m.x, ty).type === T.LADDER) ty--;
      if (ty <= SURFACE_Y || tileAt(m.x, ty).type !== T.EMPTY) {
        setMsg(m, "No room for a ladder", 1500);
        return;
      }
      setTile(m.x, ty, { type: T.LADDER, loot: 0 });
      m.ladders--;
      setMsg(m, "Ladder placed", 1000);
      if (m.id === myId) playSound("ladder");
    }

    function restartMiner(id) {
      const m = ensureMiner(id);
      if (!m) return;
      const banked = m.banked;
      const x = m.x;
      Object.assign(m, {
        x,
        y: SURFACE_Y,
        carry: 0,
        hp: maxHp(m),
        stam: maxStam(m),
        ladders: Math.max(m.ladders, 3),
        moveLockUntil: 0,
        mining: null,
        dead: false,
        banked,
      });
      setMsg(m, "Back at the surface", 1200);
    }

    function buy(id, keyName) {
      const m = ensureMiner(id);
      if (!m || m.y > SURFACE_Y) {
        setMsg(m, "Shop is at the surface", 1400);
        return;
      }
      const item = SHOP.find((s) => s.key === keyName);
      if (!item) return;
      if (item.consumable) {
        if (m.banked < item.cost) { setMsg(m, "Not enough coins", 1200); return; }
        m.banked -= item.cost;
        m.ladders += 5;
        setMsg(m, "Bought ladders", 1200);
      if (m.id === myId) playSound("buy");
        return;
      }
      const levelKey = item.key + "Lvl";
      const level = m[levelKey] || 0;
      if (level >= item.max - 1) { setMsg(m, "Already maxed", 1200); return; }
      const cost = item.costs[level];
      if (m.banked < cost) { setMsg(m, "Not enough coins", 1200); return; }
      m.banked -= cost;
      m[levelKey] = level + 1;
      if (item.key === "dig") m.dig = 1 + m.digLvl;
      m.hp = maxHp(m);
      m.stam = maxStam(m);
      setMsg(m, item.name + " upgraded", 1200);
      if (m.id === myId) playSound("buy");
    }

    function startMine(m, nx, ny, dx, dy, movesInto = true) {
      const t = tileAt(nx, ny);
      m.mining = {
        x: nx,
        y: ny,
        dx,
        dy,
        movesInto,
        startedAt: now(),
        required: digTimeFor(m, t.type),
      };
      lastFullSnapshotDirty = true;
      if (m.id === myId) playSound("dig");
    }

    function mineTile(m, nx, ny, movesInto = true) {
      if (now() < (m.moveLockUntil || 0)) return;
      const t = tileAt(nx, ny);
      if (t.type === T.BEDROCK) return;
      if (m.stam <= 0) {
        setMsg(m, "Out of stamina. Climb up.", 1800);
        return;
      }
      if ((HARD[t.type] || 1) > m.dig && t.type !== T.HAZARD) {
        setMsg(m, "Rock too hard. Upgrade pickaxe.", 1800);
        return;
      }

      const dx = Math.sign(nx - m.x);
      const dy = Math.sign(ny - m.y);
      if (!m.mining || m.mining.x !== nx || m.mining.y !== ny || m.mining.movesInto !== movesInto) {
        startMine(m, nx, ny, dx, dy, movesInto);
      }
    }

    function finishMine(m, mining) {
      const nx = mining.x;
      const ny = mining.y;
      const t = tileAt(nx, ny);
      if (t.type === T.EMPTY || t.type === T.LADDER) return;

      m.stam--;
      setTile(nx, ny, { type: T.EMPTY, loot: 0 });
      spawnTileParticles(nx, ny, tileColor(t.type), t.loot ? 16 : 9);
      if (m.id === myId) playSound(t.loot ? "treasure" : "break");
      if (t.type === T.HAZARD) {
        damage(m, 1, "Gas pocket");
      } else if (t.loot) {
        collect(m, t.loot);
      }

      if (mining.movesInto) {
        m.x = nx;
        m.y = ny;
        enterTile(m);
        settle(m);
      }
      settleAll(mining.movesInto ? m.id : null);
    }

    function updateMining() {
      const tNow = now();
      for (const m of miners.values()) {
        const mining = m.mining;
        if (!mining || m.dead) continue;
        const t = tileAt(mining.x, mining.y);
        if (t.type === T.EMPTY || t.type === T.LADDER || m.stam <= 0) {
          m.mining = null;
          lastFullSnapshotDirty = true;
          continue;
        }
        if (tNow - mining.startedAt >= mining.required) {
          m.mining = null;
          finishMine(m, mining);
          lastFullSnapshotDirty = true;
        }
      }
    }

    function handleAction(id, action) {
      if (!isHost() || !action) return;
      if (action.type === "move") moveMiner(id, action.dx, action.dy);
      else if (action.type === "ladder") placeLadder(id);
      else if (action.type === "restart") restartMiner(id);
      else if (action.type === "buy") buy(id, action.key);
    }

    function sendAction(action) {
      if (profilePanelOpen()) return;
      if (isHost()) handleAction(myId, action);
      else host.sendInput(action);
    }

    function profilePanelOpen() {
      return document.getElementById("sheet-profile")?.classList.contains("open") ||
        document.getElementById("panel-chat")?.classList.contains("open");
    }

    function makeSnapshot(full) {
      syncPlayerList();
      const tNow = now();
      const hasActiveMining = [...miners.values()].some((m) => !!m.mining);
      const maxY = Math.max(16, ...[...miners.values()].map((m) => m.y + FULL_SNAPSHOT_MARGIN_ROWS));
      if (maxY > generatedMaxY) lastFullSnapshotDirty = true;
      ensureGeneratedTo(maxY);
      if (full && lastFullSnapshot && !lastFullSnapshotDirty && !hasActiveMining) return lastFullSnapshot;
      const tileKeys = full ? [...world.keys()] : [...dirtyTiles];
      const tiles = tileKeys.map((k) => {
        const p = fromKey(k);
        const t = world.get(k);
        return [p.x, p.y, t.type, t.loot || 0];
      });
      const snapshot = {
        full: !!full,
        tiles,
        players: [...miners.values()].map((m) => ({
          id: m.id,
          name: m.name,
          color: m.color,
          icon: m.icon,
          x: m.x,
          y: m.y,
          facing: m.facing,
          carry: m.carry,
          banked: m.banked,
          depthBest: m.depthBest,
          dig: m.dig,
          digLvl: m.digLvl,
          bagLvl: m.bagLvl,
          stamLvl: m.stamLvl,
          hpLvl: m.hpLvl,
          hp: m.hp,
          stam: m.stam,
          moveLockUntil: m.moveLockUntil || 0,
          mining: m.mining ? { ...m.mining, elapsed: Math.max(0, tNow - m.mining.startedAt) } : null,
          maxHp: maxHp(m),
          maxStam: maxStam(m),
          bagCap: bagCap(m),
          ladders: m.ladders,
          dead: m.dead,
          msg: m.msg,
          msgActive: m.msgUntil > now(),
        })),
      };
      dirtyTiles.clear();
      if (full) {
        lastFullSnapshot = snapshot;
        lastFullSnapshotDirty = false;
      }
      return snapshot;
    }

    function applySnapshot(s) {
      if (!s) return;
      latest = s;
      if (s.full) {
        world.clear();
        generatedMaxY = SURFACE_Y - SKY_ROWS - 1;
      }
      for (const row of s.tiles || []) {
        world.set(key(row[0], row[1]), { type: row[2], loot: row[3] || 0 });
        if (row[1] > generatedMaxY && row[0] >= -1 && row[0] <= COLS) generatedMaxY = row[1];
      }
      if (s.players) {
        miners.clear();
        const tNow = now();
        for (const p of s.players) {
          const miner = { ...p };
          if (miner.mining) miner.mining = { ...miner.mining, startedAt: tNow - (miner.mining.elapsed || 0) };
          miners.set(p.id, miner);
        }
      }
    }

    function currentSnapshot() {
      if (isHost()) return makeSnapshot(true);
      return {
        full: true,
        tiles: [...world.keys()].map((k) => {
          const p = fromKey(k);
          const t = world.get(k);
          return [p.x, p.y, t.type, t.loot || 0];
        }),
        players: [...miners.values()].map((m) => ({ ...m })),
      };
    }

    function broadcastSnapshot(full) {
      if (!isHost()) return;
      const snapshot = makeSnapshot(full);
      latest = snapshot;
      host.broadcastState(snapshot);
    }

    function drawTile(type, x, y, size) {
      if (type === T.EMPTY) return;
      if (type === T.LADDER) {
        drawLadderTile(x, y, size);
        return;
      }
      const base = type === T.BEDROCK ? "#101018" : tileColor(type);
      ctx.fillStyle = base;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = "rgba(255,255,255,0.09)";
      ctx.fillRect(x + 1, y + 1, size - 2, Math.max(2, size * 0.10));
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.fillRect(x, y + size * 0.82, size, size * 0.18);
      if (type !== T.BEDROCK) {
        ctx.fillStyle = "rgba(0,0,0,0.13)";
        ctx.fillRect(x + size * 0.18, y + size * 0.22, size * 0.15, size * 0.13);
        ctx.fillRect(x + size * 0.62, y + size * 0.55, size * 0.13, size * 0.12);
        ctx.fillStyle = "rgba(255,255,255,0.10)";
        ctx.fillRect(x + size * 0.48, y + size * 0.18, size * 0.10, size * 0.08);
      }
      if (type === T.ROCK || type === T.DENSE || type === T.OBSID) {
        ctx.strokeStyle = "rgba(255,255,255,0.10)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + size * 0.15, y + size * 0.62);
        ctx.lineTo(x + size * 0.40, y + size * 0.48);
        ctx.lineTo(x + size * 0.70, y + size * 0.60);
        ctx.stroke();
      }
      if (type === T.HAZARD) {
        ctx.fillStyle = "rgba(124,255,158,0.65)";
        ctx.beginPath(); ctx.arc(x + size * 0.5, y + size * 0.52, size * 0.18, 0, Math.PI * 2); ctx.fill();
      }
    }

    function drawLadderTile(x, y, size) {
      ctx.strokeStyle = "#d0a15a";
      ctx.lineWidth = Math.max(3, size * 0.08);
      ctx.lineCap = "butt";
      const lx = x + size * 0.32;
      const rx = x + size * 0.68;
      ctx.beginPath();
      ctx.moveTo(lx, y - 1); ctx.lineTo(lx, y + size + 1);
      ctx.moveTo(rx, y - 1); ctx.lineTo(rx, y + size + 1);
      for (let yy = y + size * 0.2; yy < y + size; yy += size * 0.28) {
        ctx.moveTo(lx, yy); ctx.lineTo(rx, yy);
      }
      ctx.stroke();
    }

    function drawMiningOverlays() {
      const tNow = now();
      for (const m of miners.values()) {
        const mining = m.mining;
        if (!mining) continue;
        const x = screenX(mining.x);
        const y = screenY(mining.y);
        const prog = Math.max(0, Math.min(1, (tNow - mining.startedAt) / Math.max(1, mining.required)));
        drawCracks(x, y, mining.x, mining.y, prog);
        const bw = cell * 0.68;
        const bx = x + (cell - bw) / 2;
        const by = y + cell * 0.78;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(bx, by, bw, Math.max(3, cell * 0.10));
        ctx.fillStyle = "#ffd35a";
        ctx.fillRect(bx, by, bw * prog, Math.max(3, cell * 0.10));
      }
    }

    function drawCracks(x, y, col, row, prog) {
      const seed = Math.abs((col * 928371 + row * 364479) % 997) / 997;
      const cx = x + cell * (0.45 + (seed - 0.5) * 0.16);
      const cy = y + cell * (0.42 + (0.5 - seed) * 0.12);
      const stages = [0.14, 0.28, 0.42, 0.58, 0.74, 0.88];
      const branches = [
        [[0, 0], [-0.22, -0.16], [-0.34, -0.28]],
        [[0, 0], [0.20, -0.14], [0.34, -0.20]],
        [[0, 0], [-0.10, 0.23], [-0.23, 0.38]],
        [[0, 0], [0.16, 0.22], [0.31, 0.33]],
        [[-0.10, 0.23], [-0.03, 0.36], [-0.09, 0.48]],
        [[0.20, -0.14], [0.28, 0.02], [0.43, 0.08]],
      ];
      ctx.save();
      ctx.fillStyle = `rgba(0,0,0,${0.07 + prog * 0.16})`;
      ctx.fillRect(x, y, cell + 1, cell + 1);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 0; i < branches.length; i++) {
        if (prog < stages[i]) continue;
        const grow = Math.min(1, (prog - stages[i]) / 0.18);
        const branch = branches[i];
        ctx.strokeStyle = i < 2 ? "rgba(18,12,8,0.82)" : "rgba(24,16,10,0.72)";
        ctx.lineWidth = Math.max(1.2, cell * (0.025 + prog * 0.018));
        ctx.beginPath();
        ctx.moveTo(cx + branch[0][0] * cell, cy + branch[0][1] * cell);
        for (let j = 1; j < branch.length; j++) {
          const px = branch[j - 1][0] + (branch[j][0] - branch[j - 1][0]) * grow;
          const py = branch[j - 1][1] + (branch[j][1] - branch[j - 1][1]) * grow;
          ctx.lineTo(cx + px * cell, cy + py * cell);
        }
        ctx.stroke();
      }
      if (prog > 0.72) {
        ctx.fillStyle = "rgba(255,255,255,0.10)";
        ctx.fillRect(x + cell * 0.18, y + cell * 0.18, cell * 0.10, cell * 0.08);
        ctx.fillRect(x + cell * 0.67, y + cell * 0.56, cell * 0.08, cell * 0.07);
      }
      ctx.restore();
    }

    function offX() { return canvas.clientWidth / 2 - (camX + 0.5) * cell; }
    function offY() { return topPad - camY * cell; }
    function screenX(col) { return offX() + col * cell; }
    function screenY(row) { return offY() + row * cell; }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.fill();
    }

    function drawHud(me) {
      const W = canvas.clientWidth;
      ctx.fillStyle = "rgba(12,12,22,0.92)";
      ctx.fillRect(0, 0, W, topPad);

      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#eef0ff";
      ctx.font = "700 16px system-ui, sans-serif";
      ctx.fillText("⛏️ Digger", 12, 20);
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "#9a9ab5";
      ctx.fillText("Bank " + (me?.banked || 0) + " · Carry " + (me?.carry || 0) + "/" + (me?.bagCap || 30) + " · Depth " + (me?.depthBest || 0), 12, 43);

      const hearts = "♥".repeat(Math.max(0, me?.hp || 0)) + "♡".repeat(Math.max(0, (me?.maxHp || 3) - (me?.hp || 0)));
      ctx.fillStyle = "#ff6b88";
      ctx.font = "700 13px system-ui, sans-serif";
      ctx.fillText(hearts, W - 152, 20);
      ctx.fillStyle = "#7cfc9b";
      ctx.fillText("⚡" + (me?.stam || 0) + "/" + (me?.maxStam || 20), W - 152, 43);
      ctx.fillStyle = "#d0a15a";
      ctx.fillText("🪜" + (me?.ladders || 0), W - 78, 43);

      buttonRects = {
        ladder: { x: W - 132, y: topPad + 10, w: 54, h: 42 },
      };
      if (me?.y <= SURFACE_Y) buttonRects.shop = { x: W - 70, y: topPad + 10, w: 54, h: 42 };
      for (const [name, r] of Object.entries(buttonRects)) {
        ctx.fillStyle = "rgba(28,28,46,0.92)";
        roundRect(r.x, r.y, r.w, r.h, 13);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.font = "20px system-ui, sans-serif";
        ctx.fillText(name === "ladder" ? "🪜" : "🛒", r.x + r.w / 2, r.y + r.h / 2 + 1);
      }

      const text = me?.msgActive ? me.msg : (messageUntil > now() ? message : "");
      if (text) {
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        roundRect(12, topPad + 10, Math.min(W - 160, Math.max(180, text.length * 7 + 24)), 34, 12);
        ctx.textAlign = "left";
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 13px system-ui, sans-serif";
        ctx.fillText(text, 24, topPad + 27);
      }
    }

    function drawMiner(m, me) {
      const x = screenX(m.x) + cell / 2;
      const y = screenY(m.y) + cell / 2;
      if (host.isSpeaking?.(m.id)) {
        const pulse = 0.5 + 0.5 * Math.abs(Math.sin(now() / 220));
        ctx.beginPath();
        ctx.arc(x, y, cell * (0.38 + pulse * 0.08), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(124,252,155,${0.5 + 0.5 * pulse})`;
        ctx.lineWidth = Math.max(3, cell * 0.06);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, cell * 0.33, 0, Math.PI * 2);
      ctx.fillStyle = m.color || "#7cfc9b";
      ctx.fill();
      if (m.id === myId) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
      }
      ctx.font = Math.floor(cell * 0.36) + "px serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#111";
      ctx.fillText(m.icon || "⛏️", x, y + 1);
      ctx.font = "700 11px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText((host.hostCrown?.(m.id) || "") + (m.name || "Player"), x, y - cell * 0.48);
      if (m.dead) {
        ctx.fillStyle = "rgba(0,0,0,0.72)";
        ctx.fillRect(x - cell * 0.35, y - cell * 0.35, cell * 0.7, cell * 0.7);
        ctx.fillStyle = "#fff";
        ctx.fillText("KO", x, y);
      }
      if (me && m.id !== myId && Math.abs(m.x - me.x) <= 1 && Math.abs(m.y - me.y) <= 1) {
        ctx.strokeStyle = "rgba(124,252,155,0.45)";
        ctx.lineWidth = 2;
        ctx.strokeRect(screenX(m.x) + 3, screenY(m.y) + 3, cell - 6, cell - 6);
      }
    }

    function drawShop(me) {
      if (!shopOpen || !me) return;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      ctx.fillStyle = "rgba(7,7,13,0.82)";
      ctx.fillRect(0, 0, W, H);
      const panelW = Math.min(420, W - 28);
      const x = (W - panelW) / 2;
      let y = Math.max(72, H * 0.12);
      ctx.fillStyle = "#1c1c2e";
      roundRect(x, y, panelW, Math.min(H - y - 18, 420), 18);
      ctx.fillStyle = "#eef0ff";
      ctx.textAlign = "center";
      ctx.font = "800 22px system-ui, sans-serif";
      ctx.fillText("Surface Shop", W / 2, y + 32);
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillStyle = "#9a9ab5";
      ctx.fillText("Coins: " + me.banked, W / 2, y + 54);

      shopRects = [];
      y += 74;
      for (const item of SHOP) {
        const level = item.consumable ? 0 : (me[item.key + "Lvl"] || 0);
        const maxed = !item.consumable && level >= item.max - 1;
        const cost = item.consumable ? item.cost : item.costs[level];
        const row = { x: x + 12, y, w: panelW - 24, h: 58, key: item.key };
        ctx.fillStyle = maxed ? "#242438" : "#282842";
        roundRect(row.x, row.y, row.w, row.h, 12);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.font = "24px system-ui, sans-serif";
        ctx.fillText(item.emoji, row.x + 16, row.y + 31);
        ctx.font = "700 14px system-ui, sans-serif";
        ctx.fillText(item.name + (item.consumable ? "" : " " + (level + 1)), row.x + 54, row.y + 20);
        ctx.fillStyle = "#a8a8c8";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText(item.desc, row.x + 54, row.y + 40);
        ctx.textAlign = "right";
        ctx.fillStyle = maxed ? "#7a7a96" : (me.banked >= cost ? "#7cfc9b" : "#ff8aa0");
        ctx.font = "800 14px system-ui, sans-serif";
        ctx.fillText(maxed ? "MAX" : "💰" + cost, row.x + row.w - 14, row.y + 31);
        if (!maxed) shopRects.push(row);
        y += 66;
      }
      const close = { x: W / 2 - 76, y: Math.min(H - 60, y + 4), w: 152, h: 42, key: "close" };
      ctx.fillStyle = "#3b7bd6";
      roundRect(close.x, close.y, close.w, close.h, 12);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "800 14px system-ui, sans-serif";
      ctx.fillText("Back to digging", W / 2, close.y + 22);
      shopRects.push(close);
    }

    function draw() {
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      ctx.clearRect(0, 0, W, H);
      const skyGrad = ctx.createLinearGradient(0, 0, 0, Math.max(topPad + 80, H * 0.4));
      skyGrad.addColorStop(0, "#182154");
      skyGrad.addColorStop(0.55, "#3d74bb");
      skyGrad.addColorStop(1, "#78bde7");
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, topPad + (SURFACE_Y - camY + 1) * cell);
      const depthGrad = ctx.createLinearGradient(0, topPad, 0, H);
      depthGrad.addColorStop(0, "#24182b");
      depthGrad.addColorStop(0.45, "#17111f");
      depthGrad.addColorStop(1, "#090711");
      ctx.fillStyle = depthGrad;
      ctx.fillRect(0, topPad + (1 - camY) * cell, W, H);

      const me = miners.get(myId) || latest?.players?.find((p) => p.id === myId) || [...miners.values()][0];
      if (me) {
        camX += (Math.max(4, Math.min(COLS - 5, me.x)) - camX) * 0.16;
        camY += (Math.max(SURFACE_Y - SKY_ROWS, me.y - 4) - camY) * 0.18;
      }

      const startCol = Math.floor((0 - offX()) / cell) - 1;
      const endCol = Math.ceil((W - offX()) / cell) + 1;
      const startRow = Math.floor((topPad - offY()) / cell) - SKY_ROWS;
      const endRow = Math.ceil((H - offY()) / cell) + 1;
      for (let y = startRow; y <= endRow; y++) {
        for (let x = startCol; x <= endCol; x++) {
          const sx = screenX(x);
          const sy = screenY(y);
          if (y < SURFACE_Y) continue;
          if (y === SURFACE_Y) {
            if (x >= 0 && x < COLS) {
              ctx.fillStyle = "#3f8a45";
              ctx.fillRect(sx, sy, cell + 1, cell + 1);
              ctx.fillStyle = "#357a3c";
              ctx.fillRect(sx, sy, cell + 1, Math.max(3, cell * 0.24));
            }
            continue;
          }
          const t = isHost() ? tileAt(x, y) : world.get(key(x, y)) || { type: T.BEDROCK, loot: 0 };
          if (t.type === T.EMPTY || t.type === T.LADDER) drawCavernBackground(x, y, sx, sy, cell);
          drawTile(t.type, sx, sy, cell);
          if (t.loot && t.type !== T.EMPTY) {
            ctx.fillStyle = t.loot >= LOOT.gem ? "#65d6ff" : "#ffd35a";
            ctx.beginPath(); ctx.arc(sx + cell * 0.72, sy + cell * 0.32, Math.max(3, cell * 0.08), 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      drawMiningOverlays();
      drawParticles();

      for (const m of miners.values()) drawMiner(m, me);
      drawHud(me);
      drawShop(me);
    }

    function loop(ts) {
      rafId = requestAnimationFrame(loop);
      if (!lastTs) lastTs = ts;
      lastTs = ts;
      if (isHost()) {
        syncPlayerList();
        updateMining();
        updateParticles();
        if (ts - lastSnapshotAt > 1000 / SNAPSHOT_HZ) {
          broadcastSnapshot(!latest);
          lastSnapshotAt = ts;
        }
      }
      draw();
    }

    function eventPos(e) {
      const rect = canvas.getBoundingClientRect();
      const p = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
      return { x: p.clientX - rect.left, y: p.clientY - rect.top };
    }

    function hit(r, p) { return r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }

    function onPointerDown(e) {
      if (profilePanelOpen()) return;
      if (e.pointerId !== undefined) {
        if (activePointerId !== null || e.isPrimary === false) return;
        activePointerId = e.pointerId;
        canvas.setPointerCapture?.(activePointerId);
      }
      const p = eventPos(e);
      if (e.cancelable) e.preventDefault();
      if (shopOpen) {
        for (const r of shopRects) {
          if (!hit(r, p)) continue;
          if (r.key === "close") shopOpen = false;
          else sendAction({ type: "buy", key: r.key });
          activePointerId = null;
          return;
        }
        shopOpen = false;
        activePointerId = null;
        return;
      }
      if (hit(buttonRects.ladder, p)) { sendAction({ type: "ladder" }); activePointerId = null; return; }
      if (hit(buttonRects.shop, p)) { shopOpen = true; activePointerId = null; return; }
      drag = p;
    }

    function onPointerMove(e) {
      if (e.pointerId !== undefined && e.pointerId !== activePointerId) return;
      if (!drag || profilePanelOpen()) return;
      const p = eventPos(e);
      if (e.cancelable) e.preventDefault();
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      const thresh = Math.max(12, cell * 0.36);
      if (Math.abs(dx) < thresh && Math.abs(dy) < thresh) return;
      let sx = Math.abs(dx) >= thresh ? Math.sign(dx) : 0;
      let sy = Math.abs(dy) >= thresh ? Math.sign(dy) : 0;
      if (!sx && Math.abs(dx) > Math.abs(dy) * 0.45) sx = Math.sign(dx);
      if (!sy && Math.abs(dy) > Math.abs(dx) * 0.45) sy = Math.sign(dy);
      sendAction({ type: "move", dx: sx, dy: sy });
      drag = p;
    }

    function onPointerUp(e) {
      if (e?.pointerId !== undefined && e.pointerId !== activePointerId) return;
      if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
      activePointerId = null;
      drag = null;
    }

    function keyVec(key) {
      switch (key) {
        case "ArrowUp": case "w": case "W": return [0, -1];
        case "ArrowDown": case "s": case "S": return [0, 1];
        case "ArrowLeft": case "a": case "A": return [-1, 0];
        case "ArrowRight": case "d": case "D": return [1, 0];
        default: return null;
      }
    }

    function onKeyDown(e) {
      if (profilePanelOpen()) return;
      if (e.key === "Escape" && shopOpen) { e.preventDefault(); shopOpen = false; return; }
      if (e.key === " " || e.key === "e" || e.key === "E") { e.preventDefault(); sendAction({ type: "ladder" }); return; }
      if (e.key === "b" || e.key === "B") { e.preventDefault(); shopOpen = !shopOpen; return; }
      if (e.key === "r" || e.key === "R") { e.preventDefault(); sendAction({ type: "restart" }); return; }
      const v = keyVec(e.key);
      if (v) { e.preventDefault(); sendAction({ type: "move", dx: v[0], dy: v[1] }); }
    }

    return {
      start() {
        resize();
        if (initialState) applySnapshot(initialState);
        else if (isHost()) resetHostState();
        window.addEventListener("resize", resize);
        if (window.PointerEvent) {
          canvas.addEventListener("pointerdown", onPointerDown);
          canvas.addEventListener("pointermove", onPointerMove);
          canvas.addEventListener("pointerup", onPointerUp);
          canvas.addEventListener("pointercancel", onPointerUp);
          canvas.addEventListener("lostpointercapture", onPointerUp);
        } else {
          canvas.addEventListener("touchstart", onPointerDown, { passive: false });
          window.addEventListener("touchmove", onPointerMove, { passive: false });
          window.addEventListener("touchend", onPointerUp);
          window.addEventListener("touchcancel", onPointerUp);
          canvas.addEventListener("mousedown", onPointerDown);
          window.addEventListener("mousemove", onPointerMove);
          window.addEventListener("mouseup", onPointerUp);
        }
        window.addEventListener("keydown", onKeyDown);
        rafId = requestAnimationFrame(loop);
      },
      destroy() {
        cancelAnimationFrame(rafId);
        if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
        activePointerId = null;
        drag = null;
        window.removeEventListener("resize", resize);
        if (window.PointerEvent) {
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerup", onPointerUp);
          canvas.removeEventListener("pointercancel", onPointerUp);
          canvas.removeEventListener("lostpointercapture", onPointerUp);
        } else {
          canvas.removeEventListener("touchstart", onPointerDown);
          window.removeEventListener("touchmove", onPointerMove);
          window.removeEventListener("touchend", onPointerUp);
          window.removeEventListener("touchcancel", onPointerUp);
          canvas.removeEventListener("mousedown", onPointerDown);
          window.removeEventListener("mousemove", onPointerMove);
          window.removeEventListener("mouseup", onPointerUp);
        }
        window.removeEventListener("keydown", onKeyDown);
      },
      onPeerInput(id, input) { handleAction(id, input); },
      onState(state) { applySnapshot(state); },
      getSnapshot() { return currentSnapshot(); },
      onPlayerList() { syncPlayerList(); },
      restart() { if (isHost()) resetHostState(); },
    };
  }

  window.BP2PGames = window.BP2PGames || {};
  window.BP2PGames.digger = {
    id: "digger",
    name: "Deep Digger",
    emoji: "⛏️",
    create,
  };
})();
