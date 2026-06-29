/*
 * app.js — demo game + chat + profile on top of peer-net.js.
 *
 * Protocol:
 *   client -> host : { t:'hello', id, name, icon, preferredColor }   on connect
 *                    { t:'input', x, y }                             on drag
 *                    { t:'profile', name, icon, preferredColor }     on profile change
 *                    { t:'chat', text }                              on send
 *   host -> all   : { t:'state', players, hostOrder }               every tick
 *                    { t:'profile', id, name, color, icon }         on profile update
 *                    { t:'chat', fromId, text, ts }                 on chat
 *                    { t:'sys', text }                              join/leave notices
 *   host -> joiner: { t:'welcome', color }                          on join
 */

// ============================================================ CONSTANTS =====
const COLORS = [
  // reds & pinks
  "#ff5d5d", "#ff3366", "#ff4488", "#ff6fd0",
  // oranges & yellows
  "#ff9d4d", "#ff8844", "#ffbb33", "#ffd24d",
  // greens
  "#c8ee44", "#7CFC9B", "#33ddaa", "#40d9a8",
  // blues & cyans
  "#4dd2ff", "#44aaff", "#4d8bff", "#00bbdd",
  // purples & violets
  "#7766ff", "#aa44ff", "#c98cff", "#e055ff",
  // extras
  "#ff55dd", "#22cc88", "#ff6600", "#5544ee",
];
const ICONS = [
  // animals
  "🦊","🐼","🐨","🦁","🐯","🐺",
  "🦝","🦉","🐧","🦋","🐬","🦄",
  "🐸","🐙","🐻","🦈","🦕","🐮",
  // fantasy & fun
  "👾","🤖","👻","🧙","🦸","🎭",
  // nature & elements
  "🌙","⭐","🔥","❄️","⚡","🌈",
  // games & objects
  "🎮","🎯","🎲","🍕","🌮","🏆",
];
const TICK_HZ = 20;
const APP_VERSION = "1.5.0";

// Channel scopes the auto-join host id. Empty = global default.
const AUTO_CHANNEL = "";

// ============================================================ PWA ===========
let swRegistration = null;

function setUpdateStatus(text) {
  const el = $("#update-status");
  if (el) el.textContent = text;
}

function refreshReady(reg) {
  setUpdateStatus("Update ready. Restarting…");
  reg.waiting.postMessage({ type: "SKIP_WAITING" });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    setUpdateStatus("Offline caching is not supported in this browser.");
    return;
  }

  try {
    swRegistration = await navigator.serviceWorker.register("./sw.js");
    if (swRegistration.waiting) refreshReady(swRegistration);
    swRegistration.addEventListener("updatefound", () => {
      const worker = swRegistration.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) refreshReady(swRegistration);
      });
    });
  } catch {
    setUpdateStatus("Offline caching could not be enabled.");
  }
}

async function checkForUpdates() {
  if (!swRegistration) {
    setUpdateStatus("Offline caching is still starting. Try again in a moment.");
    return;
  }

  setUpdateStatus("Checking for updated files…");
  try {
    await swRegistration.update();
    if (swRegistration.waiting) {
      refreshReady(swRegistration);
    } else {
      setUpdateStatus("You have the latest files.");
    }
  } catch {
    setUpdateStatus("Could not check for updates.");
  }
}

navigator.serviceWorker?.addEventListener("controllerchange", () => location.reload());

// ============================================================ WAKE LOCK ======
const WAKE_LOCK_KEY = "bp2p-keep-awake";
let keepAwake = localStorage.getItem(WAKE_LOCK_KEY) === "1";
let wakeLock = null;

function setWakeStatus(text) {
  const el = $("#wake-status");
  if (el) el.textContent = text;
}

function syncWakeUi() {
  const btn = $("#btn-keep-awake");
  if (!btn) return;

  if (!("wakeLock" in navigator)) {
    btn.disabled = true;
    btn.textContent = "Unavailable";
    setWakeStatus("This browser does not support keeping the screen awake.");
    return;
  }

  btn.disabled = false;
  btn.textContent = keepAwake ? "On" : "Off";
  setWakeStatus(keepAwake
    ? (wakeLock ? "Screen wake lock is active." : "Screen wake lock will activate while the app is visible.")
    : "Turn on to help keep live voice active while the app is open.");
}

async function requestWakeLock() {
  if (!keepAwake || !("wakeLock" in navigator) || document.visibilityState !== "visible") {
    syncWakeUi();
    return;
  }

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      syncWakeUi();
    });
  } catch {
    wakeLock = null;
  }
  syncWakeUi();
}

async function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  if (lock) await lock.release().catch(() => {});
  syncWakeUi();
}

async function toggleKeepAwake() {
  keepAwake = !keepAwake;
  localStorage.setItem(WAKE_LOCK_KEY, keepAwake ? "1" : "0");
  if (keepAwake) await requestWakeLock();
  else await releaseWakeLock();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") requestWakeLock();
});

// ============================================================ NOTIFICATIONS =
const NOTIFY_JOIN_KEY = "bp2p-notify-joins";
let notifyJoins = localStorage.getItem(NOTIFY_JOIN_KEY) === "1";

function canNotify() {
  return "Notification" in window && Notification.permission === "granted" && notifyJoins;
}

