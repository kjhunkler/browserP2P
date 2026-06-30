/* Multiplayer Air Hockey for browserP2P.
 * Host owns seats, scores, mallets, and puck physics. Clients send drag/seat actions.
 */
(function () {
  "use strict";

  const SNAPSHOT_HZ = 24;
  const MALLET_R = 0.075;
  const PUCK_R = 0.036;
  const GOAL_W = 0.42;
  const MAX_PUCK_SPEED = 1.75;
  const FRICTION = 0.55;
  const WALL_RESTITUTION = 0.94;
  const HIT_RESTITUTION = 0.92;

  function create(host, initialState) {
    const canvas = host.canvas;
    const ctx = canvas.getContext("2d");
    const myId = host.myId;

    let rafId = 0;
    let lastTs = 0;
    let lastSnapshotAt = 0;
    let activePointerId = null;
    let dragging = false;
    let rects = { stands: null, table: null };

    const state = {
      seats: { a: null, b: null },
      scores: {},
      mallets: {},
      puck: { x: 0.5, y: 0.5, vx: 0, vy: 0 },
      playing: false,
      lastScoredBy: null,
    };

    function now() { return performance.now(); }
    function isHost() { return !!host.isHost(); }
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function seatOf(id) {
      if (state.seats.a === id) return "a";
      if (state.seats.b === id) return "b";
      return null;
    }
    function playerById(id) {
      return host.getPlayers().find((p) => p.id === id) || null;
    }
    function profile(id) {
      return playerById(id) || host.getProfile?.(id) || { id, name: "Player", color: "#7cfc9b", icon: "●" };
    }
    function score(id) { return id ? (state.scores[id] || 0) : 0; }
    function ensureScore(id) {
      if (id && state.scores[id] == null) state.scores[id] = 0;
    }
    function seatStart(seat) {
      return seat === "a" ? { x: 0.5, y: 0.78 } : { x: 0.5, y: 0.22 };
    }
    function resetPuck() {
      state.puck.x = 0.5;
      state.puck.y = 0.5;
      state.puck.vx = 0;
      state.puck.vy = 0;
      state.playing = false;
    }
    function servePuck() {
      const angle = (Math.random() * 0.9 + 0.35) * Math.PI;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const speed = 0.72;
      state.puck.x = 0.5;
      state.puck.y = 0.5;
      state.puck.vx = Math.cos(angle) * speed;
      state.puck.vy = Math.abs(Math.sin(angle)) * speed * dir;
      state.playing = true;
      state.lastScoredBy = null;
    }
    function maybeStart() {
      if (state.seats.a && state.seats.b && !state.playing) servePuck();
    }
    function resetHostState() {
      state.seats.a = null;
      state.seats.b = null;
      state.scores = {};
      state.mallets = {};
      resetPuck();
      syncPlayerList();
    }

    function syncPlayerList() {
      if (!isHost()) return;
      const live = new Set(host.getPlayers().map((p) => p.id));
      for (const id of Object.keys(state.mallets)) if (!live.has(id)) delete state.mallets[id];
      for (const id of Object.keys(state.scores)) if (!live.has(id)) delete state.scores[id];
      if (state.seats.a && !live.has(state.seats.a)) state.seats.a = null;
      if (state.seats.b && !live.has(state.seats.b)) state.seats.b = null;
      for (const p of host.getPlayers()) ensureScore(p.id);
      for (const seat of ["a", "b"]) {
        const id = state.seats[seat];
        if (id && !state.mallets[id]) state.mallets[id] = { ...seatStart(seat), vx: 0, vy: 0, t: now() };
      }
      if (!state.seats.a || !state.seats.b) resetPuck();
      else maybeStart();
    }

    function claimSeat(id) {
      if (seatOf(id)) return;
      const seat = !state.seats.a ? "a" : (!state.seats.b ? "b" : null);
      if (!seat) return;
      state.seats[seat] = id;
      ensureScore(id);
      state.mallets[id] = { ...seatStart(seat), vx: 0, vy: 0, t: now() };
      maybeStart();
    }

    function leaveSeat(id) {
      const seat = seatOf(id);
      if (!seat) return;
      state.seats[seat] = null;
      delete state.mallets[id];
      resetPuck();
    }

    function moveMallet(id, x, y) {
      const seat = seatOf(id);
      if (!seat) return;
      const t = now();
      const old = state.mallets[id] || { ...seatStart(seat), vx: 0, vy: 0, t };
      const minY = seat === "a" ? 0.5 + MALLET_R : MALLET_R;
      const maxY = seat === "a" ? 1 - MALLET_R : 0.5 - MALLET_R;
      x = clamp(x, MALLET_R, 1 - MALLET_R);
      y = clamp(y, minY, maxY);
      const dt = Math.max(0.016, Math.min(0.12, (t - (old.t || t)) / 1000));
      state.mallets[id] = {
        x,
        y,
        vx: clamp((x - old.x) / dt, -2.4, 2.4),
        vy: clamp((y - old.y) / dt, -2.4, 2.4),
        t,
      };
    }

    function handleAction(id, input) {
      if (!isHost() || !input) return;
      if (input.type === "claim") claimSeat(id);
      else if (input.type === "stand") leaveSeat(id);
      else if (input.type === "move") moveMallet(id, Number(input.x), Number(input.y));
    }

    function sendAction(input) {
      if (isHost()) handleAction(myId, input);
      else host.sendInput(input);
    }

    function goalForY(y) {
      const inGoal = Math.abs(state.puck.x - 0.5) <= GOAL_W / 2;
      if (!inGoal) return null;
      if (y < -PUCK_R) return "a";
      if (y > 1 + PUCK_R) return "b";
      return null;
    }

    function scoreGoal(seat) {
      const id = state.seats[seat];
      if (id) state.scores[id] = (state.scores[id] || 0) + 1;
      state.lastScoredBy = id || null;
      resetPuck();
      if (state.seats.a && state.seats.b) setTimeout(() => { if (isHost() && state.seats.a && state.seats.b && !state.playing) servePuck(); }, 700);
    }

    function collideMallet(m) {
      const puck = state.puck;
      const dx = puck.x - m.x;
      const dy = puck.y - m.y;
      const minD = MALLET_R + PUCK_R;
      const d2 = dx * dx + dy * dy;
      if (d2 <= 0 || d2 >= minD * minD) return;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      puck.x = m.x + nx * minD;
      puck.y = m.y + ny * minD;
      const rel = (puck.vx - (m.vx || 0)) * nx + (puck.vy - (m.vy || 0)) * ny;
      if (rel < 0.25) {
        puck.vx -= (1 + HIT_RESTITUTION) * rel * nx;
        puck.vy -= (1 + HIT_RESTITUTION) * rel * ny;
      }
      puck.vx += (m.vx || 0) * 0.42;
      puck.vy += (m.vy || 0) * 0.42;
      const speed = Math.hypot(puck.vx, puck.vy);
      if (speed < 0.42) {
        puck.vx += nx * 0.34;
        puck.vy += ny * 0.34;
      }
    }

    function updatePhysics(dt) {
      if (!state.playing) return;
      const puck = state.puck;
      puck.x += puck.vx * dt;
      puck.y += puck.vy * dt;

      const scored = goalForY(puck.y);
      if (scored) { scoreGoal(scored); return; }

      if (puck.x < PUCK_R) { puck.x = PUCK_R; puck.vx = Math.abs(puck.vx) * WALL_RESTITUTION; }
      if (puck.x > 1 - PUCK_R) { puck.x = 1 - PUCK_R; puck.vx = -Math.abs(puck.vx) * WALL_RESTITUTION; }

      const goalLeft = 0.5 - GOAL_W / 2;
      const goalRight = 0.5 + GOAL_W / 2;
      const outsideGoal = puck.x < goalLeft || puck.x > goalRight;
      if (outsideGoal && puck.y < PUCK_R) { puck.y = PUCK_R; puck.vy = Math.abs(puck.vy) * WALL_RESTITUTION; }
      if (outsideGoal && puck.y > 1 - PUCK_R) { puck.y = 1 - PUCK_R; puck.vy = -Math.abs(puck.vy) * WALL_RESTITUTION; }

      for (const id of [state.seats.a, state.seats.b]) {
        if (id && state.mallets[id]) collideMallet(state.mallets[id]);
      }

      const f = Math.exp(-FRICTION * dt);
      puck.vx *= f;
      puck.vy *= f;
      const speed = Math.hypot(puck.vx, puck.vy);
      if (speed > MAX_PUCK_SPEED) {
        puck.vx = puck.vx / speed * MAX_PUCK_SPEED;
        puck.vy = puck.vy / speed * MAX_PUCK_SPEED;
      }
      if (speed < 0.08 && state.seats.a && state.seats.b) servePuck();
    }

    function makeSnapshot() {
      return {
        seats: { ...state.seats },
        scores: { ...state.scores },
        mallets: JSON.parse(JSON.stringify(state.mallets)),
        puck: { ...state.puck },
        playing: state.playing,
        lastScoredBy: state.lastScoredBy,
      };
    }

    function applySnapshot(s) {
      if (!s) return;
      state.seats = { a: s.seats?.a || null, b: s.seats?.b || null };
      state.scores = { ...(s.scores || {}) };
      state.mallets = { ...(s.mallets || {}) };
      state.puck = { x: 0.5, y: 0.5, vx: 0, vy: 0, ...(s.puck || {}) };
      state.playing = !!s.playing;
      state.lastScoredBy = s.lastScoredBy || null;
    }

    function currentSnapshot() { return makeSnapshot(); }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function viewFlip() {
      const mySeat = seatOf(myId);
      if (mySeat === "b") return true;
      if (!mySeat && state.seats.a && !state.seats.b) return true;
      return false;
    }
    function toView(p) {
      return viewFlip() ? { x: 1 - p.x, y: 1 - p.y } : { x: p.x, y: p.y };
    }
    function fromView(p) {
      return viewFlip() ? { x: 1 - p.x, y: 1 - p.y } : { x: p.x, y: p.y };
    }
    function visibleBottomSeat() { return viewFlip() ? "b" : "a"; }
    function visibleTopSeat() { return viewFlip() ? "a" : "b"; }

    function tableToScreen(p) {
      const v = toView(p);
      return { x: rects.table.x + v.x * rects.table.w, y: rects.table.y + v.y * rects.table.h };
    }
    function screenToTable(x, y) {
      const v = { x: (x - rects.table.x) / rects.table.w, y: (y - rects.table.y) / rects.table.h };
      return fromView(v);
    }
    function pointIn(r, x, y) {
      return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }

    function drawRoundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      ctx.fill();
    }

    function drawPlayerTag(id, x, y, align) {
      if (!id) return;
      const p = profile(id);
      ctx.textAlign = align || "center";
      ctx.textBaseline = "middle";
      ctx.font = "800 13px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.94)";
      ctx.fillText((host.hostCrown?.(id) || "") + (p.name || "Player") + "  " + score(id), x, y);
    }

    function drawStands(W) {
      const r = rects.stands;
      ctx.fillStyle = "rgba(14,15,27,0.94)";
      ctx.fillRect(0, 0, W, r.h);
      ctx.fillStyle = "#8ea0c8";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = "800 13px system-ui, sans-serif";
      ctx.fillText("STANDS", 14, 18);

      const seated = new Set([state.seats.a, state.seats.b].filter(Boolean));
      const observers = host.getPlayers().filter((p) => !seated.has(p.id));
      let x = 14;
      let y = 45;
      if (!observers.length) {
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillStyle = "#6f7896";
        ctx.fillText("Tap here to leave the table", x, y);
        return;
      }
      for (const p of observers) {
        const label = (host.hostCrown?.(p.id) || "") + (p.name || "Player") + " " + score(p.id);
        const w = Math.min(160, Math.max(72, ctx.measureText(label).width + 42));
        if (x + w > W - 12) { x = 14; y += 30; }
        ctx.fillStyle = p.color || "#7cfc9b";
        ctx.beginPath(); ctx.arc(x + 13, y, 11, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#111";
        ctx.textAlign = "center";
        ctx.font = "12px serif";
        ctx.fillText(p.icon || "●", x + 13, y + 1);
        ctx.textAlign = "left";
        ctx.font = "700 12px system-ui, sans-serif";
        ctx.fillStyle = "#eef0ff";
        ctx.fillText(label, x + 30, y);
        x += w;
      }
    }

    function drawTable() {
      const t = rects.table;
      const bottomSeat = visibleBottomSeat();
      const topSeat = visibleTopSeat();
      ctx.save();
      ctx.fillStyle = "#0d1c32";
      drawRoundRect(t.x - 6, t.y - 6, t.w + 12, t.h + 12, 24);
      const grad = ctx.createLinearGradient(0, t.y, 0, t.y + t.h);
      grad.addColorStop(0, "#4b1822");
      grad.addColorStop(0.49, "#241c32");
      grad.addColorStop(0.51, "#14345d");
      grad.addColorStop(1, "#0e63c8");
      ctx.fillStyle = grad;
      drawRoundRect(t.x, t.y, t.w, t.h, 20);

      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(t.x + 12, t.y + t.h / 2);
      ctx.lineTo(t.x + t.w - 12, t.y + t.h / 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(t.x + t.w / 2, t.y + t.h / 2, Math.min(t.w, t.h) * 0.09, 0, Math.PI * 2);
      ctx.stroke();

      const goalPx = t.w * GOAL_W;
      ctx.strokeStyle = "#8fe3ff";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(t.x + (t.w - goalPx) / 2, t.y + t.h - 1);
      ctx.lineTo(t.x + (t.w + goalPx) / 2, t.y + t.h - 1);
      ctx.stroke();
      ctx.strokeStyle = "#ff9aa8";
      ctx.beginPath();
      ctx.moveTo(t.x + (t.w - goalPx) / 2, t.y + 1);
      ctx.lineTo(t.x + (t.w + goalPx) / 2, t.y + 1);
      ctx.stroke();

      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.font = "900 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("BLUE ZONE", t.x + t.w / 2, t.y + t.h * 0.76);

      drawPlayerTag(state.seats[topSeat], t.x + t.w / 2, t.y + 18, "center");
      drawPlayerTag(state.seats[bottomSeat], t.x + t.w / 2, t.y + t.h - 18, "center");
      if (!state.seats[bottomSeat] && !seatOf(myId)) {
        ctx.fillStyle = "rgba(124,252,155,0.12)";
        ctx.fillRect(t.x + 8, t.y + t.h / 2 + 8, t.w - 16, t.h / 2 - 16);
        ctx.fillStyle = "#d8ffe2";
        ctx.font = "900 18px system-ui, sans-serif";
        ctx.fillText("Tap blue zone to play", t.x + t.w / 2, t.y + t.h * 0.68);
      }
      ctx.restore();
    }

    function drawDisc(id, p, isPuck) {
      const s = tableToScreen(p);
      const r = (isPuck ? PUCK_R : MALLET_R) * Math.min(rects.table.w, rects.table.h);
      if (isPuck) {
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.beginPath(); ctx.arc(s.x + 3, s.y + 4, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#f3f6ff";
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#aeb9d7";
        ctx.lineWidth = 3;
        ctx.stroke();
        return;
      }
      const pInfo = profile(id);
      if (host.isSpeaking?.(id)) {
        const pulse = 0.5 + 0.5 * Math.abs(Math.sin(now() / 220));
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 5 + pulse * 5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(124,252,155,${0.5 + 0.5 * pulse})`;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.fillStyle = pInfo.color || "#7cfc9b";
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
      if (id === myId) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.fillStyle = "#111";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = Math.floor(r * 0.78) + "px serif";
      ctx.fillText(pInfo.icon || "●", s.x, s.y + 1);
    }

    function draw() {
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      const standsH = Math.max(74, Math.min(118, H * 0.18));
      const margin = Math.max(10, Math.min(18, W * 0.035));
      rects = {
        stands: { x: 0, y: 0, w: W, h: standsH },
        table: { x: margin, y: standsH + 10, w: W - margin * 2, h: H - standsH - 18 },
      };
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#080914";
      ctx.fillRect(0, 0, W, H);
      drawStands(W);
      drawTable();
      drawDisc(null, state.puck, true);
      for (const id of [state.seats.a, state.seats.b]) if (id && state.mallets[id]) drawDisc(id, state.mallets[id], false);
      if (!state.playing && state.seats.a && state.seats.b) {
        ctx.fillStyle = "rgba(0,0,0,0.38)";
        ctx.fillRect(rects.table.x, rects.table.y + rects.table.h / 2 - 22, rects.table.w, 44);
        ctx.fillStyle = "#fff";
        ctx.font = "900 16px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Serving…", rects.table.x + rects.table.w / 2, rects.table.y + rects.table.h / 2);
      }
    }

    function pointerPoint(e) {
      const r = canvas.getBoundingClientRect();
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
      return { x: touch.clientX - r.left, y: touch.clientY - r.top };
    }

    function onPointerDown(e) {
      const p = pointerPoint(e);
      if (pointIn(rects.stands, p.x, p.y)) {
        e.preventDefault();
        if (seatOf(myId)) sendAction({ type: "stand" });
        return;
      }
      if (!pointIn(rects.table, p.x, p.y)) return;
      e.preventDefault();
      const bottomSeat = visibleBottomSeat();
      const viewY = (p.y - rects.table.y) / rects.table.h;
      if (!seatOf(myId)) {
        if (!state.seats[bottomSeat] && viewY >= 0.5) sendAction({ type: "claim" });
        return;
      }
      dragging = true;
      activePointerId = e.pointerId ?? null;
      canvas.setPointerCapture?.(activePointerId);
      onPointerMove(e);
    }

    function onPointerMove(e) {
      if (!dragging || !seatOf(myId)) return;
      const p = pointerPoint(e);
      e.preventDefault();
      const c = screenToTable(p.x, p.y);
      sendAction({ type: "move", x: c.x, y: c.y });
    }

    function onPointerUp(e) {
      if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
      activePointerId = null;
      dragging = false;
    }

    function loop(ts) {
      rafId = requestAnimationFrame(loop);
      if (!lastTs) lastTs = ts;
      const dt = Math.min(0.05, (ts - lastTs) / 1000);
      lastTs = ts;
      if (isHost()) {
        syncPlayerList();
        updatePhysics(dt);
        if (ts - lastSnapshotAt >= 1000 / SNAPSHOT_HZ) {
          lastSnapshotAt = ts;
          host.broadcastState(makeSnapshot());
        }
      }
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
      },
      onPeerInput(id, input) { handleAction(id, input); },
      onState(snapshot) { applySnapshot(snapshot); },
      getSnapshot() { return currentSnapshot(); },
      onPlayerList() { syncPlayerList(); },
      restart() { if (isHost()) resetHostState(); },
    };
  }

  window.BP2PGames = window.BP2PGames || {};
  window.BP2PGames["air-hockey"] = {
    id: "air-hockey",
    name: "Air Hockey",
    emoji: "🏒",
    create,
  };
})();
