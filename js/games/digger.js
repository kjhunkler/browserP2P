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
  const SNAPSHOT_HZ = 12;

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
    let shopOpen = false;
    let shopRects = [];
    let buttonRects = {};
    let message = "Dig together. Swipe or use WASD.";
    let messageUntil = 0;

    const world = new Map();
    const miners = new Map();
    const dirtyTiles = new Set();

    function key(x, y) { return x + "," + y; }
    function fromKey(k) {
      const p = k.split(",");
      return { x: Number(p[0]), y: Number(p[1]) };
    }
    function now() { return performance.now(); }
    function isHost() { return !!host.isHost(); }

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
      }
      return tile;
    }

    function setTile(x, y, tile) {
      world.set(key(x, y), tile);
      dirtyTiles.add(key(x, y));
    }

    function seedTopsoil() {
      const cells = [];
      for (let y = 1; y <= TOPSOIL; y++) {
        for (let x = 0; x < COLS; x++) {
          world.set(key(x, y), { type: T.DIRT, loot: 0 });
          cells.push({ x, y });
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
      seedTopsoil();
      for (const p of host.getPlayers()) ensureMiner(p.id);
      latest = makeSnapshot(true);
    }

    function syncPlayerList() {
      if (!isHost()) return;
      const ids = new Set(host.getPlayers().map((p) => p.id));
      ids.add(myId);
      for (const id of ids) ensureMiner(id);
      for (const id of [...miners.keys()]) {
        if (!ids.has(id)) miners.delete(id);
      }
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
      const t = tileAt(x, y).type;
      return t === T.EMPTY || t === T.LADDER;
    }

    function settle(m) {
      let fell = 0;
      while (m.y > SURFACE_Y && tileAt(m.x, m.y).type !== T.LADDER && tileAt(m.x, m.y + 1).type === T.EMPTY) {
        m.y++;
        fell++;
      }
      if (fell >= 2) damage(m, 1, "Hard landing");
      enterTile(m);
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

      if (isOpen(nx, ny)) {
        m.x = nx;
        m.y = ny;
        enterTile(m);
        settle(m);
        return;
      }

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

      m.stam--;
      setTile(nx, ny, { type: T.EMPTY, loot: 0 });
      if (t.type === T.HAZARD) {
        damage(m, 1, "Gas pocket");
      } else if (t.loot) {
        collect(m, t.loot);
      }

      m.x = nx;
      m.y = ny;
      enterTile(m);
      settle(m);
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
      const maxY = Math.max(16, ...[...miners.values()].map((m) => m.y + 12));
      for (let y = SURFACE_Y - SKY_ROWS; y <= maxY; y++) {
        for (let x = -1; x <= COLS; x++) tileAt(x, y);
      }
      const tileKeys = full ? [...world.keys()] : [...dirtyTiles];
      const tiles = tileKeys.map((k) => {
        const p = fromKey(k);
        const t = world.get(k);
        return [p.x, p.y, t.type, t.loot || 0];
      });
      dirtyTiles.clear();
      return {
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
          maxHp: maxHp(m),
          maxStam: maxStam(m),
          bagCap: bagCap(m),
          ladders: m.ladders,
          dead: m.dead,
          msg: m.msg,
          msgActive: m.msgUntil > now(),
        })),
      };
    }

    function applySnapshot(s) {
      if (!s) return;
      latest = s;
      if (s.full) world.clear();
      for (const row of s.tiles || []) {
        world.set(key(row[0], row[1]), { type: row[2], loot: row[3] || 0 });
      }
      if (s.players) {
        miners.clear();
        for (const p of s.players) miners.set(p.id, { ...p });
      }
    }

    function broadcastSnapshot(full) {
      if (!isHost()) return;
      const snapshot = makeSnapshot(full);
      latest = snapshot;
      host.broadcastState(snapshot);
    }

    function drawTile(type, x, y, size) {
      if (type === T.EMPTY) return;
      const colors = {
        [T.DIRT]: "#7a4a28",
        [T.ROCK]: "#69707a",
        [T.DENSE]: "#46515d",
        [T.OBSID]: "#2a2238",
        [T.HAZARD]: "#2d7a48",
        [T.LADDER]: "#c99743",
        [T.BEDROCK]: "#101018",
      };
      ctx.fillStyle = colors[type] || "#7a4a28";
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(x + 2, y + 2, size - 4, Math.max(2, size * 0.12));
      if (type === T.LADDER) {
        ctx.strokeStyle = "#6d431a";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + size * 0.32, y + 5); ctx.lineTo(x + size * 0.32, y + size - 5);
        ctx.moveTo(x + size * 0.68, y + 5); ctx.lineTo(x + size * 0.68, y + size - 5);
        for (let yy = y + 10; yy < y + size; yy += size * 0.28) {
          ctx.moveTo(x + size * 0.28, yy); ctx.lineTo(x + size * 0.72, yy);
        }
        ctx.stroke();
      }
      if (type === T.HAZARD) {
        ctx.fillStyle = "rgba(124,255,158,0.65)";
        ctx.beginPath(); ctx.arc(x + size * 0.5, y + size * 0.52, size * 0.18, 0, Math.PI * 2); ctx.fill();
      }
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

      buttonRects = {
        ladder: { x: W - 132, y: topPad + 10, w: 54, h: 42 },
        shop: { x: W - 70, y: topPad + 10, w: 54, h: 42 },
      };
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
      ctx.fillText(m.name || "Player", x, y - cell * 0.48);
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
      ctx.fillStyle = "#87c9ff";
      ctx.fillRect(0, 0, W, topPad + (SURFACE_Y - camY + 1) * cell);
      ctx.fillStyle = "#15111f";
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
          const t = isHost() ? tileAt(x, y) : world.get(key(x, y)) || { type: T.BEDROCK, loot: 0 };
          drawTile(t.type, screenX(x), screenY(y), cell);
          if (t.loot && t.type !== T.EMPTY) {
            ctx.fillStyle = t.loot >= LOOT.gem ? "#65d6ff" : "#ffd35a";
            ctx.beginPath(); ctx.arc(screenX(x) + cell * 0.72, screenY(y) + cell * 0.32, Math.max(3, cell * 0.08), 0, Math.PI * 2); ctx.fill();
          }
        }
      }

      ctx.fillStyle = "#56aa45";
      ctx.fillRect(0, screenY(SURFACE_Y + 1) - 5, W, 8);
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
      const p = eventPos(e);
      if (e.cancelable) e.preventDefault();
      if (shopOpen) {
        for (const r of shopRects) {
          if (!hit(r, p)) continue;
          if (r.key === "close") shopOpen = false;
          else sendAction({ type: "buy", key: r.key });
          return;
        }
        shopOpen = false;
        return;
      }
      if (hit(buttonRects.ladder, p)) { sendAction({ type: "ladder" }); return; }
      if (hit(buttonRects.shop, p)) { shopOpen = true; return; }
      drag = p;
    }

    function onPointerMove(e) {
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

    function onPointerUp() { drag = null; }

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
        canvas.addEventListener("touchstart", onPointerDown, { passive: false });
        window.addEventListener("touchmove", onPointerMove, { passive: false });
        window.addEventListener("touchend", onPointerUp);
        window.addEventListener("touchcancel", onPointerUp);
        canvas.addEventListener("mousedown", onPointerDown);
        window.addEventListener("mousemove", onPointerMove);
        window.addEventListener("mouseup", onPointerUp);
        window.addEventListener("keydown", onKeyDown);
        rafId = requestAnimationFrame(loop);
      },
      destroy() {
        cancelAnimationFrame(rafId);
        window.removeEventListener("resize", resize);
        canvas.removeEventListener("touchstart", onPointerDown);
        window.removeEventListener("touchmove", onPointerMove);
        window.removeEventListener("touchend", onPointerUp);
        window.removeEventListener("touchcancel", onPointerUp);
        canvas.removeEventListener("mousedown", onPointerDown);
        window.removeEventListener("mousemove", onPointerMove);
        window.removeEventListener("mouseup", onPointerUp);
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