function setNotificationStatus(text) {
  const el = $("#notification-status");
  if (el) el.textContent = text;
}

function syncNotificationUi() {
  const btn = $("#btn-enable-notifications");
  if (!btn) return;

  if (!("Notification" in window)) {
    btn.disabled = true;
    btn.textContent = "Unavailable";
    setNotificationStatus("This browser does not support local notifications.");
    return;
  }

  if (Notification.permission === "denied") {
    btn.disabled = true;
    btn.textContent = "Blocked";
    setNotificationStatus("Notifications are blocked in browser settings.");
    return;
  }

  btn.disabled = false;
  btn.textContent = notifyJoins && Notification.permission === "granted" ? "Enabled" : "Enable";
  setNotificationStatus(
    notifyJoins && Notification.permission === "granted"
      ? "Join notifications are enabled."
      : "Enable notifications to be alerted when someone joins."
  );
}

async function enableJoinNotifications() {
  if (!("Notification" in window)) {
    syncNotificationUi();
    return;
  }

  const permission = Notification.permission === "default"
    ? await Notification.requestPermission()
    : Notification.permission;

  notifyJoins = permission === "granted";
  localStorage.setItem(NOTIFY_JOIN_KEY, notifyJoins ? "1" : "0");
  syncNotificationUi();
}

