/* Multiplayer Paint Panic for browserP2P.
 * Host owns the arena, paint grid, player motion, scoring, and round timer.
 */
(function () {
  "use strict";

  const GRID_W = 36;
  const GRID_H = 24;
  const SNAPSHOT_HZ = 15;
  const FULL_SNAPSHOT_INTERVAL_MS = 5000;
  const ROUND_MS = 120000;
  const PLAYER_R = 0.024;
  const BASE_SPEED = 0.28;
  const PAINT_RADIUS = 1;

  function create(host, initialState) {
    const canvas = host.canvas;
    const ctx = canvas.getContext("2d");
    const myId = host.myId;

    let rafId = 0;
    let lastTs = 0;
    let lastSnapshotAt = 0;
    let lastFullSnapshotAt = 0;
    let forceFullSnapshot = true;
    let lastCssWidth = 0;
    let lastCssHeight = 0;
    let activePointerId = null;
    let dragging = false;
    let audioCtx = null;
    let eventSeq = 0;
    let seenEventSeq = 0;
    let rect = { x: 0, y: 0, w: 1, h: 1, cell: 1 };
    const events = [];
    const particles = [];

    const state = {
      startedAt: 0,
      now: 0,
      round: 1,
      over: false,
      grid: [],
      players: {},
      scores: {},
    };
    const dirtyPaint = new Set();

    function now() { return performance.now(); }
    function isHost() { return !!host.isHost(); }
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function rand(min, max) { return min + Math.random() * (max - min); }
    function choice(list) { return list[Math.floor(Math.random() * list.length)]; }
    function profile(id) {
      return host.getPlayers().find((p) => p.id === id) || host.getProfile?.(id) || { id, name: "Player", color: "#7cfc9b", icon: "●" };
    }
    function colorFor(id) { return profile(id).color || "#7cfc9b"; }
    function key(x, y) { return y * GRID_W + x; }

    function playSound(kind, power = 1) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const tones = {
          paint: [260, 0.045, 0.018, "square"],
          splat: [140, 0.10, 0.045, "sawtooth"],
          bump: [90, 0.08, 0.040, "square"],
          round: [720, 0.22, 0.060, "triangle"],
        };
        const [freq, dur, vol, type] = tones[kind] || tones.paint;
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        if (kind === "round") osc.frequency.exponentialRampToValueAtTime(freq * 1.6, t + dur);
        else osc.frequency.exponentialRampToValueAtTime(Math.max(45, freq * 0.55), t + dur);
        gain.gain.setValueAtTime(vol * clamp(power, 0.35, 1.8), t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + dur);
      } catch {}
    }

    function burst(x, y, color, count, power = 1) {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = rand(0.08, 0.38) * power;
        particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, color, life: rand(320, 760), maxLife: 760, size: rand(3, 7) });
      }
      if (particles.length > 240) particles.splice(0, particles.length - 240);
    }

    function emitEvent(kind, x, y, power = 1, color = "#ffffff", text = "") {
      const evt = { seq: ++eventSeq, kind, x, y, power, color, text };
      events.push(evt);
      while (events.length > 32) events.shift();
      seenEventSeq = Math.max(seenEventSeq, evt.seq);
      playEvent(evt);
    }

    function playEvent(evt) {
      playSound(evt.kind, evt.power || 1);
      if (evt.kind === "paint") burst(evt.x, evt.y, evt.color, 8, 0.55);
      else if (evt.kind === "splat") burst(evt.x, evt.y, evt.color, 38, 1.2);
      else if (evt.kind === "bump") burst(evt.x, evt.y, "#ffffff", 16, 0.8);
      else if (evt.kind === "round") burst(0.5, 0.5, "#ffd35a", 54, 1.4);
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

    function emptyGrid() { return new Array(GRID_W * GRID_H).fill(null); }
    function tileAtNorm(x, y) {
      return { tx: clamp(Math.floor(x * GRID_W), 0, GRID_W - 1), ty: clamp(Math.floor(y * GRID_H), 0, GRID_H - 1) };
    }

    function paintAt(id, x, y, radius = PAINT_RADIUS) {
      const { tx, ty } = tileAtNorm(x, y);
      let changed = 0;
      for (let yy = ty - radius; yy <= ty + radius; yy++) {
        for (let xx = tx - radius; xx <= tx + radius; xx++) {
          if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H) continue;
          if (Math.hypot(xx - tx, yy - ty) > radius + 0.25) continue;
          const k = key(xx, yy);
          if (state.grid[k] !== id) { state.grid[k] = id; dirtyPaint.add(k); changed++; }
        }
      }
      if (changed) state.scores[id] = (state.scores[id] || 0) + changed;
      return changed;
    }

    function clearAndRestart() {
      state.startedAt = Date.now();
      state.now = state.startedAt;
      state.over = false;
      state.round++;
      state.grid = emptyGrid();
      dirtyPaint.clear();
      forceFullSnapshot = true;
      state.scores = {};
      for (const p of Object.values(state.players)) {
        p.x = rand(0.12, 0.88);
        p.y = rand(0.18, 0.88);
        p.vx = 0;
        p.vy = 0;
        p.targetX = p.x;
        p.targetY = p.y;
        state.scores[p.id] = 0;
      }
      emitEvent("round", 0.5, 0.5, 1.2, "#ffd35a");
    }

    function resetHostState() {
      state.startedAt = Date.now();
      state.now = state.startedAt;
      state.round = 1;
      state.over = false;
      state.grid = emptyGrid();
      dirtyPaint.clear();
      forceFullSnapshot = true;
      state.players = {};
      state.scores = {};
      syncPlayerList();
    }

    function syncPlayerList() {
      if (!isHost()) return;
      const live = new Set(host.getPlayers().map((p) => p.id));
      Object.keys(state.players).forEach((id) => { if (!live.has(id)) delete state.players[id]; });
      Object.keys(state.scores).forEach((id) => { if (!live.has(id)) delete state.scores[id]; });
      for (const p of host.getPlayers()) {
        if (!state.players[p.id]) {
          state.players[p.id] = { id: p.id, x: rand(0.14, 0.86), y: rand(0.18, 0.84), vx: 0, vy: 0, targetX: 0.5, targetY: 0.5 };
          state.players[p.id].targetX = state.players[p.id].x;
          state.players[p.id].targetY = state.players[p.id].y;
        }
        if (state.scores[p.id] == null) state.scores[p.id] = 0;
      }
    }

    function handleAction(id, input) {
      if (!isHost() || !input) return;
      const p = state.players[id];
      if (!p) return;
      if (input.type === "move") {
        p.targetX = clamp(Number(input.x) || p.x, PLAYER_R, 1 - PLAYER_R);
        p.targetY = clamp(Number(input.y) || p.y, PLAYER_R, 1 - PLAYER_R);
      } else if (input.type === "splat") {
        paintAt(id, p.x, p.y, 3);
        emitEvent("splat", p.x, p.y, 1.0, colorFor(id));
      } else if (input.type === "restart" && state.over) {
        clearAndRestart();
      }
    }

    function sendAction(input) {
      if (isHost()) handleAction(myId, input);
      else host.sendInput(input);
    }

    function updatePlayers(dt) {
      for (const p of Object.values(state.players)) {
        const speed = BASE_SPEED;
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.002) {
          const move = Math.min(d, speed * dt);
          p.x += dx / d * move;
          p.y += dy / d * move;
        }
        const changed = paintAt(p.id, p.x, p.y, PAINT_RADIUS);
        if (changed > 0 && Math.random() < 0.10) emitEvent("paint", p.x, p.y, 0.45, colorFor(p.id));
      }

      const list = Object.values(state.players);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy);
          if (d > 0 && d < PLAYER_R * 2) {
            const nx = dx / d, ny = dy / d;
            const push = (PLAYER_R * 2 - d) * 0.5;
            a.x -= nx * push; a.y -= ny * push;
            b.x += nx * push; b.y += ny * push;
            emitEvent("bump", (a.x + b.x) / 2, (a.y + b.y) / 2, 0.55, "#ffffff");
          }
        }
      }
    }

    function updateHost(dt) {
      syncPlayerList();
      state.now = Date.now();
      if (!state.over && state.now - state.startedAt >= ROUND_MS) {
        state.over = true;
        emitEvent("round", 0.5, 0.5, 1.4, "#ffd35a");
      }
      if (state.over) return;
      updatePlayers(dt);
    }

    function makeSnapshot(full = false) {
      full = !!full;
      const gridDelta = full ? null : [...dirtyPaint].map((i) => [i, state.grid[i] || null]);
      const snapshot = {
        full,
        startedAt: state.startedAt,
        now: state.now,
        round: state.round,
        over: state.over,
        grid: full ? state.grid.slice() : undefined,
        gridDelta,
        players: state.players,
        scores: state.scores,
        events: events.slice(-18),
      };
      dirtyPaint.clear();
      if (full) forceFullSnapshot = false;
      return snapshot;
    }

    function applySnapshot(s) {
      if (!s) return;
      state.startedAt = s.startedAt || Date.now();
      state.now = s.now || Date.now();
      state.round = s.round || 1;
      state.over = !!s.over;
      if (s.full || Array.isArray(s.grid)) state.grid = Array.isArray(s.grid) ? s.grid.slice() : emptyGrid();
      if (Array.isArray(s.gridDelta)) {
        if (!Array.isArray(state.grid) || state.grid.length !== GRID_W * GRID_H) state.grid = emptyGrid();
        for (const [i, owner] of s.gridDelta) {
          if (i >= 0 && i < state.grid.length) state.grid[i] = owner || null;
        }
      }
      state.players = { ...(s.players || {}) };
      state.scores = { ...(s.scores || {}) };
      applyEvents(s.events);
    }

    function currentSnapshot() { return makeSnapshot(true); }

    function resize() {
      const box = canvas.getBoundingClientRect();
      lastCssWidth = box.width;
      lastCssHeight = box.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(box.width * dpr));
      canvas.height = Math.max(1, Math.round(box.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function ensureCanvasSize() {
      const box = canvas.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      if (Math.abs(box.width - lastCssWidth) > 1 || Math.abs(box.height - lastCssHeight) > 1 || canvas.width <= 1 || canvas.height <= 1) resize();
      return true;
    }

    function layout() {
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      const hudH = Math.max(64, Math.min(86, H * 0.13));
      const pad = Math.max(8, Math.min(18, W * 0.025));
      const availW = W - pad * 2;
      const availH = H - hudH - pad * 1.5;
      const cell = Math.floor(Math.min(availW / GRID_W, availH / GRID_H));
      rect.cell = Math.max(6, cell);
      rect.w = rect.cell * GRID_W;
      rect.h = rect.cell * GRID_H;
      rect.x = Math.floor((W - rect.w) / 2);
      rect.y = Math.floor(hudH + (availH - rect.h) / 2);
    }

    function sx(x) { return rect.x + x * rect.w; }
    function sy(y) { return rect.y + y * rect.h; }
    function gridPoint(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      return { x: clamp((clientX - box.left - rect.x) / rect.w, 0, 1), y: clamp((clientY - box.top - rect.y) / rect.h, 0, 1) };
    }

    function drawPixelRect(x, y, w, h, color) {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    }

    function drawArena() {
      ctx.fillStyle = "#111426";
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      drawPixelRect(rect.x - 6, rect.y - 6, rect.w + 12, rect.h + 12, "#222840");
      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          const owner = state.grid[key(x, y)];
          const base = (x + y) % 2 ? "#252a43" : "#20253c";
          drawPixelRect(rect.x + x * rect.cell, rect.y + y * rect.cell, rect.cell, rect.cell, owner ? colorFor(owner) : base);
          if (owner) drawPixelRect(rect.x + x * rect.cell, rect.y + y * rect.cell, rect.cell, Math.max(1, rect.cell * 0.18), "rgba(255,255,255,0.16)");
        }
      }
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      for (let x = 0; x <= GRID_W; x += 4) {
        ctx.beginPath(); ctx.moveTo(rect.x + x * rect.cell, rect.y); ctx.lineTo(rect.x + x * rect.cell, rect.y + rect.h); ctx.stroke();
      }
      for (let y = 0; y <= GRID_H; y += 4) {
        ctx.beginPath(); ctx.moveTo(rect.x, rect.y + y * rect.cell); ctx.lineTo(rect.x + rect.w, rect.y + y * rect.cell); ctx.stroke();
      }
    }

    function drawPlayers() {
      for (const p of Object.values(state.players)) {
        const prof = profile(p.id);
        const x = sx(p.x);
        const y = sy(p.y);
        const r = Math.max(13, rect.cell * 1.15);
        if (host.isSpeaking?.(p.id)) {
          const pulse = 0.5 + 0.5 * Math.abs(Math.sin(now() / 220));
          ctx.strokeStyle = `rgba(124,252,155,${0.5 + pulse * 0.5})`;
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(x, y, r + 5 + pulse * 4, 0, Math.PI * 2); ctx.stroke();
        }
        drawPixelRect(x - r, y - r, r * 2, r * 2, prof.color || "#7cfc9b");
        if (p.id === myId) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 3;
          ctx.strokeRect(Math.round(x - r), Math.round(y - r), Math.round(r * 2), Math.round(r * 2));
        }
        ctx.fillStyle = "#111";
        ctx.font = Math.floor(r * 1.1) + "px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(prof.icon || "●", x, y + 1);
        ctx.font = "800 11px system-ui, sans-serif";
        ctx.fillStyle = "#fff";
        ctx.fillText((host.hostCrown?.(p.id) || "") + (prof.name || "Player"), x, y - r - 12);
      }
    }

    function updateEffects(dtMs) {
      const dt = dtMs / 1000;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.94;
        p.vy *= 0.94;
        p.life -= dtMs;
        if (p.life <= 0) particles.splice(i, 1);
      }
    }

    function drawEffects() {
      for (const p of particles) {
        const a = Math.max(0, p.life / p.maxLife);
        const hex = /^#?([0-9a-f]{6})$/i.exec(p.color || "");
        if (hex) {
          const n = parseInt(hex[1], 16);
          ctx.fillStyle = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
        } else ctx.fillStyle = `rgba(255,255,255,${a})`;
        drawPixelRect(sx(p.x), sy(p.y), p.size * a, p.size * a, ctx.fillStyle);
      }
    }

    function rankings() {
      return host.getPlayers().map((p) => ({ id: p.id, name: p.name, color: p.color, icon: p.icon, score: state.scores[p.id] || 0 }))
        .sort((a, b) => b.score - a.score);
    }

    function drawHud() {
      const W = canvas.clientWidth;
      ctx.fillStyle = "rgba(7,9,20,0.88)";
      ctx.fillRect(0, 0, W, rect.y - 8);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#eef0ff";
      ctx.font = "900 17px system-ui, sans-serif";
      ctx.fillText("🎨 Paint Panic", 12, 18);
      const left = Math.max(0, ROUND_MS - ((state.now || Date.now()) - state.startedAt));
      ctx.font = "800 13px system-ui, sans-serif";
      ctx.fillStyle = state.over ? "#ffd35a" : "#9fb3d9";
      ctx.fillText(state.over ? "Round over · tap to restart" : "Time " + Math.ceil(left / 1000) + "s · drag to paint · double tap to splat", 12, 40);
      let x = 12;
      const y = 61;
      ctx.font = "800 12px system-ui, sans-serif";
      for (const row of rankings().slice(0, 5)) {
        const label = (host.hostCrown?.(row.id) || "") + row.name + " " + row.score;
        ctx.fillStyle = row.color || "#fff";
        ctx.fillText(label, x, y);
        x += Math.min(160, ctx.measureText(label).width + 26);
      }
    }

    function drawOverlay() {
      if (!state.over) return;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, W, H);
      const rows = rankings();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff";
      ctx.font = "900 28px system-ui, sans-serif";
      ctx.fillText("Round Over", W / 2, H * 0.34);
      ctx.font = "800 18px system-ui, sans-serif";
      rows.slice(0, 4).forEach((r, i) => {
        ctx.fillStyle = r.color || "#fff";
        ctx.fillText((i + 1) + ". " + r.name + " — " + r.score, W / 2, H * 0.43 + i * 28);
      });
      ctx.fillStyle = "#d8e6ff";
      ctx.font = "700 14px system-ui, sans-serif";
      ctx.fillText("Tap anywhere to start a new round", W / 2, H * 0.68);
    }

    function draw() {
      if (!ensureCanvasSize()) return;
      layout();
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      drawArena();
      drawEffects();
      drawPlayers();
      drawHud();
      drawOverlay();
    }

    function pointerPoint(e) {
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
      return gridPoint(touch.clientX, touch.clientY);
    }

    function onPointerDown(e) {
      e.preventDefault();
      if (state.over) { sendAction({ type: "restart" }); return; }
      dragging = true;
      activePointerId = e.pointerId ?? null;
      canvas.setPointerCapture?.(activePointerId);
      const p = pointerPoint(e);
      sendAction({ type: "move", x: p.x, y: p.y });
    }

    function onPointerMove(e) {
      if (!dragging) return;
      e.preventDefault();
      const p = pointerPoint(e);
      sendAction({ type: "move", x: p.x, y: p.y });
    }

    function onPointerUp(e) {
      if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
      activePointerId = null;
      dragging = false;
    }

    function onDblClick(e) {
      e.preventDefault();
      sendAction({ type: "splat" });
    }

    function loop(ts) {
      rafId = requestAnimationFrame(loop);
      if (!lastTs) lastTs = ts;
      const frameMs = ts - lastTs;
      const dt = Math.min(0.05, frameMs / 1000);
      lastTs = ts;
      if (isHost()) {
        updateHost(dt);
        if (ts - lastSnapshotAt >= 1000 / SNAPSHOT_HZ) {
          lastSnapshotAt = ts;
          const full = forceFullSnapshot || ts - lastFullSnapshotAt >= FULL_SNAPSHOT_INTERVAL_MS;
          if (full) lastFullSnapshotAt = ts;
          host.broadcastState(makeSnapshot(full));
        }
      } else {
        state.now = Date.now();
      }
      updateEffects(frameMs || 16);
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
        } else {
          canvas.addEventListener("touchstart", onPointerDown, { passive: false });
          window.addEventListener("touchmove", onPointerMove, { passive: false });
          window.addEventListener("touchend", onPointerUp);
          window.addEventListener("touchcancel", onPointerUp);
          canvas.addEventListener("mousedown", onPointerDown);
          window.addEventListener("mousemove", onPointerMove);
          window.addEventListener("mouseup", onPointerUp);
        }
        canvas.addEventListener("dblclick", onDblClick);
        rafId = requestAnimationFrame(loop);
      },
      destroy() {
        cancelAnimationFrame(rafId);
        if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
        activePointerId = null;
        dragging = false;
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
        canvas.removeEventListener("dblclick", onDblClick);
      },
      onPeerInput(id, input) { handleAction(id, input); },
      onState(snapshot) { applySnapshot(snapshot); },
      getSnapshot() { return currentSnapshot(); },
      onPlayerList() { syncPlayerList(); },
      restart() { if (isHost()) clearAndRestart(); },
    };
  }

  window.BP2PGames = window.BP2PGames || {};
  window.BP2PGames["paint-panic"] = {
    id: "paint-panic",
    name: "Paint Panic",
    emoji: "🎨",
    create,
  };
})();
