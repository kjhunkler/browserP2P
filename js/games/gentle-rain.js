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
    let ctx = canvas.getContext("2d");
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
    const pond = { tileIds: new Set(), entities: [], ripples: [] };
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

    function canonicalTileMap() {
      const tiles = new Map();
      for (const tile of makeTiles()) tiles.set(tile.id, tile);
      return tiles;
    }

    function tileAccountingKey() {
      const keys = (obj) => Object.keys(obj || {}).sort();
      return JSON.stringify({
        deck: (state.deck || []).map((tile) => tile?.id || null),
        hands: keys(state.hands).map((id) => [id, (state.hands[id] || []).map((tile) => tile?.id || null)]),
        current: keys(state.currentByPlayer).map((id) => {
          const current = state.currentByPlayer[id];
          return [id, current?.tile?.id || null, current?.rot || 0];
        }),
      });
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
      const changed = reconcileActivePlayerTiles();
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

    function dealAllRemainingToActivePlayers() {
      const before = tileAccountingKey();
      const ids = sortedPlayers();
      const active = new Set(ids);
      const canonical = canonicalTileMap();
      const placed = placedTileIds();
      const seen = new Set();
      const pool = [];
      const oldHands = state.hands || {};
      const oldCurrentByPlayer = state.currentByPlayer || {};

      function addTile(tile) {
        if (!tile?.id || placed.has(tile.id) || seen.has(tile.id)) return;
        const canonicalTile = canonical.get(tile.id);
        if (!canonicalTile) return;
        seen.add(tile.id);
        pool.push(Array.isArray(tile.edges) ? tile : canonicalTile);
      }

      for (const id of ids) addTile(oldCurrentByPlayer[id]?.tile);
      for (const id of ids) for (const tile of oldHands[id] || []) addTile(tile);
      for (const [id, current] of Object.entries(oldCurrentByPlayer)) if (!active.has(id)) addTile(current?.tile);
      for (const [id, hand] of Object.entries(oldHands)) if (!active.has(id)) for (const tile of hand || []) addTile(tile);
      for (const tile of state.deck || []) addTile(tile);
      for (const tile of canonical.values()) addTile(tile);

      state.deck = [];
      state.hands = {};
      state.currentByPlayer = {};

      if (!ids.length) {
        state.deck = pool;
        return before !== tileAccountingKey();
      }

      ids.forEach((id) => { state.hands[id] = []; });

      for (const id of ids) {
        const current = oldCurrentByPlayer[id];
        const tileId = current?.tile?.id;
        const index = pool.findIndex((tile) => tile.id === tileId);
        if (index >= 0) state.currentByPlayer[id] = { tile: pool.splice(index, 1)[0], rot: current.rot || 0 };
        else state.currentByPlayer[id] = null;
      }

      pool.forEach((tile, i) => state.hands[ids[i % ids.length]].push(tile));
      for (const id of ids) drawForPlayer(id);
      return before !== tileAccountingKey();
    }

    function reconcileActivePlayerTiles() {
      if (!isHost()) return;
      const changed = dealAllRemainingToActivePlayers();
      checkEnd();
      return changed;
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
      pond.tileIds.clear();
      pond.entities = [];
      pond.ripples = [];
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

    function pondCellAt(x, y) {
      return state.board[key(Math.floor(x + 0.5), Math.floor(y + 0.5))] || null;
    }

    function inPond(x, y) {
      return !!pondCellAt(x, y);
    }

    function nearPlacedPondTile(x, y, pad = 0) {
      const cx = Math.floor(x + 0.5), cy = Math.floor(y + 0.5);
      for (let yy = cy - 1; yy <= cy + 1; yy++) {
        for (let xx = cx - 1; xx <= cx + 1; xx++) {
          if (!state.board[key(xx, yy)]) continue;
          if (x >= xx - 0.5 - pad && x <= xx + 0.5 + pad && y >= yy - 0.5 - pad && y <= yy + 0.5 + pad) return true;
        }
      }
      return false;
    }

    function pondCenter() {
      const pts = Object.keys(state.board).map(parseKey);
      if (!pts.length) return { x: 0.5, y: 0.5 };
      return { x: pts.reduce((sum, p) => sum + p.x + 0.5, 0) / pts.length, y: pts.reduce((sum, p) => sum + p.y + 0.5, 0) / pts.length };
    }

    function syncPondLife() {
      for (const [k, cell] of Object.entries(state.board)) {
        const id = cell?.tile?.id || k;
        if (pond.tileIds.has(id)) continue;
        pond.tileIds.add(id);
        spawnPondLifeForTile(k, id);
      }
      for (const id of [...pond.tileIds]) {
        const stillPlaced = Object.values(state.board).some((cell) => cell?.tile?.id === id);
        if (!stillPlaced) pond.tileIds.delete(id);
      }
      pond.entities = pond.entities.filter((e) => nearPlacedPondTile(e.x, e.y, 1.35));
    }

    function spawnPondLifeForTile(k, id) {
      const cell = parseKey(k);
      const seed = tileSeed(id);
      const roll = seeded(seed, 3);
      addPondEntity("pad", cell, seed, 0, 0.00022, 0.065);
      if (roll > 0.72) addPondEntity("koi", cell, seed, 1, 0.0010 + seeded(seed, 16) * 0.0014, 0.035);
      else if (roll > 0.62) addPondEntity("shadow", cell, seed, 2, 0.004 + seeded(seed, 18) * 0.005, 0.025);
      else if (roll > 0.42) addPondEntity("bug", cell, seed, 3, 0.0045, 0.030, seeded(seed, 19) > 0.55 ? "dragonfly" : "butterfly");
      if (seeded(seed, 8) > 0.88) addPondEntity("turtle", cell, seed, 4, 0.0022 / 3, 0.045);
    }

    function addPondEntity(type, cell, seed, i, speed, radius, bugKind = null) {
      const a = seeded(seed, i + 30) * Math.PI * 2;
      pond.entities.push({
        type,
        bugKind,
        x: cell.x - 0.32 + seeded(seed, i * 5 + 1) * 0.64,
        y: cell.y - 0.32 + seeded(seed, i * 5 + 2) * 0.64,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        speed,
        baseSpeed: speed,
        burstUntil: 0,
        radius: type === "pad" ? radius * (1 + seeded(seed, i * 5 + 4) * 1.3) : radius,
        spin: type === "pad" ? (seeded(seed, i * 5 + 6) - 0.5) * 0.00008 : 0,
        angle: a,
        seed: seed + i * 97,
        turnAt: 0,
        landedOn: null,
      });
    }

    function updatePondLife(dt) {
      syncPondLife();
      const t = now();
      const step = Math.min(3, Math.max(0.2, dt / 16.67));
      for (const e of pond.entities) {
        if (e.type === "pad") updatePad(e, step, t);
        else if (e.type === "bug") updateBug(e, step, t);
        else updateSwimmer(e, step, t);
      }
      resolvePondCollisions(t);
      updatePondRipples(dt);
      if (Math.random() < 0.020) addRandomPondRipple();
    }

    function updatePad(e, step, t) {
      gentleSteer(e, t, 0.00035);
      e.x += e.vx * step;
      e.y += e.vy * step;
      e.angle += e.spin * step * 16.67;
      steerIntoPond(e, t, 0.0008);
    }

    function updateSwimmer(e, step, t) {
      updateSwimmerSpeed(e, t);
      gentleSteer(e, t, e.type === "koi" ? 0.0022 : 0.0010);
      avoidSolidPondLife(e, e.type === "koi" ? 0.0018 : 0.0028);
      e.x += e.vx * step;
      e.y += e.vy * step;
      steerIntoPond(e, t, e.type === "koi" ? 0.006 : 0.0025);
    }

    function updateSwimmerSpeed(e, t) {
      if (e.type !== "koi") return;
      if (t < e.burstUntil) return;
      e.speed = e.baseSpeed;
      if (seeded(e.seed, Math.floor(t / 2400)) > 0.982) {
        e.speed = e.baseSpeed * (2.4 + seeded(e.seed, Math.floor(t / 1900) + 21) * 2.0);
        e.burstUntil = t + 900 + seeded(e.seed, Math.floor(t / 1700) + 22) * 1500;
      }
      normalizeVelocity(e);
    }

    function updateBug(e, step, t) {
      const target = e.landedOn && pond.entities.includes(e.landedOn) ? e.landedOn : null;
      if (target && t < e.turnAt) {
        e.x += (target.x - e.x) * 0.08;
        e.y += (target.y - e.y) * 0.08;
        e.angle = e.angle || Math.atan2(e.vy, e.vx);
        return;
      }
      e.landedOn = null;
      const landing = pond.entities.find((o) => (o.type === "pad" || o.type === "turtle") && Math.hypot(o.x - e.x, o.y - e.y) < o.radius + 0.05);
      if (landing && seeded(e.seed, Math.floor(t / 2000)) > 0.985) {
        e.landedOn = landing;
        e.turnAt = t + 2600 + seeded(e.seed, 42) * 4200;
        addPondRipple(e.x, e.y, 0.07);
        return;
      }
      gentleSteer(e, t, 0.003);
      e.x += e.vx * step;
      e.y += e.vy * step;
      steerIntoPond(e, t, 0.004);
    }

    function moveWithinPlacedPond(e, step, t) {
      const nx = e.x + e.vx * step;
      const ny = e.y + e.vy * step;
      if (inPond(nx, ny)) {
        e.x = nx;
        e.y = ny;
        return;
      }
      const cx = Math.floor(e.x + 0.5), cy = Math.floor(e.y + 0.5);
      const jitter = (seeded(e.seed, Math.floor(t / 700)) - 0.5) * Math.PI * 0.55;
      const a = Math.atan2(cy - e.y, cx - e.x) + jitter;
      e.vx = Math.cos(a) * e.speed;
      e.vy = Math.sin(a) * e.speed;
      e.x = clamp(e.x, cx - 0.48 + e.radius, cx + 0.48 - e.radius);
      e.y = clamp(e.y, cy - 0.48 + e.radius, cy + 0.48 - e.radius);
    }

    function gentleSteer(e, t, amount) {
      if (t < e.turnAt) return;
      e.turnAt = t + 1600 + seeded(e.seed, Math.floor(t / 1700)) * 3200;
      const current = Math.atan2(e.vy, e.vx);
      const a = current + (seeded(e.seed, Math.floor(t / 900) + 11) - 0.5) * Math.PI * 0.55;
      e.vx += Math.cos(a) * amount;
      e.vy += Math.sin(a) * amount;
      normalizeVelocity(e);
    }

    function steerIntoPond(e, t, amount) {
      if (nearPlacedPondTile(e.x, e.y, 0.85)) return;
      const c = pondCenter();
      const a = Math.atan2(c.y - e.y, c.x - e.x) + (seeded(e.seed, Math.floor(t / 1300)) - 0.5) * 0.8;
      e.vx += Math.cos(a) * amount;
      e.vy += Math.sin(a) * amount;
      normalizeVelocity(e);
    }

    function avoidSolidPondLife(e, amount) {
      for (const o of pond.entities) {
        if (o === e || (o.type !== "pad" && o.type !== "turtle")) continue;
        const dx = e.x - o.x, dy = e.y - o.y;
        const d = Math.hypot(dx, dy) || 1;
        const minD = e.radius + o.radius + (e.type === "koi" ? 0.08 : 0.02);
        if (d >= minD) continue;
        e.vx += dx / d * amount;
        e.vy += dy / d * amount;
      }
      normalizeVelocity(e);
    }

    function resolvePondCollisions(t) {
      for (let i = 0; i < pond.entities.length; i++) {
        const a = pond.entities[i];
        if (a.type !== "pad" && a.type !== "turtle") continue;
        for (let j = i + 1; j < pond.entities.length; j++) {
          const b = pond.entities[j];
          if (b.type !== "pad" && b.type !== "turtle") continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1;
          const minD = a.radius + b.radius;
          if (d >= minD) continue;
          const push = (minD - d) * 0.5;
          a.x -= dx / d * push; a.y -= dy / d * push;
          b.x += dx / d * push; b.y += dy / d * push;
          if (!a.lastRippleAt || t - a.lastRippleAt > 1800) {
            addPondRipple((a.x + b.x) / 2, (a.y + b.y) / 2, 0.08);
            a.lastRippleAt = b.lastRippleAt = t;
          }
        }
      }
    }

    function normalizeVelocity(e) {
      const d = Math.hypot(e.vx, e.vy) || 1;
      e.vx = e.vx / d * e.speed;
      e.vy = e.vy / d * e.speed;
    }

    function addPondRipple(x, y, r = 0.08) {
      if (!inPond(x, y)) return;
      pond.ripples.push({ x, y, r, life: 0, max: 1600 });
      while (pond.ripples.length > 48) pond.ripples.shift();
    }

    function addRandomPondRipple() {
      const cells = Object.keys(state.board);
      if (!cells.length) return;
      const p = parseKey(cells[Math.floor(Math.random() * cells.length)]);
      addPondRipple(p.x - 0.35 + Math.random() * 0.70, p.y - 0.35 + Math.random() * 0.70, 0.035 + Math.random() * 0.04);
    }

    function updatePondRipples(dt) {
      for (const r of pond.ripples) r.life += dt;
      pond.ripples = pond.ripples.filter((r) => r.life < r.max);
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
      drawRoundRectOn(ctx, x, y, w, h, r);
    }

    function drawRoundRectOn(targetCtx, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      targetCtx.beginPath();
      targetCtx.moveTo(x + rr, y);
      targetCtx.arcTo(x + w, y, x + w, y + h, rr);
      targetCtx.arcTo(x + w, y + h, x, y + h, rr);
      targetCtx.arcTo(x, y + h, x, y, rr);
      targetCtx.arcTo(x, y, x + w, y, rr);
      targetCtx.closePath();
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

    function drawTile(tile, rot, x, y, size, alpha = 1, owner = null, decorative = true) {
      const edges = rotatedEdges(tile, rot || 0);
      ctx.save();
      ctx.globalAlpha = alpha;
      drawTileBase(tile, x, y, size, decorative);
      drawTileFlowers(edges, x, y, size);
      if (owner) drawTileOwner(owner, x, y, size);
      ctx.restore();
    }

    function drawTileBase(tile, x, y, size, decorative = true) {
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

      ctx.save();
      drawPondClip(x, y, size);
      ctx.clip();
      drawStaticWaterSurface(tile.id, x, y, size);
      if (decorative) {
        drawPondScatter(tile.id, x, y, size);
        drawMotif(tile.motif, x, y, size);
      }
      ctx.restore();
    }

    function drawTileFlowers(edges, x, y, size) {
      drawEdgeFlower(x + size / 2, y, edges[0], 0, size);
      drawEdgeFlower(x + size, y + size / 2, edges[1], Math.PI / 2, size);
      drawEdgeFlower(x + size / 2, y + size, edges[2], Math.PI, size);
      drawEdgeFlower(x, y + size / 2, edges[3], -Math.PI / 2, size);
    }

    function drawTileOwner(owner, x, y, size) {
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

    function drawPondClip(x, y, size) {
      drawRoundRect(x + size * 0.065, y + size * 0.065, size * 0.87, size * 0.87, size * 0.075);
    }

    function driftPoint(seed, i, x, y, size, speed = 0.010) {
      const t = now() / 1000;
      const margin = 0.115;
      const span = 1 - margin * 2;
      const bx = seeded(seed, i * 6);
      const by = seeded(seed, i * 6 + 1);
      const vx = (seeded(seed, i * 6 + 2) - 0.5) * speed;
      const vy = (seeded(seed, i * 6 + 3) - 0.5) * speed;
      const wobble = Math.sin(t * (0.10 + seeded(seed, i * 6 + 4) * 0.10) + seeded(seed, i * 6 + 5) * Math.PI * 2) * 0.018;
      const px = margin + (((bx + vx * t + wobble) % 1) + 1) % 1 * span;
      const py = margin + (((by + vy * t - wobble * 0.55) % 1) + 1) % 1 * span;
      return { x: x + size * px, y: y + size * py, angle: Math.atan2(vy - wobble * 0.015, vx + 0.001) };
    }

    function drawStaticWaterSurface(id, x, y, size) {
      return;
    }

    function drawRainRipple(x, y, r, phase) {
      const pulse = 0.75 + ((now() / 2600 + phase) % 1) * 0.45;
      ctx.save();
      ctx.strokeStyle = "rgba(221,255,250,0.20)";
      ctx.lineWidth = Math.max(0.5, r * 0.12);
      for (let i = 0; i < 2; i++) {
        ctx.globalAlpha = 0.40 - i * 0.15;
        ctx.beginPath();
        ctx.ellipse(x, y, r * pulse * (1 + i * 0.75), r * pulse * (0.45 + i * 0.30), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawFishShadow(x, y, s, angle) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = "rgba(2,22,31,0.22)";
      ctx.beginPath(); ctx.ellipse(0, 0, s * 2.1, s * 0.55, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s * 1.75, 0); ctx.lineTo(-s * 2.45, -s * 0.36); ctx.lineTo(-s * 2.25, 0); ctx.lineTo(-s * 2.45, s * 0.36); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    function drawPondScatter(id, x, y, size) {
      const seed = tileSeed(id);
      const count = size > 58 ? 3 : 2;
      for (let i = 0; i < count; i++) {
        const speed = i % 5 === 0 || i % 5 === 4 ? 0.0012 : 0.008;
        const p = driftPoint(seed, i, x, y, size, speed);
        const s = size * (0.045 + seeded(seed, i * 4 + 2) * 0.035);
        const a = p.angle + seeded(seed, i * 4 + 3) * 0.38;
        const roll = seeded(seed, i * 5 + 9);
        if (roll < 0.62) drawMiniLilyPad(p.x, p.y, s * 1.8, a);
        else if (roll < 0.78) drawRainRipple(p.x, p.y, s * 0.58, roll);
        else if (roll < 0.86) drawMiniButterfly(p.x, p.y, s * 0.56, a);
        else if (roll < 0.92) drawMiniDragonfly(p.x, p.y, s * 0.72, a);
        else if (roll < 0.97) drawMiniKoi(p.x, p.y, s * 1.12, a);
        else drawMiniTurtle(p.x, p.y, s * 1.10, a);
      }
    }

    function drawMotif(motif, x, y, size) {
      ctx.save();
      ctx.translate(x + size * 0.5, y + size * 0.52);
      if (motif === "koi") {
        drawMiniKoi(0, 0, size * 0.15, -0.55 + Math.sin(now() / 4200) * 0.10);
      } else if (motif === "turtle") {
        drawMiniTurtle(0, 0, size * 0.17, 0.2 + Math.sin(now() / 5200) * 0.08);
      } else if (motif === "dragonfly") {
        drawMiniDragonfly(0, 0, size * 0.12, -0.18);
      } else {
        drawMiniLilyPad(-size * 0.06, size * 0.02, size * 0.18, -0.55);
        drawMiniLilyPad(size * 0.12, -size * 0.08, size * 0.12, 0.85);
        drawMiniButterfly(size * 0.03, -size * 0.13, size * 0.045, 0.35);
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
      drawKoiWake(-s * 1.08, 0, s);
      ctx.fillStyle = "rgba(1,22,32,0.20)";
      ctx.beginPath(); ctx.ellipse(s * 0.16, s * 0.12, s * 1.75, s * 0.62, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha *= 0.86;
      ctx.fillStyle = "rgba(255,238,204,0.74)";
      ctx.beginPath(); ctx.ellipse(0, 0, s * 1.30, s * 0.48, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(236,82,50,0.70)";
      ctx.beginPath(); ctx.ellipse(-s * 0.28, -s * 0.10, s * 0.42, s * 0.18, -0.35, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.30, s * 0.11, s * 0.34, s * 0.16, 0.35, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(248,154,83,0.58)";
      ctx.beginPath(); ctx.moveTo(-s * 1.10, 0); ctx.lineTo(-s * 1.72, -s * 0.40); ctx.lineTo(-s * 1.50, 0); ctx.lineTo(-s * 1.72, s * 0.40); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,238,204,0.42)";
      ctx.beginPath(); ctx.ellipse(-s * 0.28, -s * 0.52, s * 0.52, s * 0.12, -0.45, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-s * 0.28, s * 0.52, s * 0.52, s * 0.12, 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(221,255,250,0.22)";
      ctx.lineWidth = Math.max(0.5, s * 0.07);
      ctx.beginPath(); ctx.moveTo(s * 0.95, 0); ctx.quadraticCurveTo(s * 0.10, -s * 0.16, -s * 0.95, 0); ctx.stroke();
      ctx.fillStyle = "rgba(10,24,25,0.64)";
      ctx.beginPath(); ctx.arc(s * 0.78, -s * 0.11, Math.max(0.7, s * 0.08), 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.78, s * 0.11, Math.max(0.7, s * 0.08), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(110,220,230,0.15)";
      ctx.beginPath(); ctx.ellipse(0, 0, s * 1.70, s * 0.68, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function drawKoiWake(x, y, s) {
      ctx.save();
      ctx.translate(x, y);
      ctx.strokeStyle = "rgba(221,255,250,0.24)";
      ctx.lineWidth = Math.max(0.45, s * 0.050);
      for (let i = 0; i < 3; i++) {
        const spread = s * (0.26 + i * 0.17);
        const length = s * (0.72 + i * 0.46);
        ctx.globalAlpha = 0.34 - i * 0.075;
        ctx.beginPath();
        ctx.moveTo(-s * 0.06, 0);
        ctx.quadraticCurveTo(-length * 0.48, -spread * 0.34, -length, -spread);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-s * 0.06, 0);
        ctx.quadraticCurveTo(-length * 0.48, spread * 0.34, -length, spread);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawMiniTurtle(x, y, s, angle) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      drawWake(-s * 1.05, 0, s * 0.85, Math.PI);
      ctx.fillStyle = "rgba(8,29,31,0.18)";
      ctx.beginPath(); ctx.ellipse(s * 0.10, s * 0.12, s * 1.35, s * 0.92, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(49,111,78,0.72)";
      for (const p of [[-0.62, -0.66, -0.60], [-0.62, 0.66, 0.60], [0.48, -0.70, 0.75], [0.48, 0.70, -0.75]]) {
        ctx.beginPath(); ctx.ellipse(s * p[0], s * p[1], s * 0.42, s * 0.17, p[2], 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "rgba(115,178,104,0.78)";
      ctx.beginPath(); ctx.arc(s * 1.06, 0, s * 0.30, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(69,139,83,0.88)";
      ctx.beginPath(); ctx.ellipse(0, 0, s * 1.08, s * 0.78, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(94,164,95,0.86)";
      ctx.beginPath(); ctx.ellipse(s * 0.10, 0, s * 0.78, s * 0.54, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(222,249,186,0.36)";
      ctx.lineWidth = Math.max(0.5, s * 0.075);
      ctx.beginPath();
      ctx.moveTo(-s * 0.58, 0); ctx.lineTo(s * 0.62, 0);
      ctx.moveTo(-s * 0.12, -s * 0.50); ctx.lineTo(-s * 0.12, s * 0.50);
      ctx.moveTo(s * 0.35, -s * 0.38); ctx.lineTo(s * 0.35, s * 0.38);
      ctx.stroke();
      ctx.fillStyle = "rgba(13,48,42,0.60)";
      ctx.beginPath(); ctx.arc(s * 1.16, -s * 0.08, Math.max(0.5, s * 0.045), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function drawMiniDragonfly(x, y, s, angle) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      const flap = Math.sin(now() / 260 + x * 0.01 + y * 0.01) * 0.18;
      const rearWingHeadOffset = Math.min(0.75, 10 / Math.max(1, s));
      ctx.fillStyle = "rgba(213,250,255,0.34)";
      for (const p of [[-0.34, -0.16, -0.58 - flap], [0.34, -0.16, 0.58 + flap], [-0.30, -0.13 - rearWingHeadOffset, 0.46 + flap], [0.30, -0.13 - rearWingHeadOffset, -0.46 - flap]]) {
        ctx.beginPath(); ctx.ellipse(s * p[0], s * p[1], s * 0.42, s * 0.15, p[2], 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(230,255,255,0.20)";
        ctx.lineWidth = Math.max(0.3, s * 0.035);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(64,157,143,0.82)";
      ctx.lineWidth = Math.max(0.5, s * 0.10);
      ctx.beginPath(); ctx.moveTo(0, -s * 0.72); ctx.quadraticCurveTo(s * 0.05, 0, 0, s * 0.92); ctx.stroke();
      ctx.fillStyle = "rgba(29,86,80,0.88)";
      ctx.beginPath(); ctx.arc(0, -s * 0.88, s * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(179,255,246,0.60)";
      ctx.beginPath(); ctx.arc(-s * 0.07, -s * 0.92, s * 0.045, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.07, -s * 0.92, s * 0.045, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function drawMiniButterfly(x, y, s, angle) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      const flap = Math.sin(now() / 340 + x * 0.02) * 0.18;
      ctx.fillStyle = "rgba(255,218,149,0.58)";
      ctx.beginPath(); ctx.ellipse(-s * 0.38, -s * 0.02, s * 0.46, s * 0.28, -0.72 - flap, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.38, -s * 0.02, s * 0.46, s * 0.28, 0.72 + flap, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(64,57,47,0.68)";
      ctx.lineWidth = Math.max(0.4, s * 0.06);
      ctx.beginPath(); ctx.moveTo(0, -s * 0.32); ctx.lineTo(0, s * 0.42); ctx.stroke();
      ctx.restore();
    }

    function drawWake(x, y, s, angle) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.strokeStyle = "rgba(221,255,250,0.20)";
      ctx.lineWidth = Math.max(0.4, s * 0.045);
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = 0.32 - i * 0.07;
        ctx.beginPath();
        ctx.ellipse(-s * (0.18 + i * 0.35), 0, s * (0.38 + i * 0.28), s * (0.12 + i * 0.03), 0, Math.PI * 0.14, Math.PI * 1.86);
        ctx.stroke();
      }
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
      ctx.strokeStyle = "rgba(255,255,255,0.085)";
      ctx.lineWidth = Math.max(1, size * 0.012);
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.7885, 0, Math.PI);
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
        drawBoardTileBase(cell.tile, p.x, p.y, ui.view.scale - 2, 1);
      }

      drawPondLife();

      for (const [k, cell] of entries) {
        const { x, y } = parseKey(k);
        const p = gridToScreen(x, y);
        drawBoardTileTop(cell.tile, cell.rot, p.x, p.y, ui.view.scale - 2, 1, cell.owner !== "system" ? cell.owner : null);
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

    function drawPondLife() {
      if (!pond.entities.length && !pond.ripples.length) return;
      for (const k of Object.keys(state.board)) {
        const cell = parseKey(k);
        ctx.save();
        beginPlacedCardClip(cell.x, cell.y);
        ctx.clip();
        for (const r of pond.ripples) if (rippleOverlapsPlacedCell(r, cell.x, cell.y)) drawWorldPondRipple(r);
        for (const e of pond.entities.filter((entity) => entity.type === "shadow")) if (entityOverlapsPlacedCell(e, cell.x, cell.y)) drawWorldPondEntity(e);
        for (const e of pond.entities.filter((entity) => entity.type !== "shadow")) if (entityOverlapsPlacedCell(e, cell.x, cell.y)) drawWorldPondEntity(e);
        ctx.restore();
      }
    }

    function entityOverlapsPlacedCell(e, cellX, cellY) {
      return circleOverlapsPlacedCell(e.x, e.y, pondEntityDrawRadius(e), cellX, cellY);
    }

    function rippleOverlapsPlacedCell(r, cellX, cellY) {
      const t = r.life / r.max;
      return circleOverlapsPlacedCell(r.x, r.y, r.r * (1 + t * 2.2), cellX, cellY);
    }

    function circleOverlapsPlacedCell(x, y, radius, cellX, cellY) {
      const minX = cellX - 0.5, maxX = cellX + 0.5;
      const minY = cellY - 0.5, maxY = cellY + 0.5;
      const nearestX = clamp(x, minX, maxX);
      const nearestY = clamp(y, minY, maxY);
      return Math.hypot(x - nearestX, y - nearestY) <= radius;
    }

    function pondEntityDrawRadius(e) {
      if (e.type === "koi") return e.radius * 1.8;
      if (e.type === "turtle") return e.radius * 1.5;
      if (e.type === "shadow") return e.radius * 2.5;
      if (e.type === "bug") return e.radius * 1.4;
      return e.radius * 1.2;
    }

    function beginPlacedCardClip(x, y) {
      const c = gridToScreen(x, y);
      ctx.beginPath();
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(ui.view.rot);
      drawRoundRect(-ui.view.scale / 2 + 1, -ui.view.scale / 2 + 1, ui.view.scale - 2, ui.view.scale - 2, ui.view.scale * 0.10);
      ctx.restore();
    }

    function drawWorldPondRipple(r) {
      const p = gridToScreen(r.x, r.y);
      const scale = ui.view.scale;
      const t = r.life / r.max;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t) * 0.55;
      ctx.strokeStyle = "rgba(221,255,250,0.46)";
      ctx.lineWidth = Math.max(0.5, scale * 0.006);
      for (let i = 0; i < 2; i++) {
        const ringT = Math.min(1, t + i * 0.18);
        ctx.globalAlpha = Math.max(0, 1 - ringT) * (0.42 - i * 0.14);
        ctx.beginPath();
        ctx.arc(p.x, p.y, scale * r.r * (0.35 + ringT * 2.9), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawWorldPondEntity(e) {
      const p = gridToScreen(e.x, e.y);
      const size = ui.view.scale;
      const angle = Math.atan2(e.vy, e.vx) + ui.view.rot;
      if (e.type === "pad") drawMiniLilyPad(p.x, p.y, size * e.radius, (e.angle || 0) + ui.view.rot);
      else if (e.type === "koi") drawMiniKoi(p.x, p.y, size * e.radius * 0.82, angle);
      else if (e.type === "turtle") drawMiniTurtle(p.x, p.y, size * e.radius * 0.92, angle);
      else if (e.type === "shadow") drawFishShadow(p.x, p.y, size * e.radius, angle);
      else if (e.bugKind === "dragonfly") drawMiniDragonfly(p.x, p.y, size * e.radius, (e.landedOn ? e.angle + ui.view.rot : angle + Math.PI / 2), !e.landedOn);
      else drawMiniButterfly(p.x, p.y, size * e.radius, angle);
    }

    function drawBoardTile(tile, rot, cx, cy, size, alpha, owner) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ui.view.rot);
      drawTile(tile, rot, -size / 2, -size / 2, size, alpha, owner, false);
      ctx.restore();
    }

    function drawBoardTileBase(tile, cx, cy, size, alpha) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.rotate(ui.view.rot);
      drawTileBase(tile, -size / 2, -size / 2, size, false);
      ctx.restore();
    }

    function drawBoardTileTop(tile, rot, cx, cy, size, alpha, owner) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.rotate(ui.view.rot);
      drawTileFlowers(rotatedEdges(tile, rot || 0), -size / 2, -size / 2, size);
      if (owner) drawTileOwner(owner, -size / 2, -size / 2, size);
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
      const pointerId = e.pointerId ?? "mouse";
      activePointers.set(pointerId, pointerEntry(e));
      if (drag && (activePointerId === null || e.pointerId === undefined || e.pointerId !== activePointerId)) {
        e.preventDefault();
        rotateCurrent();
        activePointers.delete(pointerId);
        return;
      }
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
      if (drag && activePointerId === null && e.changedTouches && e.touches?.length) {
        e.preventDefault();
        activePointers.set("mouse", pointerEntry(e));
        const p = pointerPoint(e);
        drag.x = p.x;
        drag.y = p.y;
        drag.hover = pointIn(ui.deck, p.x, p.y) ? null : nearestEmptyCell(p.x, p.y, ui.view.scale * 0.46);
        return;
      }
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

    function onLostPointerCapture(e) {
      activePointers.delete(e.pointerId ?? "mouse");
      if (!activePointers.size && !drag) boardGesture = null;
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
      updatePondLife(frameMs || 16);
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
          canvas.addEventListener("lostpointercapture", onLostPointerCapture);
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
          canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
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