function notifyPlayerJoined(name) {
  if (!canNotify()) return;
  if (document.visibilityState === "visible" && !profileOpen && !chatOpen) return;

  const notification = new Notification("browserP2P", {
    body: `${name} joined the lobby`,
    icon: "icons/robot.svg",
    tag: "browserp2p-player-joined",
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

// ============================================================ IDENTITY ======
function clientId() {
  let id = localStorage.getItem("bp2p-client-id");
  if (!id) {
    id = "c-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("bp2p-client-id", id);
  }
  return id;
}

const MY_ID = clientId();

// Default icon: deterministic from the last two chars of MY_ID so it's stable
// without an extra localStorage entry, but changes if the user picks another.
const DEFAULT_ICON = ICONS[parseInt(MY_ID.slice(-2), 36) % ICONS.length];
const DEFAULT_NAME = "Player " + MY_ID.slice(2, 5).toUpperCase();

// Profile: persisted to localStorage, reflected live to all peers.
const profile = {
  name:  localStorage.getItem("bp2p-name")  || DEFAULT_NAME,
  icon:  localStorage.getItem("bp2p-icon")  || DEFAULT_ICON,
  color: localStorage.getItem("bp2p-color") || "",   // preferred; host may reassign
};

// myColor: the actual color the host assigned (may differ from preference).
let myColor = profile.color || COLORS[0];

// profiles: id -> { name, color, icon } for every connected player.
// Used to render chat bubbles retroactively when a profile changes.
const profiles = new Map();
profiles.set(MY_ID, { name: profile.name, color: myColor, icon: profile.icon });

// ============================================================ NET ==========
let net = new PeerNet();
let autoMode = true;
let hasLeftLobby = false;

// ============================================================ DOM ===========
const $ = (sel) => document.querySelector(sel);
const screens = { menu: $("#screen-menu"), lobby: $("#screen-lobby"), play: $("#screen-play") };
function show(name) {
  for (const key in screens) screens[key].classList.toggle("active", key === name);
}

// ============================================================ HOST STATE ====
const players  = new Map();   // id -> { id, name, color, icon, x, y }
const peerMap  = new Map();   // transport peerId -> clientId
let usedColors = new Set();

function pickColor() {
  for (const c of COLORS) if (!usedColors.has(c)) { usedColors.add(c); return c; }
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function addPlayer(id, name, peerId, icon, preferredColor) {
  if (players.has(id)) {
    if (peerId) peerMap.set(peerId, id);
    return players.get(id);
  }
  let color;
  if (preferredColor && !usedColors.has(preferredColor)) {
    color = preferredColor;
    usedColors.add(color);
  } else {
    color = pickColor();
  }
  const p = { id, name, color, icon: icon || DEFAULT_ICON, x: 0.5, y: 0.5 };
  players.set(id, p);
  if (peerId) peerMap.set(peerId, id);
  profiles.set(id, { name: p.name, color: p.color, icon: p.icon });
  return p;
}

// ============================================================ NET WIRING ====
function wireNetEvents() {
  net.on("ready", () => {
    if (lastState.length > 0) {
      // Host migration: restore last snapshot so players keep colors and positions.
      for (const p of lastState) {
        players.set(p.id, { ...p, icon: p.icon || DEFAULT_ICON });
        usedColors.add(p.color);
        profiles.set(p.id, { name: p.name, color: p.color, icon: p.icon || DEFAULT_ICON });
      }
    } else {
      addPlayer(MY_ID, profile.name, null, profile.icon, profile.color);
    }
    startHostLoop();
    renderLobby();
    show("lobby");
  });

  net.on("peer-join", () => renderLobby());

  net.on("peer-leave", (peerId) => {
    const id = peerMap.get(peerId);
    if (id) {
      const p = players.get(id);
      const name = p ? p.name : "Someone";
      if (p) usedColors.delete(p.color);
      players.delete(id);
      peerMap.delete(peerId);
      markSilent(id);
      pushSys(name + " left");
      net.broadcast({ t: "sys", text: name + " left" });
    }
    renderLobby();
  });

  net.on("connected", () => {
    net.send({ t: "hello", id: MY_ID, name: profile.name, icon: profile.icon, preferredColor: profile.color });
    show("lobby");
  });

  net.on("host-closed", () => {
    if (hasLeftLobby) return;
    if (!autoMode) { alert("The host left. Game over."); location.reload(); return; }
    const myIndex = lastHostOrder.indexOf(MY_ID);
    const delay = Math.max(0, myIndex) * 700;
    hostLoopRunning = false;
    setTimeout(() => {
      if (!hasLeftLobby) net.migrate(AUTO_CHANNEL);
    }, delay);
  });

  net.on("error", (err) => {
    console.error(err);
    setStatus("Connection error: " + (err.type || err.message || err));
  });

  net.on("message", ({ from, data }) => {
    if (net.isHost) handleHostMsg(from, data);
    else handleClientMsg(data);
  });
}
wireNetEvents();

// ---- host-side message handling ----
function handleHostMsg(peerId, msg) {
  if (msg.t === "hello") {
    const p = addPlayer(msg.id, msg.name, peerId, msg.icon, msg.preferredColor);
    net.sendTo(peerId, { t: "welcome", color: p.color });
    net.sendTo(peerId, { t: "history", chatLog });
    net.sendTo(peerId, { t: "drawing", strokes: drawingStrokes });
    pushSys(p.name + " joined");
    net.broadcast({ t: "sys", text: p.name + " joined" });
    if (p.id !== MY_ID) notifyPlayerJoined(p.name);
    renderLobby();

  } else if (msg.t === "input") {
    const id = peerMap.get(peerId);
    const p  = id && players.get(id);
    if (p) { p.x = clamp01(msg.x); p.y = clamp01(msg.y); }

  } else if (msg.t === "profile") {
    const id = peerMap.get(peerId);
    const p  = id && players.get(id);
    if (!p) return;
    p.name = msg.name;
    p.icon = msg.icon;
    if (msg.preferredColor && !usedColors.has(msg.preferredColor)) {
      usedColors.delete(p.color);
      p.color = msg.preferredColor;
      usedColors.add(p.color);
    }
    profiles.set(id, { name: p.name, color: p.color, icon: p.icon });
    net.broadcast({ t: "profile", id, name: p.name, color: p.color, icon: p.icon });
    renderChat();

  } else if (msg.t === "chat") {
    const id = peerMap.get(peerId);
    if (!id) return;
    const entry = { fromId: id, text: msg.text, ts: Date.now() };
    chatLog.push(entry);
    saveChatLog();
    renderChat();
    net.broadcast({ t: "chat", fromId: id, text: msg.text, ts: entry.ts });

  } else if (msg.t === "draw") {
    addDrawingStroke(msg.stroke, false);
    for (const [targetPeerId, conn] of net.conns) {
      if (targetPeerId !== peerId && conn.open) conn.send({ t: "draw", stroke: msg.stroke });
    }

  } else if (msg.t === "audio-start" || msg.t === "audio-stop" || msg.t === "audio-pcm") {
    const id = peerMap.get(peerId);
    if (!id) return;
    msg.fromId = id;
    handleLiveAudio(msg);
    net.broadcast(msg);
  }
}

// ---- client-side message handling ----
let myColor_assigned = false;
function handleClientMsg(msg) {
  if (msg.t === "welcome") {
    myColor = msg.color;
    profile.color = msg.color;
    profiles.set(MY_ID, { ...profiles.get(MY_ID), color: myColor });
    updateProfilePreview();
    renderLobby();

  } else if (msg.t === "state") {
    lastState = msg.players;
    if (msg.hostOrder) lastHostOrder = msg.hostOrder;
    for (const p of msg.players) {
      profiles.set(p.id, { name: p.name, color: p.color, icon: p.icon || DEFAULT_ICON });
    }
    renderLobby();

  } else if (msg.t === "profile") {
    profiles.set(msg.id, { name: msg.name, color: msg.color, icon: msg.icon });
    if (msg.id === MY_ID) {
      myColor = msg.color;
      profile.color = msg.color;
      localStorage.setItem("bp2p-color", msg.color);
      updateProfilePreview();
    }
    renderChat();

  } else if (msg.t === "history") {
    chatLog.length = 0;
    chatLog.push(...msg.chatLog);
    saveChatLog();
    renderChat();

  } else if (msg.t === "drawing") {
    replaceDrawing(msg.strokes);

  } else if (msg.t === "chat") {
    chatLog.push({ fromId: msg.fromId, text: msg.text, ts: msg.ts });
    saveChatLog();
    renderChat();
    if (!chatOpen) showChatBadge();

  } else if (msg.t === "draw") {
    addDrawingStroke(msg.stroke, false);

  } else if (msg.t === "audio-start" || msg.t === "audio-stop" || msg.t === "audio-pcm") {
    handleLiveAudio(msg);

  } else if (msg.t === "sys") {
    pushSys(msg.text);
    const joined = msg.text.match(/^(.+) joined$/);
    if (joined) notifyPlayerJoined(joined[1]);
  }
}

// ============================================================ HOST LOOP =====
let hostLoopRunning = false;
let lastState = [];
let lastHostOrder = [];

function startHostLoop() {
  if (hostLoopRunning) return;
  hostLoopRunning = true;
  setInterval(() => {
    const list = [...players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, icon: p.icon, x: p.x, y: p.y,
    }));
    const hostOrder = [...players.keys()];
    net.broadcast({ t: "state", players: list, hostOrder });
    lastState = list;
    lastHostOrder = hostOrder;
  }, 1000 / TICK_HZ);
}

// ============================================================ CHAT =========
const CHAT_KEY   = "bp2p-chat";
const CHAT_LIMIT = 500;

function loadChatLog() {
  try { return JSON.parse(localStorage.getItem(CHAT_KEY) || "[]"); } catch { return []; }
}
function saveChatLog() {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatLog.slice(-CHAT_LIMIT))); } catch {}
}

