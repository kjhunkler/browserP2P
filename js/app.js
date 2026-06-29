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
  "#ff5d5d", "#4dd2ff", "#7CFC9B", "#ffd24d",
  "#c98cff", "#ff9d4d", "#4d8bff", "#ff6fd0",
];
const ICONS = ["🦊","🐼","🐨","🦁","🐯","🦋","🐬","🦄","🐸","🐙","🐺","🦝"];
const TICK_HZ = 20;

// Channel scopes the auto-join host id. Empty = global default.
const AUTO_CHANNEL = "";

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
const net = new PeerNet();
let autoMode = false;

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
  if (autoMode) { show("play"); } else { renderLobby(); show("lobby"); }
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
    pushSys(name + " left");
    net.broadcast({ t: "sys", text: name + " left" });
  }
  renderLobby();
});

net.on("connected", () => {
  net.send({ t: "hello", id: MY_ID, name: profile.name, icon: profile.icon, preferredColor: profile.color });
  show("play");
});

net.on("host-closed", () => {
  if (!autoMode) { alert("The host left. Game over."); location.reload(); return; }
  const myIndex = lastHostOrder.indexOf(MY_ID);
  const delay = Math.max(0, myIndex) * 700;
  hostLoopRunning = false;
  setTimeout(() => net.migrate(AUTO_CHANNEL), delay);
});

net.on("error", (err) => {
  console.error(err);
  setStatus("Connection error: " + (err.type || err.message || err));
});

net.on("message", ({ from, data }) => {
  if (net.isHost) handleHostMsg(from, data);
  else handleClientMsg(data);
});

// ---- host-side message handling ----
function handleHostMsg(peerId, msg) {
  if (msg.t === "hello") {
    const p = addPlayer(msg.id, msg.name, peerId, msg.icon, msg.preferredColor);
    net.sendTo(peerId, { t: "welcome", color: p.color });
    pushSys(p.name + " joined");
    net.broadcast({ t: "sys", text: p.name + " joined" });
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
    renderChat();
    net.broadcast({ t: "chat", fromId: id, text: msg.text, ts: entry.ts });
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

  } else if (msg.t === "state") {
    lastState = msg.players;
    if (msg.hostOrder) lastHostOrder = msg.hostOrder;
    for (const p of msg.players) {
      profiles.set(p.id, { name: p.name, color: p.color, icon: p.icon || DEFAULT_ICON });
    }

  } else if (msg.t === "profile") {
    profiles.set(msg.id, { name: msg.name, color: msg.color, icon: msg.icon });
    if (msg.id === MY_ID) {
      myColor = msg.color;
      profile.color = msg.color;
      localStorage.setItem("bp2p-color", msg.color);
      updateProfilePreview();
    }
    renderChat();

  } else if (msg.t === "chat") {
    chatLog.push({ fromId: msg.fromId, text: msg.text, ts: msg.ts });
    renderChat();
    if (!chatOpen) showChatBadge();

  } else if (msg.t === "sys") {
    pushSys(msg.text);
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
const chatLog = [];   // { fromId, text, ts } | { sys, text }
let chatOpen   = false;
let unreadCount = 0;

function pushSys(text) {
  chatLog.push({ sys: true, text });
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
    const pf = profiles.get(entry.fromId) || { name: "?", color: "#888", icon: "👤" };
    const isMe = entry.fromId === MY_ID;
    const el = document.createElement("div");
    el.className = "chat-msg" + (isMe ? " mine" : "");
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
    renderChat();
    net.broadcast({ t: "chat", fromId: MY_ID, text, ts: entry.ts });
  } else {
    net.send({ t: "chat", text });
  }
}

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
  $("#sheet-profile").classList.remove("open");
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
  if (!net.isHost) return;
  $("#lobby-code").textContent = net.code || "----";
  const joinUrl = `${location.origin}${location.pathname}?join=${net.code}`;
  $("#join-url").textContent = joinUrl.replace(/^https?:\/\//, "");
  drawQR(joinUrl);
  const list = $("#player-list");
  list.innerHTML = "";
  for (const p of players.values()) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="swatch" style="background:${p.color}"></span>${esc(p.name)}`;
    list.appendChild(li);
  }
  $("#player-count").textContent = players.size;
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

function onDown(e) {
  // Don't drag when a sheet or chat panel is open.
  if (profileOpen || chatOpen) return;
  dragging = true;
  onMove(e);
}
function onMove(e) {
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
function onUp() { dragging = false; }

canvas.addEventListener("mousedown",  onDown);
canvas.addEventListener("mousemove",  onMove);
window.addEventListener("mouseup",    onUp);
canvas.addEventListener("touchstart", onDown, { passive: false });
canvas.addEventListener("touchmove",  onMove, { passive: false });
window.addEventListener("touchend",   onUp);

function render() {
  const rect = syncCanvasSize();
  ctx.clearRect(0, 0, rect.width, rect.height);

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
  autoMode = true;
  $("#btn-auto").disabled = true;
  $("#auto-status").textContent = "Looking for a game on your Wi-Fi…";
  net.auto(AUTO_CHANNEL);
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

// Auto-join from QR link (?join=CODE).
const joinParam = new URLSearchParams(location.search).get("join");
if (joinParam) $("#code-input").value = joinParam.toUpperCase();

// ============================================================ PROFILE ACTIONS
$("#btn-profile").addEventListener("click", openProfileSheet);
$("#btn-close-profile").addEventListener("click", closeProfileSheet);

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
render();
