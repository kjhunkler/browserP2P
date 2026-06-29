/*
 * app.js — the demo game layered on top of peer-net.js.
 *
 * It's deliberately trivial: every connected phone gets a colored dot it can
 * drag. The HOST runs an authoritative ~20Hz loop, collects everyone's input,
 * and broadcasts the full state; every phone renders what the host sends. This
 * exercises the whole multiplayer skeleton (discovery, join, host-authority,
 * broadcast, reconnect) without committing to a real game design.
 *
 * Protocol:
 *   client -> host : { t:'hello', id, name }      on connect
 *                    { t:'input', x, y }          on drag (normalized 0..1)
 *   host -> client : { t:'welcome', color }       on join
 *                    { t:'state', players:[...] } every tick
 */

const COLORS = [
  "#ff5d5d", "#4dd2ff", "#7CFC9B", "#ffd24d",
  "#c98cff", "#ff9d4d", "#4d8bff", "#ff6fd0",
];
const TICK_HZ = 20;

// Stable per-device identity so a dropped player reclaims its slot on rejoin.
function clientId() {
  let id = localStorage.getItem("bp2p-client-id");
  if (!id) {
    id = "c-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("bp2p-client-id", id);
  }
  return id;
}

const MY_ID = clientId();
const MY_NAME = "Player " + MY_ID.slice(2, 5).toUpperCase();

const net = new PeerNet();

// Channel scopes the well-known auto-join host id. Empty = the global default,
// which is fine when you only run one game per network. Set it (e.g. a family
// name) only if you ever need to avoid colliding with other users worldwide.
const AUTO_CHANNEL = "";
let autoMode = false;

// ---- DOM ----
const $ = (sel) => document.querySelector(sel);
const screens = {
  menu: $("#screen-menu"),
  lobby: $("#screen-lobby"),
  play: $("#screen-play"),
};
function show(name) {
  for (const key in screens) screens[key].classList.toggle("active", key === name);
}

// ============================================================ HOST STATE ====
// Keyed by clientId. peerMap maps a transport peerId -> clientId so we can drop
// the right player when a connection closes.
const players = new Map();
const peerMap = new Map();
let usedColors = new Set();

function pickColor() {
  for (const c of COLORS) if (!usedColors.has(c)) { usedColors.add(c); return c; }
  return COLORS[Math.floor(Math.random() * COLORS.length)]; // ran out — reuse
}

function addPlayer(id, name, peerId) {
  if (players.has(id)) {
    // Rejoin: keep color/position, just rebind the transport peer.
    if (peerId) peerMap.set(peerId, id);
    return players.get(id);
  }
  const p = { id, name, color: pickColor(), x: 0.5, y: 0.5 };
  players.set(id, p);
  if (peerId) peerMap.set(peerId, id);
  return p;
}

// ============================================================ NET WIRING ====
net.on("ready", () => {
  // We're the host — either fresh or elected after the previous host left.
  if (lastState.length > 0) {
    // Migration: restore the last known state so returning players keep their
    // colors and positions. Our own entry is already in lastState.
    for (const p of lastState) {
      players.set(p.id, { id: p.id, name: p.name, color: p.color, x: p.x, y: p.y });
      usedColors.add(p.color);
    }
  } else {
    addPlayer(MY_ID, MY_NAME + " (host)", null);
  }
  startHostLoop();
  if (autoMode) {
    show("play");
  } else {
    renderLobby();
    show("lobby");
  }
});

net.on("peer-join", (peerId) => renderLobby());
net.on("peer-leave", (peerId) => {
  const id = peerMap.get(peerId);
  if (id) {
    const p = players.get(id);
    if (p) usedColors.delete(p.color);
    players.delete(id);
    peerMap.delete(peerId);
  }
  renderLobby();
});

net.on("connected", () => {
  net.send({ t: "hello", id: MY_ID, name: MY_NAME });
  show("play");
});

net.on("host-closed", () => {
  if (!autoMode) { alert("The host left. Game over."); location.reload(); return; }
  // Elect a new host. Each client waits (its position in hostOrder) * 700ms,
  // then runs the auto election — first in line registers as host, the rest
  // join them. The well-known id (bp2p-auto) stays the same so everyone finds
  // the new host without any extra coordination.
  const myIndex = lastHostOrder.indexOf(MY_ID);
  const delay = Math.max(0, myIndex) * 700;
  hostLoopRunning = false; // allow the new host loop to start if we're elected
  setTimeout(() => net.migrate(AUTO_CHANNEL), delay);
});