const chatLog = loadChatLog();
let chatOpen   = false;
let unreadCount = 0;

// ============================================================ DRAWING =======
const DRAWING_KEY = "bp2p-drawing";
const DRAWING_LIMIT = 800;
const DRAW_COLOR = "#fff";

function loadDrawing() {
  try { return JSON.parse(localStorage.getItem(DRAWING_KEY) || "[]"); } catch { return []; }
}
function saveDrawing() {
  try { localStorage.setItem(DRAWING_KEY, JSON.stringify(drawingStrokes.slice(-DRAWING_LIMIT))); } catch {}
}

const drawingStrokes = loadDrawing();
let drawMode = false;
let drawing = false;
let currentStroke = null;

function addDrawingStroke(stroke, broadcast = true) {
  if (!stroke || !stroke.points || stroke.points.length < 2) return;
  if (stroke.id && drawingStrokes.some((s) => s.id === stroke.id)) return;
  drawingStrokes.push(stroke);
  if (drawingStrokes.length > DRAWING_LIMIT) drawingStrokes.splice(0, drawingStrokes.length - DRAWING_LIMIT);
  saveDrawing();
  if (broadcast) sendDrawingStroke(stroke);
}

function replaceDrawing(strokes) {
  drawingStrokes.length = 0;
  drawingStrokes.push(...(Array.isArray(strokes) ? strokes.slice(-DRAWING_LIMIT) : []));
  saveDrawing();
}

function sendDrawingStroke(stroke) {
  const msg = { t: "draw", stroke };
  if (net.isHost) net.broadcast(msg);
  else net.send(msg);
}

function drawStroke(stroke, rect) {
  const points = stroke.points || [];
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = stroke.color || DRAW_COLOR;
  ctx.lineWidth = stroke.width || 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0].x * rect.width, points[0].y * rect.height);
  for (let i = 1; i < points.length - 1; i++) {
    const midX = ((points[i].x + points[i + 1].x) / 2) * rect.width;
    const midY = ((points[i].y + points[i + 1].y) / 2) * rect.height;
    ctx.quadraticCurveTo(points[i].x * rect.width, points[i].y * rect.height, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x * rect.width, last.y * rect.height);
  ctx.stroke();
  ctx.restore();
}

function renderDrawing(rect) {
  for (const stroke of drawingStrokes) drawStroke(stroke, rect);
  if (currentStroke) drawStroke(currentStroke, rect);
}

function setDrawMode(enabled) {
  drawMode = enabled;
  $("#btn-draw").classList.toggle("active", drawMode);
}

function pushSys(text) {
  chatLog.push({ sys: true, text });
  saveChatLog();
  renderChat();
  if (!chatOpen) showChatBadge();
}

function renderChat() {
  const log = $("#chat-log");
  const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = "";
  for (const entry of chatLog) {
    if (entry.sys) {
      const el = document.createElement("div");
      el.className = "chat-msg sys";
      el.textContent = entry.text;
      log.appendChild(el);
      continue;
    }
    const pf   = profiles.get(entry.fromId) || { name: "?", color: "#888", icon: "👤" };
    const isMe = entry.fromId === MY_ID;
    const el   = document.createElement("div");
    el.className = "chat-msg" + (isMe ? " mine" : "");

    if (entry.voice) continue; // voice messages no longer shown in thread
    el.innerHTML = `
      <div class="msg-avatar" style="background:${pf.color}">${pf.icon}</div>
      <div class="msg-body">
        <div class="msg-name" style="color:${pf.color}">${esc(pf.name)}</div>
        <div class="msg-bubble">${esc(entry.text)}</div>
      </div>`;
    log.appendChild(el);
  }
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}


function showChatBadge() {
  unreadCount++;
  const badge = $("#chat-badge");
  badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
  badge.classList.remove("hidden");
}

function openChat() {
  chatOpen = true;
  unreadCount = 0;
  $("#chat-badge").classList.add("hidden");
  $("#panel-chat").classList.add("open");
  renderChat();
  setTimeout(() => {
    const log = $("#chat-log");
    log.scrollTop = log.scrollHeight;
    $("#chat-input").focus();
  }, 50);
}

function closeChat() {
  chatOpen = false;
  $("#panel-chat").classList.remove("open");
}

function sendChat() {
  const input = $("#chat-input");
  const text  = input.value.trim();
  if (!text) return;
  input.value = "";
  if (net.isHost) {
    const entry = { fromId: MY_ID, text, ts: Date.now() };
    chatLog.push(entry);
    saveChatLog();
    renderChat();
    net.broadcast({ t: "chat", fromId: MY_ID, text, ts: entry.ts });
  } else {
    net.send({ t: "chat", text });
  }
}

