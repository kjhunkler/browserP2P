/* Snow Brawl Royale for browserP2P.
 * Host owns combat, pickups, cold, destructibles, snowmen, and compact snapshots.
 */
(function () {
  "use strict";

  const MAP_W = 72;
  const MAP_H = 52;
  const SNAPSHOT_HZ = 15;
  const SNAPSHOT_INTERPOLATION_MS = 120;
  const SNAPSHOT_SNAP_DISTANCE = 3.5;
  const FULL_SNAPSHOT_MS = 5000;
  const PLAYER_R = 0.34;
  const SNOWMAN_R = 0.34;
  const BASE_SPEED = 5.0;
  const COLD_GRACE = 20;
  const WARM_SECONDS = 5;
  const VISION = 9.5;
  const BINOCULAR_VISION = 15.5;
  const VIEW_W = 24;
  const VIEW_H = 16;
  const PROJECTILE_SPEED = 16;
  const PROJECTILE_LIFE = 0.9;
  const SNOWBALL_DAMAGE = 20;
  const MELEE_DAMAGE = 50;
  const MELEE_RANGE = 1.55;
  const MELEE_HALF_ANGLE = Math.PI / 5;
  const SNOWBALL_TARGET_RANGE = PROJECTILE_SPEED * PROJECTILE_LIFE;
  const SNOWMAN_SNOWBALL_DAMAGE = 12;
  const DESPAWN_TRACK_MS = 30000;
  const ROUND_RESTART_MS = 5000;

  const ITEM_TYPES = {
    heart: { emoji: "❤️", r: 0.28 },
    binoculars: { emoji: "🔭", r: 0.28 },
    snowballs: { emoji: "⚪", r: 0.28 },
  };

  function create(host, initialState) {
    const canvas = host.canvas;
    const ctx = canvas.getContext("2d");
    const myId = host.myId;

    let rafId = 0;
    let lastTs = 0;
    let lastSnapshotAt = 0;
    let lastFullSnapshotAt = 0;
    let lastCssWidth = 0;
    let lastCssHeight = 0;
    let nextId = 1;
    let map = null;
    let audioCtx = null;
    let winnerTimeout = null;
    let camera = { x: MAP_W / 2, y: MAP_H / 2, scale: 18 };
    let pointerMode = window.PointerEvent;
    let leftStick = null;
    let rightStick = null;
    let mouseAim = { x: 1, y: 0, active: false };
    let spectatorCamera = null;
    let keys = new Set();
    let selectedWeapon = "snowball";
    let pendingFire = null;
    let lastInputSentAt = 0;
    let weaponRect = null;
    const dirtyItems = new Set();
    const dirtyObjects = new Set();
    const visualEntities = { players: new Map(), snowmen: new Map(), projectiles: new Map() };
    const controls = { mx: 0, my: 0, ax: 1, ay: 0, aiming: false, weapon: "snowball" };

    const state = {
      full: true,
      seed: Math.floor(Math.random() * 1_000_000_000),
      round: 1,
      over: false,
      winner: null,
      restartAt: 0,
      players: {},
      snowmen: [],
      projectiles: [],
      items: [],
      objects: [],
      piles: [],
      tracks: [],
      events: [],
    };

    function isHost() { return !!host.isHost(); }
    function now() { return performance.now(); }
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function id(prefix) { return prefix + nextId++; }
    function keyId(id) { return String(id || ""); }
    function profile(id) { return host.getPlayers().find((p) => p.id === id) || host.getProfile?.(id) || { id, name: "Player", color: "#7cfc9b", icon: "❄️" }; }

    function rng(seed) {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function choice(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }
    function randRange(rand, min, max) { return min + rand() * (max - min); }
    function randInner(rand, margin = 5) { return { x: randRange(rand, margin, MAP_W - margin), y: randRange(rand, margin, MAP_H - margin) }; }

    function makeMap(seed) {
      const rand = rng(seed);
      const buildings = [];
      const scenery = [];
      const obstacles = [];
      const ponds = [];
      const roads = [];
      const lots = [];
      const types = ["Cabin", "Garage", "Store", "Barn", "Shed", "Lodge", "Depot"];

      const mainY = randRange(rand, MAP_H * 0.42, MAP_H * 0.58);
      const mainX = randRange(rand, MAP_W * 0.43, MAP_W * 0.58);
      roads.push({ x: 0, y: mainY - 1.7, w: MAP_W, h: 3.4 });
      roads.push({ x: mainX - 1.6, y: 0, w: 3.2, h: MAP_H });
      roads.push({ x: mainX - randRange(rand, 20, 28), y: mainY + randRange(rand, 8, 13), w: randRange(rand, 24, 34), h: 2.0 });
      roads.push({ x: mainX + randRange(rand, 7, 14), y: mainY - randRange(rand, 14, 20), w: 2.0, h: randRange(rand, 14, 22) });

      const addLot = (road, side, i) => {
        const along = road.w > road.h;
        const gap = 0.8;
        const lw = along ? randRange(rand, 6.6, 9.4) : randRange(rand, 7.2, 10.5);
        const lh = along ? randRange(rand, 7.2, 10.5) : randRange(rand, 6.6, 9.4);
        const cx = along ? randRange(rand, Math.max(6, road.x + 4), Math.min(MAP_W - 6, road.x + road.w - 4)) : road.x + road.w / 2 + side * (road.w / 2 + gap + lw / 2);
        const cy = along ? road.y + road.h / 2 + side * (road.h / 2 + gap + lh / 2) : randRange(rand, Math.max(6, road.y + 4), Math.min(MAP_H - 6, road.y + road.h - 4));
        const lot = { x: cx - lw / 2, y: cy - lh / 2, w: lw, h: lh, road, side, along };
        if (lot.x < 2 || lot.y < 2 || lot.x + lot.w > MAP_W - 2 || lot.y + lot.h > MAP_H - 2) return;
        if (roads.some((r) => rectsOverlap(padRect(lot, -0.2), r))) return;
        if (lots.some((l) => rectsOverlap(padRect(lot, 1.0), l))) return;
        lots.push(lot);
        const bw = randRange(rand, 3.8, Math.min(6.2, lot.w - 1.7));
        const bh = randRange(rand, 3.2, Math.min(5.4, lot.h - 1.7));
        const b = {
          id: "b" + i,
          type: choice(rand, types),
          x: lot.x + randRange(rand, 0.8, Math.max(0.9, lot.w - bw - 0.8)),
          y: lot.y + randRange(rand, 0.8, Math.max(0.9, lot.h - bh - 0.8)),
          w: bw,
          h: bh,
          door: along ? (side < 0 ? "s" : "n") : (side < 0 ? "e" : "w"),
        };
        buildings.push(b);
        addFenceForLot(lot, b, obstacles, rand);
        if (rand() < 0.55) addDriveway(lot, b, obstacles);
      };

      let buildingId = 0;
      for (const road of roads) {
        const count = road.w > road.h ? Math.ceil(road.w / 13) : Math.ceil(road.h / 12);
        for (let i = 0; i < count; i++) {
          if (rand() < 0.78) addLot(road, -1, buildingId++);
          if (rand() < 0.72) addLot(road, 1, buildingId++);
        }
      }

      for (let i = 0; i < 5; i++) {
        const p = i < 2 ? { x: randRange(rand, 6, 18), y: randRange(rand, 6, 18) } : randInner(rand, 8);
        const pond = { x: p.x, y: p.y, rx: randRange(rand, 2.4, 4.6), ry: randRange(rand, 1.5, 3.1) };
        const bounds = { x: pond.x - pond.rx - 1.2, y: pond.y - pond.ry - 1.2, w: pond.rx * 2 + 2.4, h: pond.ry * 2 + 2.4 };
        if (roads.some((r) => rectsOverlap(bounds, r)) || buildings.some((b) => rectsOverlap(bounds, b)) || ponds.some((o) => rectsOverlap(bounds, { x: o.x - o.rx, y: o.y - o.ry, w: o.rx * 2, h: o.ry * 2 }))) continue;
        ponds.push(pond);
      }

      for (let i = 0; i < 100; i++) {
        const p = randInner(rand, 3.2);
        const nearLot = lots.some((l) => rectsOverlap({ x: p.x - 0.2, y: p.y - 0.2, w: 0.4, h: 0.4 }, padRect(l, 1.5)));
        if (inBuilding(p.x, p.y, { buildings }) || inPond(p.x, p.y, { ponds }) || roads.some((r) => pointInRect(p.x, p.y, padRect(r, 0.8)))) continue;
        scenery.push({ type: nearLot || rand() < 0.34 ? "bush" : "tree", x: p.x, y: p.y, r: randRange(rand, 0.35, nearLot ? 0.55 : 0.8) });
      }

      for (let i = 0; i < 24; i++) {
        const road = choice(rand, roads);
        const along = road.w > road.h;
        const x = along ? randRange(rand, Math.max(3, road.x + 2), Math.min(MAP_W - 3, road.x + road.w - 2)) : road.x + road.w / 2 + randRange(rand, -0.9, 0.9);
        const y = along ? road.y + road.h / 2 + randRange(rand, -0.8, 0.8) : randRange(rand, Math.max(3, road.y + 2), Math.min(MAP_H - 3, road.y + road.h - 2));
        const car = { type: rand() < 0.72 ? "car" : "truck", x: x - 0.8, y: y - 0.45, w: rand() < 0.72 ? 1.7 : 2.6, h: 0.95 };
        if (buildings.some((b) => rectsOverlap(padRect(car, 0.7), b))) continue;
        obstacles.push(car);
      }

      return { buildings, scenery, obstacles, ponds, roads };
    }

    function addFenceForLot(lot, building, obstacles, rand) {
      const t = 0.24;
      const gate = lot.along ? building.x + building.w / 2 : building.y + building.h / 2;
      const add = (x, y, w, h) => obstacles.push({ type: "fence", x, y, w, h });
      if (lot.along) {
        const roadY = lot.side < 0 ? lot.y + lot.h - t : lot.y;
        const farY = lot.side < 0 ? lot.y : lot.y + lot.h - t;
        add(lot.x, farY, lot.w, t);
        add(lot.x, roadY, Math.max(0, gate - lot.x - 1.1), t);
        add(gate + 1.1, roadY, Math.max(0, lot.x + lot.w - gate - 1.1), t);
        if (lot.w > 7.4 && lot.h > 8.2 && rand() < 0.5) {
          add(lot.x, lot.y, t, lot.h);
          add(lot.x + lot.w - t, lot.y, t, lot.h);
        }
      } else {
        const roadX = lot.side < 0 ? lot.x + lot.w - t : lot.x;
        const farX = lot.side < 0 ? lot.x : lot.x + lot.w - t;
        add(farX, lot.y, t, lot.h);
        add(roadX, lot.y, t, Math.max(0, gate - lot.y - 1.1));
        add(roadX, gate + 1.1, t, Math.max(0, lot.y + lot.h - gate - 1.1));
        if (lot.w > 8.2 && lot.h > 7.4 && rand() < 0.5) {
          add(lot.x, lot.y, lot.w, t);
          add(lot.x, lot.y + lot.h - t, lot.w, t);
        }
      }
    }

    function addDriveway(lot, building, obstacles) {
      const along = lot.along;
      const x = along ? building.x + building.w / 2 - 0.45 : (lot.side < 0 ? lot.x : lot.x + lot.w - 0.9);
      const y = along ? (lot.side < 0 ? lot.y + lot.h - 1.7 : lot.y) : building.y + building.h / 2 - 0.45;
      obstacles.push({ type: "driveway", x, y, w: along ? 0.9 : 1.7, h: along ? 1.7 : 0.9 });
    }

    function padRect(r, p) { return { x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 }; }
    function rectsOverlap(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
    function pointInRect(x, y, r) { return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h; }
    function inBuilding(x, y, m = map) { return m?.buildings.find((b) => pointInRect(x, y, b)); }
    function inPond(x, y, m = map) { return !!m?.ponds.find((p) => ((x - p.x) / p.rx) ** 2 + ((y - p.y) / p.ry) ** 2 <= 1); }
    function inShelter(x, y) { return !!inBuilding(x, y); }

    function resetHostState(keepPlayers = true) {
      state.seed = Math.floor(Math.random() * 1_000_000_000);
      map = makeMap(state.seed);
      state.round++;
      state.over = false;
      state.winner = null;
      state.restartAt = 0;
      state.projectiles = [];
      state.items = [];
      state.objects = [];
      state.piles = [];
      state.tracks = [];
      state.events = [];
      dirtyItems.clear();
      dirtyObjects.clear();
      nextId = 1;
      spawnWorldObjects();
      spawnSnowmen();
      spawnPiles(34);
      if (keepPlayers) syncPlayerList(true);
      forceFullSnapshot();
    }

    function forceFullSnapshot() {
      lastFullSnapshotAt = 0;
      for (const it of state.items) dirtyItems.add(it.id);
      for (const obj of state.objects) dirtyObjects.add(obj.id);
      for (const pile of state.piles) dirtyObjects.add(pile.id);
    }

    function spawnWorldObjects() {
      const rand = rng(state.seed ^ 0xabc123);
      const types = ["barrel", "trash", "chest", "pot"];
      for (let i = 0; i < 58; i++) {
        const p = randInner(rand, 5.5);
        if (inPond(p.x, p.y) || nearMapEdge(p, 4)) continue;
        const obj = { id: id("o"), type: choice(rand, types), x: p.x, y: p.y, r: 0.42, hp: choice(rand, [30, 35, 45]), dead: false };
        if (inBuilding(p.x, p.y)) obj.inside = inBuilding(p.x, p.y).id;
        state.objects.push(obj);
      }
    }

    function spawnPiles(count) {
      const rand = rng((state.seed + state.round) ^ 0x9182);
      for (let i = 0; i < count; i++) {
        const p = randInner(rand, 5.5);
        if (inPond(p.x, p.y) || nearMapEdge(p, 4)) continue;
        state.piles.push({ id: id("p"), x: p.x, y: p.y, count: 2 + Math.floor(rand() * 5), dead: false });
      }
    }

    function spawnSnowmen() {
      const rand = rng(state.seed ^ 0x55aa);
      state.snowmen = [];
      for (let i = 0; i < 18; i++) {
        let p = edgeSpawn(rand);
        for (let tries = 0; tries < 18 && (inPond(p.x, p.y) || inBuilding(p.x, p.y) || visibleToAnyPlayer(p.x, p.y)); tries++) p = edgeSpawn(rand);
        state.snowmen.push({ id: id("s"), x: p.x, y: p.y, hp: 60, vx: 0, vy: 0, cool: rand() * 1.2, dead: false });
      }
    }

    function edgeSpawn(rand) {
      const side = Math.floor(rand() * 4);
      const margin = randRange(rand, 2.5, 8);
      if (side === 0) return { x: randRange(rand, 2, MAP_W - 2), y: margin };
      if (side === 1) return { x: randRange(rand, 2, MAP_W - 2), y: MAP_H - margin };
      if (side === 2) return { x: margin, y: randRange(rand, 2, MAP_H - 2) };
      return { x: MAP_W - margin, y: randRange(rand, 2, MAP_H - 2) };
    }

    function nearMapEdge(p, margin) { return p.x < margin || p.y < margin || p.x > MAP_W - margin || p.y > MAP_H - margin; }

    function spawnPlayer(id, fresh = false) {
      const prof = profile(id);
      let p = state.players[id];
      if (p && !fresh) return p;
      const rand = rng((state.seed ^ hash(id) ^ state.round) >>> 0);
      let pos = randInner(rand, 8);
      for (let i = 0; i < 80 && !safePlayerSpawn(pos); i++) pos = randInner(rand, 8);
      if (!safePlayerSpawn(pos)) pos = findSafePlayerSpawn(rand);
      p = {
        id, x: pos.x, y: pos.y, vx: 0, vy: 0, aimX: 1, aimY: 0, hp: 100, warmth: 100, cold: 0,
        snowballs: 6, binoculars: 0, alive: true, spectator: false, weapon: "snowball", cool: 0,
        name: prof.name, color: prof.color || "#7cfc9b", icon: prof.icon || "❄️", kills: 0, lastTrackAt: 0,
      };
      state.players[id] = p;
      return p;
    }

    function safePlayerSpawn(pos) {
      if (!pos || nearMapEdge(pos, 2)) return false;
      if (inPond(pos.x, pos.y) || inBuilding(pos.x, pos.y)) return false;
      if (blocked(pos.x, pos.y, PLAYER_R + 0.08)) return false;
      for (const p of Object.values(state.players)) {
        if (p.alive && Math.hypot(p.x - pos.x, p.y - pos.y) < PLAYER_R * 4) return false;
      }
      return true;
    }

    function findSafePlayerSpawn(rand) {
      for (let y = 6; y <= MAP_H - 6; y += 2) {
        for (let x = 6; x <= MAP_W - 6; x += 2) {
          const pos = { x: x + randRange(rand, -0.5, 0.5), y: y + randRange(rand, -0.5, 0.5) };
          if (safePlayerSpawn(pos)) return pos;
        }
      }
      return { x: MAP_W / 2, y: MAP_H / 2 };
    }

    function hash(s) { let h = 2166136261; for (let i = 0; i < String(s).length; i++) h = Math.imul(h ^ String(s).charCodeAt(i), 16777619); return h >>> 0; }

    function syncPlayerList(newRound = false) {
      if (!isHost()) return;
      const live = new Set(host.getPlayers().map((p) => p.id));
      for (const p of host.getPlayers()) {
        if (!state.players[p.id]) spawnPlayer(p.id, true);
        else {
          const prof = profile(p.id);
          Object.assign(state.players[p.id], { name: prof.name, color: prof.color, icon: prof.icon });
          if (newRound) spawnPlayer(p.id, true);
        }
      }
    }

    function visibleToAnyPlayer(x, y) {
      for (const p of Object.values(state.players)) {
        if (!p.alive) continue;
        if (Math.hypot(p.x - x, p.y - y) <= visionFor(p) + 2) return true;
      }
      return false;
    }

    function visionFor(p) { return (p.binoculars ? BINOCULAR_VISION : VISION) * (p.warmth < 25 ? 0.78 : 1); }

    function handleAction(id, input) {
      if (!isHost() || !input) return;
      const p = state.players[id] || spawnPlayer(id, true);
      if (!p.alive || state.over) return;
      p.input = {
        mx: clamp(Number(input.mx) || 0, -1, 1),
        my: clamp(Number(input.my) || 0, -1, 1),
        ax: clamp(Number(input.ax) || p.aimX || 1, -1, 1),
        ay: clamp(Number(input.ay) || p.aimY || 0, -1, 1),
        aiming: !!input.aiming,
      };
      if (Math.hypot(p.input.ax, p.input.ay) > 0.15) {
        const d = Math.hypot(p.input.ax, p.input.ay);
        p.aimX = p.input.ax / d;
        p.aimY = p.input.ay / d;
      }
      if (input.weapon === "melee" || input.weapon === "snowball") p.weapon = input.weapon;
      if (input.fire) fireWeapon(p);
    }

    function fireWeapon(p) {
      if (p.cool > 0) return;
      if (p.weapon === "melee") {
        p.cool = 0.42;
        state.events.push({ type: "melee", x: p.x, y: p.y, ax: p.aimX, ay: p.aimY, by: p.id, t: Date.now() });
        meleeHit(p);
        playSound("melee");
        return;
      }
      if (p.snowballs <= 0) return;
      p.snowballs--;
      p.cool = 0.35;
      state.projectiles.push({ id: id("q"), owner: p.id, team: "player", x: p.x + p.aimX * 0.52, y: p.y + p.aimY * 0.52, vx: p.aimX * PROJECTILE_SPEED, vy: p.aimY * PROJECTILE_SPEED, life: PROJECTILE_LIFE });
      playSound("throw");
    }

    function meleeHit(attacker) {
      const hitArc = (target) => {
        const dx = target.x - attacker.x, dy = target.y - attacker.y;
        const d = Math.hypot(dx, dy);
        if (d > MELEE_RANGE || d < 0.001) return false;
        return (dx / d) * attacker.aimX + (dy / d) * attacker.aimY >= Math.cos(MELEE_HALF_ANGLE);
      };
      for (const p of Object.values(state.players)) if (p.id !== attacker.id && p.alive && hitArc(p)) damagePlayer(p, MELEE_DAMAGE, attacker.id);
      for (const s of state.snowmen) if (!s.dead && hitArc(s)) damageSnowman(s, MELEE_DAMAGE, attacker.id);
      for (const o of state.objects) if (!o.dead && hitArc(o)) damageObject(o, MELEE_DAMAGE, attacker.id);
    }

    function updateHost(dt) {
      syncPlayerList(false);
      if (state.over) return;
      for (const p of Object.values(state.players)) updatePlayer(p, dt);
      updateSnowmen(dt);
      updateProjectiles(dt);
      updateTracks();
      collectPickups();
      checkWinner();
    }

    function updatePlayer(p, dt) {
      if (!p.alive) return;
      p.cool = Math.max(0, p.cool - dt);
      const input = p.input || { mx: 0, my: 0 };
      const warm = inShelter(p.x, p.y);
      if (warm) {
        p.cold = Math.max(0, p.cold - dt * 5);
        p.warmth = Math.min(100, p.warmth + (100 / WARM_SECONDS) * dt);
      } else {
        p.cold += dt;
        if (p.cold > COLD_GRACE) p.warmth = Math.max(0, p.warmth - 5.5 * dt);
      }
      if (p.warmth <= 0) damagePlayer(p, 5 * dt, null);
      const slow = p.warmth < 35 ? 0.55 + p.warmth / 80 : 1;
      const d = Math.hypot(input.mx, input.my);
      const speed = BASE_SPEED * slow;
      if (d > 0.05) moveCircle(p, input.mx / d * speed * dt, input.my / d * speed * dt, PLAYER_R);
      if (now() - p.lastTrackAt > 280 && d > 0.12 && !inBuilding(p.x, p.y)) {
        state.tracks.push({ id: id("t"), x: p.x, y: p.y, a: Math.atan2(input.my, input.mx), t: Date.now(), who: p.id });
        p.lastTrackAt = now();
      }
    }

    function moveCircle(e, dx, dy, r) {
      const oldX = e.x, oldY = e.y;
      e.x = clamp(e.x + dx, r, MAP_W - r);
      if (blocked(e.x, e.y, r)) e.x = oldX;
      e.y = clamp(e.y + dy, r, MAP_H - r);
      if (blocked(e.x, e.y, r)) e.y = oldY;
    }

    function blocked(x, y, r) {
      if (inPond(x, y)) return true;
      for (const o of map.obstacles) if (o.type !== "driveway" && circleRect(x, y, r, o)) return true;
      for (const o of state.objects) if (!o.dead && Math.hypot(o.x - x, o.y - y) < r + o.r) return true;
      return false;
    }

    function circleRect(cx, cy, cr, r) {
      const nx = clamp(cx, r.x, r.x + r.w), ny = clamp(cy, r.y, r.y + r.h);
      return Math.hypot(cx - nx, cy - ny) < cr;
    }

    function updateSnowmen(dt) {
      for (const s of state.snowmen) {
        if (s.dead) continue;
        s.cool = Math.max(0, s.cool - dt);
        let target = null, best = 8.5;
        for (const p of Object.values(state.players)) {
          if (!p.alive) continue;
          const d = Math.hypot(p.x - s.x, p.y - s.y);
          if (d < best && sameVisibilitySpace(s, p)) { best = d; target = p; }
        }
        if (target) {
          const dx = target.x - s.x, dy = target.y - s.y, d = Math.hypot(dx, dy) || 1;
          if (d > 4.2) moveCircle(s, dx / d * 2.0 * dt, dy / d * 2.0 * dt, SNOWMAN_R);
          if (s.cool <= 0 && d < 7.5) {
            s.cool = 1.45;
            state.projectiles.push({ id: id("q"), owner: s.id, team: "snowman", x: s.x + dx / d * 0.5, y: s.y + dy / d * 0.5, vx: dx / d * 11.5, vy: dy / d * 11.5, life: 1.05 });
          }
        }
        if (now() - (s.lastTrackAt || 0) > 380 && !inBuilding(s.x, s.y)) {
          state.tracks.push({ id: id("t"), x: s.x, y: s.y, a: Math.atan2(s.vy || 0, s.vx || 1), t: Date.now(), who: s.id });
          s.lastTrackAt = now();
        }
      }
      state.snowmen = state.snowmen.filter((s) => !s.dead);
      if (state.snowmen.length < 12 && Math.random() < 0.012) spawnOneSnowman();
    }

    function spawnOneSnowman() {
      const rand = rng((Date.now() ^ state.snowmen.length ^ state.seed) >>> 0);
      let p = edgeSpawn(rand);
      for (let tries = 0; tries < 24 && (inPond(p.x, p.y) || inBuilding(p.x, p.y) || visibleToAnyPlayer(p.x, p.y)); tries++) p = edgeSpawn(rand);
      if (!visibleToAnyPlayer(p.x, p.y)) state.snowmen.push({ id: id("s"), x: p.x, y: p.y, hp: 60, vx: 0, vy: 0, cool: rand(), dead: false });
    }

    function sameVisibilitySpace(a, b) {
      const ba = inBuilding(a.x, a.y), bb = inBuilding(b.x, b.y);
      return (!ba && !bb) || (ba && bb && ba.id === bb.id);
    }

    function updateProjectiles(dt) {
      for (const q of state.projectiles) {
        q.life -= dt;
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        if (q.x < 0 || q.y < 0 || q.x > MAP_W || q.y > MAP_H || inPond(q.x, q.y)) q.life = 0;
        if (q.life <= 0) continue;
        for (const o of state.objects) if (!o.dead && Math.hypot(o.x - q.x, o.y - q.y) < o.r + 0.18) { damageObject(o, SNOWBALL_DAMAGE, q.owner); q.life = 0; break; }
        if (q.life <= 0) continue;
        if (q.team === "player") {
          for (const s of state.snowmen) if (!s.dead && Math.hypot(s.x - q.x, s.y - q.y) < SNOWMAN_R + 0.18) { damageSnowman(s, SNOWBALL_DAMAGE, q.owner); q.life = 0; break; }
          for (const p of Object.values(state.players)) if (p.id !== q.owner && p.alive && Math.hypot(p.x - q.x, p.y - q.y) < PLAYER_R + 0.18) { damagePlayer(p, SNOWBALL_DAMAGE, q.owner); q.life = 0; break; }
        } else {
          for (const p of Object.values(state.players)) if (p.alive && Math.hypot(p.x - q.x, p.y - q.y) < PLAYER_R + 0.18) { damagePlayer(p, SNOWMAN_SNOWBALL_DAMAGE, null); q.life = 0; break; }
        }
      }
      state.projectiles = state.projectiles.filter((q) => q.life > 0);
    }

    function damagePlayer(p, amount, by) {
      p.hp = Math.max(0, p.hp - amount);
      if (p.hp <= 0 && p.alive) {
        p.alive = false;
        p.spectator = true;
        p.input = { mx: 0, my: 0 };
        if (by && state.players[by]) state.players[by].kills = (state.players[by].kills || 0) + 1;
        dropItem("snowballs", p.x, p.y, Math.min(8, Math.max(1, p.snowballs || 0)));
        state.events.push({ type: "ko", x: p.x, y: p.y, t: Date.now() });
        playSound("hit");
      }
    }

    function damageSnowman(s, amount, by) {
      s.hp -= amount;
      if (s.hp <= 0 && !s.dead) {
        s.dead = true;
        if (Math.random() < 0.28) dropItem("heart", s.x, s.y);
        else if (Math.random() < 0.22) dropItem("binoculars", s.x, s.y);
        else dropItem("snowballs", s.x, s.y, 3);
        if (by && state.players[by]) state.players[by].kills = (state.players[by].kills || 0) + 1;
      }
    }

    function damageObject(o, amount) {
      o.hp -= amount;
      dirtyObjects.add(o.id);
      if (o.hp <= 0 && !o.dead) {
        o.dead = true;
        dirtyObjects.add(o.id);
        const roll = Math.random();
        if (roll < 0.25) dropItem("heart", o.x, o.y);
        else if (roll < 0.38) dropItem("binoculars", o.x, o.y);
        else dropItem("snowballs", o.x, o.y, 2 + Math.floor(Math.random() * 5));
        playSound("break");
      }
    }

    function dropItem(type, x, y, count = 1) {
      const it = { id: id("i"), type, x: x + (Math.random() - 0.5) * 0.5, y: y + (Math.random() - 0.5) * 0.5, count, dead: false };
      state.items.push(it);
      dirtyItems.add(it.id);
    }

    function collectPickups() {
      for (const p of Object.values(state.players)) {
        if (!p.alive) continue;
        for (const it of state.items) {
          if (it.dead || Math.hypot(p.x - it.x, p.y - it.y) > 0.65) continue;
          if (it.type === "heart") p.hp = Math.min(100, p.hp + 28);
          else if (it.type === "binoculars") p.binoculars = Math.max(p.binoculars || 0, 1);
          else if (it.type === "snowballs") p.snowballs = Math.min(30, (p.snowballs || 0) + (it.count || 1));
          it.dead = true;
          dirtyItems.add(it.id);
          playSound("pickup");
        }
        for (const pile of state.piles) {
          if (pile.dead || pile.count <= 0 || Math.hypot(p.x - pile.x, p.y - pile.y) > 0.8) continue;
          const take = Math.min(pile.count, 1 + Math.floor(Math.random() * 2), 30 - (p.snowballs || 0));
          if (take <= 0) continue;
          p.snowballs += take;
          pile.count -= take;
          if (pile.count <= 0) pile.dead = true;
          dirtyObjects.add(pile.id);
        }
      }
      state.items = state.items.filter((it) => !it.dead);
      state.piles = state.piles.filter((p) => !p.dead);
    }

    function updateTracks() {
      const cutoff = Date.now() - DESPAWN_TRACK_MS;
      state.tracks = state.tracks.filter((t) => t.t > cutoff).slice(-420);
      state.events = state.events.filter((e) => Date.now() - e.t < 1200).slice(-36);
    }

    function checkWinner() {
      const alive = Object.values(state.players).filter((p) => p.alive);
      const playerCount = Object.keys(state.players).length;
      if ((alive.length === 0 || (alive.length === 1 && playerCount > 1)) && playerCount > 0 && !state.over) {
        state.over = true;
        state.winner = alive.length === 1 ? alive[0].id : null;
        state.restartAt = Date.now() + ROUND_RESTART_MS;
        clearTimeout(winnerTimeout);
        winnerTimeout = setTimeout(() => { if (isHost()) resetHostState(true); }, ROUND_RESTART_MS);
        forceFullSnapshot();
      }
    }

    function makeSnapshot(full = false) {
      full = full || !lastFullSnapshotAt;
      const snap = {
        full,
        seed: state.seed,
        round: state.round,
        over: state.over,
        winner: state.winner,
        restartAt: state.restartAt,
        players: state.players,
        snowmen: state.snowmen,
        projectiles: state.projectiles,
        tracks: state.tracks.slice(-320),
        events: state.events.slice(-24),
        nextId,
      };
      if (full) {
        snap.items = state.items;
        snap.objects = state.objects;
        snap.piles = state.piles;
        dirtyItems.clear();
        dirtyObjects.clear();
      } else {
        snap.itemDelta = [...dirtyItems].map((itemId) => state.items.find((i) => i.id === itemId) || { id: itemId, dead: true });
        snap.objectDelta = [...dirtyObjects].map((objId) => state.objects.find((o) => o.id === objId) || state.piles.find((p) => p.id === objId) || { id: objId, dead: true });
        dirtyItems.clear();
        dirtyObjects.clear();
      }
      return snap;
    }

    function currentSnapshot() { return makeSnapshot(true); }

    function applySnapshot(s) {
      if (!s) return;
      const oldSeed = state.seed;
      const oldRound = state.round;
      state.seed = s.seed || state.seed;
      if (!map || oldSeed !== state.seed) map = makeMap(state.seed);
      state.round = s.round || 1;
      state.over = !!s.over;
      state.winner = s.winner || null;
      state.restartAt = s.restartAt || 0;
      state.players = s.players || {};
      state.snowmen = s.snowmen || [];
      state.projectiles = s.projectiles || [];
      state.tracks = s.tracks || [];
      state.events = s.events || [];
      nextId = Math.max(nextId, s.nextId || 1);
      if (s.full) {
        state.items = s.items || [];
        state.objects = s.objects || [];
        state.piles = s.piles || [];
      } else {
        applyArrayDelta(state.items, s.itemDelta);
        applyMixedObjectDelta(s.objectDelta);
      }
      if (oldSeed !== state.seed || oldRound !== state.round) {
        visualEntities.players.clear();
        visualEntities.snowmen.clear();
        visualEntities.projectiles.clear();
      }
      captureVisualTargets(state.players, state.snowmen, state.projectiles);
    }

    function captureVisualTargets(players, snowmen, projectiles) {
      if (isHost()) return;
      const t = now();
      captureVisualMap(visualEntities.players, Object.values(players || {}), t);
      captureVisualMap(visualEntities.snowmen, snowmen || [], t);
      captureVisualMap(visualEntities.projectiles, projectiles || [], t);
    }

    function captureVisualMap(map, entities, t) {
      const live = new Set();
      for (const e of entities) {
        if (!e?.id) continue;
        live.add(e.id);
        const v = map.get(e.id);
        if (!v) map.set(e.id, { x: e.x, y: e.y, fromX: e.x, fromY: e.y, targetX: e.x, targetY: e.y, at: t });
        else Object.assign(v, { fromX: v.x, fromY: v.y, targetX: e.x, targetY: e.y, at: t });
      }
      for (const id of map.keys()) if (!live.has(id)) map.delete(id);
    }

    function visualEntity(e, kind) {
      if (isHost() || !e?.id) return e;
      const map = visualEntities[kind];
      let v = map.get(e.id);
      if (!v) {
        v = { x: e.x, y: e.y, fromX: e.x, fromY: e.y, targetX: e.x, targetY: e.y, at: now() };
        map.set(e.id, v);
      }
      const d = Math.hypot((e.x || 0) - v.x, (e.y || 0) - v.y);
      if (d > SNAPSHOT_SNAP_DISTANCE) {
        Object.assign(v, { x: e.x, y: e.y, fromX: e.x, fromY: e.y, targetX: e.x, targetY: e.y, at: now() });
      } else {
        const a = clamp((now() - v.at) / SNAPSHOT_INTERPOLATION_MS, 0, 1);
        const eased = a * a * (3 - 2 * a);
        v.x = v.fromX + (v.targetX - v.fromX) * eased;
        v.y = v.fromY + (v.targetY - v.fromY) * eased;
      }
      return { ...e, x: v.x, y: v.y };
    }

    function updateClientPrediction(dt) {
      if (isHost()) return;
      const me = state.players[myId];
      if (!me?.alive || state.over) return;
      me.cool = Math.max(0, (me.cool || 0) - dt);
      const d = Math.hypot(controls.mx, controls.my);
      if (d > 0.05) {
        const slow = me.warmth < 35 ? 0.55 + me.warmth / 80 : 1;
        const speed = BASE_SPEED * slow;
        moveCircle(me, controls.mx / d * speed * dt, controls.my / d * speed * dt, PLAYER_R);
      }
      if (Math.hypot(controls.ax, controls.ay) > 0.15) {
        me.aimX = controls.ax;
        me.aimY = controls.ay;
      }
      const v = visualEntities.players.get(myId);
      if (v) Object.assign(v, { x: me.x, y: me.y, fromX: me.x, fromY: me.y, targetX: me.x, targetY: me.y, at: now() });
    }

    function applyArrayDelta(arr, delta) {
      if (!Array.isArray(delta)) return;
      for (const d of delta) {
        const i = arr.findIndex((x) => x.id === d.id);
        if (d.dead) { if (i >= 0) arr.splice(i, 1); }
        else if (i >= 0) arr[i] = d;
        else arr.push(d);
      }
    }

    function applyMixedObjectDelta(delta) {
      if (!Array.isArray(delta)) return;
      for (const d of delta) {
        const target = d.id?.startsWith("p") ? state.piles : state.objects;
        const i = target.findIndex((x) => x.id === d.id);
        if (d.dead) { if (i >= 0) target.splice(i, 1); }
        else if (i >= 0) target[i] = d;
        else target.push(d);
      }
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      lastCssWidth = rect.width;
      lastCssHeight = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function ensureCanvasSize() {
      const r = canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (Math.abs(r.width - lastCssWidth) > 1 || Math.abs(r.height - lastCssHeight) > 1 || canvas.width <= 1 || canvas.height <= 1) resize();
      return true;
    }

    function updateCamera() {
      const me = state.players[myId];
      if (isSpectating()) {
        spectatorCamera = spectatorCamera || { x: me?.x || camera.x, y: me?.y || camera.y };
        camera.x += (spectatorCamera.x - camera.x) * 0.18;
        camera.y += (spectatorCamera.y - camera.y) * 0.18;
        updateCameraScale();
        return;
      }
      spectatorCamera = null;
      let target = me;
      if (!target?.alive) target = Object.values(state.players).find((p) => p.alive) || me;
      if (target) target = visualEntity(target, "players");
      if (target) {
        camera.x += (target.x - camera.x) * 0.15;
        camera.y += (target.y - camera.y) * 0.15;
      }
      updateCameraScale();
    }

    function updateCameraScale() {
      camera.scale = Math.max(canvas.clientWidth / VIEW_W, canvas.clientHeight / VIEW_H);
    }

    function sx(x) { return canvas.clientWidth / 2 + (x - camera.x) * camera.scale; }
    function sy(y) { return canvas.clientHeight / 2 + (y - camera.y) * camera.scale; }
    function worldPoint(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      return { x: camera.x + (clientX - box.left - canvas.clientWidth / 2) / camera.scale, y: camera.y + (clientY - box.top - canvas.clientHeight / 2) / camera.scale };
    }

    function draw() {
      if (!ensureCanvasSize()) return;
      if (!map) map = makeMap(state.seed);
      updateCamera();
      const W = canvas.clientWidth, H = canvas.clientHeight;
      ctx.clearRect(0, 0, W, H);
      drawMap();
      drawTracks();
      drawItemsAndObjects();
      drawActors();
      drawProjectiles();
      drawRoofsAndFog();
      enforceViewportVision();
      drawHud();
      drawControls();
      drawFreeze();
    }

    function drawMap() {
      ctx.fillStyle = "#dfefff";
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.strokeStyle = "rgba(130,170,200,0.20)";
      ctx.lineWidth = 1;
      for (let x = -2; x <= MAP_W + 2; x += 3) { ctx.beginPath(); ctx.moveTo(sx(x), sy(-2)); ctx.lineTo(sx(x + 12), sy(MAP_H + 2)); ctx.stroke(); }
      for (const r of map.roads) drawRectWorld(r, "#cdd3dc");
      for (const p of map.ponds) { ctx.fillStyle = "#8ed8ff"; ctx.beginPath(); ctx.ellipse(sx(p.x), sy(p.y), p.rx * camera.scale, p.ry * camera.scale, 0, 0, Math.PI * 2); ctx.fill(); }
      for (const b of map.buildings) drawBuildingFloor(b);
      for (const o of map.obstacles) drawObstacle(o);
      for (const s of map.scenery) drawScenery(s);
    }

    function drawRectWorld(r, fill) { ctx.fillStyle = fill; ctx.fillRect(sx(r.x), sy(r.y), r.w * camera.scale, r.h * camera.scale); }
    function drawBuildingFloor(b) { drawRectWorld(b, "#9b7b5f"); ctx.strokeStyle = "#6e5440"; ctx.lineWidth = 2; ctx.strokeRect(sx(b.x), sy(b.y), b.w * camera.scale, b.h * camera.scale); }
    function drawObstacle(o) {
      if (o.type === "fence") drawRectWorld(o, "#8b6a3f");
      else if (o.type === "driveway") drawRectWorld(o, "#b9c2cc");
      else drawRectWorld(o, o.type === "truck" ? "#475569" : "#64748b");
    }
    function drawScenery(s) {
      ctx.beginPath();
      ctx.arc(sx(s.x), sy(s.y), s.r * camera.scale, 0, Math.PI * 2);
      ctx.fillStyle = s.type === "tree" ? "#1f7a4a" : "#3aa35f";
      ctx.fill();
    }

    function drawTracks() {
      const tNow = Date.now();
      for (const t of state.tracks) {
        const a = clamp(1 - (tNow - t.t) / DESPAWN_TRACK_MS, 0, 1) * 0.28;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(sx(t.x), sy(t.y));
        ctx.rotate(t.a);
        ctx.fillStyle = "#6b8498";
        ctx.fillRect(-0.22 * camera.scale, -0.05 * camera.scale, 0.44 * camera.scale, 0.10 * camera.scale);
        ctx.restore();
      }
    }

    function drawItemsAndObjects() {
      for (const pile of state.piles) if (visibleEntity(pile)) { ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(sx(pile.x), sy(pile.y), 0.35 * camera.scale, 0, Math.PI * 2); ctx.fill(); drawText(String(pile.count), sx(pile.x), sy(pile.y) + 3, 12, "#335"); }
      for (const o of state.objects) if (!o.dead && visibleEntity(o)) drawText(objEmoji(o.type), sx(o.x), sy(o.y), Math.max(17, camera.scale * 0.85));
      for (const it of state.items) if (visibleEntity(it)) drawText(ITEM_TYPES[it.type]?.emoji || "?", sx(it.x), sy(it.y), Math.max(16, camera.scale * 0.75));
    }

    function objEmoji(type) { return type === "barrel" ? "🛢️" : type === "trash" ? "🗑️" : type === "chest" ? "📦" : "🏺"; }

    function drawActors() {
      for (const s of state.snowmen) {
        const vs = visualEntity(s, "snowmen");
        if (visibleEntity(vs)) drawSnowman(vs);
      }
      for (const p of Object.values(state.players)) {
        const vp = visualEntity(p, "players");
        if (visibleEntity(vp)) drawPlayer(vp);
      }
    }

    function visibleEntity(e) {
      if (isSpectating()) return true;
      const me = state.players[myId];
      const viewer = me?.alive ? me : (Object.values(state.players).find((p) => p.alive) || me);
      if (!viewer) return true;
      const eb = inBuilding(e.x, e.y), vb = inBuilding(viewer.x, viewer.y);
      if (eb && (!vb || eb.id !== vb.id)) return false;
      const range = viewer.id === myId ? visionFor(viewer) : VISION;
      return Math.hypot(e.x - viewer.x, e.y - viewer.y) <= range + 2;
    }

    function drawPlayer(p) {
      const x = sx(p.x), y = sy(p.y), r = PLAYER_R * camera.scale;
      if (!p.alive) { ctx.globalAlpha = 0.35; }
      if (host.isSpeaking?.(p.id)) { ctx.strokeStyle = "#7cfc9b"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r + 8, 0, Math.PI * 2); ctx.stroke(); }
      ctx.fillStyle = p.color || "#7cfc9b";
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      drawText(p.icon || "❄️", x, y + 1, Math.max(14, r * 1.2), "#10202b");
      drawBar(x - r, y - r - 12, r * 2, 4, p.hp / 100, "#ef4444");
      drawText((host.hostCrown?.(p.id) || "") + (p.name || "Player"), x, y - r - 20, 11, "#102033");
      ctx.globalAlpha = 1;
    }

    function drawSnowman(s) {
      const x = sx(s.x), y = sy(s.y), r = SNOWMAN_R * camera.scale;
      ctx.fillStyle = "#f8fbff";
      ctx.beginPath(); ctx.arc(x, y + r * 0.18, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y - r * 0.55, r * 0.68, 0, Math.PI * 2); ctx.fill();
      drawText("☃️", x, y, Math.max(17, r * 1.5));
      drawBar(x - r, y - r - 10, r * 2, 3, s.hp / 60, "#60a5fa");
    }

    function drawProjectiles() {
      ctx.fillStyle = "#ffffff";
      for (const q of state.projectiles) {
        const vq = visualEntity(q, "projectiles");
        ctx.beginPath(); ctx.arc(sx(vq.x), sy(vq.y), 0.16 * camera.scale, 0, Math.PI * 2); ctx.fill();
      }
      const me = state.players[myId];
      if (me?.alive && controls.aiming) {
        ctx.save(); ctx.strokeStyle = selectedWeapon === "melee" ? "rgba(255,180,100,0.7)" : "rgba(255,255,255,0.8)"; ctx.lineWidth = 3;
        if (selectedWeapon === "melee") drawMeleeCone(me.x, me.y, controls.ax, controls.ay);
        else { ctx.beginPath(); ctx.moveTo(sx(me.x), sy(me.y)); ctx.lineTo(sx(me.x + controls.ax * 5), sy(me.y + controls.ay * 5)); ctx.stroke(); }
        ctx.restore();
      }
    }

    function enforceViewportVision() {
      if (isSpectating()) return;
      const me = state.players[myId];
      const viewer = me?.alive ? me : (Object.values(state.players).find((p) => p.alive) || me);
      if (!viewer) return;
      const range = visionFor(viewer) * camera.scale;
      const cx = sx(viewer.x), cy = sy(viewer.y);
      ctx.save();
      ctx.fillStyle = "rgba(12,18,30,0.94)";
      ctx.beginPath();
      ctx.rect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.arc(cx, cy, range, 0, Math.PI * 2, true);
      ctx.fill("evenodd");
      ctx.restore();
    }

    function drawMeleeCone(x, y, ax, ay) {
      const a = Math.atan2(ay, ax);
      ctx.beginPath();
      ctx.moveTo(sx(x), sy(y));
      ctx.arc(sx(x), sy(y), MELEE_RANGE * camera.scale, a - MELEE_HALF_ANGLE, a + MELEE_HALF_ANGLE);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,180,100,0.20)";
      ctx.fill();
      ctx.stroke();
    }

    function drawRoofsAndFog() {
      if (isSpectating()) return;
      const me = state.players[myId];
      const viewer = me?.alive ? me : (Object.values(state.players).find((p) => p.alive) || me);
      const viewerBuilding = viewer && inBuilding(viewer.x, viewer.y);
      for (const b of map.buildings) {
        if (viewerBuilding?.id === b.id) continue;
        drawRectWorld(b, "#5b2d2d");
        drawText(b.type, sx(b.x + b.w / 2), sy(b.y + b.h / 2), 12, "#ffd7d7");
      }
      if (viewer) {
        const range = visionFor(viewer);
        const grad = ctx.createRadialGradient(sx(viewer.x), sy(viewer.y), range * camera.scale * 0.55, sx(viewer.x), sy(viewer.y), range * camera.scale);
        grad.addColorStop(0, "rgba(12,18,30,0)"); grad.addColorStop(1, "rgba(12,18,30,0.72)");
        ctx.fillStyle = grad; ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      }
    }

    function drawHud() {
      const me = state.players[myId];
      ctx.fillStyle = "rgba(10,18,30,0.78)"; ctx.fillRect(0, 0, canvas.clientWidth, 54);
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      drawText("❄️ Snow Brawl Royale", 12, 17, 16, "#eef6ff", "left");
      if (me) drawText(`HP ${Math.ceil(me.hp)} · Warm ${Math.ceil(me.warmth)} · ⚪ ${me.snowballs || 0} · ${me.weapon === "melee" ? "Shovel" : "Snowballs"}${me.binoculars ? " · 🔭" : ""}`, 12, 39, 12, "#d8e6ff", "left");
      const alive = Object.values(state.players).filter((p) => p.alive).length;
      drawText(`${alive} alive`, canvas.clientWidth - 12, 22, 13, "#eef6ff", "right");
      weaponRect = { x: canvas.clientWidth - 104, y: 58, w: 92, h: 34 };
      ctx.fillStyle = "rgba(10,18,30,0.76)"; roundRect(weaponRect.x, weaponRect.y, weaponRect.w, weaponRect.h, 12); ctx.fill();
      drawText(selectedWeapon === "melee" ? "🪓 Shovel" : "⚪ Throw", weaponRect.x + weaponRect.w / 2, weaponRect.y + 18, 13, "#fff");
      if (me && !me.alive) drawText(state.over ? "Round ending…" : "Spectating until the round ends", canvas.clientWidth / 2, canvas.clientHeight * 0.18, 18, "#fff");
      if (state.over) {
        const left = Math.max(0, Math.ceil(((state.restartAt || Date.now()) - Date.now()) / 1000));
        drawText(state.winner ? `${profile(state.winner).name} wins!` : "No living players left", canvas.clientWidth / 2, canvas.clientHeight * 0.25, 24, "#fff");
        drawText(`Restarting in ${left}s`, canvas.clientWidth / 2, canvas.clientHeight * 0.31, 17, "#d8e6ff");
      }
    }

    function drawControls() {
      drawStick(leftStick, "rgba(124,252,155,0.28)");
      drawStick(rightStick, "rgba(77,210,255,0.28)");
    }

    function drawStick(stick, color) {
      if (!stick) return;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(stick.x0, stick.y0, 42, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(stick.x0 + stick.dx * 34, stick.y0 + stick.dy * 34, 20, 0, Math.PI * 2); ctx.fill();
    }

    function drawFreeze() {
      const me = state.players[myId];
      if (!me || me.warmth > 45) return;
      const a = clamp((45 - me.warmth) / 45, 0, 1) * 0.48;
      ctx.fillStyle = `rgba(160,220,255,${a})`; ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.strokeStyle = `rgba(235,250,255,${a})`; ctx.lineWidth = 2;
      for (let i = 0; i < 16; i++) { const x = (i * 97) % canvas.clientWidth, y = (i * 53) % canvas.clientHeight; ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); ctx.stroke(); }
    }

    function drawText(text, x, y, size = 14, color = "#fff", align = "center") { ctx.fillStyle = color; ctx.font = `800 ${size}px system-ui, sans-serif`; ctx.textAlign = align; ctx.textBaseline = "middle"; ctx.fillText(text, x, y); }
    function drawBar(x, y, w, h, pct, color) { ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(x, y, w, h); ctx.fillStyle = color; ctx.fillRect(x, y, w * clamp(pct, 0, 1), h); }
    function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

    function playSound(kind) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        const t = audioCtx.currentTime, osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        const tones = { throw: [420, 0.05, 0.028], hit: [120, 0.10, 0.05], pickup: [720, 0.06, 0.03], break: [90, 0.12, 0.05], melee: [180, 0.08, 0.04] };
        const [freq, dur, vol] = tones[kind] || tones.pickup;
        osc.type = kind === "pickup" ? "triangle" : "square";
        osc.frequency.setValueAtTime(freq, t); osc.frequency.exponentialRampToValueAtTime(Math.max(45, freq * 0.62), t + dur);
        gain.gain.setValueAtTime(vol, t); gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(gain); gain.connect(audioCtx.destination); osc.start(t); osc.stop(t + dur);
      } catch {}
    }

    function sendControls(fire = false) {
      controls.weapon = selectedWeapon;
      const input = { ...controls, fire };
      if (isHost()) handleAction(myId, input);
      else host.sendInput(input);
    }

    function updateLocalControls() {
      let mx = 0, my = 0;
      if (keys.has("a") || keys.has("arrowleft")) mx--;
      if (keys.has("d") || keys.has("arrowright")) mx++;
      if (keys.has("w") || keys.has("arrowup")) my--;
      if (keys.has("s") || keys.has("arrowdown")) my++;
      if (leftStick) { mx = leftStick.dx; my = leftStick.dy; }
      const d = Math.hypot(mx, my); controls.mx = d > 1 ? mx / d : mx; controls.my = d > 1 ? my / d : my;
      if (isSpectating()) {
        spectatorCamera = spectatorCamera || { x: camera.x, y: camera.y };
        spectatorCamera.x = clamp(spectatorCamera.x + controls.mx * 0.35, 0, MAP_W);
        spectatorCamera.y = clamp(spectatorCamera.y + controls.my * 0.35, 0, MAP_H);
      }
      if (rightStick) { controls.ax = rightStick.dx || controls.ax; controls.ay = rightStick.dy || controls.ay; controls.aiming = true; }
      else if (mouseAim.active) { controls.ax = mouseAim.x; controls.ay = mouseAim.y; controls.aiming = true; }
      else controls.aiming = false;
      if (pendingFire) {
        const auto = pendingFire === "auto";
        pendingFire = null;
        if (auto) autoTargetAim();
        sendControls(!isSpectating());
      }
      else if (now() - lastInputSentAt > 55) { lastInputSentAt = now(); sendControls(false); }
    }

    function isSpectating() {
      const me = state.players[myId];
      return !!me && !me.alive;
    }

    function autoTargetAim() {
      const me = state.players[myId];
      if (!me?.alive) return;
      const maxRange = selectedWeapon === "melee" ? MELEE_RANGE : SNOWBALL_TARGET_RANGE;
      let best = null;
      for (const p of Object.values(state.players)) {
        if (p.id === myId || !p.alive || !visibleEntity(p)) continue;
        const d = Math.hypot(p.x - me.x, p.y - me.y);
        if (d <= maxRange && (!best || d < best.d)) best = { x: p.x, y: p.y, d };
      }
      for (const s of state.snowmen) {
        if (s.dead || !visibleEntity(s)) continue;
        const d = Math.hypot(s.x - me.x, s.y - me.y);
        if (d <= maxRange && (!best || d < best.d)) best = { x: s.x, y: s.y, d };
      }
      if (!best) return;
      const dx = best.x - me.x, dy = best.y - me.y, d = Math.hypot(dx, dy) || 1;
      controls.ax = dx / d;
      controls.ay = dy / d;
    }

    function pointerDown(e) {
      const p = pointerScreen(e);
      if (weaponRect && pointInRect(p.x, p.y, weaponRect)) { selectedWeapon = selectedWeapon === "snowball" ? "melee" : "snowball"; sendControls(false); return; }
      if (e.pointerType === "mouse") {
        updateMouseAim(p);
        mouseAim.down = p;
        e.preventDefault();
        return;
      }
      if (p.x < canvas.clientWidth * 0.46 && !leftStick) leftStick = makeStick(e, p);
      else if (!rightStick) rightStick = makeStick(e, p);
      e.preventDefault();
    }

    function pointerMove(e) {
      const p = pointerScreen(e);
      const id = e.pointerId ?? "mouse";
      for (const stick of [leftStick, rightStick]) if (stick && stick.id === id) updateStick(stick, p);
      if (!leftStick && !rightStick && e.buttons) updateMouseAim(p);
      e.preventDefault();
    }

    function pointerUp(e) {
      const id = e.pointerId ?? "mouse";
      if (e.pointerType === "mouse") {
        mouseUp(e);
        e.preventDefault();
        return;
      }
      if (rightStick && rightStick.id === id) pendingFire = Math.hypot(rightStick.dx, rightStick.dy) < 0.18 ? "auto" : true;
      if (leftStick && leftStick.id === id) leftStick = null;
      if (rightStick && rightStick.id === id) rightStick = null;
      mouseAim.active = false;
    }

    function makeStick(e, p) { canvas.setPointerCapture?.(e.pointerId); return { id: e.pointerId ?? "mouse", x0: p.x, y0: p.y, dx: 0, dy: 0 }; }
    function updateStick(stick, p) { const dx = p.x - stick.x0, dy = p.y - stick.y0, d = Math.max(1, Math.hypot(dx, dy)), m = Math.min(1, d / 44); stick.dx = dx / d * m; stick.dy = dy / d * m; }
    function pointerScreen(e) { const box = canvas.getBoundingClientRect(); const t = e.touches?.[0] || e.changedTouches?.[0] || e; return { x: t.clientX - box.left, y: t.clientY - box.top, clientX: t.clientX, clientY: t.clientY }; }
    function updateMouseAim(p) { const me = state.players[myId]; if (!me) return; const w = worldPoint(p.clientX, p.clientY); const dx = w.x - me.x, dy = w.y - me.y, d = Math.hypot(dx, dy) || 1; mouseAim = { x: dx / d, y: dy / d, active: true }; }
    function mouseDown(e) { const p = pointerScreen(e); updateMouseAim(p); mouseAim.down = p; }
    function mouseUp(e) {
      const p = e ? pointerScreen(e) : null;
      if (p && mouseAim.down && Math.hypot(p.x - mouseAim.down.x, p.y - mouseAim.down.y) < 8) pendingFire = "auto";
      else if (mouseAim.active) pendingFire = true;
      mouseAim.active = false;
      mouseAim.down = null;
    }
    function keyDown(e) { const k = e.key.toLowerCase(); if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) { keys.add(k); e.preventDefault(); } if (k === "q" || k === " ") { selectedWeapon = selectedWeapon === "snowball" ? "melee" : "snowball"; e.preventDefault(); } }
    function keyUp(e) { keys.delete(e.key.toLowerCase()); }

    function loop(ts) {
      rafId = requestAnimationFrame(loop);
      if (!lastTs) lastTs = ts;
      const dt = Math.min(0.05, (ts - lastTs) / 1000);
      lastTs = ts;
      updateLocalControls();
      if (isHost()) {
        updateHost(dt);
        if (ts - lastSnapshotAt >= 1000 / SNAPSHOT_HZ) {
          const full = !lastFullSnapshotAt || ts - lastFullSnapshotAt >= FULL_SNAPSHOT_MS;
          if (full) lastFullSnapshotAt = ts;
          lastSnapshotAt = ts;
          host.broadcastState(makeSnapshot(full));
        }
      }
      else updateClientPrediction(dt);
      draw();
    }

    return {
      start() {
        resize();
        if (initialState) applySnapshot(initialState);
        else if (isHost()) resetHostState(true);
        if (!map) map = makeMap(state.seed);
        window.addEventListener("resize", resize);
        if (pointerMode) {
          canvas.addEventListener("pointerdown", pointerDown);
          canvas.addEventListener("pointermove", pointerMove);
          canvas.addEventListener("pointerup", pointerUp);
          canvas.addEventListener("pointercancel", pointerUp);
        } else {
          canvas.addEventListener("touchstart", pointerDown, { passive: false });
          canvas.addEventListener("touchmove", pointerMove, { passive: false });
          window.addEventListener("touchend", pointerUp);
        }
        if (!pointerMode) {
          canvas.addEventListener("mousedown", mouseDown);
          window.addEventListener("mouseup", mouseUp);
        }
        window.addEventListener("keydown", keyDown);
        window.addEventListener("keyup", keyUp);
        rafId = requestAnimationFrame(loop);
      },
      destroy() {
        cancelAnimationFrame(rafId);
        clearTimeout(winnerTimeout);
        window.removeEventListener("resize", resize);
        if (pointerMode) {
          canvas.removeEventListener("pointerdown", pointerDown);
          canvas.removeEventListener("pointermove", pointerMove);
          canvas.removeEventListener("pointerup", pointerUp);
          canvas.removeEventListener("pointercancel", pointerUp);
        } else {
          canvas.removeEventListener("touchstart", pointerDown);
          canvas.removeEventListener("touchmove", pointerMove);
          window.removeEventListener("touchend", pointerUp);
        }
        if (!pointerMode) {
          canvas.removeEventListener("mousedown", mouseDown);
          window.removeEventListener("mouseup", mouseUp);
        }
        window.removeEventListener("keydown", keyDown);
        window.removeEventListener("keyup", keyUp);
      },
      onPeerInput(id, input) { handleAction(id, input); },
      onState(snapshot) { applySnapshot(snapshot); },
      getSnapshot() { return currentSnapshot(); },
      onPlayerList() { if (isHost()) { syncPlayerList(false); host.broadcastState(makeSnapshot(true)); } },
      restart() { if (isHost()) resetHostState(true); },
    };
  }

  window.BP2PGames = window.BP2PGames || {};
  window.BP2PGames["snow-brawl"] = {
    id: "snow-brawl",
    name: "Snow Brawl Royale",
    emoji: "❄️",
    create,
  };
})();
