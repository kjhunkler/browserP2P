/* Multiplayer Fishing for browserP2P.
 * Host owns the boat, ocean, hooks, fish, snags, and scores. Clients send cast/reel/aim input.
 */
(function () {
  "use strict";

  const SNAPSHOT_HZ = 15;
  const MAX_FISH = 48;
  const MAX_SNAGS = 9;
  const GRAVITY = 0.54;
  const CAST_SPEED = 0.62;
  const REEL_SPEED = 0.34;
  const HOOK_R = 0.018;
  const WATER_SURFACE_Y = 0.315;
  const MIN_FISH_Y = 0.48;
  const MAX_FISH_Y = 0.91;
  const FISH_EDGE_PAD = 0.06;
  const FISH_TYPES = [
    { kind: "minnow", points: 2, w: 0.042, h: 0.020, colors: ["#9be7ff", "#c8f6ff", "#7ed6ff"], speed: 0.018 },
    { kind: "snapper", points: 7, w: 0.058, h: 0.030, colors: ["#ff7b7b", "#ffd166", "#f77f00"], speed: 0.016 },
    { kind: "tuna", points: 14, w: 0.080, h: 0.034, colors: ["#5386e4", "#89b4ff", "#2b59c3"], speed: 0.022 },
    { kind: "jelly", points: 10, w: 0.052, h: 0.048, colors: ["#d783ff", "#ff9af5", "#a855f7"], speed: 0.011 },
    { kind: "eel", points: 18, w: 0.098, h: 0.022, colors: ["#70e000", "#38b000", "#9ef01a"], speed: 0.026 },
    { kind: "gold", points: 30, w: 0.060, h: 0.030, colors: ["#ffd700", "#fff3a3", "#ff9f1c"], speed: 0.030 },
  ];
  const SNAG_TYPES = ["boot", "crate", "kelp", "anchor", "can"];

  function create(host, initialState) {
    const canvas = host.canvas;
    const ctx = canvas.getContext("2d");
    const myId = host.myId;

    let rafId = 0;
    let lastTs = 0;
    let lastSnapshotAt = 0;
    let lastCssWidth = 0;
    let lastCssHeight = 0;
    let pointerDown = false;
    let activePointerId = null;
    let audioCtx = null;
    let eventSeq = 0;
    let seenEventSeq = 0;
    const events = [];
    const splashes = [];
    const bubbles = [];
    const wake = [];

    const state = {
      t: 0,
      boatX: 0.5,
      players: {},
      fish: [],
      snags: [],
      scores: {},
      combo: {},
    };

    function now() { return performance.now(); }
    function isHost() { return !!host.isHost(); }
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function rand(min, max) { return min + Math.random() * (max - min); }
    function choice(list) { return list[Math.floor(Math.random() * list.length)]; }
    function profile(id) {
      return host.getPlayers().find((p) => p.id === id) || host.getProfile?.(id) || { id, name: "Player", color: "#7cfc9b", icon: "🎣" };
    }
    function score(id) { return id ? (state.scores[id] || 0) : 0; }

    function playSound(kind, power = 1) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const tones = {
          cast: [290, 0.10, 0.035, "triangle"],
          splash: [120, 0.11, 0.035, "sine"],
          catch: [520, 0.16, 0.055, "triangle"],
          snag: [85, 0.14, 0.045, "sawtooth"],
          tangle: [170, 0.18, 0.050, "square"],
          reel: [360, 0.055, 0.022, "sine"],
        };
        const [freq, dur, vol, type] = tones[kind] || tones.splash;
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        if (kind === "catch") osc.frequency.exponentialRampToValueAtTime(freq * 1.7, t + dur);
        if (kind === "snag" || kind === "tangle") osc.frequency.exponentialRampToValueAtTime(Math.max(45, freq * 0.45), t + dur);
        gain.gain.setValueAtTime(vol * clamp(power, 0.4, 1.7), t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + dur);
      } catch {}
    }

    function emitEvent(kind, x, y, power = 1, color = "#ffffff", text = "") {
      const evt = { seq: ++eventSeq, kind, x, y, power, color, text };
      events.push(evt);
      while (events.length > 32) events.shift();
      seenEventSeq = Math.max(seenEventSeq, evt.seq);
      playEvent(evt);
    }

    function addSplash(x, y, color, count, power) {
      for (let i = 0; i < count; i++) {
        const a = rand(Math.PI * 1.05, Math.PI * 1.95);
        const s = rand(0.10, 0.45) * power;
        splashes.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - rand(0.06, 0.18), color, life: rand(360, 760), maxLife: 760, text: "" });
      }
      if (splashes.length > 220) splashes.splice(0, splashes.length - 220);
    }

    function floatText(x, y, text, color) {
      splashes.push({ x, y, vx: 0, vy: -0.10, color, life: 980, maxLife: 980, text });
    }

    function playEvent(evt) {
      playSound(evt.kind, evt.power || 1);
      if (evt.kind === "cast" || evt.kind === "splash") addSplash(evt.x, evt.y, "#b8efff", 18, evt.power || 1);
      else if (evt.kind === "catch") { addSplash(evt.x, evt.y, evt.color || "#ffd35a", 30, 1.2); if (evt.text) floatText(evt.x, evt.y - 0.03, evt.text, evt.color || "#ffd35a"); }
      else if (evt.kind === "snag") { addSplash(evt.x, evt.y, "#a68a64", 22, 0.9); if (evt.text) floatText(evt.x, evt.y - 0.03, evt.text, "#d6b88a"); }
      else if (evt.kind === "tangle") { addSplash(evt.x, evt.y, "#ff9aa8", 24, 1.0); if (evt.text) floatText(evt.x, evt.y - 0.03, evt.text, "#ffb3bd"); }
      else if (evt.kind === "reel") addSplash(evt.x, evt.y, "#d8fbff", 8, 0.55);
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

    function spawnFish() {
      const type = choice(FISH_TYPES);
      const dir = Math.random() < 0.5 ? 1 : -1;
      const color = choice(type.colors);
      return {
        id: "f" + Math.random().toString(36).slice(2, 9),
        kind: type.kind,
        points: type.points + Math.floor(rand(0, type.points * 0.35)),
        x: rand(FISH_EDGE_PAD, 1 - FISH_EDGE_PAD),
        y: rand(MIN_FISH_Y, MAX_FISH_Y),
        vx: dir * type.speed * rand(0.70, 1.10),
        vy: rand(-0.004, 0.004),
        w: type.w * rand(0.85, 1.15),
        h: type.h * rand(0.85, 1.15),
        color,
        accent: choice(type.colors),
        phase: rand(0, Math.PI * 2),
      };
    }

    function spawnSnag() {
      return {
        id: "s" + Math.random().toString(36).slice(2, 9),
        kind: choice(SNAG_TYPES),
        x: rand(0.05, 0.95),
        y: rand(0.66, 0.96),
        w: rand(0.025, 0.050),
        h: rand(0.020, 0.042),
        drift: rand(-0.006, 0.006),
        phase: rand(0, Math.PI * 2),
      };
    }

    function seatX(index, total) {
      const usable = 0.78;
      if (total <= 1) return 0.5;
      return 0.5 - usable / 2 + usable * (index / (total - 1));
    }

    function syncPlayerList() {
      if (!isHost()) return;
      const livePlayers = host.getPlayers();
      const live = new Set(livePlayers.map((p) => p.id));
      Object.keys(state.players).forEach((id) => { if (!live.has(id)) delete state.players[id]; });
      Object.keys(state.scores).forEach((id) => { if (!live.has(id)) delete state.scores[id]; });
      livePlayers.forEach((p, i) => {
        if (state.scores[p.id] == null) state.scores[p.id] = 0;
        if (!state.combo[p.id]) state.combo[p.id] = 0;
        const targetX = seatX(i, Math.max(1, livePlayers.length));
        const existing = state.players[p.id];
        if (!existing) {
          state.players[p.id] = { id: p.id, seatX: targetX, aim: 0, line: "idle", hx: targetX, hy: 0.25, vx: 0, vy: 0, catchId: null, snagId: null, tangleId: null, tension: 0 };
        } else {
          existing.seatX += (targetX - existing.seatX) * 0.08;
        }
      });
    }

    function resetHostState() {
      state.t = 0;
      state.boatX = 0.5;
      state.players = {};
      state.fish = [];
      state.snags = [];
      state.scores = {};
      state.combo = {};
      for (let i = 0; i < MAX_FISH; i++) state.fish.push(spawnFish());
      for (let i = 0; i < MAX_SNAGS; i++) state.snags.push(spawnSnag());
      syncPlayerList();
    }

    function rodPoint(p) {
      return { x: p.seatX + 0.014, y: 0.232 };
    }

    function castLine(id, aim) {
      const p = state.players[id];
      if (!p || p.line !== "idle") return;
      const start = rodPoint(p);
      p.aim = clamp(aim, -1, 1);
      p.line = "cast";
      p.hx = start.x;
      p.hy = start.y;
      p.vx = p.aim * CAST_SPEED;
      p.vy = -0.10;
      p.catchId = null;
      p.snagId = null;
      p.tangleId = null;
      p.tension = 0;
      emitEvent("cast", start.x, 0.315, 0.85, "#b8efff");
    }

    function reelLine(id) {
      const p = state.players[id];
      if (!p || p.line === "idle") return;
      p.line = "reel";
      p.tension = Math.max(p.tension || 0, 0.25);
      const t = now();
      if (t - (p.lastReelAt || 0) > 240) {
        p.lastReelAt = t;
        emitEvent("reel", p.hx, p.hy, 0.45, "#d8fbff");
      }
    }

    function cutLine(id, reason) {
      const p = state.players[id];
      if (!p) return;
      const wasSnag = reason === "snag" || p.snagId;
      const wasTangle = reason === "tangle" || p.tangleId;
      emitEvent(wasTangle ? "tangle" : (wasSnag ? "snag" : "splash"), p.hx, p.hy, 0.9, "#ff9aa8", wasTangle ? "Tangled!" : (wasSnag ? "Snagged!" : "Lost it!"));
      p.line = "idle";
      p.catchId = null;
      p.snagId = null;
      p.tangleId = null;
      p.tension = 0;
      const start = rodPoint(p);
      p.hx = start.x;
      p.hy = start.y;
      p.vx = 0;
      p.vy = 0;
      state.combo[id] = 0;
    }

    function handleAction(id, input) {
      if (!isHost() || !input) return;
      if (input.type === "cast") castLine(id, Number(input.aim) || 0);
      else if (input.type === "reel") reelLine(id);
      else if (input.type === "cut") cutLine(id, input.reason || "cut");
      else if (input.type === "aim" && state.players[id]) state.players[id].aim = clamp(Number(input.aim) || 0, -1, 1);
    }

    function sendAction(input) {
      if (isHost()) handleAction(myId, input);
      else host.sendInput(input);
    }

    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

    function updateHook(id, p, dt) {
      const start = rodPoint(p);
      const snag = p.snagId ? snagById(p.snagId) : null;
      if (p.line === "idle") {
        p.hx += (start.x - p.hx) * 0.2;
        p.hy += (start.y - p.hy) * 0.2;
        return;
      }
      if (p.line === "cast") {
        p.vy += GRAVITY * dt;
        p.hx += p.vx * dt;
        p.hy += p.vy * dt;
        p.vx *= 0.985;
        if (p.hy >= 0.315) {
          p.hy = Math.max(p.hy, 0.315);
          p.line = "sink";
          p.vx *= 0.35;
          p.vy = 0.11;
          emitEvent("splash", p.hx, 0.315, 0.75, "#b8efff");
        }
      } else if (p.line === "sink") {
        p.hx += Math.sin(state.t * 1.7 + p.seatX * 10) * dt * 0.015;
        p.hy += (0.055 + p.tension * 0.035) * dt;
        p.vx *= 0.97;
        p.tension = Math.max(0, p.tension - dt * 0.12);
      } else if (p.line === "reel") {
        const dx = start.x - p.hx;
        const dy = start.y - p.hy;
        const d = Math.max(0.001, Math.hypot(dx, dy));
        p.hx += dx / d * REEL_SPEED * dt;
        p.hy += dy / d * REEL_SPEED * dt;
        p.tension = Math.max(0, p.tension - dt * 0.22);
        if (snag) {
          snag.x = p.hx;
          snag.y = p.hy + 0.012;
          snag.drift = 0;
        }
        if (d < 0.030) finishReel(id, p);
      }
      p.hx = clamp(p.hx, -0.08, 1.08);
      p.hy = clamp(p.hy, 0.20, 1.05);
      if (p.hy >= 1.02) cutLine(id, "deep");
    }

    function fishById(id) { return state.fish.find((f) => f.id === id); }
    function snagById(id) { return state.snags.find((s) => s.id === id); }

    function attachFish(id, p, f) {
      p.catchId = f.id;
      p.line = "reel";
      p.tension = 0.55;
      emitEvent("catch", p.hx, p.hy, 0.75, f.color, "Bite!");
    }

    function finishReel(id, p) {
      if (p.catchId) {
        const f = fishById(p.catchId);
        if (f) {
          const combo = (state.combo[id] || 0) + 1;
          state.combo[id] = combo;
          const bonus = combo > 2 ? Math.floor(combo * 1.5) : 0;
          const points = f.points + bonus;
          state.scores[id] = (state.scores[id] || 0) + points;
          emitEvent("catch", p.seatX, 0.25, 1.25, f.color, "+" + points + " " + f.kind);
          state.fish = state.fish.filter((x) => x.id !== f.id);
          state.fish.push(spawnFish());
        }
      } else if (p.snagId) {
        const snag = snagById(p.snagId);
        const penalty = Math.min(6, state.scores[id] || 0);
        state.scores[id] = Math.max(0, (state.scores[id] || 0) - penalty);
        if (snag) {
          state.snags = state.snags.filter((s) => s.id !== snag.id);
          state.combo[id] = 0;
          emitEvent("snag", p.seatX, 0.25, 1.1, "#d6b88a", penalty ? "Trash cleared -" + penalty : "Trash cleared!");
        } else {
          emitEvent("snag", p.seatX, 0.25, 1.1, "#d6b88a", penalty ? "Trash -" + penalty : "Trash!");
        }
      }
      p.line = "idle";
      p.catchId = null;
      p.snagId = null;
      p.tangleId = null;
      p.tension = 0;
      const start = rodPoint(p);
      p.hx = start.x;
      p.hy = start.y;
    }

    function updateCatches() {
      const hookList = Object.values(state.players).filter((p) => p.line !== "idle");
      for (const p of hookList) {
        if (!p.catchId && !p.snagId && p.hy > 0.33) {
          for (const f of state.fish) {
            if (dist({ x: p.hx, y: p.hy }, f) < Math.max(HOOK_R + f.h * 0.6, f.w * 0.45)) { attachFish(p.id, p, f); break; }
          }
        }
        if (!p.catchId && !p.snagId && p.hy > 0.42) {
          for (const s of state.snags) {
            if (Math.abs(p.hx - s.x) < s.w * 0.8 && Math.abs(p.hy - s.y) < s.h * 0.9) {
              p.snagId = s.id;
              p.line = "reel";
              p.tension = 0.9;
              emitEvent("snag", p.hx, p.hy, 0.9, "#a68a64", "Snag!");
              break;
            }
          }
        }
      }
      for (let i = 0; i < hookList.length; i++) {
        for (let j = i + 1; j < hookList.length; j++) {
          const a = hookList[i];
          const b = hookList[j];
          if (a.line !== "idle" && b.line !== "idle" && dist({ x: a.hx, y: a.hy }, { x: b.hx, y: b.hy }) < HOOK_R * 2.8) {
            a.tangleId = b.id;
            b.tangleId = a.id;
            cutLine(a.id, "tangle");
            cutLine(b.id, "tangle");
          }
        }
      }
    }

    function updateFish(dt) {
      for (const f of state.fish) {
        f.phase += dt * 4;
        f.x += f.vx * dt;
        f.y += Math.sin(f.phase) * f.speed * 0.20 * dt + f.vy * dt;
        if (f.x < FISH_EDGE_PAD) { f.x = FISH_EDGE_PAD; f.vx = Math.abs(f.vx); }
        if (f.x > 1 - FISH_EDGE_PAD) { f.x = 1 - FISH_EDGE_PAD; f.vx = -Math.abs(f.vx); }
        f.y = clamp(f.y, MIN_FISH_Y, MAX_FISH_Y);
      }
      for (const s of state.snags) {
        s.phase += dt;
        s.x += s.drift * dt;
        s.y += Math.sin(s.phase) * 0.003 * dt;
        if (s.x < -0.08) s.x = 1.08;
        if (s.x > 1.08) s.x = -0.08;
      }
    }

    function updateHost(dt) {
      state.t += dt;
      state.boatX = 0.5 + Math.sin(state.t * 0.11) * 0.08;
      syncPlayerList();
      while (state.fish.length < MAX_FISH) state.fish.push(spawnFish());
      while (state.snags.length < MAX_SNAGS) state.snags.push(spawnSnag());
      updateFish(dt);
      for (const [id, p] of Object.entries(state.players)) updateHook(id, p, dt);
      updateCatches();
    }

    function makeSnapshot() {
      return {
        t: state.t,
        boatX: state.boatX,
        players: JSON.parse(JSON.stringify(state.players)),
        fish: state.fish,
        snags: state.snags,
        scores: state.scores,
        combo: state.combo,
        events: events.slice(-18),
      };
    }

    function applySnapshot(s) {
      if (!s) return;
      state.t = s.t || 0;
      state.boatX = s.boatX ?? 0.5;
      state.players = { ...(s.players || {}) };
      state.fish = (s.fish || []).map((f) => ({ ...f }));
      state.snags = (s.snags || []).map((x) => ({ ...x }));
      state.scores = { ...(s.scores || {}) };
      state.combo = { ...(s.combo || {}) };
      applyEvents(s.events);
    }

    function currentSnapshot() { return makeSnapshot(); }

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
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (Math.abs(rect.width - lastCssWidth) > 1 || Math.abs(rect.height - lastCssHeight) > 1 || canvas.width <= 1 || canvas.height <= 1) resize();
      return true;
    }

    function sx(x) { return x * canvas.clientWidth; }
    function sy(y) { return y * canvas.clientHeight; }
    function px(v) { return Math.round(v) + 0.5; }

    function drawPixelRect(x, y, w, h, color) {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    }

    function drawOcean(W, H) {
      const skyH = H * 0.31;
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "#17245c");
      grad.addColorStop(0.30, "#476eb4");
      grad.addColorStop(0.31, "#0e7fb0");
      grad.addColorStop(1, "#05243d");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "rgba(255,230,164,0.75)";
      ctx.beginPath(); ctx.arc(W * 0.82, H * 0.09, Math.max(16, W * 0.045), 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 9; i++) {
        const y = skyH + i * H * 0.075 + Math.sin(state.t * 0.7 + i) * 5;
        const off = ((state.t * 16 + i * 67) % (W + 120)) - 120;
        ctx.fillStyle = i % 2 ? "rgba(130,225,255,0.20)" : "rgba(255,255,255,0.15)";
        for (let x = off; x < W + 120; x += 130) drawPixelRect(x, y, 58, 4, ctx.fillStyle);
      }
      for (let i = 0; i < 60; i++) {
        const x = (i * 91 + state.t * (10 + (i % 5) * 5)) % (W + 60) - 30;
        const y = skyH + ((i * 47) % Math.max(1, H - skyH));
        const a = 0.08 + (i % 4) * 0.035;
        drawPixelRect(x, y, 14 + (i % 5) * 6, 2, `rgba(185,240,255,${a})`);
      }
    }

    function drawBoat(W, H) {
      const x = sx(state.boatX);
      const y = sy(0.25);
      wake.push({ x: state.boatX - 0.17, y: 0.305, life: 700, maxLife: 700 });
      if (wake.length > 40) wake.shift();
      for (const w of wake) {
        const a = Math.max(0, w.life / w.maxLife);
        drawPixelRect(sx(w.x) - 40 * (1 - a), sy(w.y), 78 * a, 3, `rgba(220,250,255,${a * 0.35})`);
      }
      const bw = Math.min(W * 0.86, 640);
      const bh = Math.max(52, H * 0.09);
      drawPixelRect(x - bw / 2, y, bw, bh * 0.55, "#7a4324");
      drawPixelRect(x - bw / 2 + 18, y - bh * 0.35, bw - 36, bh * 0.42, "#b36a34");
      drawPixelRect(x - bw / 2 + 34, y - bh * 0.62, bw * 0.20, bh * 0.30, "#d7a15e");
      drawPixelRect(x + bw * 0.10, y - bh * 0.70, bw * 0.21, bh * 0.40, "#e0b46d");
      drawPixelRect(x - bw / 2 + 10, y + bh * 0.52, bw - 20, bh * 0.22, "#4b2617");
      for (let i = 0; i < 12; i++) drawPixelRect(x - bw / 2 + 34 + i * ((bw - 68) / 11), y - 8, 7, 11, "#4b2617");
    }

    function drawFish(f) {
      if (f.y < WATER_SURFACE_Y + f.h * 0.9) return;
      const x = sx(f.x);
      const y = sy(f.y);
      const scale = Math.min(canvas.clientWidth, canvas.clientHeight);
      const w = f.w * scale;
      const h = f.h * scale;
      const dir = f.vx >= 0 ? 1 : -1;
      const bodyX = x - w * 0.34;
      const bodyY = y - h * 0.36;
      ctx.fillStyle = "rgba(3,10,24,0.40)";
      ctx.fillRect(Math.round(x - w * 0.56), Math.round(y - h * 0.48), Math.round(w * 1.08), Math.round(h * 1.02));
      drawPixelRect(bodyX, bodyY, w * 0.68, h * 0.72, f.color);
      drawPixelRect(bodyX + w * 0.08, bodyY - h * 0.18, w * 0.28, h * 0.22, f.accent);
      drawPixelRect(bodyX + w * 0.16, bodyY + h * 0.68, w * 0.24, h * 0.20, f.accent);
      drawPixelRect(x - dir * w * 0.54, y - h * 0.30, w * 0.26, h * 0.60, f.accent);
      drawPixelRect(x - dir * w * 0.66, y - h * 0.18, w * 0.16, h * 0.36, f.accent);
      drawPixelRect(x + dir * w * 0.26, y - h * 0.22, w * 0.20, h * 0.44, f.color);
      drawPixelRect(x + dir * w * 0.34, y - h * 0.10, Math.max(3, w * 0.07), Math.max(3, h * 0.14), "#07111f");
      drawPixelRect(x - w * 0.16, y - h * 0.05, w * 0.22, Math.max(2, h * 0.10), "rgba(255,255,255,0.28)");
      if (f.kind === "jelly") {
        drawPixelRect(x - w * 0.30, y - h * 0.38, w * 0.60, h * 0.42, f.color);
        for (let i = -2; i <= 2; i++) drawPixelRect(x + i * w * 0.12, y + h * 0.04, 4, h * 0.70, f.accent);
      } else if (f.kind === "eel") {
        drawPixelRect(x - w * 0.46, y + Math.sin(f.phase) * h * 0.25, w * 0.92, h * 0.42, f.accent);
      }
    }

    function drawSnag(s) {
      const x = sx(s.x);
      const y = sy(s.y);
      const w = s.w * canvas.clientWidth;
      const h = s.h * canvas.clientHeight;
      const color = s.kind === "kelp" ? "#2d6a4f" : (s.kind === "anchor" ? "#67707f" : "#8a6f4d");
      drawPixelRect(x - w / 2, y - h / 2, w, h, color);
      drawPixelRect(x - w * 0.30, y - h * 0.20, w * 0.60, h * 0.18, "rgba(255,255,255,0.22)");
      if (s.kind === "anchor") drawPixelRect(x - 2, y - h, 4, h * 1.6, "#8b95a6");
      if (s.kind === "kelp") for (let i = -2; i <= 2; i++) drawPixelRect(x + i * 5, y - h, 4, h * 1.8, "#40916c");
    }

    function drawLine(p, prof) {
      const start = rodPoint(p);
      ctx.strokeStyle = p.tangleId ? "#ff9aa8" : (p.snagId ? "#d6b88a" : "rgba(235,245,255,0.82)");
      ctx.lineWidth = Math.max(1, canvas.clientWidth * 0.003);
      ctx.beginPath();
      ctx.moveTo(px(sx(start.x)), px(sy(start.y)));
      const sag = Math.min(0.08, Math.max(0, p.hy - start.y) * 0.16 + (p.tension || 0) * 0.012);
      ctx.quadraticCurveTo(px(sx((start.x + p.hx) / 2)), px(sy((start.y + p.hy) / 2 + sag)), px(sx(p.hx)), px(sy(p.hy)));
      ctx.stroke();
      drawPixelRect(sx(p.hx) - 4, sy(p.hy) - 4, 8, 8, prof.color || "#ffffff");
      drawPixelRect(sx(p.hx) - 2, sy(p.hy) + 3, 4, 6, "#d9e4ff");
    }

    function drawPlayers(W, H) {
      const entries = Object.values(state.players).sort((a, b) => a.seatX - b.seatX);
      for (const p of entries) {
        const prof = profile(p.id);
        const x = sx(p.seatX + (state.boatX - 0.5) * 0.10);
        const y = sy(0.205);
        if (host.isSpeaking?.(p.id)) {
          const pulse = 0.5 + 0.5 * Math.abs(Math.sin(now() / 220));
          ctx.strokeStyle = `rgba(124,252,155,${0.5 + pulse * 0.5})`;
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(x, y, 18 + pulse * 5, 0, Math.PI * 2); ctx.stroke();
        }
        drawPixelRect(x - 13, y - 13, 26, 26, prof.color || "#7cfc9b");
        ctx.fillStyle = "#111";
        ctx.font = "16px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(prof.icon || "🎣", x, y + 1);
        ctx.font = "800 11px system-ui, sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.fillText((host.hostCrown?.(p.id) || "") + (prof.name || "Player") + " " + score(p.id), x, y - 24);
        ctx.strokeStyle = "#6b3a20";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + 10, y - 5);
        ctx.lineTo(sx(rodPoint(p).x), sy(rodPoint(p).y));
        ctx.stroke();
      }
      for (const p of entries) {
        const prof = profile(p.id);
        if (p.line !== "idle") drawLine(p, prof);
      }
    }

    function updateEffects(dtMs) {
      const dt = dtMs / 1000;
      for (let i = splashes.length - 1; i >= 0; i--) {
        const p = splashes[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 0.28 * dt;
        p.life -= dtMs;
        if (p.life <= 0) splashes.splice(i, 1);
      }
      for (let i = wake.length - 1; i >= 0; i--) {
        wake[i].life -= dtMs;
        if (wake[i].life <= 0) wake.splice(i, 1);
      }
      if (Math.random() < 0.26) bubbles.push({ x: rand(0.02, 0.98), y: rand(0.62, 1.02), r: rand(2, 5), life: rand(1100, 2400), maxLife: 2400 });
      for (let i = bubbles.length - 1; i >= 0; i--) {
        bubbles[i].y -= dt * rand(0.018, 0.036);
        bubbles[i].life -= dtMs;
        if (bubbles[i].life <= 0 || bubbles[i].y < 0.34) bubbles.splice(i, 1);
      }
    }

    function drawEffects() {
      for (const b of bubbles) {
        const a = Math.max(0, b.life / b.maxLife) * 0.35;
        ctx.strokeStyle = `rgba(210,250,255,${a})`;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(sx(b.x)), Math.round(sy(b.y)), b.r, b.r);
      }
      for (const p of splashes) {
        const a = Math.max(0, p.life / p.maxLife);
        if (p.text) {
          ctx.fillStyle = p.color;
          ctx.font = "900 14px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(p.text, sx(p.x), sy(p.y));
          continue;
        }
        ctx.fillStyle = p.color.replace(/^#?([0-9a-f]{6})$/i, (_, hex) => {
          const n = parseInt(hex, 16);
          return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
        });
        if (!ctx.fillStyle.startsWith("rgba")) ctx.fillStyle = `rgba(255,255,255,${a})`;
        drawPixelRect(sx(p.x), sy(p.y), 4 * a + 2, 4 * a + 2, ctx.fillStyle);
      }
    }

    function drawHud(W) {
      ctx.fillStyle = "rgba(7,9,20,0.80)";
      ctx.fillRect(0, 0, W, 42);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#eef0ff";
      ctx.font = "900 16px system-ui, sans-serif";
      ctx.fillText("🎣 Pixel Fishing", 12, 16);
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "#9fb3d9";
      const mine = state.players[myId];
      const hint = mine?.line === "idle" ? "Drag to aim, release to cast" : "Tap/drag to reel · double tap to cut";
      ctx.fillText(hint, 12, 33);
    }

    function draw() {
      if (!ensureCanvasSize()) return;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, W, H);
      drawOcean(W, H);
      for (const s of state.snags) drawSnag(s);
      for (const f of state.fish) drawFish(f);
      drawEffects();
      drawBoat(W, H);
      drawPlayers(W, H);
      drawHud(W);
    }

    function pointerPoint(e) {
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    }

    function aimFromPoint(pt) {
      const p = state.players[myId];
      if (!p) return 0;
      return clamp((pt.x / Math.max(1, canvas.clientWidth) - p.seatX) * 3.1, -1, 1);
    }

    function onPointerDown(e) {
      e.preventDefault();
      pointerDown = true;
      activePointerId = e.pointerId ?? null;
      canvas.setPointerCapture?.(activePointerId);
      const mine = state.players[myId];
      if (mine && mine.line !== "idle") sendAction({ type: "reel" });
      else sendAction({ type: "aim", aim: aimFromPoint(pointerPoint(e)) });
    }

    function onPointerMove(e) {
      if (!pointerDown) return;
      e.preventDefault();
      const mine = state.players[myId];
      if (mine?.line === "idle") sendAction({ type: "aim", aim: aimFromPoint(pointerPoint(e)) });
      else sendAction({ type: "reel" });
    }

    function onPointerUp(e) {
      const pt = pointerPoint(e);
      if (activePointerId !== null && canvas.hasPointerCapture?.(activePointerId)) canvas.releasePointerCapture(activePointerId);
      activePointerId = null;
      pointerDown = false;
      const mine = state.players[myId];
      if (mine?.line === "idle") sendAction({ type: "cast", aim: aimFromPoint(pt) });
    }

    function onDblClick(e) {
      e.preventDefault();
      sendAction({ type: "cut", reason: "cut" });
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
      } else {
        state.t += dt;
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
        pointerDown = false;
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
  window.BP2PGames.fishing = {
    id: "fishing",
    name: "Pixel Fishing",
    emoji: "🎣",
    create,
  };
})();