// ============================================================ VOICE =========
const voiceCache = new Map(); // msgId -> { url, blob } (ephemeral — cleared on reload)

// iOS Safari blocks HTMLAudioElement.play() without a fresh gesture. Fix: use a
// Web AudioContext that is unlocked once on the first user interaction and stays
// running for the session. Decode the blob via decodeAudioData to play it.
let msgAudioCtx = null;
function ensureMsgAudioCtx() {
  if (!msgAudioCtx) msgAudioCtx = new AudioContext();
  if (msgAudioCtx.state === "suspended") msgAudioCtx.resume().catch(() => {});
  return msgAudioCtx;
}
// Unlock on the first touch/click anywhere on the page.
document.addEventListener("touchend", () => ensureMsgAudioCtx(), { passive: true });
document.addEventListener("click",    () => ensureMsgAudioCtx(), { passive: true });

async function autoPlayVoice(blob) {
  const ctx = ensureMsgAudioCtx();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* codec not supported on this browser — silently skip */ }
}
const MAX_RECORD_MS = 30_000;
let mediaRecorder  = null;
let recChunks      = [];
let recStart       = 0;
let recTimerStop   = null;
let recTickInterval = null;

function fmtDur(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function bestMimeType() {
  const candidates = [
    "audio/webm;codecs=opus", "audio/webm",
    "audio/ogg;codecs=opus",  "audio/mp4",
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function startRecording() {
  if (mediaRecorder) return;
  const label = $("#ptt-label");
  try {
    const stream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const mimeType = bestMimeType();
    mediaRecorder  = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    recChunks      = [];
    recStart       = Date.now();

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const duration = (Date.now() - recStart) / 1000;
      if (duration >= 0.5) {
        const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        sendVoiceMessage(blob, duration);
      }
      mediaRecorder = null;
      setPttIdle();
    };

    mediaRecorder.start(100);
    setPttRecording();
    recTimerStop = setTimeout(stopRecording, MAX_RECORD_MS);
  } catch {
    mediaRecorder = null;
    setPttIdle();
    if (label) label.textContent = "Mic unavailable";
    setTimeout(() => { if (label) label.textContent = "Hold to talk"; }, 2500);
  }
}

function stopRecording() {
  clearTimeout(recTimerStop);
  clearInterval(recTickInterval);
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

function setPttRecording() {
  $("#btn-ptt").classList.add("recording");
  const label = $("#ptt-label");
  recTickInterval = setInterval(() => {
    if (label) label.textContent = "Recording " + fmtDur((Date.now() - recStart) / 1000);
  }, 200);
}

function setPttIdle() {
  clearInterval(recTickInterval);
  $("#btn-ptt").classList.remove("recording");
  const label = $("#ptt-label");
  if (label) label.textContent = "Hold to talk";
}

async function sendVoiceMessage(blob, duration) {
  // Convert to base64 for transport over PeerJS DataChannel.
  const ab     = await blob.arrayBuffer();
  const bytes  = new Uint8Array(ab);
  let binary   = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const audioB64 = btoa(binary);

  const msgId = MY_ID + "-" + Date.now();
  const ts    = Date.now();
  const mimeType = blob.type;

  // Store locally so the sender can replay their own message.
  voiceCache.set(msgId, { url: URL.createObjectURL(blob), blob });

  const entry = { fromId: MY_ID, voice: true, msgId, duration, ts };
  chatLog.push(entry);
  saveChatLog();
  renderChat();

  const msg = { t: "voice", fromId: MY_ID, msgId, mimeType, audioB64, duration, ts };
  if (net.isHost) {
    net.broadcast(msg); // host sends directly to all clients
  } else {
    net.send(msg);      // client sends to host; host rebroadcasts
  }
}

function receiveVoiceMessage(msg) {
  const { fromId, msgId, mimeType, audioB64, duration, ts } = msg;
  // Never play back the sender's own echoed message.
  if (fromId === MY_ID) return;
  // Dedup: if we already have this entry (race or reconnect), skip.
  if (chatLog.some((e) => e.voice && e.msgId === msgId)) return;

  // Decode base64 → blob → cache.
  const binary = atob(audioB64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType || "audio/webm" });
  const url  = URL.createObjectURL(blob);
  voiceCache.set(msgId, { url, blob });

  chatLog.push({ fromId, voice: true, msgId, duration, ts });
  saveChatLog();
  renderChat();
  if (!chatOpen) showChatBadge();

  // Auto-play via Web Audio so it works on iOS Safari (unlocked AudioContext).
  autoPlayVoice(blob);
}

// PTT events for optional record-to-thread buttons.
function attachPtt(btn) {
  if (!btn) return;
  btn.addEventListener("mousedown",   (e) => { e.preventDefault(); startRecording(); });
  btn.addEventListener("mouseup",     stopRecording);
  btn.addEventListener("mouseleave",  stopRecording);
  btn.addEventListener("touchstart",  (e) => { e.preventDefault(); startRecording(); }, { passive: false });
  btn.addEventListener("touchend",    (e) => { e.preventDefault(); stopRecording(); },  { passive: false });
  btn.addEventListener("touchcancel", stopRecording);
}
attachPtt($("#btn-ptt"));
// #btn-mic is wired separately in the LIVE VOICE section below.

// ============================================================ LIVE VOICE ====
// Real-time walkie-talkie: raw 16kHz PCM streamed as Int16 base64 over the
// existing DataChannel. No storage, no thread association. Multiple speakers
// can be active simultaneously; each has an independent jitter-buffered queue.

const speaking        = new Set();          // ids currently transmitting
const speakerTimeouts = new Map();          // id -> auto-clear timeout
const speakerBufs     = new Map();          // id -> { nextTime } for scheduling
let   playAudioCtx    = null;               // shared playback context

// Capture state (one instance per PTT press)
let liveStream    = null;
let liveCapCtx    = null;
let liveProcessor = null;

const LIVE_SR    = 16000; // sample rate — adequate for voice
const LIVE_CHUNK = 512;   // samples per callback (~32 ms)

function handleLiveAudio(msg) {
  const { fromId, t } = msg;
  if (fromId === MY_ID) return; // ignore own echoes from host relay

  if (t === "audio-start") {
    markSpeaking(fromId);
  } else if (t === "audio-stop") {
    markSilent(fromId);
  } else if (t === "audio-pcm") {
    markSpeaking(fromId);
    playLivePcm(fromId, msg.b64);
  }
}

function markSpeaking(fromId) {
  speaking.add(fromId);
  clearTimeout(speakerTimeouts.get(fromId));
  // Auto-remove after 3 s if the sender crashes without sending audio-stop.
  speakerTimeouts.set(fromId, setTimeout(() => {
    speaking.delete(fromId);
    speakerTimeouts.delete(fromId);
    speakerBufs.delete(fromId);
  }, 3000));
}

function markSilent(fromId) {
  speaking.delete(fromId);
  clearTimeout(speakerTimeouts.get(fromId));
  speakerTimeouts.delete(fromId);
  speakerBufs.delete(fromId);
}

function playLivePcm(fromId, b64) {
  if (!playAudioCtx) playAudioCtx = new AudioContext({ sampleRate: LIVE_SR });
  if (playAudioCtx.state === "suspended") playAudioCtx.resume();

  // base64 → bytes → Int16 → Float32
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16   = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const buf = playAudioCtx.createBuffer(1, float32.length, LIVE_SR);
  buf.copyToChannel(float32, 0);
  const node = playAudioCtx.createBufferSource();
  node.buffer = buf;
  node.connect(playAudioCtx.destination);

  // Per-sender jitter buffer — each chunk schedules right after the last.
  if (!speakerBufs.has(fromId)) speakerBufs.set(fromId, { nextTime: 0 });
  const spk    = speakerBufs.get(fromId);
  const now    = playAudioCtx.currentTime;
  const playAt = Math.max(now + 0.05, spk.nextTime); // 50 ms minimum buffer
  node.start(playAt);
  spk.nextTime = playAt + buf.duration;
}

function sendLiveMsg(msg) {
  if (net.isHost) net.broadcast(msg);
  else net.send(msg);
}

async function startLiveVoice() {
  if (liveStream) return;
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    liveCapCtx = new AudioContext({ sampleRate: LIVE_SR });
    const src  = liveCapCtx.createMediaStreamSource(liveStream);

    liveProcessor = liveCapCtx.createScriptProcessor(LIVE_CHUNK, 1, 1);
    liveProcessor.onaudioprocess = (e) => {
      const pcm   = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
      }
      const bytes  = new Uint8Array(int16.buffer);
      let   binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      sendLiveMsg({ t: "audio-pcm", fromId: MY_ID, b64: btoa(binary) });
    };

    // Mute local output (ScriptProcessor must connect to destination to fire,
    // but we don't want to hear ourselves).
    const mute = liveCapCtx.createGain();
    mute.gain.value = 0;
    src.connect(liveProcessor);
    liveProcessor.connect(mute);
    mute.connect(liveCapCtx.destination);

    speaking.add(MY_ID);
    sendLiveMsg({ t: "audio-start", fromId: MY_ID });
    $("#btn-mic").classList.add("recording");
  } catch {
    liveStream = null;
    $("#btn-mic").classList.remove("recording");
  }
}

