/* A Gentle Rain for browserP2P.
 * Host owns the tile deck, shared hand tile, legal placements, blossoms, and scoring.
 */
(function () {
  "use strict";

  const SNAPSHOT_HZ = 12;
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

  function create(host, initialState) {
    const canvas = host.canvas;
    const ctx = canvas.getContext("2d");
    const myId = host.myId;

    let rafId = 0;
    let lastTs = 0;
    let lastSnapshotAt = 0;
    let lastCssWidth = 0;
    let lastCssHeight = 0;
    let activePointerId = null;
    let audioCtx = null;
    let eventSeq = 0;
    let seenEventSeq = 0;
    let ui = { board: null, hand: null, handTile: null, rotate: null, deck: null, reset: null, cells: new Map(), scale: 1 };
    let drag = null;
    const events = [];
    const drops = [];
    const ripples = [];
    const particles = [];

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

    function liveTilePool() {
      const pool = state.deck.slice();
      for (const hand of Object.values(state.hands)) pool.push(...(hand || []));
      for (const current of Object.values(state.currentByPlayer)) if (current?.tile) pool.push(current.tile);
      return pool;
    }

    function dealEvenly(pool = liveTilePool()) {
      const ids = sortedPlayers();
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

    function handleAction(id, input) {
      if (!isHost() || !input || typeof input !== "object") return;
      if (input.type === "rotate" && currentFor(id) && !state.over) {
        const current = currentFor(id);
        current.rot = ((current.rot || 0) + 1) % 4;
        state.message = "The tile turns softly in your hands.";
      } else if (input.type === "place") {
        placeTile(id, Math.round(input.x), Math.round(input.y));
      } else if (input.type === "swap") {
        swapTile(id);
      } else if (input.type === "reset") {
        resetHostState();
      }
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
      const legal = legalCellsFor(currentFor());
      for (const p of legal) pts.push(p);
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
      const top = Math.max(88, Math.min(120, H * 0.18));
      const handH = Math.max(142, Math.min(188, H * 0.25));
      const margin = Math.max(12, Math.min(22, W * 0.04));
      const board = { x: margin, y: top, w: W - margin * 2, h: H - top - handH - margin };
      const bounds = boardBounds();
      const cols = bounds.maxX - bounds.minX + 1;
      const rows = bounds.maxY - bounds.minY + 1;
      const cell = Math.max(24, Math.min(board.w / cols, board.h / rows));
      ui = {
        board,
        hand: { x: margin, y: H - handH + 10, w: W - margin * 2, h: handH - 18 },
        handTile: { x: margin + 22, y: H - handH + 70, w: Math.min(90, handH - 44), h: Math.min(90, handH - 44) },
        rotate: { x: W - margin - 112, y: H - handH + 30, w: 104, h: 42 },
        deck: { x: W - margin - 108, y: H - handH + 84, w: 92, h: 70 },
        reset: { x: margin, y: 52, w: 84, h: 32 },
        cells: new Map(),
        scale: cell,
        bounds,
      };
      return ui;
    }

    function gridToScreen(x, y) {
      const { board, scale, bounds } = ui;
      return {
        x: board.x + (x - bounds.minX) * scale + (board.w - (bounds.maxX - bounds.minX + 1) * scale) / 2,
        y: board.y + (y - bounds.minY) * scale + (board.h - (bounds.maxY - bounds.minY + 1) * scale) / 2,
      };
    }

    function boardToNorm(x, y) {
      const W = Math.max(1, canvas.clientWidth || lastCssWidth || 1);
      const H = Math.max(1, canvas.clientHeight || lastCssHeight || 1);
      const p = gridToScreen(x, y);
      return { x: clamp(p.x / W, 0, 1), y: clamp(p.y / H, 0, 1) };
    }

    function pointIn(r, x, y) { return r && x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h; }

    function screenCell(px, py) {
      for (const [k, r] of ui.cells) if (pointIn(r, px, py)) return parseKey(k);
      return null;
    }

    function nearestEmptyCell(px, py, maxDist = Infinity) {
      let best = null;
      let bestD = maxDist;
      for (const [k, r] of ui.cells) {
        if (state.board[k]) continue;
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
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

    function drawDeckStack() {
      const r = ui.deck;
      const count = (state.hands[myId]?.length || 0);
      const layers = Math.min(9, Math.max(1, count));
      ctx.save();
      for (let i = layers - 1; i >= 0; i--) {
        const off = i * 2.4;
        ctx.fillStyle = count ? "rgba(211,232,224,0.92)" : "rgba(83,108,114,0.45)";
        drawRoundRect(r.x + off, r.y - off, r.w - 12, r.h - 10, 9);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(27,76,87,0.88)";
      drawRoundRect(r.x + 10, r.y + 12, r.w - 28, r.h - 32, 7);
      ctx.fill();
      ctx.fillStyle = "#eafff8";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "900 18px system-ui, sans-serif";
      ctx.fillText(String(count), r.x + r.w / 2 - 6, r.y + r.h / 2 - 2);
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillStyle = "rgba(235,255,249,0.72)";
      ctx.fillText("deck", r.x + r.w / 2 - 6, r.y + r.h - 8);
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
        ui.cells.set(k, { x: p.x, y: p.y, w: ui.scale, h: ui.scale });
        drawTile(cell.tile, cell.rot, p.x + 1, p.y + 1, ui.scale - 2, 1, cell.owner !== "system" ? cell.owner : null);
      }

      for (const k of legal) {
        const { x, y } = parseKey(k);
        const p = gridToScreen(x, y);
        ui.cells.set(k, { x: p.x, y: p.y, w: ui.scale, h: ui.scale });
        if (k !== hoverKey) continue;
        ctx.fillStyle = "rgba(211,255,244,0.26)";
        ctx.strokeStyle = "rgba(235,255,249,0.92)";
        ctx.lineWidth = 3;
        drawRoundRect(p.x + 4, p.y + 4, ui.scale - 8, ui.scale - 8, ui.scale * 0.10);
        ctx.fill();
        ctx.stroke();
        if (current?.tile) drawTile(current.tile, current.rot || 0, p.x + 1, p.y + 1, ui.scale - 2, 0.28, null);
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

      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(239,252,255,0.88)";
      ctx.font = "700 14px system-ui, sans-serif";
      ctx.fillText(state.message, h.x + 18, h.y + 14, Math.max(180, h.w - 150));
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "rgba(223,246,255,0.62)";
      ctx.fillText("Match touching flower halves. Finish a 2×2 pond opening to place a blossom.", h.x + 18, h.y + 38, Math.max(180, h.w - 150));

      const current = currentFor();
      if (current?.tile && !drag) {
        const size = ui.handTile.w;
        drawTile(current.tile, current.rot || 0, ui.handTile.x, ui.handTile.y, size, 1, null);
      } else {
        ctx.font = "700 18px Georgia, serif";
        ctx.fillStyle = state.won ? "#d3fff4" : "#d9eaff";
        ctx.fillText(state.won ? "The lake is blooming." : "No active tile.", h.x + 24, h.y + 78);
      }

      drawButton(ui.rotate, "Rotate", "#2f6674", !!current?.tile && !state.over);
      drawDeckStack();

      const tokenX = h.x + Math.min(h.w - 148, 126);
      const tokenY = h.y + h.h - 54;
      for (let i = 0; i < BLOSSOMS.length; i++) {
        const b = BLOSSOMS[i];
        const x = tokenX + (i % 4) * 34;
        const y = tokenY + Math.floor(i / 4) * 28;
        ctx.globalAlpha = state.used[b.key] ? 1 : 0.32;
        ctx.fillStyle = tileColor(b.key);
        ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(40,31,26,0.36)";
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (drag?.tile) drawTile(drag.tile, drag.rot || 0, drag.x - drag.size / 2, drag.y - drag.size / 2, drag.size, 0.92, null);
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

    function onPointerDown(e) {
      const p = pointerPoint(e);
      if (drag && activePointerId !== null && e.pointerId !== activePointerId) {
        e.preventDefault();
        rotateCurrent();
        return;
      }
      if (pointIn(ui.reset, p.x, p.y)) { e.preventDefault(); sendAction({ type: "reset" }); return; }
      if (pointIn(ui.rotate, p.x, p.y)) { e.preventDefault(); rotateCurrent(); return; }
      if (pointIn(ui.deck, p.x, p.y)) { e.preventDefault(); sendAction({ type: "swap" }); return; }
      const current = currentFor();
      if (current?.tile && pointIn(ui.handTile, p.x, p.y)) {
        e.preventDefault();
        activePointerId = e.pointerId ?? null;
        canvas.setPointerCapture?.(activePointerId);
        drag = { tile: current.tile, rot: current.rot || 0, x: p.x, y: p.y, size: ui.handTile.w, hover: null };
        return;
      }
    }

    function onPointerMove(e) {
      if (!drag) return;
      if (activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) return;
      e.preventDefault();
      const p = pointerPoint(e);
      drag.x = p.x;
      drag.y = p.y;
      drag.hover = nearestEmptyCell(p.x, p.y, ui.scale * 0.36);
    }

    function onPointerUp(e) {
      if (drag && activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) {
        e.preventDefault();
        return;
      }
      const hover = drag?.hover;
      if (hover && legalAt(hover.x, hover.y)) sendAction({ type: "place", x: hover.x, y: hover.y });
      drag = null;
      if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
      activePointerId = null;
    }

    function onKeyDown(e) {
      if (e.key === "r" || e.key === "R" || e.key === " ") { e.preventDefault(); rotateCurrent(); }
      else if (e.key === "d" || e.key === "D") { e.preventDefault(); sendAction({ type: "swap" }); }
    }

    function onContextMenu(e) {
      if (!drag && !currentFor()?.tile) return;
      e.preventDefault();
      rotateCurrent();
    }

    function loop(ts) {
      rafId = requestAnimationFrame(loop);
      if (!lastTs) lastTs = ts;
      const frameMs = ts - lastTs;
      lastTs = ts;
      if (isHost() && ts - lastSnapshotAt >= 1000 / SNAPSHOT_HZ) {
        lastSnapshotAt = ts;
        host.broadcastState(makeSnapshot());
      }
      updateEffects(frameMs || 16, canvas.clientWidth, canvas.clientHeight);
      draw();
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
          canvas.addEventListener("contextmenu", onContextMenu);
        } else {
          canvas.addEventListener("touchstart", onPointerDown, { passive: false });
          window.addEventListener("touchmove", onPointerMove, { passive: false });
          window.addEventListener("touchend", onPointerUp);
          window.addEventListener("touchcancel", onPointerUp);
          canvas.addEventListener("mousedown", onPointerDown);
          window.addEventListener("mousemove", onPointerMove);
          window.addEventListener("mouseup", onPointerUp);
          canvas.addEventListener("contextmenu", onContextMenu);
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
        } else {
          canvas.removeEventListener("touchstart", onPointerDown);
          window.removeEventListener("touchmove", onPointerMove);
          window.removeEventListener("touchend", onPointerUp);
          window.removeEventListener("touchcancel", onPointerUp);
          canvas.removeEventListener("mousedown", onPointerDown);
          window.removeEventListener("mousemove", onPointerMove);
          window.removeEventListener("mouseup", onPointerUp);
          canvas.removeEventListener("contextmenu", onContextMenu);
        }
        window.removeEventListener("keydown", onKeyDown);
      },
      onPeerInput(id, input) { handleAction(id, input); },
      onState(snapshot) { applySnapshot(snapshot); },
      getSnapshot() { return currentSnapshot(); },
      onPlayerList() { if (isHost()) { dealEvenly(); host.broadcastState(makeSnapshot()); } },
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
