/* A Gentle Rain for browserP2P.
 * Host owns the tile deck, shared hand tile, legal placements, blossoms, and scoring.
 */
(function () {
  "use strict";

  const SNAPSHOT_HZ = 12;
  const TILE_COUNT = 28;
  const BLOSSOMS = [
    { key: "lotus", name: "Lotus", color: "#f4a6cf", text: "Lotus" },
    { key: "iris", name: "Iris", color: "#a993ff", text: "Iris" },
    { key: "lily", name: "Lily", color: "#f7f0bd", text: "Lily" },
    { key: "mint", name: "Mint", color: "#8ce8bc", text: "Mint" },
    { key: "sky", name: "Sky", color: "#8ed8ff", text: "Sky" },
    { key: "coral", name: "Coral", color: "#ffb08a", text: "Coral" },
    { key: "violet", name: "Violet", color: "#d9a6ff", text: "Violet" },
    { key: "jade", name: "Jade", color: "#94d78d", text: "Jade" },
  ];
  const MOTIFS = ["lily", "koi", "duck", "reed", "ripple", "leaf"];
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
    let ui = { board: null, hand: null, rotate: null, discard: null, reset: null, cells: new Map(), scale: 1 };
    const events = [];
    const drops = [];
    const ripples = [];
    const particles = [];

    const state = {
      board: {},
      deck: [],
      current: null,
      blossoms: [],
      used: {},
      completed: {},
      discards: 0,
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
          discard: [[180, 0.18, 0.018]],
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
      const tiles = [];
      for (let i = 0; i < TILE_COUNT; i++) {
        const a = names[i % names.length];
        const b = names[(i + 1 + Math.floor(i / 3)) % names.length];
        const c = names[(i + 3) % names.length];
        const d = names[(i + 5 + Math.floor(i / 5)) % names.length];
        tiles.push({ id: `rain-${i + 1}`, edges: [a, b, c, d], motif: MOTIFS[i % MOTIFS.length] });
      }
      return tiles;
    }

    function shuffle(list) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    }

    function resetHostState() {
      const deck = shuffle(makeTiles());
      const start = deck.shift();
      state.board = { [key(0, 0)]: { tile: start, rot: 0, owner: "system", turn: 0 } };
      state.deck = deck;
      state.current = null;
      state.blossoms = [];
      state.used = {};
      state.completed = {};
      state.discards = 0;
      state.turn = 1;
      state.over = false;
      state.won = false;
      state.message = "A single tile rests on the lake. Draw and place gently.";
      drawNextTile();
      emitEvent("reset", 0.5, 0.5, "#8ed8ff");
    }

    function drawNextTile() {
      if (Object.keys(state.used).length >= BLOSSOMS.length) {
        state.current = null;
        state.over = true;
        state.won = true;
        state.message = `All eight blossoms are placed. Score ${score()} with ${state.deck.length} tiles unused.`;
        return;
      }
      if (!state.deck.length) {
        state.current = null;
        state.over = true;
        state.won = false;
        state.message = `The rain softens. ${Object.keys(state.used).length} blossoms placed.`;
        return;
      }
      state.current = { tile: state.deck.shift(), rot: 0 };
      state.message = "Draw one tile. Rotate if needed, then tap a highlighted space.";
    }

    function rotatedEdges(tile, rot) {
      const r = ((rot % 4) + 4) % 4;
      return [0, 1, 2, 3].map((i) => tile.edges[(i - r + 4) % 4]);
    }

    function cellEdges(cell) { return rotatedEdges(cell.tile, cell.rot || 0); }

    function legalAt(x, y, current = state.current) {
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

    function legalCellsFor(current = state.current) {
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

    function hasLegalPlacementAnyRotation() {
      if (!state.current) return false;
      for (let r = 0; r < 4; r++) {
        if (legalCellsFor({ tile: state.current.tile, rot: r }).length) return true;
      }
      return false;
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
      if (!state.current || state.over || !legalAt(x, y)) return;
      state.board[key(x, y)] = { tile: state.current.tile, rot: state.current.rot || 0, owner: id, turn: state.turn++ };
      const p = boardToNorm(x, y);
      emitEvent("place", p.x, p.y, "#dff9ff");
      tryCompleteSquares(x, y);
      if (!state.over) drawNextTile();
    }

    function discardTile() {
      if (!state.current || state.over || hasLegalPlacementAnyRotation()) return;
      state.discards++;
      state.message = "The tile drifts away; draw the next one.";
      emitEvent("discard", 0.5, 0.84, "#b7d7ff");
      drawNextTile();
    }

    function handleAction(id, input) {
      if (!isHost() || !input || typeof input !== "object") return;
      if (input.type === "rotate" && state.current && !state.over) {
        state.current.rot = ((state.current.rot || 0) + 1) % 4;
        state.message = "The tile turns softly in your hands.";
      } else if (input.type === "place") {
        placeTile(id, Math.round(input.x), Math.round(input.y));
      } else if (input.type === "discard") {
        discardTile();
      } else if (input.type === "reset") {
        resetHostState();
      }
      host.broadcastState(makeSnapshot());
    }

    function sendAction(input) {
      if (isHost()) handleAction(myId, input);
      else host.sendInput(input);
    }

    function score() {
      const placed = Object.keys(state.used).length;
      return placed >= BLOSSOMS.length ? placed + state.deck.length : placed;
    }

    function makeSnapshot() {
      return {
        full: true,
        board: state.board,
        deck: state.deck,
        current: state.current,
        blossoms: state.blossoms,
        used: state.used,
        completed: state.completed,
        discards: state.discards,
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
      state.current = snapshot.current || null;
      state.blossoms = snapshot.blossoms || [];
      state.used = snapshot.used || {};
      state.completed = snapshot.completed || {};
      state.discards = snapshot.discards || 0;
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
      const legal = legalCellsFor();
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
      const handH = Math.max(132, Math.min(178, H * 0.24));
      const margin = Math.max(12, Math.min(22, W * 0.04));
      const board = { x: margin, y: top, w: W - margin * 2, h: H - top - handH - margin };
      const bounds = boardBounds();
      const cols = bounds.maxX - bounds.minX + 1;
      const rows = bounds.maxY - bounds.minY + 1;
      const cell = Math.max(24, Math.min(board.w / cols, board.h / rows));
      ui = {
        board,
        hand: { x: margin, y: H - handH + 10, w: W - margin * 2, h: handH - 18 },
        rotate: { x: W - margin - 112, y: H - handH + 30, w: 104, h: 42 },
        discard: { x: W - margin - 112, y: H - handH + 80, w: 104, h: 42 },
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
      ctx.fillText(`${Object.keys(state.used).length}/8 blossoms · ${state.deck.length + (state.current ? 1 : 0)} tiles left · score ${score()}`, W / 2, 64);
      drawButton(ui.reset, "Reset", "#21495c", true);
    }

    function drawTile(tile, rot, x, y, size, alpha = 1, owner = null) {
      const edges = rotatedEdges(tile, rot || 0);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(174,218,212,0.94)";
      drawRoundRect(x, y, size, size, size * 0.10);
      ctx.fill();
      const water = ctx.createRadialGradient(x + size * 0.35, y + size * 0.28, size * 0.08, x + size * 0.5, y + size * 0.5, size * 0.76);
      water.addColorStop(0, "rgba(239,255,250,0.78)");
      water.addColorStop(0.55, "rgba(91,162,177,0.92)");
      water.addColorStop(1, "rgba(53,106,137,0.96)");
      ctx.fillStyle = water;
      drawRoundRect(x + size * 0.055, y + size * 0.055, size * 0.89, size * 0.89, size * 0.08);
      ctx.fill();

      ctx.strokeStyle = "rgba(255,255,255,0.20)";
      ctx.lineWidth = Math.max(1, size * 0.018);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.ellipse(x + size * (0.5 + i * 0.06 - 0.06), y + size * (0.48 + i * 0.035), size * (0.20 + i * 0.05), size * 0.07, -0.35, 0, Math.PI * 2);
        ctx.stroke();
      }

      drawMotif(tile.motif, x, y, size);
      drawCornerCutouts(x, y, size);
      drawEdgeFlower(x + size / 2, y + size * 0.055, edges[0], 0, size);
      drawEdgeFlower(x + size * 0.945, y + size / 2, edges[1], Math.PI / 2, size);
      drawEdgeFlower(x + size / 2, y + size * 0.945, edges[2], Math.PI, size);
      drawEdgeFlower(x + size * 0.055, y + size / 2, edges[3], -Math.PI / 2, size);
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

    function drawMotif(motif, x, y, size) {
      ctx.save();
      ctx.translate(x + size * 0.5, y + size * 0.52);
      if (motif === "koi") {
        ctx.fillStyle = "rgba(255,198,150,0.72)";
        ctx.beginPath(); ctx.ellipse(0, 0, size * 0.14, size * 0.055, -0.55, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,244,220,0.62)";
        ctx.beginPath(); ctx.ellipse(size * 0.10, -size * 0.04, size * 0.055, size * 0.025, -0.55, 0, Math.PI * 2); ctx.fill();
      } else if (motif === "duck") {
        ctx.fillStyle = "rgba(246,226,130,0.66)";
        ctx.beginPath(); ctx.ellipse(0, size * 0.02, size * 0.13, size * 0.07, 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(size * 0.11, -size * 0.04, size * 0.045, 0, Math.PI * 2); ctx.fill();
      } else if (motif === "reed") {
        ctx.strokeStyle = "rgba(127,206,163,0.70)"; ctx.lineWidth = Math.max(1, size * 0.018);
        for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(i * size * 0.04, size * 0.16); ctx.quadraticCurveTo(i * size * 0.08, 0, i * size * 0.03, -size * 0.17); ctx.stroke(); }
      } else {
        ctx.fillStyle = "rgba(139,213,151,0.64)";
        ctx.beginPath(); ctx.ellipse(-size * 0.03, size * 0.02, size * 0.14, size * 0.08, -0.55, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(52,105,82,0.36)"; ctx.beginPath(); ctx.moveTo(-size * 0.08, size * 0.06); ctx.lineTo(size * 0.07, -size * 0.03); ctx.stroke();
      }
      ctx.restore();
    }

    function drawCornerCutouts(x, y, size) {
      ctx.fillStyle = "rgba(13,32,45,0.55)";
      for (const [cx, cy] of [[x, y], [x + size, y], [x + size, y + size], [x, y + size]]) {
        ctx.beginPath();
        ctx.arc(cx, cy, size * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function drawEdgeFlower(cx, cy, colorKey, angle, size) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.fillStyle = tileColor(colorKey);
      ctx.strokeStyle = "rgba(255,255,255,0.62)";
      ctx.lineWidth = Math.max(1, size * 0.012);
      ctx.beginPath();
      ctx.ellipse(0, size * 0.018, size * 0.082, size * 0.038, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    function drawBoard() {
      const legal = new Set(legalCellsFor().map((p) => key(p.x, p.y)));
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
        ctx.fillStyle = "rgba(211,255,244,0.11)";
        ctx.strokeStyle = "rgba(211,255,244,0.50)";
        ctx.lineWidth = 2;
        drawRoundRect(p.x + 4, p.y + 4, ui.scale - 8, ui.scale - 8, ui.scale * 0.10);
        ctx.fill();
        ctx.stroke();
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

      if (state.current) {
        const size = Math.min(82, h.h - 38, W * 0.22);
        drawTile(state.current.tile, state.current.rot || 0, h.x + 22, h.y + h.h - size - 16, size, 1, null);
      } else {
        ctx.font = "700 18px Georgia, serif";
        ctx.fillStyle = state.won ? "#d3fff4" : "#d9eaff";
        ctx.fillText(state.won ? "The lake is blooming." : "The tile stack is empty.", h.x + 24, h.y + 78);
      }

      const canDiscard = !!state.current && !hasLegalPlacementAnyRotation();
      drawButton(ui.rotate, "Rotate", "#2f6674", !!state.current && !state.over);
      drawButton(ui.discard, "Discard", canDiscard ? "#6b5572" : "#314654", canDiscard);

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
      if (pointIn(ui.reset, p.x, p.y)) { e.preventDefault(); sendAction({ type: "reset" }); return; }
      if (pointIn(ui.rotate, p.x, p.y)) { e.preventDefault(); sendAction({ type: "rotate" }); return; }
      if (pointIn(ui.discard, p.x, p.y)) { e.preventDefault(); sendAction({ type: "discard" }); return; }
      const cell = screenCell(p.x, p.y);
      if (cell && legalAt(cell.x, cell.y)) {
        e.preventDefault();
        activePointerId = e.pointerId ?? null;
        canvas.setPointerCapture?.(activePointerId);
        sendAction({ type: "place", x: cell.x, y: cell.y });
      }
    }

    function onPointerUp() {
      if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
      activePointerId = null;
    }

    function onKeyDown(e) {
      if (e.key === "r" || e.key === "R" || e.key === " ") { e.preventDefault(); sendAction({ type: "rotate" }); }
      else if (e.key === "d" || e.key === "D") { e.preventDefault(); sendAction({ type: "discard" }); }
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
          canvas.addEventListener("pointerup", onPointerUp);
          canvas.addEventListener("pointercancel", onPointerUp);
          canvas.addEventListener("lostpointercapture", onPointerUp);
        } else {
          canvas.addEventListener("touchstart", onPointerDown, { passive: false });
          window.addEventListener("touchend", onPointerUp);
          window.addEventListener("touchcancel", onPointerUp);
          canvas.addEventListener("mousedown", onPointerDown);
          window.addEventListener("mouseup", onPointerUp);
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
          canvas.removeEventListener("pointerup", onPointerUp);
          canvas.removeEventListener("pointercancel", onPointerUp);
          canvas.removeEventListener("lostpointercapture", onPointerUp);
        } else {
          canvas.removeEventListener("touchstart", onPointerDown);
          window.removeEventListener("touchend", onPointerUp);
          window.removeEventListener("touchcancel", onPointerUp);
          canvas.removeEventListener("mousedown", onPointerDown);
          window.removeEventListener("mouseup", onPointerUp);
        }
        window.removeEventListener("keydown", onKeyDown);
      },
      onPeerInput(id, input) { handleAction(id, input); },
      onState(snapshot) { applySnapshot(snapshot); },
      getSnapshot() { return currentSnapshot(); },
      onPlayerList() {},
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
