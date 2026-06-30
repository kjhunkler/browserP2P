/* Multiplayer Tower Tumble for browserP2P.
 * Host owns rigid-body blocks, gravity, collision solving, and scoring.
 */
(function () {
  "use strict";

  const SNAPSHOT_HZ = 20;
  const PHYSICS_DT = 1 / 60;
  const GRAVITY = 1.25;
  const FLOOR_Y = 0.90;
  const WALL_PAD = 0.055;
  const BLOCK_LIMIT = 90;
  const SOLVER_PASSES = 10;
  const LINEAR_DAMPING = 0.992;
  const ANGULAR_DAMPING = 0.985;
  const RESTITUTION = 0.03;
  const FRICTION = 0.90;
  const RESTING_SPEED = 0.030;
  const SHAPES = [
    { key: "brick", name: "Brick", w: 0.145, h: 0.050, mass: 1.0, emoji: "▭", color: "#e46b5d" },
    { key: "wide", name: "Wide", w: 0.210, h: 0.040, mass: 1.2, emoji: "▬", color: "#f2a65a" },
    { key: "tall", name: "Tall", w: 0.062, h: 0.150, mass: 1.1, emoji: "▯", color: "#5dade2" },
    { key: "cube", name: "Cube", w: 0.082, h: 0.082, mass: 0.9, emoji: "■", color: "#7bd88f" },
    { key: "heavy", name: "Heavy", w: 0.120, h: 0.065, mass: 1.8, emoji: "▰", color: "#a98bff" },
  ];

  function create(host, initialState) {
    const canvas = host.canvas;
    const ctx = canvas.getContext("2d");
    const myId = host.myId;

    let rafId = 0;
    let lastTs = 0;
    let accumulator = 0;
    let lastSnapshotAt = 0;
    let lastCssWidth = 0;
    let lastCssHeight = 0;
    let activePointerId = null;
    let dragging = false;
    let preview = null;
    let selectedShape = 0;
    let audioCtx = null;
    let eventSeq = 0;
    let seenEventSeq = 0;
    const events = [];
    const particles = [];
    let ui = { shapeRects: [], resetRect: null, play: { x: 0, y: 0, w: 1, h: 1 }, scale: 1 };

    const state = {
      blocks: [],
      scores: {},
      settledBy: {},
      nextId: 1,
      cameraY: 0,
      lastHeight: 0,
    };

    function now() { return performance.now(); }
    function isHost() { return !!host.isHost(); }
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function rand(min, max) { return min + Math.random() * (max - min); }
    function profile(id) {
      return host.getPlayers().find((p) => p.id === id) || host.getProfile?.(id) || { id, name: "Player", color: "#7cfc9b", icon: "▭" };
    }
    function shapeByKey(key) { return SHAPES.find((s) => s.key === key) || SHAPES[0]; }
    function selected() { return SHAPES[selectedShape] || SHAPES[0]; }

    function playSound(kind, power = 1) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const tones = {
          place: [420, 0.07, 0.036, "triangle"],
          hit: [120 + power * 80, 0.045, 0.030, "square"],
          fall: [72, 0.20, 0.050, "sawtooth"],
          score: [650, 0.16, 0.050, "triangle"],
          reset: [220, 0.12, 0.036, "sine"],
        };
        const [freq, dur, vol, type] = tones[kind] || tones.hit;
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        if (kind === "fall") osc.frequency.exponentialRampToValueAtTime(42, t + dur);
        else if (kind === "score") osc.frequency.exponentialRampToValueAtTime(freq * 1.65, t + dur);
        else osc.frequency.exponentialRampToValueAtTime(Math.max(45, freq * 0.72), t + dur);
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
        const s = rand(0.06, 0.26) * power;
        particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, color, life: rand(260, 620), maxLife: 620, size: rand(2.5, 6) });
      }
      if (particles.length > 180) particles.splice(0, particles.length - 180);
    }

    function emitEvent(kind, x, y, power = 1, color = "#ffffff") {
      const evt = { seq: ++eventSeq, kind, x, y, power, color };
      events.push(evt);
      while (events.length > 32) events.shift();
      seenEventSeq = Math.max(seenEventSeq, evt.seq);
      playEvent(evt);
    }

    function playEvent(evt) {
      playSound(evt.kind, evt.power || 1);
      if (evt.kind === "place") burst(evt.x, evt.y, evt.color, 12, 0.7);
      else if (evt.kind === "hit") burst(evt.x, evt.y, "#d8e6ff", 6, evt.power || 0.6);
      else if (evt.kind === "fall") burst(evt.x, evt.y, "#ff9aa8", 30, 1.2);
      else if (evt.kind === "score") burst(evt.x, evt.y, "#ffd35a", 24, 1.0);
      else if (evt.kind === "reset") burst(0.5, 0.55, "#ffffff", 42, 1.3);
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

    function resetHostState() {
      state.blocks = [];
      state.scores = {};
      state.settledBy = {};
      state.nextId = 1;
      state.cameraY = 0;
      state.lastHeight = 0;
      for (const p of host.getPlayers()) state.scores[p.id] = 0;
      addFoundation();
      emitEvent("reset", 0.5, FLOOR_Y, 1, "#ffffff");
    }

    function addFoundation() {
      state.blocks.push(makeBlock("foundation", "system", 0.5, FLOOR_Y + 0.035, 0, { key: "foundation", w: 0.62, h: 0.07, mass: 999, color: "#556070" }, true));
    }

    function syncPlayerList() {
      if (!isHost()) return;
      const live = new Set(host.getPlayers().map((p) => p.id));
      Object.keys(state.scores).forEach((id) => { if (!live.has(id)) delete state.scores[id]; });
      for (const p of host.getPlayers()) if (state.scores[p.id] == null) state.scores[p.id] = 0;
    }

    function inertia(m, w, h) { return m * (w * w + h * h) / 12; }

    function makeBlock(id, owner, x, y, angle, shape, fixed = false) {
      const m = fixed ? 999999 : shape.mass;
      return {
        id,
        owner,
        shape: shape.key,
        x, y, angle,
        vx: 0, vy: 0, av: 0,
        w: shape.w, h: shape.h,
        mass: m,
        invMass: fixed ? 0 : 1 / m,
        invI: fixed ? 0 : 1 / inertia(m, shape.w, shape.h),
        fixed,
        color: shape.color,
        settled: false,
        sleep: 0,
      };
    }

    function corners(b) {
      const c = Math.cos(b.angle), s = Math.sin(b.angle);
      const hw = b.w / 2, hh = b.h / 2;
      return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: b.x + x * c - y * s, y: b.y + x * s + y * c }));
    }

    function axesFor(b) {
      const c = Math.cos(b.angle), s = Math.sin(b.angle);
      return [{ x: c, y: s }, { x: -s, y: c }];
    }

    function project(points, axis) {
      let min = Infinity, max = -Infinity;
      for (const p of points) {
        const v = p.x * axis.x + p.y * axis.y;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      return { min, max };
    }

    function sat(a, b) {
      const ac = corners(a), bc = corners(b);
      let overlap = Infinity;
      let best = null;
      for (const axis of axesFor(a).concat(axesFor(b))) {
        const pa = project(ac, axis), pb = project(bc, axis);
        const o = Math.min(pa.max, pb.max) - Math.max(pa.min, pb.min);
        if (o <= 0) return null;
        if (o < overlap) { overlap = o; best = axis; }
      }
      const dx = b.x - a.x, dy = b.y - a.y;
      if (dx * best.x + dy * best.y < 0) best = { x: -best.x, y: -best.y };
      return { normal: best, depth: overlap, contacts: contactPoints(a, b, ac, bc) };
    }

    function contactPoints(a, b, ac = corners(a), bc = corners(b)) {
      const pts = [];
      for (const p of ac) if (pointInBlock(p, b, 0.003)) pts.push(p);
      for (const p of bc) if (pointInBlock(p, a, 0.003)) pts.push(p);
      if (!pts.length) return [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }];
      const unique = [];
      for (const p of pts) {
        if (!unique.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.006)) unique.push(p);
      }
      if (unique.length <= 2) return unique;
      const axis = Math.abs(a.angle - b.angle) < 0.35 ? axesFor(a)[0] : { x: 1, y: 0 };
      unique.sort((p, q) => (p.x * axis.x + p.y * axis.y) - (q.x * axis.x + q.y * axis.y));
      return [unique[0], unique[unique.length - 1]];
    }

    function pointInBlock(p, b, pad = 0.001) {
      const c = Math.cos(-b.angle), s = Math.sin(-b.angle);
      const dx = p.x - b.x, dy = p.y - b.y;
      const lx = dx * c - dy * s;
      const ly = dx * s + dy * c;
      return Math.abs(lx) <= b.w / 2 + pad && Math.abs(ly) <= b.h / 2 + pad;
    }

    function cross(ax, ay, bx, by) { return ax * by - ay * bx; }

    function applyImpulse(b, ix, iy, px, py) {
      if (b.invMass === 0) return;
      b.vx += ix * b.invMass;
      b.vy += iy * b.invMass;
      b.av += cross(px - b.x, py - b.y, ix, iy) * b.invI;
    }

    function solveCollision(a, b, hit) {
      const n = hit.normal;
      const totalInv = a.invMass + b.invMass;
      if (totalInv <= 0) return;
      const correction = Math.max(0, hit.depth - 0.001) / totalInv * 0.72;
      if (a.invMass) { a.x -= n.x * correction * a.invMass; a.y -= n.y * correction * a.invMass; }
      if (b.invMass) { b.x += n.x * correction * b.invMass; b.y += n.y * correction * b.invMass; }

      const contacts = hit.contacts?.length ? hit.contacts : [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }];
      let maxJ = 0;
      for (const p of contacts) solveContactImpulse(a, b, n, p, contacts.length, (j) => { maxJ = Math.max(maxJ, Math.abs(j)); });
      stabilizeRestingPair(a, b, n, contacts.length);
      if (maxJ > 0.018 && Math.random() < 0.04) {
        const p = contacts[0];
        emitEvent("hit", p.x, p.y, Math.min(1.2, maxJ * 5), "#d8e6ff");
      }
    }

    function solveContactImpulse(a, b, n, p, contactCount, onImpulse) {
      const rax = p.x - a.x, ray = p.y - a.y;
      const rbx = p.x - b.x, rby = p.y - b.y;
      const vax = a.vx - a.av * ray, vay = a.vy + a.av * rax;
      const vbx = b.vx - b.av * rby, vby = b.vy + b.av * rbx;
      const rvx = vbx - vax, rvy = vby - vay;
      const velN = rvx * n.x + rvy * n.y;
      if (velN > 0) return;
      const raCn = cross(rax, ray, n.x, n.y);
      const rbCn = cross(rbx, rby, n.x, n.y);
      const totalInv = a.invMass + b.invMass;
      const inv = totalInv + raCn * raCn * a.invI + rbCn * rbCn * b.invI;
      const j = (-(1 + RESTITUTION) * velN / Math.max(0.0001, inv)) / contactCount;
      const ix = n.x * j, iy = n.y * j;
      applyImpulse(a, -ix, -iy, p.x, p.y);
      applyImpulse(b, ix, iy, p.x, p.y);

      const tx = -n.y, ty = n.x;
      const velT = rvx * tx + rvy * ty;
      const jt = -velT / Math.max(0.0001, inv);
      const mu = FRICTION;
      const fj = clamp(jt / contactCount, -Math.abs(j) * mu, Math.abs(j) * mu);
      applyImpulse(a, -tx * fj, -ty * fj, p.x, p.y);
      applyImpulse(b, tx * fj, ty * fj, p.x, p.y);
      onImpulse?.(j);
    }

    function belowScreen(b) {
      const playHeight = ui.play?.h || canvas.clientHeight || 1;
      const scale = ui.scale || 1;
      const bottomY = FLOOR_Y - state.cameraY + (playHeight * 0.48) / scale;
      const radius = Math.hypot(b.w, b.h) / 2;
      return b.y - radius > bottomY;
    }

    function stabilizeRestingPair(a, b, n, contactCount) {
      if (contactCount < 2) return;
      const top = n.y < -0.45 ? b : (n.y > 0.45 ? a : null);
      const bottom = top === b ? a : (top === a ? b : null);
      if (!top || !bottom || top.fixed) return;
      const relV = Math.hypot(top.vx - bottom.vx, top.vy - bottom.vy);
      if (relV > RESTING_SPEED || Math.abs(top.av) > 0.18 || Math.abs(bottom.av) > 0.18) return;
      top.vx = bottom.fixed ? top.vx * 0.78 : bottom.vx + (top.vx - bottom.vx) * 0.45;
      top.vy = Math.min(top.vy, bottom.vy + 0.002);
      top.av *= 0.35;
      if (!bottom.fixed) bottom.av *= 0.65;
    }

    function integrate(dt) {
      for (const b of state.blocks) {
        if (b.fixed) continue;
        b.vy += GRAVITY * dt;
        b.vx *= LINEAR_DAMPING;
        b.vy *= LINEAR_DAMPING;
        b.av *= ANGULAR_DAMPING;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.angle += b.av * dt;
      }
      for (let pass = 0; pass < SOLVER_PASSES; pass++) {
        for (const b of state.blocks) solveGroundContact(b);
        for (let i = 0; i < state.blocks.length; i++) {
          for (let j = i + 1; j < state.blocks.length; j++) {
            const a = state.blocks[i], b = state.blocks[j];
            if (a.fixed || b.fixed) continue;
            if (Math.abs(a.x - b.x) > (a.w + b.w) * 0.9 || Math.abs(a.y - b.y) > (a.h + b.h) * 1.2) continue;
            const hit = sat(a, b);
            if (hit) solveCollision(a, b, hit);
          }
        }
      }
      for (const b of state.blocks) {
        if (b.fixed) continue;
        if (belowScreen(b)) {
          emitEvent("fall", clamp(b.x, 0.05, 0.95), 0.95, 1.1, b.color);
          b.dead = true;
          if (b.owner && b.owner !== "system") state.scores[b.owner] = Math.max(0, (state.scores[b.owner] || 0) - 2);
        }
      }
      state.blocks = state.blocks.filter((b) => !b.dead).slice(-BLOCK_LIMIT);
    }

    function solveGroundContact(b) {
      if (b.fixed) return;
      const below = corners(b).filter((p) => p.y > FLOOR_Y && p.x >= 0 && p.x <= 1);
      if (!below.length) return;
      const n = { x: 0, y: -1 };
      const count = below.length;
      // Resolve penetration once up front so every contact shares the same lever arm.
      let maxDepth = 0;
      for (const p of below) maxDepth = Math.max(maxDepth, p.y - FLOOR_Y);
      b.y -= maxDepth * 0.92;
      // Solve all contacts against a frozen velocity snapshot so corner order can't bias drift.
      const vx0 = b.vx, vy0 = b.vy, av0 = b.av;
      const ry = FLOOR_Y - b.y;
      for (const p of below) {
        const rx = p.x - b.x;
        const vx = vx0 - av0 * ry;
        const vy = vy0 + av0 * rx;
        const velN = vx * n.x + vy * n.y;
        if (velN >= 0) continue;
        const rCn = cross(rx, ry, n.x, n.y);
        const inv = b.invMass + rCn * rCn * b.invI;
        const j = (-(1 + RESTITUTION) * velN / Math.max(0.0001, inv)) / count;
        applyImpulse(b, n.x * j, n.y * j, p.x, FLOOR_Y);
        const tx = 1, ty = 0;
        const vt = vx * tx + vy * ty;
        const jt = (-vt / Math.max(0.0001, inv)) / count;
        const fj = clamp(jt, -Math.abs(j) * FRICTION, Math.abs(j) * FRICTION);
        applyImpulse(b, tx * fj, ty * fj, p.x, FLOOR_Y);
      }
      if (Math.abs(b.vy) < 0.006) b.vy = 0;
      if (Math.abs(b.vx) < 0.004) b.vx = 0;
      if (Math.abs(b.av) < 0.012) b.av = 0;
    }

    function updateSettledScores() {
      let minY = FLOOR_Y;
      for (const b of state.blocks) {
        if (b.fixed || b.owner === "system") continue;
        minY = Math.min(minY, b.y - Math.abs(Math.cos(b.angle)) * b.h / 2 - Math.abs(Math.sin(b.angle)) * b.w / 2);
        const speed = Math.hypot(b.vx, b.vy) + Math.abs(b.av) * 0.18;
        if (speed < 0.018) b.sleep += PHYSICS_DT; else b.sleep = 0;
        if (!b.settled && b.sleep > 1.25) {
          b.settled = true;
          state.scores[b.owner] = (state.scores[b.owner] || 0) + 3;
          emitEvent("score", b.x, b.y, 0.85, b.color);
        }
      }
      const height = Math.max(0, Math.round((FLOOR_Y - minY) * 100));
      if (height > state.lastHeight) state.lastHeight = height;
      const targetCameraY = Math.max(0, 0.62 - minY);
      state.cameraY += (targetCameraY - state.cameraY) * 0.035;
    }

    function updateHost(dt) {
      syncPlayerList();
      accumulator += dt;
      let steps = 0;
      while (accumulator >= PHYSICS_DT && steps++ < 5) {
        integrate(PHYSICS_DT);
        updateSettledScores();
        accumulator -= PHYSICS_DT;
      }
    }

    function placeBlock(id, input) {
      const shape = shapeByKey(input.shape);
      const x = clamp(Number(input.x) || 0.5, WALL_PAD + shape.w / 2, 1 - WALL_PAD - shape.w / 2);
      const y = clamp((Number(input.y) || 0.25) - shape.h * 0.25, -0.7 - state.cameraY, FLOOR_Y - shape.h / 2 - 0.01);
      let angle = clamp(Number(input.angle) || 0, -Math.PI, Math.PI);
      if (Math.abs(angle) < 0.025) angle = 0;
      const b = makeBlock("b" + state.nextId++, id, x, y, angle, { ...shape, color: profile(id).color || shape.color });
      b.vy = 0;
      state.blocks.push(b);
      emitEvent("place", x, y, 0.9, b.color);
    }

    function handleAction(id, input) {
      if (!isHost() || !input) return;
      if (input.type === "place") placeBlock(id, input);
      else if (input.type === "reset") resetHostState();
    }

    function sendAction(input) {
      if (isHost()) handleAction(myId, input);
      else host.sendInput(input);
    }

    function makeSnapshot() {
      return {
        blocks: state.blocks,
        scores: state.scores,
        nextId: state.nextId,
        cameraY: state.cameraY,
        lastHeight: state.lastHeight,
        events: events.slice(-18),
      };
    }

    function applySnapshot(s) {
      if (!s) return;
      state.blocks = (s.blocks || []).map((b) => ({ ...b }));
      state.scores = { ...(s.scores || {}) };
      state.nextId = s.nextId || 1;
      state.cameraY = s.cameraY || 0;
      state.lastHeight = s.lastHeight || 0;
      applyEvents(s.events);
    }

    function currentSnapshot() { return makeSnapshot(); }

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
      const hud = Math.max(82, Math.min(112, H * 0.16));
      const dock = Math.max(62, Math.min(82, H * 0.13));
      ui.play = { x: 0, y: hud, w: W, h: H - hud - dock };
      ui.scale = Math.min(ui.play.w, ui.play.h * 0.82);
    }

    function sx(x) { return ui.play.x + ui.play.w / 2 + (x - 0.5) * ui.scale; }
    function sy(y) { return ui.play.y + ui.play.h * 0.52 + (y - FLOOR_Y + state.cameraY) * ui.scale; }
    function worldPoint(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      return {
        x: clamp(0.5 + (clientX - box.left - ui.play.x - ui.play.w / 2) / ui.scale, WALL_PAD, 1 - WALL_PAD),
        y: clamp(FLOOR_Y - state.cameraY + (clientY - box.top - ui.play.y - ui.play.h * 0.52) / ui.scale, -0.7 - state.cameraY, FLOOR_Y - 0.04),
      };
    }

    function drawPixelRect(x, y, w, h, color) {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    }

    function drawBlock(b, ghost = false) {
      const x = sx(b.x), y = sy(b.y);
      const w = b.w * ui.scale, h = b.h * ui.scale;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(b.angle);
      ctx.globalAlpha = ghost ? 0.58 : 1;
      drawPixelRect(-w / 2, -h / 2, w, h, b.color || shapeByKey(b.shape).color);
      drawPixelRect(-w / 2, -h / 2, w, Math.max(2, h * 0.20), "rgba(255,255,255,0.22)");
      drawPixelRect(-w / 2, h * 0.30, w, Math.max(2, h * 0.18), "rgba(0,0,0,0.16)");
      ctx.strokeStyle = ghost ? "#fff" : "rgba(0,0,0,0.46)";
      ctx.lineWidth = ghost ? 2 : 1;
      ctx.strokeRect(Math.round(-w / 2), Math.round(-h / 2), Math.round(w), Math.round(h));
      ctx.restore();
    }

    function drawScene() {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      ctx.fillStyle = "#101426";
      ctx.fillRect(0, 0, W, H);
      const grad = ctx.createLinearGradient(0, ui.play.y, 0, ui.play.y + ui.play.h);
      grad.addColorStop(0, "#17245c");
      grad.addColorStop(1, "#0b1020");
      ctx.fillStyle = grad;
      ctx.fillRect(ui.play.x, ui.play.y, ui.play.w, ui.play.h);
      for (let i = 0; i < 10; i++) {
        const y = ui.play.y + ((i * 73 + state.cameraY * 800) % ui.play.h);
        drawPixelRect(0, y, W, 1, "rgba(255,255,255,0.05)");
      }
      drawPixelRect(sx(0), sy(FLOOR_Y + 0.07), ui.scale, 16, "#334052");
      drawPixelRect(sx(0), sy(FLOOR_Y + 0.07) - 6, ui.scale, 6, "#64748b");
      for (const b of state.blocks) drawBlock(b);
      if (preview) drawBlock(preview, true);
    }

    function updateEffects(dtMs) {
      const dt = dtMs / 1000;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += GRAVITY * 0.25 * dt;
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
      return host.getPlayers().map((p) => ({ id: p.id, name: p.name, color: p.color, score: state.scores[p.id] || 0 }))
        .sort((a, b) => b.score - a.score);
    }

    function drawHud() {
      const W = canvas.clientWidth;
      ctx.fillStyle = "rgba(7,9,20,0.92)";
      ctx.fillRect(0, 0, W, ui.play.y);
      ctx.fillStyle = "#eef0ff";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = "900 17px system-ui, sans-serif";
      ctx.fillText("🏗️ Tower Tumble", 12, 18);
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "#9fb3d9";
      ctx.fillText("Choose a block, drag to place, double tap to rotate. Uneven towers will tip.", 12, 40);
      ctx.fillStyle = "#ffd35a";
      ctx.font = "800 13px system-ui, sans-serif";
      ctx.fillText("Height " + state.lastHeight, 12, 62);
      let x = 110;
      for (const row of rankings().slice(0, 5)) {
        const label = (host.hostCrown?.(row.id) || "") + row.name + " " + row.score;
        ctx.fillStyle = row.color || "#fff";
        ctx.fillText(label, x, 62);
        x += Math.min(145, ctx.measureText(label).width + 24);
      }
      ui.resetRect = { x: W - 76, y: 12, w: 62, h: 34 };
      drawPixelRect(ui.resetRect.x, ui.resetRect.y, ui.resetRect.w, ui.resetRect.h, "#3b435d");
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "800 12px system-ui, sans-serif";
      ctx.fillText("Reset", ui.resetRect.x + ui.resetRect.w / 2, ui.resetRect.y + 18);
    }

    function drawDock() {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      const y = ui.play.y + ui.play.h;
      ctx.fillStyle = "rgba(7,9,20,0.94)";
      ctx.fillRect(0, y, W, H - y);
      ui.shapeRects = [];
      const gap = 8;
      const bw = Math.min(94, Math.max(58, (W - gap * (SHAPES.length + 1)) / SHAPES.length));
      let x = gap;
      for (let i = 0; i < SHAPES.length; i++) {
        const s = SHAPES[i];
        const r = { x, y: y + 10, w: bw, h: 48, i };
        ui.shapeRects.push(r);
        drawPixelRect(r.x, r.y, r.w, r.h, i === selectedShape ? "#eef0ff" : "#252b43");
        drawPixelRect(r.x + 6, r.y + 7, r.w - 12, 20, s.color);
        ctx.fillStyle = i === selectedShape ? "#111" : "#eef0ff";
        ctx.textAlign = "center";
        ctx.font = "800 11px system-ui, sans-serif";
        ctx.fillText(s.name, r.x + r.w / 2, r.y + 36);
        x += bw + gap;
      }
    }

    function draw() {
      if (!ensureCanvasSize()) return;
      layout();
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      drawScene();
      drawEffects();
      drawHud();
      drawDock();
    }

    function pointIn(r, x, y) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
    function pointerPoint(e) {
      const box = canvas.getBoundingClientRect();
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
      return { x: touch.clientX - box.left, y: touch.clientY - box.top, clientX: touch.clientX, clientY: touch.clientY };
    }

    function updatePreview(pt) {
      const w = worldPoint(pt.clientX, pt.clientY);
      const s = selected();
      preview = makeBlock("preview", myId, w.x, w.y, preview?.angle || 0, { ...s, color: profile(myId).color || s.color });
    }

    function onPointerDown(e) {
      const pt = pointerPoint(e);
      for (const r of ui.shapeRects) {
        if (pointIn(r, pt.x, pt.y)) { e.preventDefault(); selectedShape = r.i; preview = null; return; }
      }
      if (pointIn(ui.resetRect, pt.x, pt.y)) { e.preventDefault(); sendAction({ type: "reset" }); return; }
      if (!pointIn(ui.play, pt.x, pt.y)) return;
      e.preventDefault();
      dragging = true;
      activePointerId = e.pointerId ?? null;
      canvas.setPointerCapture?.(activePointerId);
      updatePreview(pt);
    }

    function onPointerMove(e) {
      if (!dragging) return;
      e.preventDefault();
      updatePreview(pointerPoint(e));
    }

    function onPointerUp(e) {
      if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
      activePointerId = null;
      if (dragging && preview) {
        sendAction({ type: "place", x: preview.x, y: preview.y, angle: preview.angle, shape: selected().key });
      }
      dragging = false;
      preview = null;
    }

    function onDblClick(e) {
      e.preventDefault();
      if (preview) preview.angle += Math.PI / 10;
      else selectedShape = (selectedShape + 1) % SHAPES.length;
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
          host.broadcastState(makeSnapshot());
        }
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
        preview = null;
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
      restart() { if (isHost()) resetHostState(); },
    };
  }

  window.BP2PGames = window.BP2PGames || {};
  window.BP2PGames.tower = {
    id: "tower",
    name: "Tower Tumble",
    emoji: "🏗️",
    create,
  };
})();