function stopLiveVoice() {
  if (!liveStream) return;
  liveProcessor?.disconnect();
  liveProcessor = null;
  liveCapCtx?.close().catch(() => {});
  liveCapCtx = null;
  liveStream.getTracks().forEach((t) => t.stop());
  liveStream = null;

  speaking.delete(MY_ID);
  sendLiveMsg({ t: "audio-stop", fromId: MY_ID });
  $("#btn-mic").classList.remove("recording");
}

// HUD mic button → live voice (independent from in-chat record-to-thread PTT)
const hudMic = $("#btn-mic");
hudMic.addEventListener("mousedown",   (e) => { e.preventDefault(); startLiveVoice(); });
hudMic.addEventListener("mouseup",     stopLiveVoice);
hudMic.addEventListener("mouseleave",  stopLiveVoice);
hudMic.addEventListener("touchstart",  (e) => { e.preventDefault(); startLiveVoice(); }, { passive: false });
hudMic.addEventListener("touchend",    (e) => { e.preventDefault(); stopLiveVoice(); },  { passive: false });
hudMic.addEventListener("touchcancel", stopLiveVoice);

// ============================================================ PROFILE UI ====
let profileOpen = false;

function openProfileSheet() {
  profileOpen = true;
  // Populate fields from current profile.
  $("#input-name").value = profile.name;
  buildColorPicker();
  buildIconPicker();
  updateProfilePreview();
  $("#sheet-profile").classList.add("open");
}