net.on("error", (err) => {
  console.error(err);
  setStatus("Connection error: " + (err.type || err.message || err));
});

net.on("message", ({ from, data }) => {
  if (net.isHost) handleHostMessage(from, data);
  else handleClientMessage(data);
});

function handleHostMessage(peerId, msg) {
  if (msg.t === "hello") {
    const p = addPlayer(msg.id, msg.name, peerId);
    net.sendTo(peerId, { t: "welcome", color: p.color });
    renderLobby();
  } else if (msg.t === "input") {
    const id = peerMap.get(peerId);
    const p = id && players.get(id);
    if (p) { p.x = clamp01(msg.x); p.y = clamp01(msg.y); }
  }
}

let myColor = "#fff";
let lastState = [];
let lastHostOrder = [];
function handleClientMessage(msg) {
  if (msg.t === "welcome") myColor = msg.color;
  else if (msg.t === "state") {
    lastState = msg.players;
    if (msg.hostOrder) lastHostOrder = msg.hostOrder;
  }
}

// ============================================================ HOST LOOP =====
let hostLoopRunning = false;
function startHostLoop() {
  if (hostLoopRunning) return;
  hostLoopRunning = true;
  setInterval(() => {
    const list = [...players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, x: p.x, y: p.y,
    }));
    // hostOrder: clientIds in join time order — clients use this to elect a
    // new host if we disconnect.
    const hostOrder = [...players.keys()];
    net.broadcast({ t: "state", players: list, hostOrder });
    lastState = list;
    lastHostOrder = hostOrder;
  }, 1000 / TICK_HZ);
}

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
    li.innerHTML = `<span class="swatch" style="background:${p.color}"></span>${p.name}`;
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

// ============================================================ PLAY / CANVAS =
const canvas = $("#stage");
const ctx = canvas.getContext("2d");
let myTarget = { x: 0.5, y: 0.5 };
let dragging = false;

// Keep the canvas backing store matched to its on-screen size. Called every
// frame so it self-corrects no matter when the play screen becomes visible
// (host pressing Start, a client connecting) and on rotate/resize. Returns the
// element's CSS-pixel size for use in drawing/input math.
function syncCanvasSize() {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return rect; // not visible yet
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return rect;
}

function pointerToNorm(e) {
  const rect = canvas.getBoundingClientRect();
  const px = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const py = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  return { x: clamp01(px / rect.width), y: clamp01(py / rect.height) };
}

function onMove(e) {
  if (!dragging) return;
  e.preventDefault();
  myTarget = pointerToNorm(e);
  // Push my input upstream (or apply directly if I'm the host).
  if (net.isHost) {
    const me = players.get(MY_ID);
    if (me) { me.x = myTarget.x; me.y = myTarget.y; }
  } else {
    net.send({ t: "input", x: myTarget.x, y: myTarget.y });
  }
}
function onDown(e) { dragging = true; onMove(e); }
function onUp() { dragging = false; }

canvas.addEventListener("mousedown", onDown);
canvas.addEventListener("mousemove", onMove);
window.addEventListener("mouseup", onUp);
canvas.addEventListener("touchstart", onDown, { passive: false });
canvas.addEventListener("touchmove", onMove, { passive: false });
window.addEventListener("touchend", onUp);

function render() {
  const rect = syncCanvasSize();
  ctx.clearRect(0, 0, rect.width, rect.height);
  for (const p of lastState) {
    const x = p.x * rect.width;
    const y = p.y * rect.height;
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    if (p.id === MY_ID) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.name, x, y - 30);
  }
  requestAnimationFrame(render);
}

// ============================================================ MENU ACTIONS ==
$("#btn-auto").addEventListener("click", () => {
  autoMode = true;
  document.querySelector("#btn-auto").disabled = true;
  document.querySelector("#auto-status").textContent = "Looking for a game on your Wi-Fi…";
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

$("#btn-start").addEventListener("click", () => {
  show("play"); // render loop sizes the canvas once it's visible
});

// Auto-join if opened from a QR link (?join=CODE).
const params = new URLSearchParams(location.search);
const joinParam = params.get("join");
if (joinParam) {
  $("#code-input").value = joinParam.toUpperCase();
}

// ---- helpers ----
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Kick off the render loop once; it harmlessly draws nothing until we're playing.
render();
