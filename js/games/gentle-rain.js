/* A Gentle Rain for browserP2P.
 * Host owns the tile deck, shared hand tile, legal placements, blossoms, and scoring.
 */
(function () {
  "use strict";

  const SNAPSHOT_HZ = 12;
  const PERF_LOG_INTERVAL_MS = 5000;
  const TILE_VALIDATION_INTERVAL_MS = 2400;
  const ENJOYMENT_MESSAGE_CHANCE = 0.28;
  const TILE_COUNT = 28;
  const BLOSSOMS = [
    { key: "lotus", name: "Rose Lotus", color: "#f4a6cf", center: "#ffe5a8", petals: 8, design: "lotus" },
    { key: "iris", name: "Purple Iris", color: "#a993ff", center: "#fff0a8", petals: 5, design: "iris" },
    { key: "lily", name: "Cream Lily", color: "#f7f0bd", center: "#f2b84b", petals: 6, design: "lily" },
    { key: "mint", name: "Mint Clover", color: "#8ce8bc", center: "#fff7c7", petals: 4, design: "clover" },
    { key: "sky", name: "Blue Anemone", color: "#8ed8ff", center: "#263a76", petals: 10, design: "anemone" },
    { key: "coral", name: "Coral Poppy", color: "#ffb08a", center: "#5d3328", petals: 5, design: "poppy" },
    { key: "violet", name: "Lilac Aster", color: "#d9a6ff", center: "#ffe28f", petals: 12, design: "aster" },
    { key: "jade", name: "Jade Orchid", color: "#94d78d", center: "#f9ffd8", petals: 6, design: "orchid" },
  ];
  const MOTIFS = ["lily", "koi", "turtle", "dragonfly", "pads", "pondlife"];
  const DIRS = [
    { dx: 0, dy: -1, edge: 0, opp: 2 },
    { dx: 1, dy: 0, edge: 1, opp: 3 },
    { dx: 0, dy: 1, edge: 2, opp: 0 },
    { dx: -1, dy: 0, edge: 3, opp: 1 },
  ];
  const ENJOYMENT_MESSAGES = [
    "A quiet ripple follows your touch.",
    "The lake listens.",
    "A koi turns beneath the rain.",
    "Soft drops gather at the tile edge.",
    "The garden breathes between turns.",
    "A dragonfly waits out the shower.",
    "The water brightens for a moment.",
    "Lotus leaves tremble in the mist.",
    "The next pattern is hiding in plain sight.",
    "Rain beads shine on the pond stones.",
    "A small wave carries your choice onward.",
    "The blossoms are patient.",
  ];

  function create(host, initialState) {
    const canvas = host.canvas;
    const ctx = canvas.getContext("2d");
    const myId = host.myId;

    let rafId = 0;
    let lastTs = 0;
    let lastSnapshotAt = 0;
    let lastPerfLogAt = 0;
    let lastValidationAt = 0;
    let lastCssWidth = 0;
    let lastCssHeight = 0;
    let activePointerId = null;
    let audioCtx = null;
    let eventSeq = 0;
    let seenEventSeq = 0;
    let ui = { board: null, hand: null, handTile: null, deck: null, reset: null, cells: new Map(), scale: 1 };
    let drag = null;
    let drawAnim = null;
    let boardGesture = null;
    let lastTapAt = 0;
    let handMessage = { text: "", previous: "", changedAt: 0, duration: 520 };
    const activePointers = new Map();
    const view = { zoom: 1, rot: 0, panX: 0, panY: 0 };
    const events = [];
    const drops = [];
    const ripples = [];
    const particles = [];
    const perf = { frames: 0, drawMs: 0, effectsMs: 0, snapshotMs: 0, snapshots: 0 };

    const state = {
      board: {},
      deck: [],
      hands: {},
      currentByPlayer: {},
      blossoms: [],
      used: {},
      completed: {},
      turn: 1,
      over: false,
      won: false,
      message: "Place the first drawn tile beside the lake.",
    };

    function isHost() { return !!host.isHost(); }
    function now() { return performance.now(); }
    function hasRemotePeers() { return host.getPlayers().some((p) => p.id !== myId); }
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function rand(min, max) { return min + Math.random() * (max - min); }
    function key(x, y) { return `${x},${y}`; }
    function parseKey(k) { const [x, y] = k.split(",").map(Number); return { x, y }; }
    function blossom(key) { return BLOSSOMS.find((b) => b.key === key) || BLOSSOMS[0]; }
    function tileColor(k) { return blossom(k).color; }
    function profile(id) {
      return host.getPlayers().find((p) => p.id === id) || host.getProfile?.(id) || { id, name: "Player", color: "#8ce8bc", icon: "🌧️" };
    }

    function playSound(kind) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        const t = audioCtx.currentTime;
        const tones = {
          place: [[330, 0.10, 0.025], [440, 0.16, 0.018]],
          blossom: [[520, 0.18, 0.030], [780, 0.26, 0.024], [1040, 0.34, 0.018]],
          draw: [[220, 0.12, 0.018], [360, 0.18, 0.016]],
          reset: [[260, 0.18, 0.020], [390, 0.24, 0.018]],
        };
        for (const [freq, dur, vol] of tones[kind] || tones.place) {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, t);
          osc.frequency.exponentialRampToValueAtTime(freq * 0.82, t + dur);
          gain.gain.setValueAtTime(vol, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(t);
          osc.stop(t + dur);
        }
      } catch {}
    }

    function emitEvent(kind, x = 0.5, y = 0.5, color = "#ffffff") {
      const evt = { seq: ++eventSeq, kind, x, y, color };
      events.push(evt);
      while (events.length > 32) events.shift();
      seenEventSeq = Math.max(seenEventSeq, evt.seq);
      playEvent(evt);
    }

    function playEvent(evt) {
      playSound(evt.kind);
      if (evt.kind === "blossom") {
        for (let i = 0; i < 34; i++) particles.push({ x: evt.x, y: evt.y, vx: rand(-0.07, 0.07), vy: rand(-0.09, 0.035), color: evt.color, life: rand(520, 980), maxLife: 980, size: rand(2.5, 6.5) });
      } else if (evt.kind === "place") {
        ripples.push({ x: evt.x, y: evt.y, life: 780, maxLife: 780 });
      } else if (evt.kind === "draw") {
        ripples.push({ x: evt.x, y: evt.y, life: 520, maxLife: 520 });
      }
    }

    function applyEvents(incoming) {
      if (!incoming?.length) return;
      const maxSeq = incoming.reduce((m, e) => Math.max(m, e.seq || 0), seenEventSeq);
      if (!seenEventSeq) { seenEventSeq = maxSeq; return; }
      for (const evt of incoming) {
        if ((evt.seq || 0) <= seenEventSeq) continue;
        playEvent(evt);
        seenEventSeq = Math.max(seenEventSeq, evt.seq || 0);
      }
    }

    function makeTiles() {
      const names = BLOSSOMS.map((b) => b.key);
      const edgeSets = [
        [0, 1, 2, 3], [0, 2, 4, 6], [0, 3, 5, 7], [0, 4, 1, 5],
        [1, 2, 3, 4], [1, 3, 5, 7], [1, 4, 6, 0], [1, 5, 2, 6],
        [2, 3, 4, 5], [2, 4, 6, 0], [2, 5, 7, 1], [2, 6, 3, 7],
        [3, 4, 5, 6], [3, 5, 7, 1], [3, 6, 0, 2], [3, 7, 4, 0],
        [4, 5, 6, 7], [4, 6, 0, 2], [4, 7, 1, 3], [4, 0, 5, 1],
        [5, 6, 7, 0], [5, 7, 1, 3], [5, 0, 2, 4], [5, 1, 6, 2],
        [6, 7, 0, 1], [6, 0, 2, 4], [7, 0, 1, 2], [7, 1, 3, 5],
      ];
      return edgeSets.map((set, i) => {
        const edges = set.map((n) => names[n]);
        if (new Set(edges).size !== edges.length) throw new Error("A Gentle Rain tile has duplicate flower colors.");
        return { id: `rain-${String(i + 1).padStart(2, "0")}`, edges, motif: MOTIFS[i % MOTIFS.length] };
      });
    }

    function sortedPlayers() {
      return host.getPlayers().map((p) => p.id).sort();
    }

    function placedTileIds() {
      const ids = new Set();
      for (const cell of Object.values(state.board)) if (cell?.tile?.id) ids.add(cell.tile.id);
      return ids;
    }

    function addLiveTile(pool, seen, placed, tile) {
      if (!tile?.id || seen.has(tile.id) || placed.has(tile.id)) return;
      seen.add(tile.id);
      pool.push(tile);
    }

    function liveTilePool() {
      const pool = [];
      const seen = new Set();
      const placed = placedTileIds();
      for (const tile of state.deck) addLiveTile(pool, seen, placed, tile);
      for (const hand of Object.values(state.hands)) for (const tile of hand || []) addLiveTile(pool, seen, placed, tile);
      for (const current of Object.values(state.currentByPlayer)) addLiveTile(pool, seen, placed, current?.tile);
      return pool;
    }

    function playerTileCount(id) {
      return (state.hands[id]?.length || 0) + (state.currentByPlayer[id]?.tile ? 1 : 0);
    }

    function validateRemainingTiles() {
      if (!isHost()) return;
      const ids = sortedPlayers();
      if (!ids.length) return;
      const pool = liveTilePool();
      const activeNeedingTiles = ids.filter((id) => !state.currentByPlayer[id]?.tile && !state.over);
      if (pool.length < activeNeedingTiles.length) {
        checkEnd();
        return;
      }
      let changed = false;
      for (const id of ids) {
        if (!state.currentByPlayer[id]?.tile && (state.hands[id]?.length || 0)) {
          drawForPlayer(id);
          changed = true;
        }
      }
      if (!state.over && ids.some((id) => !playerTileCount(id))) checkEnd();
      if (changed) host.broadcastState(makeSnapshot());
    }

    function dealEvenly(pool = liveTilePool()) {
      const ids = sortedPlayers();
      const placed = placedTileIds();
      const seen = new Set();
      pool = pool.filter((tile) => {
        if (!tile?.id || seen.has(tile.id) || placed.has(tile.id)) return false;
        seen.add(tile.id);
        return true;
      });
      state.deck = [];
      state.hands = {};
      state.currentByPlayer = {};
      if (!ids.length) {
        state.deck = pool;
        return;
      }
      ids.forEach((id) => { state.hands[id] = []; });
      pool.forEach((tile, i) => state.hands[ids[i % ids.length]].push(tile));
      for (const id of ids) drawForPlayer(id);
    }

    function reconcileActivePlayerTiles() {
      if (!isHost()) return;
      dealEvenly(liveTilePool());
      checkEnd();
    }

    function drawForPlayer(id) {
      if (state.currentByPlayer[id]?.tile) return;
      const hand = state.hands[id] || [];
      state.currentByPlayer[id] = hand.length ? { tile: hand.shift(), rot: 0 } : null;
      state.hands[id] = hand;
    }

    function currentFor(id = myId) {
      return state.currentByPlayer[id] || null;
    }

    function remainingTiles() {
      return state.deck.length
        + Object.values(state.hands).reduce((sum, hand) => sum + (hand?.length || 0), 0)
        + Object.values(state.currentByPlayer).filter((current) => current?.tile).length;
    }

    function resetHostState() {
      const deck = makeTiles();
      const start = deck.shift();
      state.board = { [key(0, 0)]: { tile: start, rot: 0, owner: "system", turn: 0 } };
      state.deck = deck;
      state.hands = {};
      state.currentByPlayer = {};
      state.blossoms = [];
      state.used = {};
      state.completed = {};
      state.turn = 1;
      state.over = false;
      state.won = false;
      state.message = "Drag your tile over the still lake. Release on a glowing space to place it.";
      dealEvenly(deck);
      emitEvent("reset", 0.5, 0.5, "#8ed8ff");
    }

    function checkEnd() {
      if (Object.keys(state.used).length >= BLOSSOMS.length) {
        state.over = true;
        state.won = true;
        state.message = `All eight blossoms are placed. Score ${score()} with ${remainingTiles()} tiles unused.`;
      } else if (!remainingTiles()) {
        state.over = true;
        state.won = false;
        state.message = `The rain softens. ${Object.keys(state.used).length} blossoms placed.`;
      }
    }

    function rotatedEdges(tile, rot) {
      const r = ((rot % 4) + 4) % 4;
      return [0, 1, 2, 3].map((i) => tile.edges[(i - r + 4) % 4]);
    }

    function cellEdges(cell) { return rotatedEdges(cell.tile, cell.rot || 0); }

    function legalAt(x, y, current = currentFor()) {
      if (!current || state.board[key(x, y)]) return false;
      const edges = rotatedEdges(current.tile, current.rot || 0);
      let adjacent = false;
      for (const d of DIRS) {
        const n = state.board[key(x + d.dx, y + d.dy)];
        if (!n) continue;
        adjacent = true;
        if (edges[d.edge] !== cellEdges(n)[d.opp]) return false;
      }
      return adjacent;
    }

    function legalCellsFor(current = currentFor()) {
      const result = [];
      const seen = new Set();
      for (const k of Object.keys(state.board)) {
        const { x, y } = parseKey(k);
        for (const d of DIRS) {
          const nx = x + d.dx, ny = y + d.dy, nk = key(nx, ny);
          if (seen.has(nk) || state.board[nk]) continue;
          seen.add(nk);
          if (legalAt(nx, ny, current)) result.push({ x: nx, y: ny });
        }
      }
      return result;
    }

    function tryCompleteSquares(x, y) {
      const starts = [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]];
      for (const [sx, sy] of starts) {
        const sk = key(sx, sy);
        if (state.completed[sk]) continue;
        const tl = state.board[key(sx, sy)];
        const tr = state.board[key(sx + 1, sy)];
        const bl = state.board[key(sx, sy + 1)];
        const br = state.board[key(sx + 1, sy + 1)];
        if (!tl || !tr || !bl || !br) continue;

        const inner = [cellEdges(tl)[1], cellEdges(tr)[3], cellEdges(tl)[2], cellEdges(bl)[0], cellEdges(tr)[2], cellEdges(br)[0], cellEdges(bl)[1], cellEdges(br)[3]];
        const counts = new Map();
        for (const c of inner) counts.set(c, (counts.get(c) || 0) + 1);
        const candidates = [...counts.entries()]
          .filter(([c, n]) => n >= 2 && !state.used[c])
          .sort((a, b) => b[1] - a[1]);
        state.completed[sk] = true;
        if (!candidates.length) continue;
        const color = candidates[0][0];
        state.used[color] = true;
        state.blossoms.push({ x: sx + 0.5, y: sy + 0.5, color });
        state.message = `${blossom(color).name} opens in the rain.`;
        const p = boardToNorm(sx + 0.5, sy + 0.5);
        emitEvent("blossom", p.x, p.y, tileColor(color));
      }
    }

    function placeTile(id, x, y) {
      const current = currentFor(id);
      if (!current || state.over || !legalAt(x, y, current)) return;
      state.board[key(x, y)] = { tile: current.tile, rot: current.rot || 0, owner: id, turn: state.turn++ };
      const p = boardToNorm(x, y);
      emitEvent("place", p.x, p.y, "#dff9ff");
      tryCompleteSquares(x, y);
      state.currentByPlayer[id] = null;
      drawForPlayer(id);
      checkEnd();
    }

    function swapTile(id) {
      const current = currentFor(id);
      const hand = state.hands[id] || [];
      if (!current?.tile || !hand.length || state.over) return;
      hand.push(current.tile);
      state.currentByPlayer[id] = { tile: hand.shift(), rot: 0 };
      state.hands[id] = hand;
      state.message = "The tile slips back into your stack and another rises from the rain.";
      emitEvent("draw", 0.18, 0.84, "#b7d7ff");
    }

    function maybeEnjoymentMessage() {
      if (state.over || Math.random() > ENJOYMENT_MESSAGE_CHANCE) return;
      const message = ENJOYMENT_MESSAGES[Math.floor(Math.random() * ENJOYMENT_MESSAGES.length)];
      if (message && message !== state.message) state.message = message;
    }

    function easeOutCubic(t) { return 1 - Math.pow(1 - clamp(t, 0, 1), 3); }

    function startDrawAnimation(tile) {
      if (!tile || !ui.deck || !ui.handTile) return;
      drawAnim = { tileId: tile.id, start: now(), duration: 420 };
    }

    function handleAction(id, input) {
      if (!isHost() || !input || typeof input !== "object") return;
      if (input.type === "rotate" && currentFor(id) && !state.over) {
        const current = currentFor(id);
        current.rot = ((current.rot || 0) + 1) % 4;
        state.message = "The tile turns softly in your hands.";
      } else if (input.type === "place") {
        placeTile(id, Math.round(input.x), Math.round(input.y));
        if (id === myId) startDrawAnimation(currentFor(id)?.tile);
      } else if (input.type === "swap") {
        swapTile(id);
        if (id === myId) startDrawAnimation(currentFor(id)?.tile);
      } else if (input.type === "reset") {
        resetHostState();
      }
      if (input.type === "rotate" || input.type === "place") maybeEnjoymentMessage();
      host.broadcastState(makeSnapshot());
    }

    function sendAction(input) {
      if (isHost()) handleAction(myId, input);
      else host.sendInput(input);
    }

    function rotateCurrent() {
      const current = currentFor();
      if (!current?.tile || state.over) return;
      if (!isHost()) {
        current.rot = ((current.rot || 0) + 1) % 4;
        if (drag?.tile === current.tile) drag.rot = current.rot;
      }
      sendAction({ type: "rotate" });
      if (isHost() && drag?.tile === current.tile) drag.rot = current.rot || 0;
    }

    function score() {
      const placed = Object.keys(state.used).length;
      return placed >= BLOSSOMS.length ? placed + remainingTiles() : placed;
    }

    function makeSnapshot() {
      return {
        full: true,
        board: state.board,
        deck: state.deck,
        hands: state.hands,
        currentByPlayer: state.currentByPlayer,
        blossoms: state.blossoms,
        used: state.used,
        completed: state.completed,
        turn: state.turn,
        over: state.over,
        won: state.won,
        message: state.message,
        events: events.slice(-16),
      };
    }

    function currentSnapshot() { return makeSnapshot(); }

    function timedSnapshot() {
      const start = now();
      const snapshot = makeSnapshot();
      perf.snapshotMs += now() - start;
      perf.snapshots++;
      return snapshot;
    }

    function logPerf(ts) {
      if (ts - lastPerfLogAt < PERF_LOG_INTERVAL_MS) return;
      if (lastPerfLogAt) {
        const seconds = (ts - lastPerfLogAt) / 1000;
        console.debug("Gentle Rain perf", {
          fps: Math.round(perf.frames / seconds),
          drawMsPerFrame: +(perf.drawMs / Math.max(1, perf.frames)).toFixed(2),
          effectsMsPerFrame: +(perf.effectsMs / Math.max(1, perf.frames)).toFixed(2),
          snapshotMsPerSnapshot: +(perf.snapshotMs / Math.max(1, perf.snapshots)).toFixed(2),
          snapshotsPerSecond: +(perf.snapshots / seconds).toFixed(1),
          remotePeers: host.getPlayers().filter((p) => p.id !== myId).length,
        });
      }
      lastPerfLogAt = ts;
      perf.frames = 0;
      perf.drawMs = 0;
      perf.effectsMs = 0;
      perf.snapshotMs = 0;
      perf.snapshots = 0;
    }

    function applySnapshot(snapshot) {
      if (!snapshot) return;
      state.board = snapshot.board || {};
      state.deck = snapshot.deck || [];
      state.hands = snapshot.hands || {};
      state.currentByPlayer = snapshot.currentByPlayer || {};
      state.blossoms = snapshot.blossoms || [];
      state.used = snapshot.used || {};
      state.completed = snapshot.completed || {};
      state.turn = snapshot.turn || 1;
      state.over = !!snapshot.over;
      state.won = !!snapshot.won;
      state.message = snapshot.message || "Listen to the rain and place the next tile.";
      applyEvents(snapshot.events);
    }

    function ensureCanvasSize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const changed = lastCssWidth !== rect.width || lastCssHeight !== rect.height;
      lastCssWidth = rect.width;
      lastCssHeight = rect.height;
      return !changed || rect.width > 0;
    }

    function resize() { ensureCanvasSize(); }

    function boardBounds() {
      const pts = Object.keys(state.board).map(parseKey);
      for (const p of Object.keys(state.board).map(parseKey)) {
        for (const d of DIRS) pts.push({ x: p.x + d.dx, y: p.y + d.dy });
      }
      for (const b of state.blossoms) pts.push({ x: Math.floor(b.x), y: Math.floor(b.y) });
      if (!pts.length) return { minX: -2, maxX: 2, minY: -2, maxY: 2 };
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      return { minX: minX - 1, maxX: maxX + 1, minY: minY - 1, maxY: maxY + 1 };
    }

    function layout(W, H) {
      const top = Math.max(112, Math.min(144, H * 0.20));
      const handH = Math.max(170, Math.min(218, H * 0.30));
      const margin = Math.max(12, Math.min(22, W * 0.04));
      const board = { x: margin, y: top, w: W - margin * 2, h: H - top - handH - margin };
      const bounds = boardBounds();
      const cols = bounds.maxX - bounds.minX + 1;
      const rows = bounds.maxY - bounds.minY + 1;
      const cell = Math.max(24, Math.min(board.w / cols, board.h / rows));
      const cx = board.x + board.w / 2 + view.panX;
      const cy = board.y + board.h / 2 + view.panY;
      const handTileSize = Math.min(112, Math.max(78, handH - 88));
      const handTileY = H - handH + 72;
      ui = {
        board,
        hand: { x: margin, y: H - handH + 10, w: W - margin * 2, h: handH - 18 },
        deck: { x: margin + 24, y: handTileY, w: handTileSize, h: handTileSize },
        handTile: { x: W - margin - handTileSize - 24, y: handTileY, w: handTileSize, h: handTileSize },
        reset: { x: margin, y: 52, w: 84, h: 32 },
        cells: new Map(),
        scale: cell,
        bounds,
        view: { cx, cy, baseScale: cell, scale: cell * view.zoom, rot: view.rot },
      };
      return ui;
    }

    function gridToScreen(x, y) {
      const { bounds } = ui;
      const v = ui.view;
      const gx = x - (bounds.minX + bounds.maxX + 1) / 2;
      const gy = y - (bounds.minY + bounds.maxY + 1) / 2;
      const c = Math.cos(v.rot), s = Math.sin(v.rot);
      return {
        x: v.cx + (gx * c - gy * s) * v.scale,
        y: v.cy + (gx * s + gy * c) * v.scale,
      };
    }

    function screenToGrid(px, py) {
      const { bounds } = ui;
      const v = ui.view;
      const dx = (px - v.cx) / v.scale;
      const dy = (py - v.cy) / v.scale;
      const c = Math.cos(-v.rot), s = Math.sin(-v.rot);
      return {
        x: dx * c - dy * s + (bounds.minX + bounds.maxX + 1) / 2,
        y: dx * s + dy * c + (bounds.minY + bounds.maxY + 1) / 2,
      };
    }

    function resetBoardView() {
      view.zoom = 1;
      view.rot = 0;
      view.panX = 0;
      view.panY = 0;
    }

    function boardToNorm(x, y) {
      const W = Math.max(1, canvas.clientWidth || lastCssWidth || 1);
      const H = Math.max(1, canvas.clientHeight || lastCssHeight || 1);
      const p = gridToScreen(x, y);
      return { x: clamp(p.x / W, 0, 1), y: clamp(p.y / H, 0, 1) };
    }

    function pointIn(r, x, y) { return r && x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h; }

    function screenCell(px, py) {
      const g = screenToGrid(px, py);
      const p = { x: Math.floor(g.x), y: Math.floor(g.y) };
      return ui.cells.has(key(p.x, p.y)) ? p : null;
    }

    function nearestEmptyCell(px, py, maxDist = Infinity) {
      let best = null;
      let bestD = maxDist;
      for (const [k, r] of ui.cells) {
        if (state.board[k]) continue;
        const cx = r.x;
        const cy = r.y;
        const d = Math.hypot(px - cx, py - cy);
        if (d < bestD) { bestD = d; best = parseKey(k); }
      }
      return best;
    }

    function drawRoundRect(x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    function drawBackground(W, H) {
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "#10283a");
      grad.addColorStop(0.45, "#173d4d");
      grad.addColorStop(1, "#0d202d");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.strokeStyle = "#d8f2ff";
      ctx.lineWidth = 1;
      for (let y = 40; y < H; y += 34) {
        ctx.beginPath();
        for (let x = -20; x <= W + 20; x += 18) {
          const yy = y + Math.sin((x + now() * 0.018) / 38) * 4;
          if (x === -20) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.restore();

      while (drops.length < Math.min(90, Math.floor(W * H / 7200))) drops.push({ x: Math.random() * W, y: Math.random() * H, s: rand(0.5, 1.6), v: rand(24, 56) });
      ctx.strokeStyle = "rgba(216,242,255,0.22)";
      ctx.lineWidth = 1;
      for (const d of drops) {
        d.y += d.v / 60;
        d.x += d.s * 0.08;
        if (d.y > H + 12) { d.y = -12; d.x = Math.random() * W; }
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.s * 1.6, d.y + d.s * 8);
        ctx.stroke();
      }
    }

    function drawHeader(W) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const titleGrad = ctx.createLinearGradient(W * 0.25, 10, W * 0.75, 58);
      titleGrad.addColorStop(0, "#d3fff4");
      titleGrad.addColorStop(0.55, "#b6ddff");
      titleGrad.addColorStop(1, "#e6c8ff");
      ctx.font = "700 30px Georgia, 'Times New Roman', serif";
      ctx.shadowColor = "rgba(201,236,255,0.42)";
      ctx.shadowBlur = 14;
      ctx.fillStyle = titleGrad;
      ctx.fillText("A Gentle Rain", W / 2, 34);
      ctx.shadowBlur = 0;
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillStyle = "rgba(233,249,255,0.82)";
      ctx.fillText(`${Object.keys(state.used).length}/8 blossoms · ${remainingTiles()} tiles unplaced · score ${score()}`, W / 2, 64);
      drawButton(ui.reset, "Reset", "#21495c", true);
      drawPlayerStrip(W);
    }

    function drawPlayerStrip(W) {
      const players = host.getPlayers();
      const totalW = Math.min(W - 120, players.length * 82);
      let x = W / 2 - totalW / 2;
      for (const p of players) {
        const count = playerTileCount(p.id);
        ctx.save();
        ctx.fillStyle = p.id === myId ? "rgba(163,231,221,0.24)" : "rgba(8,20,30,0.36)";
        drawRoundRect(x, 82, 72, 28, 14);
        ctx.fill();
        ctx.strokeStyle = "rgba(216,242,255,0.16)";
        ctx.stroke();
        ctx.fillStyle = p.color || "#8ce8bc";
        ctx.beginPath(); ctx.arc(x + 18, 96, 10, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#10202b";
        ctx.font = "13px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(p.icon || "●", x + 18, 96);
        ctx.fillStyle = "#eafff8";
        ctx.font = "800 13px system-ui, sans-serif";
        ctx.fillText(String(count), x + 48, 96);
        ctx.restore();
        x += 82;
      }
    }

    function drawTile(tile, rot, x, y, size, alpha = 1, owner = null) {
      const edges = rotatedEdges(tile, rot || 0);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(49,103,102,0.96)";
      drawRoundRect(x, y, size, size, size * 0.10);
      ctx.fill();
      const water = ctx.createRadialGradient(x + size * 0.35, y + size * 0.28, size * 0.08, x + size * 0.5, y + size * 0.5, size * 0.76);
      water.addColorStop(0, "rgba(48,132,139,0.96)");
      water.addColorStop(0.52, "rgba(18,92,111,0.98)");
      water.addColorStop(1, "rgba(8,55,81,0.99)");
      ctx.fillStyle = water;
      drawRoundRect(x + size * 0.055, y + size * 0.055, size * 0.89, size * 0.89, size * 0.08);
      ctx.fill();

      ctx.strokeStyle = "rgba(189,245,232,0.20)";
      ctx.lineWidth = Math.max(1, size * 0.018);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.ellipse(x + size * (0.5 + i * 0.06 - 0.06), y + size * (0.48 + i * 0.035), size * (0.20 + i * 0.05), size * 0.07, -0.35, 0, Math.PI * 2);
        ctx.stroke();
      }

      drawPondScatter(tile.id, x, y, size);
      drawMotif(tile.motif, x, y, size);
      drawEdgeFlower(x + size / 2, y, edges[0], 0, size);
      drawEdgeFlower(x + size, y + size / 2, edges[1], Math.PI / 2, size);
      drawEdgeFlower(x + size / 2, y + size, edges[2], Math.PI, size);
      drawEdgeFlower(x, y + size / 2, edges[3], -Math.PI / 2, size);
      if (owner) {
        const p = profile(owner);
        ctx.fillStyle = p.color || "#ffffff";
        ctx.beginPath();
        ctx.arc(x + size * 0.82, y + size * 0.18, size * 0.105, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#10202b";
        ctx.font = `${Math.max(10, size * 0.13)}px serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(p.icon || "●", x + size * 0.82, y + size * 0.18);
      }
      ctx.restore();
    }

    function drawTileBack(x, y, size, alpha = 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      const grad = ctx.createLinearGradient(x, y, x + size, y + size);
      grad.addColorStop(0, "#d6f3ee");
      grad.addColorStop(0.45, "#7bb9bb");
      grad.addColorStop(1, "#234c62");
      ctx.fillStyle = grad;
      drawRoundRect(x, y, size, size, size * 0.10);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.48)";
      ctx.lineWidth = Math.max(1, size * 0.018);
      ctx.stroke();
      ctx.fillStyle = "rgba(9,45,61,0.34)";
      drawRoundRect(x + size * 0.11, y + size * 0.11, size * 0.78, size * 0.78, size * 0.08);
      ctx.fill();
      ctx.strokeStyle = "rgba(234,255,248,0.50)";
      ctx.lineWidth = Math.max(1, size * 0.014);
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(x + size / 2, y + size / 2, size * (0.16 + i * 0.066), Math.PI * 0.18, Math.PI * 1.82);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawDeckStack() {
      const r = ui.deck;
      const count = (state.hands[myId]?.length || 0);
      const layers = Math.min(9, Math.max(1, count));
      ctx.save();
      for (let i = layers - 1; i >= 0; i--) {
        const off = i * 2.2;
        drawTileBack(r.x + off, r.y - off, r.w - 14, count ? 0.92 : 0.34);
      }
      ctx.fillStyle = "#eafff8";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "900 20px system-ui, sans-serif";
      ctx.fillText(String(count), r.x + r.w / 2 - 6, r.y + r.h / 2 - 4);
      ctx.restore();
    }

    function tileSeed(id) {
      let n = 0;
      for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0;
      return n || 1;
    }

    function seeded(seed, i) {
      let n = (seed + i * 0x9e3779b9) >>> 0;
      n ^= n << 13; n ^= n >>> 17; n ^= n << 5;
      return ((n >>> 0) % 10000) / 10000;
    }

    function drawPondScatter(id, x, y, size) {
      const seed = tileSeed(id);
      const count = size > 58 ? 5 : 4;
      for (let i = 0; i < count; i++) {
        const px = x + size * (0.18 + seeded(seed, i * 4) * 0.64);
        const py = y + size * (0.18 + seeded(seed, i * 4 + 1) * 0.64);
        const s = size * (0.045 + seeded(seed, i * 4 + 2) * 0.035);
        const a = seeded(seed, i * 4 + 3) * Math.PI * 2;
        if (i % 5 === 0) drawMiniLilyPad(px, py, s * 1.9, a);
        else if (i % 5 === 1) drawMiniKoi(px, py, s * 1.25, a);
        else if (i % 5 === 2) drawMiniTurtle(px, py, s * 1.25, a);
        else if (i % 5 === 3) drawMiniDragonfly(px, py, s * 1.15, a);
        else drawMiniLilyPad(px, py, s * 1.6, a);
      }
    }

    function drawMotif(motif, x, y, size) {
      ctx.save();
      ctx.translate(x + size * 0.5, y + size * 0.52);
      if (motif === "koi") {
        drawMiniKoi(0, 0, size * 0.15, -0.55);
      } else if (motif === "turtle") {
        drawMiniTurtle(0, 0, size * 0.17, 0.2);
      } else if (motif === "dragonfly") {
        drawMiniDragonfly(0, 0, size * 0.17, -0.18);
      } else {
        drawMiniLilyPad(-size * 0.06, size * 0.02, size * 0.18, -0.55);
        drawMiniLilyPad(size * 0.12, -size * 0.08, size * 0.12, 0.85);
      }
      ctx.restore();
    }

    function drawMiniLilyPad(x, y, r, angle) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = "rgba(77,174,113,0.76)";
      ctx.strokeStyle = "rgba(184,241,182,0.48)";
      ctx.lineWidth = Math.max(0.7, r * 0.10);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, 0.42, Math.PI * 1.86);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "rgba(24,91,67,0.45)";
      ctx.lineWidth = Math.max(0.6, r * 0.055);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r * 0.72, -r * 0.18); ctx.stroke();
      ctx.restore();
    }

    function drawMiniKoi(x, y, s, angle) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = "rgba(255,225,186,0.88)";
      ctx.beginPath(); ctx.ellipse(0, 0, s * 1.35, s * 0.58, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(236,92,57,0.86)";
      ctx.beginPath(); ctx.ellipse(-s * 0.24, -s * 0.10, s * 0.45, s * 0.24, -0.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s * 1.22, 0); ctx.lineTo(-s * 1.88, -s * 0.44); ctx.lineTo(-s * 1.72, 0); ctx.lineTo(-s * 1.88, s * 0.44); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(24,34,33,0.72)";
      ctx.beginPath(); ctx.arc(s * 0.86, -s * 0.14, Math.max(1, s * 0.12), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function drawMiniTurtle(x, y, s, angle) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = "rgba(83,151,96,0.82)";
      ctx.beginPath(); ctx.ellipse(0, 0, s * 1.12, s * 0.82, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(126,190,115,0.80)";
      ctx.beginPath(); ctx.arc(s * 1.10, 0, s * 0.34, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(47,112,78,0.78)";
      for (const p of [[-0.62, -0.65], [-0.62, 0.65], [0.48, -0.65], [0.48, 0.65]]) {
        ctx.beginPath(); ctx.ellipse(s * p[0], s * p[1], s * 0.34, s * 0.20, p[1] > 0 ? 0.65 : -0.65, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = "rgba(217,249,186,0.38)";
      ctx.lineWidth = Math.max(0.6, s * 0.10);
      ctx.beginPath(); ctx.moveTo(-s * 0.58, 0); ctx.lineTo(s * 0.58, 0); ctx.moveTo(0, -s * 0.58); ctx.lineTo(0, s * 0.58); ctx.stroke();
      ctx.restore();
    }

    function drawMiniDragonfly(x, y, s, angle) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = "rgba(198,244,255,0.42)";
      for (const p of [[-0.34, -0.48, -0.48], [0.34, -0.48, 0.48], [-0.28, 0.45, 0.45], [0.28, 0.45, -0.45]]) {
        ctx.beginPath(); ctx.ellipse(s * p[0], s * p[1], s * 0.48, s * 0.20, p[2], 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = "rgba(150,235,225,0.82)";
      ctx.lineWidth = Math.max(0.8, s * 0.13);
      ctx.beginPath(); ctx.moveTo(0, -s * 0.82); ctx.lineTo(0, s * 0.88); ctx.stroke();
      ctx.fillStyle = "rgba(42,92,90,0.84)";
      ctx.beginPath(); ctx.arc(0, -s * 0.95, s * 0.20, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function drawEdgeFlower(cx, cy, colorKey, angle, size) {
      const def = blossom(colorKey);
      const radius = size * 0.44;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.rect(-radius, 0, radius * 2, radius * 1.08);
      ctx.clip();
      drawFlowerPetals(def, size);
      ctx.strokeStyle = "rgba(255,255,255,0.34)";
      ctx.lineWidth = Math.max(1, size * 0.012);
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.83, 0, Math.PI);
      ctx.stroke();
      ctx.fillStyle = def.center;
      ctx.beginPath();
      if (def.design === "iris") ctx.ellipse(0, 0, size * 0.050, size * 0.084, 0, 0, Math.PI * 2);
      else if (def.design === "orchid") ctx.ellipse(0, 0, size * 0.088, size * 0.056, 0, 0, Math.PI * 2);
      else ctx.arc(0, 0, size * (def.design === "poppy" ? 0.082 : 0.068), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(40,31,26,0.35)";
      ctx.lineWidth = Math.max(0.8, size * 0.007);
      ctx.stroke();
      if (def.design === "anemone") drawStamens(size, 12, "#eaf6ff", 0.12);
      else if (def.design === "poppy") drawStamens(size, 10, "#2b1d1b", 0.11);
      else if (def.design === "aster") drawStamens(size, 13, "#fff4b5", 0.12);
      else drawStamens(size, 6, "rgba(255,255,225,0.70)", 0.09);
      ctx.strokeStyle = "rgba(255,255,255,0.72)";
      ctx.lineWidth = Math.max(1, size * 0.010);
      ctx.beginPath();
      ctx.moveTo(-radius, 0);
      ctx.lineTo(radius, 0);
      ctx.stroke();
      ctx.restore();
    }

    function drawFlowerPetals(def, size) {
      if (def.design === "lotus") {
        drawPetalRing(def, size, 12, 0.074, 0.315, "point", 0);
        drawPetalRing(def, size, 8, 0.060, 0.215, "round", Math.PI / 8);
      } else if (def.design === "iris") {
        drawPetalRing(def, size, 6, 0.070, 0.300, "point", 0);
        drawPetalRing(def, size, 6, 0.060, 0.185, "wide", Math.PI / 6);
      } else if (def.design === "lily") {
        drawPetalRing(def, size, 6, 0.072, 0.355, "long", 0);
        drawPetalRing(def, size, 6, 0.050, 0.250, "point", Math.PI / 6);
      } else if (def.design === "clover") {
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI / 2;
          drawPetalAt(Math.cos(a) * 0.112, Math.sin(a) * 0.112, a, size, def, 0.118, 0.178, "heart");
        }
      } else if (def.design === "anemone") {
        drawPetalRing(def, size, 16, 0.050, 0.250, "round", 0);
        drawPetalRing(def, size, 16, 0.034, 0.180, "round", Math.PI / 16);
      } else if (def.design === "poppy") {
        drawPetalRing(def, size, 5, 0.150, 0.255, "wide", Math.PI / 10);
        drawPetalRing(def, size, 5, 0.094, 0.185, "wide", Math.PI / 5);
      } else if (def.design === "aster") {
        drawPetalRing(def, size, 22, 0.024, 0.330, "needle", 0);
        drawPetalRing(def, size, 22, 0.020, 0.235, "needle", Math.PI / 22);
      } else if (def.design === "orchid") {
        drawPetalRing(def, size, 3, 0.110, 0.310, "long", -Math.PI / 2);
        drawPetalRing(def, size, 3, 0.074, 0.205, "round", Math.PI / 2);
      }
    }

    function drawPetalRing(def, size, count, width, length, shape, offset) {
      for (let i = 0; i < count; i++) {
        const a = offset + i * Math.PI * 2 / count;
        drawPetalAt(Math.cos(a) * 0.062, Math.sin(a) * 0.062, a, size, def, width, length, shape);
      }
    }

    function drawPetalFan(def, size, count, width, length, shape, offset) {
      for (let i = 0; i < count; i++) {
        const a = offset + i * Math.PI / Math.max(1, count - 1);
        drawPetalAt(Math.cos(a) * 0.088, Math.sin(a) * 0.088, a, size, def, width, length, shape);
      }
    }

    function drawPetalAt(nx, ny, angle, size, def, width, length, shape) {
      ctx.save();
      ctx.translate(nx * size, ny * size);
      ctx.rotate(angle + Math.PI / 2);
      ctx.fillStyle = def.color;
      ctx.strokeStyle = "rgba(255,255,255,0.68)";
      ctx.lineWidth = Math.max(0.7, size * 0.008);
      ctx.beginPath();
      if (shape === "point" || shape === "needle") {
        ctx.moveTo(0, -length * size * 0.06);
        ctx.quadraticCurveTo(width * size, length * size * 0.30, 0, length * size);
        ctx.quadraticCurveTo(-width * size, length * size * 0.30, 0, -length * size * 0.06);
      } else if (shape === "heart") {
        ctx.moveTo(0, length * size);
        ctx.bezierCurveTo(width * size, length * size * 0.72, width * size, length * size * 0.18, 0, length * size * 0.28);
        ctx.bezierCurveTo(-width * size, length * size * 0.18, -width * size, length * size * 0.72, 0, length * size);
      } else {
        ctx.ellipse(0, length * size * 0.48, width * size, length * size * 0.52, 0, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    function drawStamens(size, count, color, length = 0.07) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(0.8, size * 0.006);
      for (let i = 0; i < count; i++) {
        const a = (i + 0.5) * Math.PI / count;
        const x = Math.cos(a) * size * length;
        const y = Math.sin(a) * size * length;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, size * 0.008, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function drawBoard() {
      const current = currentFor();
      const legal = new Set(legalCellsFor(current).map((p) => key(p.x, p.y)));
      const hoverKey = drag?.hover && legalAt(drag.hover.x, drag.hover.y, current) ? key(drag.hover.x, drag.hover.y) : null;
      ctx.save();
      ctx.fillStyle = "rgba(227,249,255,0.045)";
      drawRoundRect(ui.board.x, ui.board.y, ui.board.w, ui.board.h, 22);
      ctx.fill();
      ui.cells.clear();

      const entries = Object.entries(state.board).sort((a, b) => (a[1].turn || 0) - (b[1].turn || 0));
      for (const [k, cell] of entries) {
        const { x, y } = parseKey(k);
        const p = gridToScreen(x, y);
        ui.cells.set(k, { x: p.x, y: p.y, w: ui.view.scale, h: ui.view.scale });
        drawBoardTile(cell.tile, cell.rot, p.x, p.y, ui.view.scale - 2, 1, cell.owner !== "system" ? cell.owner : null);
      }

      for (const k of legal) {
        const { x, y } = parseKey(k);
        const p = gridToScreen(x, y);
        ui.cells.set(k, { x: p.x, y: p.y, w: ui.view.scale, h: ui.view.scale });
        if (k !== hoverKey) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(ui.view.rot);
        ctx.fillStyle = "rgba(211,255,244,0.26)";
        ctx.strokeStyle = "rgba(235,255,249,0.92)";
        ctx.lineWidth = 3;
        drawRoundRect(-ui.view.scale / 2 + 4, -ui.view.scale / 2 + 4, ui.view.scale - 8, ui.view.scale - 8, ui.view.scale * 0.10);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        if (current?.tile) drawBoardTile(current.tile, current.rot || 0, p.x, p.y, ui.view.scale - 2, 0.28, null);
      }

      for (const b of state.blossoms) {
        const p = gridToScreen(b.x, b.y);
        const r = ui.scale * 0.20;
        ctx.fillStyle = "rgba(55,42,31,0.62)";
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.25, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = tileColor(b.color);
        for (let i = 0; i < 6; i++) {
          const a = i * Math.PI / 3;
          ctx.beginPath();
          ctx.ellipse(p.x + Math.cos(a) * r * 0.45, p.y + Math.sin(a) * r * 0.45, r * 0.52, r * 0.25, a, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = "#fff3bd";
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.24, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    function drawBoardTile(tile, rot, cx, cy, size, alpha, owner) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ui.view.rot);
      drawTile(tile, rot, -size / 2, -size / 2, size, alpha, owner);
      ctx.restore();
    }

    function drawButton(r, label, color, enabled = true) {
      ctx.save();
      ctx.globalAlpha = enabled ? 1 : 0.45;
      ctx.fillStyle = color;
      drawRoundRect(r.x, r.y, r.w, r.h, 14);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.stroke();
      ctx.fillStyle = "#effcff";
      ctx.font = "800 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
      ctx.restore();
    }

    function drawHand(W) {
      const h = ui.hand;
      ctx.fillStyle = "rgba(8,20,30,0.52)";
      drawRoundRect(h.x, h.y, h.w, h.h, 22);
      ctx.fill();
      ctx.strokeStyle = "rgba(216,242,255,0.13)";
      ctx.stroke();

      drawHandMessage(h);

      const current = currentFor();
      if (drag?.tile) drawHandTileSlot(true);
      if (current?.tile && !drag) {
        const size = ui.handTile.w;
        drawAnimatedActiveTile(current.tile, current.rot || 0, ui.handTile.x, ui.handTile.y, size);
      } else {
        drawHandTileSlot(false);
        ctx.font = "700 18px Georgia, serif";
        ctx.fillStyle = state.won ? "#d3fff4" : "#d9eaff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(state.won ? "The lake is blooming." : "No active tile.", ui.handTile.x + ui.handTile.w / 2, ui.handTile.y + ui.handTile.h / 2);
      }

      drawDeckStack();
      if (drag?.tile) drawTile(drag.tile, drag.rot || 0, drag.x - drag.size / 2, drag.y - drag.size / 2, drag.size, 0.92, null);
    }

    function drawHandTileSlot(active) {
      const r = ui.handTile;
      ctx.save();
      ctx.strokeStyle = active ? "rgba(235,255,249,0.76)" : "rgba(216,242,255,0.24)";
      ctx.lineWidth = active ? 3 : 2;
      ctx.setLineDash([8, 7]);
      drawRoundRect(r.x, r.y, r.w, r.h, r.w * 0.10);
      ctx.stroke();
      ctx.restore();
    }

    function drawHandMessage(h) {
      const text = state.message || "";
      const t = now();
      if (handMessage.text !== text) {
        handMessage.previous = handMessage.text;
        handMessage.text = text;
        handMessage.changedAt = t;
      }
      const p = clamp((t - handMessage.changedAt) / handMessage.duration, 0, 1);
      const oldAlpha = handMessage.previous && p < 0.5 ? 1 - p * 2 : 0;
      const newAlpha = p < 0.5 ? 0 : (p - 0.5) * 2;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "700 14px system-ui, sans-serif";
      const maxWidth = Math.max(160, h.w - 48);
      if (oldAlpha > 0) {
        ctx.globalAlpha = oldAlpha;
        ctx.fillStyle = "rgba(239,252,255,0.88)";
        ctx.fillText(handMessage.previous, h.x + h.w / 2, h.y + 26, maxWidth);
      }
      ctx.globalAlpha = handMessage.changedAt ? newAlpha : 1;
      ctx.fillStyle = "rgba(239,252,255,0.88)";
      ctx.fillText(handMessage.text, h.x + h.w / 2, h.y + 26, maxWidth);
      ctx.restore();
    }

    function drawAnimatedActiveTile(tile, rot, x, y, size) {
      let scaleX = 1;
      let alpha = 1;
      if (drawAnim?.tileId === tile.id) {
        const t = (now() - drawAnim.start) / drawAnim.duration;
        if (t >= 1) drawAnim = null;
        else {
          const e = easeOutCubic(t);
          const sx = ui.deck.x + ui.deck.w / 2 - size / 2;
          const sy = ui.deck.y + ui.deck.h / 2 - size / 2;
          x = sx + (x - sx) * e;
          y = sy + (y - sy) * e;
          scaleX = Math.abs(Math.cos(t * Math.PI));
          alpha = 0.72 + e * 0.28;
          if (t < 0.5) { drawTileBack(x, y, size, alpha); return; }
        }
      }
      ctx.save();
      ctx.translate(x + size / 2, y + size / 2);
      ctx.scale(Math.max(0.14, scaleX), 1);
      drawTile(tile, rot, -size / 2, -size / 2, size, alpha, null);
      ctx.restore();
    }

    function updateEffects(dt, W, H) {
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        r.life -= dt;
        if (r.life <= 0) ripples.splice(i, 1);
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        p.x += p.vx * dt / 16;
        p.y += p.vy * dt / 16;
        p.vy += 0.0009 * dt;
        if (p.life <= 0) particles.splice(i, 1);
      }
      if (particles.length > 180) particles.splice(0, particles.length - 180);
    }

    function drawEffects(W, H) {
      ctx.save();
      for (const r of ripples) {
        const a = Math.max(0, r.life / r.maxLife);
        ctx.strokeStyle = `rgba(220,248,255,${a * 0.30})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x * W, r.y * H, (1 - a) * 44 + 8, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (const p of particles) {
        const a = Math.max(0, p.life / p.maxLife);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, p.size * a, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function draw() {
      if (!ensureCanvasSize()) return;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      layout(W, H);
      ctx.clearRect(0, 0, W, H);
      drawBackground(W, H);
      drawHeader(W);
      drawBoard();
      drawEffects(W, H);
      drawHand(W);
    }

    function pointerPoint(e) {
      const r = canvas.getBoundingClientRect();
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
      return { x: touch.clientX - r.left, y: touch.clientY - r.top };
    }

    function eventPoint(e) {
      if (e.offsetX !== undefined && e.offsetY !== undefined) return { x: e.offsetX, y: e.offsetY };
      return pointerPoint(e);
    }

    function pointerEntry(e) {
      const p = pointerPoint(e);
      return { x: p.x, y: p.y };
    }

    function gestureMetrics(points) {
      const a = points[0], b = points[1];
      return {
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }

    function startBoardGesture() {
      if (drag) return;
      const points = [...activePointers.values()];
      if (!points.length) return;
      if (points.length >= 2) {
        const g = gestureMetrics(points);
        boardGesture = { mode: "pinch", start: g, zoom: view.zoom, rot: view.rot, panX: view.panX, panY: view.panY };
      } else {
        const p = points[0];
        boardGesture = { mode: "pan", x: p.x, y: p.y, panX: view.panX, panY: view.panY };
      }
    }

    function updateBoardGesture() {
      if (!boardGesture || drag) return;
      const points = [...activePointers.values()];
      if (points.length >= 2) {
        if (boardGesture.mode !== "pinch") startBoardGesture();
        const g = gestureMetrics(points);
        view.zoom = clamp(boardGesture.zoom * (g.dist / boardGesture.start.dist), 0.55, 3.2);
        view.rot = boardGesture.rot + g.angle - boardGesture.start.angle;
        view.panX = boardGesture.panX + g.cx - boardGesture.start.cx;
        view.panY = boardGesture.panY + g.cy - boardGesture.start.cy;
      } else if (points.length === 1) {
        if (boardGesture.mode !== "pan") startBoardGesture();
        const p = points[0];
        view.panX = boardGesture.panX + p.x - boardGesture.x;
        view.panY = boardGesture.panY + p.y - boardGesture.y;
      }
    }

    function onPointerDown(e) {
      const p = pointerPoint(e);
      activePointers.set(e.pointerId ?? "mouse", pointerEntry(e));
      if (drag && activePointerId !== null && e.pointerId !== activePointerId) {
        e.preventDefault();
        rotateCurrent();
        return;
      }
      if (pointIn(ui.reset, p.x, p.y)) { e.preventDefault(); sendAction({ type: "reset" }); return; }
      if (pointIn(ui.deck, p.x, p.y)) { e.preventDefault(); sendAction({ type: "swap" }); return; }
      const current = currentFor();
      if (current?.tile && pointIn(ui.handTile, p.x, p.y)) {
        e.preventDefault();
        activePointerId = e.pointerId ?? null;
        canvas.setPointerCapture?.(activePointerId);
        drag = { tile: current.tile, rot: current.rot || 0, x: p.x, y: p.y, startX: p.x, startY: p.y, size: Math.max(24, ui.view.scale - 2), hover: null };
        return;
      }
      if (pointIn(ui.board, p.x, p.y)) {
        e.preventDefault();
        const t = now();
        if (t - lastTapAt < 320) resetBoardView();
        lastTapAt = t;
        startBoardGesture();
      }
    }

    function onPointerMove(e) {
      if (activePointers.has(e.pointerId ?? "mouse")) activePointers.set(e.pointerId ?? "mouse", pointerEntry(e));
      if (!drag) {
        updateBoardGesture();
        if (boardGesture) e.preventDefault();
        return;
      }
      if (activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) return;
      e.preventDefault();
      const p = pointerPoint(e);
      drag.x = p.x;
      drag.y = p.y;
      drag.hover = pointIn(ui.deck, p.x, p.y) ? null : nearestEmptyCell(p.x, p.y, ui.view.scale * 0.46);
    }

    function onPointerUp(e) {
      if (drag && activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) {
        e.preventDefault();
        activePointers.delete(e.pointerId ?? "mouse");
        return;
      }
      const hover = drag?.hover;
      const p = pointerPoint(e);
      const moved = drag ? Math.hypot(p.x - drag.startX, p.y - drag.startY) : 0;
      if (drag && pointIn(ui.deck, p.x, p.y)) sendAction({ type: "swap" });
      else if (hover && legalAt(hover.x, hover.y)) sendAction({ type: "place", x: hover.x, y: hover.y });
      else if (drag && moved < 8 && pointIn(ui.handTile, p.x, p.y)) rotateCurrent();
      drag = null;
      if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
      activePointerId = null;
      activePointers.delete(e.pointerId ?? "mouse");
      if (!activePointers.size) boardGesture = null;
      else startBoardGesture();
    }

    function onKeyDown(e) {
      if (e.key === "r" || e.key === "R" || e.key === " ") { e.preventDefault(); rotateCurrent(); }
      else if (e.key === "d" || e.key === "D") { e.preventDefault(); sendAction({ type: "swap" }); }
      else if (e.key === "q" || e.key === "Q") { e.preventDefault(); view.rot -= Math.PI / 12; }
      else if (e.key === "e" || e.key === "E") { e.preventDefault(); view.rot += Math.PI / 12; }
      else if (e.key === "0") { e.preventDefault(); resetBoardView(); }
    }

    function onContextMenu(e) {
      if (!drag && !currentFor()?.tile) return;
      e.preventDefault();
      rotateCurrent();
    }

    function onWheel(e) {
      const p = eventPoint(e);
      if (!pointIn(ui.board, p.x, p.y) || drag) return;
      e.preventDefault();
      const oldZoom = view.zoom;
      const nextZoom = clamp(view.zoom * Math.exp(-e.deltaY * 0.0014), 0.55, 3.2);
      const k = nextZoom / oldZoom;
      const cx = ui.board.x + ui.board.w / 2;
      const cy = ui.board.y + ui.board.h / 2;
      view.panX = p.x - cx - (p.x - cx - view.panX) * k;
      view.panY = p.y - cy - (p.y - cy - view.panY) * k;
      view.zoom = nextZoom;
    }

    function loop(ts) {
      rafId = requestAnimationFrame(loop);
      if (!lastTs) lastTs = ts;
      const frameMs = ts - lastTs;
      lastTs = ts;
      if (isHost() && hasRemotePeers() && ts - lastSnapshotAt >= 1000 / SNAPSHOT_HZ) {
        lastSnapshotAt = ts;
        host.broadcastState(timedSnapshot());
      }
      if (isHost() && ts - lastValidationAt >= TILE_VALIDATION_INTERVAL_MS) {
        lastValidationAt = ts;
        validateRemainingTiles();
      }
      const effectsStart = now();
      updateEffects(frameMs || 16, canvas.clientWidth, canvas.clientHeight);
      perf.effectsMs += now() - effectsStart;
      const drawStart = now();
      draw();
      perf.drawMs += now() - drawStart;
      perf.frames++;
      logPerf(ts);
    }

    return {
      start() {
        resize();
        if (initialState) applySnapshot(initialState);
        else if (isHost()) resetHostState();
        if (isHost()) reconcileActivePlayerTiles();
        window.addEventListener("resize", resize);
        if (window.PointerEvent) {
          canvas.addEventListener("pointerdown", onPointerDown);
          canvas.addEventListener("pointermove", onPointerMove);
          canvas.addEventListener("pointerup", onPointerUp);
          canvas.addEventListener("pointercancel", onPointerUp);
          canvas.addEventListener("lostpointercapture", onPointerUp);
          canvas.addEventListener("contextmenu", onContextMenu);
          canvas.addEventListener("wheel", onWheel, { passive: false });
        } else {
          canvas.addEventListener("touchstart", onPointerDown, { passive: false });
          window.addEventListener("touchmove", onPointerMove, { passive: false });
          window.addEventListener("touchend", onPointerUp);
          window.addEventListener("touchcancel", onPointerUp);
          canvas.addEventListener("mousedown", onPointerDown);
          window.addEventListener("mousemove", onPointerMove);
          window.addEventListener("mouseup", onPointerUp);
          canvas.addEventListener("contextmenu", onContextMenu);
          canvas.addEventListener("wheel", onWheel, { passive: false });
        }
        window.addEventListener("keydown", onKeyDown);
        rafId = requestAnimationFrame(loop);
      },
      destroy() {
        cancelAnimationFrame(rafId);
        if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
        activePointerId = null;
        window.removeEventListener("resize", resize);
        if (window.PointerEvent) {
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerup", onPointerUp);
          canvas.removeEventListener("pointercancel", onPointerUp);
          canvas.removeEventListener("lostpointercapture", onPointerUp);
          canvas.removeEventListener("contextmenu", onContextMenu);
          canvas.removeEventListener("wheel", onWheel);
        } else {
          canvas.removeEventListener("touchstart", onPointerDown);
          window.removeEventListener("touchmove", onPointerMove);
          window.removeEventListener("touchend", onPointerUp);
          window.removeEventListener("touchcancel", onPointerUp);
          canvas.removeEventListener("mousedown", onPointerDown);
          window.removeEventListener("mousemove", onPointerMove);
          window.removeEventListener("mouseup", onPointerUp);
          canvas.removeEventListener("contextmenu", onContextMenu);
          canvas.removeEventListener("wheel", onWheel);
        }
        window.removeEventListener("keydown", onKeyDown);
      },
      onPeerInput(id, input) { handleAction(id, input); },
      onState(snapshot) { applySnapshot(snapshot); },
      getSnapshot() { return currentSnapshot(); },
      onPlayerList() { if (isHost()) { reconcileActivePlayerTiles(); host.broadcastState(makeSnapshot()); } },
      restart() { if (isHost()) resetHostState(); },
    };
  }

  window.BP2PGames = window.BP2PGames || {};
  window.BP2PGames["gentle-rain"] = {
    id: "gentle-rain",
    name: "A Gentle Rain",
    emoji: "🌧️",
    create,
  };
})();