function closeProfileSheet() {
  profileOpen = false;
  $("#sheet-profile")?.classList.remove("open");
}

function leaveLobby() {
  hasLeftLobby = true;
  autoMode = false;
  hostLoopRunning = false;
  stopLiveVoice();
  net.destroy();
  players.clear();
  peerMap.clear();
  usedColors.clear();
  lastState = [];
  lastHostOrder = [];
  drawing = false;
  currentStroke = null;
  setDrawMode(false);
  closeProfileSheet();
  show("menu");
  $("#btn-auto").disabled = false;
  $("#auto-status").textContent = "Finds or starts the game on your Wi-Fi.";
  setStatus("");
}

function enterDefaultLobby() {
  hasLeftLobby = false;
  autoMode = true;
  renderLobby();
  show("lobby");
  net.auto(AUTO_CHANNEL);
}

function buildColorPicker() {
  const grid = $("#picker-color");
  grid.innerHTML = "";
  for (const c of COLORS) {
    const btn = document.createElement("button");
    btn.className = "swatch-opt" + (c === (myColor || profile.color) ? " selected" : "");
    btn.style.background = c;
    btn.setAttribute("aria-label", c);
    btn.addEventListener("click", () => {
      profile.color = c;
      localStorage.setItem("bp2p-color", c);
      updateProfilePreview();
      grid.querySelectorAll(".swatch-opt").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      broadcastProfile();
    });
    grid.appendChild(btn);
  }
}

function buildIconPicker() {
  const grid = $("#picker-icon");
  grid.innerHTML = "";
  for (const ic of ICONS) {
    const btn = document.createElement("button");
    btn.className = "icon-opt" + (ic === profile.icon ? " selected" : "");
    btn.textContent = ic;
    btn.addEventListener("click", () => {
      profile.icon = ic;
      localStorage.setItem("bp2p-icon", ic);
      profiles.set(MY_ID, { ...profiles.get(MY_ID), icon: ic });
      updateProfilePreview();
      grid.querySelectorAll(".icon-opt").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      broadcastProfile();
      if (net.isHost) {
        const me = players.get(MY_ID);
        if (me) { me.icon = ic; profiles.set(MY_ID, { ...profiles.get(MY_ID), icon: ic }); }
      }
    });
    grid.appendChild(btn);
  }
}

function updateProfilePreview() {
  const color = myColor || profile.color || COLORS[0];
  $("#preview-dot").style.background = color;
  $("#preview-dot").textContent = profile.icon;
  $("#preview-name").textContent = profile.name;
}

function broadcastProfile() {
  const msg = { t: "profile", name: profile.name, icon: profile.icon, preferredColor: profile.color };
  if (net.isHost) {
    const me = players.get(MY_ID);
    if (me) {
      me.name = profile.name;
      me.icon = profile.icon;
      // Host always gets their preferred color.
      if (!usedColors.has(profile.color) || me.color === profile.color) {
        usedColors.delete(me.color);
        me.color = profile.color;
        myColor  = profile.color;
        usedColors.add(me.color);
      }
      profiles.set(MY_ID, { name: me.name, color: me.color, icon: me.icon });
      net.broadcast({ t: "profile", id: MY_ID, name: me.name, color: me.color, icon: me.icon });
    }
    renderChat();
  } else {
    net.send(msg);
  }
}

// Name input: debounce to avoid broadcasting every keystroke.
let nameTimer = null;
$("#input-name").addEventListener("input", (e) => {
  profile.name = e.target.value.trim() || DEFAULT_NAME;
  localStorage.setItem("bp2p-name", profile.name);
  profiles.set(MY_ID, { ...profiles.get(MY_ID), name: profile.name });
  updateProfilePreview();
  clearTimeout(nameTimer);
  nameTimer = setTimeout(broadcastProfile, 500);
  if (net.isHost) {
    const me = players.get(MY_ID);
    if (me) { me.name = profile.name; profiles.set(MY_ID, { ...profiles.get(MY_ID), name: profile.name }); }
  }
});

// ============================================================ LOBBY UI ======
function renderLobby() {
  const code = net.code || "----";
  $("#lobby-code").textContent = code;
  const joinUrl = `${location.origin}${location.pathname}?join=${code}`;
  $("#join-url").textContent = code === "----" ? "Joining lobby…" : joinUrl.replace(/^https?:\/\//, "");
  if (code === "----") $("#qr").innerHTML = "";
  else drawQR(joinUrl);
  const list = $("#player-list");
  list.innerHTML = "";
  const lobbyPlayers = net.isHost ? Array.from(players.values()) : lastState;
  for (const p of lobbyPlayers) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="swatch" style="background:${p.color}"></span>${esc(p.name)}`;
    list.appendChild(li);
  }
  $("#player-count").textContent = lobbyPlayers.length;
}

let qr = null;
function drawQR(text) {
  const el = $("#qr");
  el.innerHTML = "";
  qr = new QRCode(el, { text, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
}

function setStatus(text) {
  const s = $("#join-status");
  if (s) s.textContent = text;
}

// ============================================================ CANVAS ========
const canvas = $("#stage");
const ctx    = canvas.getContext("2d");
let dragging = false;

function syncCanvasSize() {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return rect;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width  * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return rect;
}

function pointerToNorm(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  return {
    x: clamp01((src.clientX - rect.left)  / rect.width),
    y: clamp01((src.clientY - rect.top)   / rect.height),
  };
}

function pointerPressure(e) {
  const src = e.touches ? e.touches[0] : e;
  return src.force || src.pressure || 0.5;
}

function onDown(e) {
  // Don't drag when a sheet or chat panel is open.
  if (profileOpen || chatOpen) return;
  if (drawMode) {
    e.preventDefault();
    drawing = true;
    const point = pointerToNorm(e);
    currentStroke = {
      id: MY_ID + "-" + Date.now(),
      color: DRAW_COLOR,
      width: 2 + pointerPressure(e) * 6,
      points: [point],
    };
    return;
  }
  dragging = true;
  onMove(e);
}
function onMove(e) {
  if (drawing && currentStroke) {
    e.preventDefault();
    const point = pointerToNorm(e);
    const last = currentStroke.points[currentStroke.points.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.003) currentStroke.points.push(point);
    return;
  }
  if (!dragging) return;
  e.preventDefault();
  const { x, y } = pointerToNorm(e);
  if (net.isHost) {
    const me = players.get(MY_ID);
    if (me) { me.x = x; me.y = y; }
  } else {
    net.send({ t: "input", x, y });
  }
}
function onUp() {
  if (drawing && currentStroke) addDrawingStroke(currentStroke);
  drawing = false;
  currentStroke = null;
  dragging = false;
}

canvas.addEventListener("mousedown",  onDown);
canvas.addEventListener("mousemove",  onMove);
window.addEventListener("mouseup",    onUp);
canvas.addEventListener("touchstart", onDown, { passive: false });
canvas.addEventListener("touchmove",  onMove, { passive: false });
window.addEventListener("touchend",   onUp);
window.addEventListener("touchcancel", onUp);

function render() {
  const rect = syncCanvasSize();
  ctx.clearRect(0, 0, rect.width, rect.height);
  renderDrawing(rect);

  for (const p of lastState) {
    const x = p.x * rect.width;
    const y = p.y * rect.height;
    const isMe = p.id === MY_ID;

    // Dot
    ctx.beginPath();
    ctx.arc(x, y, 24, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    if (isMe) {
      ctx.lineWidth   = 3;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }

    // Icon emoji inside dot
    ctx.font          = "20px serif";
    ctx.textAlign     = "center";
    ctx.textBaseline  = "middle";
    ctx.fillText(p.icon || "●", x, y);

    // Speaking ring (pulses when live voice is active)
    if (speaking.has(p.id)) {
      const pulse = 0.5 + 0.5 * Math.abs(Math.sin(Date.now() / 220));
      ctx.beginPath();
      ctx.arc(x, y, 28 + pulse * 5, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(124,252,155,${0.5 + 0.5 * pulse})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Name above dot
    ctx.font          = "bold 11px system-ui, sans-serif";
    ctx.textBaseline  = "alphabetic";
    ctx.fillStyle     = "rgba(255,255,255,0.85)";
    ctx.fillText(p.name, x, y - 32);
  }

  requestAnimationFrame(render);
}

// ============================================================ MENU ACTIONS ==
$("#btn-auto").addEventListener("click", () => {
  if (!hasLeftLobby) return;
  net = new PeerNet();
  wireNetEvents();
  $("#btn-auto").disabled = true;
  $("#auto-status").textContent = "Looking for a game on your Wi-Fi…";
  enterDefaultLobby();
});

$("#btn-host").addEventListener("click", () => {
  setStatus("");
  net.host();
});

$("#btn-join").addEventListener("click", () => {
  const code = $("#code-input").value.trim().toUpperCase();
  if (code.length !== 4) { setStatus("Enter the 4-character code."); return; }
  setStatus("Connecting…");
  net.join(code);
});

$("#btn-start").addEventListener("click", () => show("play"));
$("#btn-draw").addEventListener("click", () => setDrawMode(!drawMode));

// Auto-join from QR link (?join=CODE).
const joinParam = new URLSearchParams(location.search).get("join");
if (joinParam) $("#code-input").value = joinParam.toUpperCase();

// ============================================================ PROFILE ACTIONS
$("#btn-profile").addEventListener("click", openProfileSheet);
$("#btn-lobby-settings").addEventListener("click", openProfileSheet);
$("#btn-close-profile").addEventListener("click", closeProfileSheet);
$("#app-version").textContent = APP_VERSION;
$("#btn-check-update").addEventListener("click", checkForUpdates);
$("#btn-leave-lobby").addEventListener("click", leaveLobby);
$("#btn-keep-awake").addEventListener("click", toggleKeepAwake);
syncWakeUi();
$("#btn-enable-notifications").addEventListener("click", enableJoinNotifications);
syncNotificationUi();

// ============================================================ CHAT ACTIONS ==
$("#btn-chat").addEventListener("click", openChat);
$("#btn-close-chat").addEventListener("click", closeChat);
$("#btn-send").addEventListener("click", sendChat);
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); sendChat(); }
});

// ---- helpers ----
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Kick off the render loop; draws nothing until we're playing.
registerServiceWorker();
requestWakeLock();
enterDefaultLobby();
render();
