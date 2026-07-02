/*
 * app.js — demo game + chat + profile on top of peer-net.js.
 *
 * Protocol:
 *   client -> host : { t:'hello', id, name, icon, preferredColor }   on connect
 *                    { t:'input', x, y }                             on drag
 *                    { t:'game-input', game, input }                 active game input
 *                    { t:'profile', name, icon, preferredColor }     on profile change
 *                    { t:'chat', text }                              on send
 *   host -> all   : { t:'state', players, hostOrder }               every tick
 *                    { t:'game-state', game, state }                 active game state
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
const APP_VERSION = "2.9.3";
const HOST_THROTTLE_DRIFT_MS = 1200;
const HOST_THROTTLE_STRIKES = 2;
const LAST_GAME_KEY = "bp2p-last-game";
const RESTORE_PLAY_KEY = "bp2p-restore-play";
const CURRENT_LOBBY_KEY = "bp2p-current-lobby";
const LAST_CODE_KEY = "bp2p-last-code";

const ELEMENTAL_LOBBIES = [
  { id: "FIRE", name: "Fire", icon: "🔥" },
  { id: "EART", name: "Earth", icon: "⛰️" },
  { id: "WATE", name: "Water", icon: "💧" },
  { id: "WIND", name: "Air", icon: "🌬️" },
];

// Channel scopes the legacy host migration id. Empty = global default.
const AUTO_CHANNEL = "";

const PERF_WARN_MS = 50;

function profileTask(label, fn) {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const elapsed = performance.now() - start;
    if (elapsed >= PERF_WARN_MS) console.warn(`[perf] ${label} blocked for ${elapsed.toFixed(1)}ms`);
  }
}

function runWhenIdle(fn, timeout = 1200) {
  if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout });
  else setTimeout(fn, 0);
}

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
    swRegistration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
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

function refreshCachedFiles() {
  return new Promise((resolve, reject) => {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) {
      reject(new Error("No active service worker."));
      return;
    }

    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("Update check timed out.")), 12000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      if (event.data?.ok) resolve(event.data);
      else reject(new Error(event.data?.error || "Update check failed."));
    };
    controller.postMessage({ type: "REFRESH_APP_SHELL" }, [channel.port2]);
  });
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
      await refreshCachedFiles();
      setUpdateStatus("Updated cached files. Restarting…");
      setTimeout(() => location.reload(), 250);
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
  if (document.visibilityState === "hidden") yieldHostForBackground("browser hidden");
  if (document.visibilityState === "visible") rejoinAfterYield();
});

function releaseNetworkOnPageExit() {
  hasLeftLobby = true;
  stopHostLoop();
  try { net?.destroy(); } catch {}
}

window.addEventListener("pagehide", releaseNetworkOnPageExit);
window.addEventListener("beforeunload", releaseNetworkOnPageExit);

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

  const notification = new Notification("ClasslessRPG", {
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
let activity = new PeerActivity();
let autoMode = false;
let hasLeftLobby = true;
let migratingFromHostId = null;
let migrationPending = false;
let keepPlayingAfterMigration = false;
let yieldedHostForBackground = false;
let pendingMigratedGameState = null;
let playStarted = false;
let hostLoopLastTick = 0;
let hostThrottleStrikes = 0;
let currentLobby = null;
const lobbyStatuses = new Map();
let onlineUsers = [];
let lastActivityUpdate = 0;

// ============================================================ DOM ===========
const $ = (sel) => document.querySelector(sel);
const screens = { menu: $("#screen-menu"), lobby: $("#screen-lobby"), play: $("#screen-play") };
function show(name) {
  for (const key in screens) screens[key].classList.toggle("active", key === name);
  syncTopNav();
}

function isInLobby() {
  return !!(currentLobby?.code && (net?.peer || net?.hostConn || net?.isHost));
}

function syncTopNav() {
  const chatBtn = $("#btn-chat");
  if (chatBtn) chatBtn.classList.toggle("hidden", !isInLobby());
  $("#btn-leave-lobby")?.classList.toggle("hidden", !isInLobby());
  const avatar = $("#nav-avatar");
  if (avatar) {
    avatar.textContent = profile.icon || "⚙️";
    avatar.parentElement.style.background = myColor || profile.color || "";
  }
}

// ============================================================ HOST STATE ====
const players  = new Map();   // id -> { id, name, color, icon, x, y }
const peerMap  = new Map();   // transport peerId -> clientId
const liveVideoPeers = new Map(); // clientId -> peerId
let usedColors = new Set();

function pickColor() {
  for (const c of COLORS) if (!usedColors.has(c)) { usedColors.add(c); return c; }
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function addPlayer(id, name, peerId, icon, preferredColor) {
  if (players.has(id)) {
    const p = players.get(id);
    p.name = name || p.name;
    p.icon = icon || p.icon || DEFAULT_ICON;
    p.connected = true;
    if (peerId) peerMap.set(peerId, id);
    profiles.set(id, { name: p.name, color: p.color, icon: p.icon });
    return p;
  }
  let color;
  if (preferredColor && !usedColors.has(preferredColor)) {
    color = preferredColor;
    usedColors.add(color);
  } else {
    color = pickColor();
  }
  const p = { id, name, color, icon: icon || DEFAULT_ICON, x: 0.5, y: 0.5, connected: true };
  players.set(id, p);
  if (peerId) peerMap.set(peerId, id);
  profiles.set(id, { name: p.name, color: p.color, icon: p.icon });
  return p;
}

function lobbyDisplayName(code) {
  return ELEMENTAL_LOBBIES.find((l) => l.id === code)?.name || code || "Custom";
}

function randomLobbyCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function rememberLobbyCode(code) {
  code = sanitizeLobbyCode(code);
  if (code) localStorage.setItem(LAST_CODE_KEY, code);
}

function preferredLobbyCode() {
  const stored = sanitizeLobbyCode(localStorage.getItem(LAST_CODE_KEY));
  return stored.length === 4 ? stored : randomLobbyCode();
}

function saveCurrentLobby(code, role) {
  currentLobby = { code, role, name: lobbyDisplayName(code) };
  localStorage.setItem(CURRENT_LOBBY_KEY, JSON.stringify(currentLobby));
  syncTopNav();
  updateActivityStatus();
}

function clearCurrentLobby() {
  currentLobby = null;
  localStorage.removeItem(CURRENT_LOBBY_KEY);
  syncTopNav();
  updateActivityStatus();
}

function currentLobbyInfo() {
  return {
    app: "ClasslessRPG",
    version: APP_VERSION,
    name: profile.name,
    icon: profile.icon,
    players: net.isHost ? players.size : lastState.length,
    lobby: currentLobby?.name || lobbyDisplayName(net.code),
  };
}

function updateHostedLobbyInfo() {
  if (net?.setLobbyInfo) net.setLobbyInfo(currentLobbyInfo());
  updateActivityStatus();
}

function getStoredLobby() {
  try { return JSON.parse(localStorage.getItem(CURRENT_LOBBY_KEY) || "null"); } catch { return null; }
}

// ============================================================ NET WIRING ====
function wireNetEvents() {
  net.on("ready", async () => {
    yieldedHostForBackground = false;
    migrationPending = false;
    saveCurrentLobby(net.code, "host");
    players.clear();
    peerMap.clear();
    usedColors.clear();
    if (lastState.length > 0) {
      // Host migration: restore last snapshot so players keep colors and positions.
      for (const p of lastState) {
        if (p.id === migratingFromHostId) continue;
        players.set(p.id, { ...p, icon: p.icon || DEFAULT_ICON, connected: p.connected !== false });
        usedColors.add(p.color);
        profiles.set(p.id, { name: p.name, color: p.color, icon: p.icon || DEFAULT_ICON });
      }
    } else {
      addPlayer(MY_ID, profile.name, null, profile.icon, profile.color);
    }
    migratingFromHostId = null;
    startHostLoop();
    const restoreGame = !lastState.length && selectedGame === "free-play" ? rememberedGameOrDefault() : null;
    if (restoreGame) await setGameMode(restoreGame, false, savedGameStateOrNull(restoreGame), false).catch(console.error);
    if (selectedGame !== "free-play") {
      if (!activeGame) await startActiveGame(pendingMigratedGameState || loadSavedGameState(selectedGame)?.state || null).catch(console.error);
      else if (pendingMigratedGameState) activeGame.onState?.(pendingMigratedGameState);
      const state = snapshotActiveGame("host ready migration snapshot");
      if (state) {
        queueGameStateSave(selectedGame, state);
        net.broadcast({ t: "game-mode", game: selectedGame });
        sendGameState({ game: selectedGame, state, fullOnly: true });
      }
    }
    pendingMigratedGameState = null;
    announceCameraOn();
    renderLobby();
    refreshLobbyCards();
    const restorePlay = keepPlayingAfterMigration || shouldRestorePlay();
    show(restorePlay ? "play" : "lobby");
    playStarted = restorePlay;
    keepPlayingAfterMigration = false;
  });

  net.on("peer-join", () => renderLobby());

  net.on("peer-leave", (peerId) => {
    markPeerDisconnected(peerId);
  });

  net.on("connected", () => {
    yieldedHostForBackground = false;
    migrationPending = false;
    saveCurrentLobby(net.code, "client");
    net.send({ t: "hello", id: MY_ID, name: profile.name, icon: profile.icon, preferredColor: profile.color });
    announceCameraOn();
    show(keepPlayingAfterMigration ? "play" : "lobby");
    keepPlayingAfterMigration = false;
  });

  net.on("host-closed", () => {
    handleHostClosed();
  });

  net.on("host-yield", (reason) => {
    pushSys("Host handoff: " + reason);
    migrateFromHost("host handoff snapshot");
  });

  net.on("error", (err) => {
    console.error(err);
    migrationPending = false;
    setStatus("Connection error: " + (err.type === "unavailable-id" ? "That lobby is already hosted." : (err.type || err.message || err)));
    if (err.type === "unavailable-id" && currentLobby?.role === "host") {
      const code = sanitizeLobbyCode(currentLobby.code);
      showToast(`${lobbyDisplayName(code)} is already hosted — joining instead…`, "info", "🔗");
      setStatus("Joining " + lobbyDisplayName(code) + "…");
      setTimeout(() => {
        if (code) joinLobbyCode(code);
        else {
          clearCurrentLobby();
          hasLeftLobby = true;
          show("menu");
          refreshLobbyCards();
        }
      }, 250);
    }
  });

  net.on("message", ({ from, data }) => {
    if (net.isHost) handleHostMsg(from, data);
    else handleClientMsg(data);
  });

  net.on("voice-message", ({ from, data }) => {
    if (net.isHost) handleHostVoiceMsg(from, data);
    else handleClientVoiceMsg(data);
  });

  net.on("voice-close", (peerId) => {
    const id = peerId === "host" ? lastHostOrder[0] : peerMap.get(peerId);
    if (id) markSilent(id);
  });

  net.on("media-call", handleMediaCall);
  net.on("media-close", removeVideoTile);
}
wireNetEvents();

function migrateFromHost(snapshotReason) {
  if (hasLeftLobby || migrationPending) return;
  const lobbyCode = !autoMode ? sanitizeLobbyCode(currentLobby?.code) : "";
  if (!autoMode && lobbyCode.length !== 4) {
    setStatus("The host left this lobby.");
    showToast("The host left this lobby", "error", "🔌");
    clearCurrentLobby();
    stopHostLoop();
    net.destroy();
    show("menu");
    refreshLobbyCards();
    return;
  }
  migrationPending = true;
  keepPlayingAfterMigration = screens.play.classList.contains("active");
  migratingFromHostId = lastHostOrder[0] || null;
  pendingMigratedGameState = snapshotActiveGame(snapshotReason) || loadSavedGameState(selectedGame)?.state || null;
  const remainingOrder = migratingFromHostId ? lastHostOrder.filter((id) => id !== migratingFromHostId) : [MY_ID];
  const myIndex = remainingOrder.indexOf(MY_ID);
  const preferHost = myIndex === 0;
  const delay = myIndex < 0 ? 300 : myIndex * 700;
  showToast(preferHost ? "Host left — taking over as host…" : "Host left — reconnecting…", "info", "👑");
  stopHostLoop();
  setTimeout(() => {
    if (hasLeftLobby) return;
    if (lobbyCode) net.migrateCode(lobbyCode, preferHost);
    else net.migrate(AUTO_CHANNEL, preferHost);
  }, delay);
}

function handleHostClosed() {
  if (hasLeftLobby) return;
  migrateFromHost("host migration snapshot");
}

function markPeerDisconnected(peerId) {
  const id = peerMap.get(peerId);
  if (!id) return;
  const p = players.get(id);
  const name = p ? p.name : "Someone";
  if (p) p.connected = false;
  peerMap.delete(peerId);
  liveVideoPeers.delete(id);
  removeVideoTile(id);
  markSilent(id);
  pushSys(name + " left");
  showToast(name + " left", "info", "👋");
  net.broadcast({ t: "sys", text: name + " left" });
  renderLobby();
  updateHostedLobbyInfo();
  notifyActiveGamePlayersChanged();
}

// ---- host-side message handling ----
function handleHostMsg(peerId, msg) {
  if (msg.t === "hello") {
    const p = addPlayer(msg.id, msg.name, peerId, msg.icon, msg.preferredColor);
    net.sendTo(peerId, { t: "welcome", color: p.color });
    net.sendTo(peerId, { t: "history", chatLog });
    net.sendTo(peerId, { t: "drawing", strokes: drawingStrokes });
    net.sendTo(peerId, { t: "dnd-state", state: dndSharedState });
    net.sendTo(peerId, { t: "game-mode", game: selectedGame });
    queueGameStateForPeer(peerId);
    if (playStarted || screens.play.classList.contains("active")) net.sendTo(peerId, { t: "play" });
    net.sendTo(peerId, { t: "video-list", live: liveVideoList() });
    pushSys(p.name + " joined");
    net.broadcast({ t: "sys", text: p.name + " joined" });
    if (p.id !== MY_ID) {
      notifyPlayerJoined(p.name);
      showToast(p.name + " joined", "success", "🎉");
    }
    renderLobby();
    updateHostedLobbyInfo();
    notifyActiveGamePlayersChanged();

  } else if (msg.t === "leave") {
    markPeerDisconnected(peerId);

  } else if (msg.t === "input") {
    const id = peerMap.get(peerId);
    const p  = id && players.get(id);
    if (p) { p.x = clamp01(msg.x); p.y = clamp01(msg.y); }

  } else if (msg.t === "game-input") {
    const id = peerMap.get(peerId);
    if (id) handleGameInput(id, msg.game, msg.input);

  } else if (msg.t === "game-mode") {
    setGameMode(msg.game, true, undefined, false).catch(console.error);

  } else if (msg.t === "play") {
    startPlaying(true);

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

  } else if (msg.t === "dnd-action") {
    const id = peerMap.get(peerId);
    applyDndAction(msg.action, id || MY_ID, true);

  } else if (msg.t === "dnd-roll") {
    const id = peerMap.get(peerId);
    if (id) rollDiceForPlayer(id, msg.formula, { mod: msg.mod, label: msg.label });

  } else if (msg.t === "dnd-ping") {
    if (msg.ping) {
      addBoardPing(msg.ping);
      for (const [targetPeerId, conn] of net.conns) {
        if (targetPeerId !== peerId && conn.open) conn.send({ t: "dnd-ping", ping: msg.ping });
      }
    }

  } else if (msg.t === "draw-clear") {
    clearDrawing(false);
    net.broadcast({ t: "draw-clear" });

  } else if (msg.t === "drawing") {
    replaceDrawing(msg.strokes);
    net.broadcast({ t: "drawing", strokes: drawingStrokes });

  } else if (msg.t === "video-on") {
    const id = peerMap.get(peerId);
    if (!id) return;
    remoteVideoIds.set(peerId, id);
    liveVideoPeers.set(id, peerId);
    net.broadcast({ t: "video-on", fromId: id, peerId });
    net.sendTo(peerId, { t: "video-request", requesterPeerId: net.peer?.id });

  } else if (msg.t === "video-request") {
    if (msg.peerId === net.peer?.id && cameraStream) callPeerForVideo(peerId);
    else if (msg.peerId) net.sendTo(msg.peerId, { t: "video-request", requesterPeerId: peerId });

  } else if (msg.t === "video-off") {
    const id = peerMap.get(peerId);
    if (!id) return;
    liveVideoPeers.delete(id);
    removeVideoTile(id);
    net.broadcast({ t: "video-off", fromId: id });

  } else if (msg.t === "audio-start" || msg.t === "audio-stop" || msg.t === "audio-pcm") {
    const id = peerMap.get(peerId);
    if (!id) return;
    msg.fromId = id;
    handleLiveAudio(msg);
    net.broadcast(msg);
  }
}

function handleHostVoiceMsg(peerId, msg) {
  if (msg.t !== "audio-start" && msg.t !== "audio-stop" && msg.t !== "audio-pcm") return;
  const id = peerMap.get(peerId);
  if (!id) return;
  msg.fromId = id;
  handleLiveAudio(msg);
  for (const [targetPeerId, conn] of net.voiceConns) {
    if (targetPeerId !== peerId && conn.open) conn.send(msg);
  }
}

function handleClientVoiceMsg(msg) {
  if (msg.t === "audio-start" || msg.t === "audio-stop" || msg.t === "audio-pcm") handleLiveAudio(msg);
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

  } else if (msg.t === "game-mode") {
    setGameMode(msg.game, false).catch(console.error);

  } else if (msg.t === "game-state") {
    handleGameState(msg.game, msg.state);

  } else if (msg.t === "play") {
    startPlaying(false);

  } else if (msg.t === "chat") {
    chatLog.push({ fromId: msg.fromId, text: msg.text, ts: msg.ts });
    saveChatLog();
    renderChat();
    if (!chatOpen) showChatBadge();

  } else if (msg.t === "draw") {
    addDrawingStroke(msg.stroke, false);

  } else if (msg.t === "dnd-state") {
    replaceDndState(msg.state);

  } else if (msg.t === "dnd-roll") {
    showDiceRoll(msg.roll);

  } else if (msg.t === "dnd-ping") {
    if (msg.ping) addBoardPing(msg.ping);

  } else if (msg.t === "draw-clear") {
    clearDrawing(false);

  } else if (msg.t === "drawing") {
    replaceDrawing(msg.strokes);

  } else if (msg.t === "video-on") {
    if (msg.fromId !== MY_ID) {
      remoteVideoIds.set(msg.peerId, msg.fromId);
      requestVideoFromPeer(msg.peerId, msg.fromId);
    }

  } else if (msg.t === "video-request") {
    if (cameraStream && msg.requesterPeerId) callPeerForVideo(msg.requesterPeerId);

  } else if (msg.t === "video-off") {
    liveVideoPeers.delete(msg.fromId);
    removeVideoTile(msg.fromId);

  } else if (msg.t === "video-list") {
    for (const live of msg.live || []) {
      if (live.fromId !== MY_ID) {
        remoteVideoIds.set(live.peerId, live.fromId);
        requestVideoFromPeer(live.peerId, live.fromId);
      }
    }

  } else if (msg.t === "audio-start" || msg.t === "audio-stop" || msg.t === "audio-pcm") {
    handleLiveAudio(msg);

  } else if (msg.t === "sys") {
    pushSys(msg.text);
    const joined = msg.text.match(/^(.+) joined$/);
    const left = msg.text.match(/^(.+) left$/);
    if (joined) {
      notifyPlayerJoined(joined[1]);
      showToast(msg.text, "success", "🎉");
    } else if (left) {
      showToast(msg.text, "info", "👋");
    }
  }
}

// ============================================================ HOST LOOP =====
let hostLoopRunning = false;
let hostLoopTimer = null;
let lastState = [];
let lastHostOrder = [];

function startHostLoop() {
  if (hostLoopRunning) return;
  hostLoopRunning = true;
  hostLoopLastTick = performance.now();
  hostThrottleStrikes = 0;
  hostLoopTimer = setInterval(() => {
    if (!hostLoopRunning || !net.isHost) return;
    const tickNow = performance.now();
    const drift = tickNow - hostLoopLastTick - (1000 / TICK_HZ);
    hostLoopLastTick = tickNow;
    if (drift > HOST_THROTTLE_DRIFT_MS) hostThrottleStrikes++;
    else hostThrottleStrikes = 0;
    if (hostThrottleStrikes >= HOST_THROTTLE_STRIKES) {
      yieldHostForBackground("timer throttling");
      return;
    }
    ensureDndPlayerStats();
    const connectedPlayers = [...players.values()].filter((p) => p.connected !== false);
    const list = connectedPlayers.map(p => ({
      id: p.id, name: p.name, color: p.color, icon: p.icon, x: p.x, y: p.y,
    }));
    const hostOrder = connectedPlayers.map((p) => p.id);
    net.broadcast({ t: "state", players: list, hostOrder });
    net.broadcast({ t: "dnd-state", state: dndSharedState });
    lastState = list;
    lastHostOrder = hostOrder;
    updateHostedLobbyInfo();
  }, 1000 / TICK_HZ);
}

function stopHostLoop() {
  hostLoopRunning = false;
  clearInterval(hostLoopTimer);
  hostLoopTimer = null;
  hostLoopLastTick = 0;
  hostThrottleStrikes = 0;
}

function yieldHostForBackground(reason = "background") {
  if (!net.isHost || hasLeftLobby || !autoMode || yieldedHostForBackground) return;
  if (net.peerCount() === 0) return;
  yieldedHostForBackground = true;
  keepPlayingAfterMigration = screens.play.classList.contains("active");
  const state = snapshotActiveGame("yield host snapshot");
  if (state) saveGameState(selectedGame, state);
  pushSys("Host handoff: " + reason);
  stopHostLoop();
  net.yieldHost(reason);
  net.destroy();
  show(keepPlayingAfterMigration ? "play" : "lobby");
}

function rejoinAfterYield() {
  if (!yieldedHostForBackground || hasLeftLobby) return;
  net = new PeerNet();
  wireNetEvents();
  hasLeftLobby = false;
  autoMode = true;
  renderLobby();
  if (!keepPlayingAfterMigration) show("lobby");
  net.auto(AUTO_CHANNEL);
}

function joinCode(code) {
  autoMode = false;
  hasLeftLobby = false;
  keepPlayingAfterMigration = false;
  yieldedHostForBackground = false;
  setStatus("Connecting…");
  renderLobby();
  show("lobby");
  net.join(code);
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
const DRAW_COLOR_KEY = "bp2p-draw-color";
const DRAW_SIZE_KEY = "bp2p-draw-size";
const DRAW_DEFAULT_COLOR = "#ffffff";
const DRAW_PEN_WIDTH = 2.2;
const DRAW_ERASER_WIDTH = 18;

function loadDrawing() {
  try { return JSON.parse(localStorage.getItem(DRAWING_KEY) || "[]"); } catch { return []; }
}
function saveDrawing() {
  try { localStorage.setItem(DRAWING_KEY, JSON.stringify(drawingStrokes.slice(-DRAWING_LIMIT))); } catch {}
}

const drawingStrokes = loadDrawing();
let drawMode = false;
let drawTool = "pen";
let drawColor = localStorage.getItem(DRAW_COLOR_KEY) || DRAW_DEFAULT_COLOR;
let drawSize = Number(localStorage.getItem(DRAW_SIZE_KEY) || 4);
let drawing = false;
let currentStroke = null;
const drawingRedoStack = [];

// ============================================================ DND BOARD ======
const DND_STATE_KEY = "bp2p-dnd-board";
const DND_LIBRARY_KEY = "bp2p-dnd-assets";
const DND_INVENTORY_KEY = "bp2p-dnd-inventory";
const DND_GRID_FT = 5;
const DND_CELL_PX = 48;
const DND_ZOOM_KEY = "bp2p-dnd-zoom";
const DND_ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const DND_ASSETS = [
  { id: "hero", name: "Hero", icon: "🧙", color: "#4dd2ff", w: 1, h: 1, role: "player", statPreset: "caster" },
  { id: "fighter", name: "Fighter", icon: "🛡️", color: "#7cfc9b", w: 1, h: 1, role: "player", statPreset: "fighter" },
  { id: "rogue", name: "Rogue", icon: "🗡️", color: "#ffd24d", w: 1, h: 1, role: "player", statPreset: "rogue" },
  { id: "goblin", name: "Goblin", icon: "👺", color: "#7CFC9B", w: 1, h: 1, role: "enemy", statPreset: "goblin" },
  { id: "orc", name: "Orc", icon: "🪓", color: "#22cc88", w: 1, h: 1, role: "enemy", statPreset: "orc" },
  { id: "skeleton", name: "Skeleton", icon: "💀", color: "#c8c8d8", w: 1, h: 1, role: "enemy", statPreset: "skeleton" },
  { id: "dragon", name: "Dragon Boss", icon: "🐉", color: "#ff5d5d", w: 3, h: 3, role: "boss", statPreset: "dragon" },
  { id: "lich", name: "Lich Boss", icon: "🧟", color: "#aa44ff", w: 2, h: 2, role: "boss", statPreset: "lich" },
  { id: "chest", name: "Treasure Chest", icon: "🧰", color: "#ffbb33", w: 1, h: 1, role: "object" },
  { id: "wall", name: "Wall", icon: "🧱", color: "#77778d", w: 2, h: 1, role: "object" },
  { id: "tree", name: "Tree", icon: "🌲", color: "#22aa66", w: 1, h: 1, role: "object" },
  { id: "rock", name: "Rock", icon: "🪨", color: "#9090a8", w: 1, h: 1, role: "object" },
];
const CUSTOM_ASSET_ICONS = ["⭐", "⚔️", "🛡️", "🧙", "🧟", "👺", "🐉", "💀", "🧰", "🧱", "🌲", "🪨", "🔥", "💧", "⚡", "❄️", "🏰", "🚪", "🪤", "💎", "📜", "🕯️", "🗝️", "🍄"];
const CUSTOM_ASSET_COLORS = ["#4dd2ff", "#7cfc9b", "#ff5d5d", "#ffbb33", "#aa44ff", "#c8c8d8", "#22cc88", "#ff8844", "#9090a8", "#ffffff"];
const DND_SCENES = [
  { id: "blank", name: "Blank Board", bg: "#182033", board: { cols: 24, rows: 18 }, assets: [] },
  { id: "tavern", name: "Tavern Ambush", bg: "#3a2418", board: { cols: 24, rows: 18 }, assets: [
    ["wall", "North Bar", 5, 3, 5, 1], ["wall", "Long Table", 9, 8, 4, 1], ["wall", "Long Table", 15, 8, 4, 1],
    ["goblin", "Goblin Sneak", 10, 10, 1, 1], ["orc", "Orc Captain", 18, 5, 1, 1], ["chest", "Locked Chest", 4, 14, 1, 1],
  ] },
  { id: "dungeon", name: "Dungeon Boss Room", bg: "#1b1b24", board: { cols: 28, rows: 20 }, assets: [
    ["wall", "Stone Pillar", 5, 5, 1, 2], ["wall", "Stone Pillar", 21, 5, 1, 2], ["wall", "Altar", 13, 3, 2, 1],
    ["skeleton", "Skeleton Guard", 8, 12, 1, 1], ["skeleton", "Skeleton Guard", 19, 12, 1, 1], ["lich", "The Lich", 14, 10, 2, 2],
  ] },
  { id: "forest", name: "Forest Dragon", bg: "#133020", board: { cols: 30, rows: 22 }, assets: [
    ["tree", "Ancient Pine", 5, 4, 1, 1], ["tree", "Ancient Pine", 8, 16, 1, 1], ["tree", "Ancient Pine", 24, 7, 1, 1],
    ["rock", "Boulder", 12, 12, 2, 1], ["goblin", "Scout", 18, 15, 1, 1], ["dragon", "Emberclaw", 22, 11, 3, 3],
  ] },
];

function defaultDndState() {
  return { grid: false, board: { cols: 24, rows: 18 }, bg: "#182033", assets: [], playerStats: {}, playerSizes: {} };
}

function loadDndState() {
  try { return { ...defaultDndState(), ...(JSON.parse(localStorage.getItem(DND_STATE_KEY) || "null") || {}) }; }
  catch { return defaultDndState(); }
}

function saveDndState() {
  try { localStorage.setItem(DND_STATE_KEY, JSON.stringify(dndSharedState)); } catch {}
}

function loadDndLibrary() {
  try { return JSON.parse(localStorage.getItem(DND_LIBRARY_KEY) || "[]"); } catch { return []; }
}

function saveDndLibrary() {
  try { localStorage.setItem(DND_LIBRARY_KEY, JSON.stringify(dndLocalLibrary)); } catch {}
}

function loadDndInventory() {
  try { return JSON.parse(localStorage.getItem(DND_INVENTORY_KEY) || "[]"); } catch { return []; }
}

function saveDndInventory() {
  try { localStorage.setItem(DND_INVENTORY_KEY, JSON.stringify(dndInventory)); } catch {}
}

let dndSharedState = loadDndState();
let dndLocalLibrary = loadDndLibrary();
let dndInventory = loadDndInventory();
let dndOpen = false;
let dndSelectedId = null;
let dndSelectedPlayerId = null;
const dndSelectedIds = new Set();
let dndDrag = null;
let dndInventoryDrag = null;
let dndPlayerDrag = null;
let dndHoverName = "";
const DND_ZOOM_MIN = 0.08;
const DND_ZOOM_MAX = 3;
let dndZoom = Math.max(DND_ZOOM_MIN, Math.min(DND_ZOOM_MAX, Number(localStorage.getItem(DND_ZOOM_KEY) || 1)));
let dndCam = null; // board-cell coords of the viewport center
let dndPan = null; // active empty-space pan gesture
let dndPinch = null; // active two-finger pinch gesture
let dndViewInitialized = false; // fit board on the first rendered frame
let measureMode = false;
let measureLine = null; // { x1, y1, x2, y2 } in board cells
let activePings = []; // { x, y, color, name, start } in board cells
let lastTapInfo = null; // for double-tap ping detection
let activeDiceRoll = null;
let dndPointerDown = null;
let dndQuickMode = "hp"; // stats-card quick buttons adjust "hp" or "mana"
let dndStatsEntity = null; // entity currently shown in the stats card
const DND_PIN_KEY = "bp2p-dnd-pin";
let dndPinned = loadDndPin(); // { id, kind, icon, x, y } floating pinned-details button
let dndPinDrag = null; // dragging the floating pin button
let dndStatsHeaderDrag = null; // dragging the stats card header to pin it

function abilityMod(score) {
  return Math.floor(((Number(score) || 10) - 10) / 2);
}

function modText(score) {
  const mod = abilityMod(score);
  return mod >= 0 ? `+${mod}` : String(mod);
}

function varyStat(base, amount = 2) {
  return Math.max(3, Math.min(20, base + Math.floor(Math.random() * (amount * 2 + 1)) - amount));
}

function statBlock(preset = "commoner") {
  const templates = {
    commoner: { level: 1, ac: 10, speed: 30, hp: 8, mana: 0, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } },
    fighter: { level: 1, ac: 16, speed: 30, hp: 14, mana: 0, abilities: { str: 15, dex: 12, con: 14, int: 10, wis: 11, cha: 10 } },
    rogue: { level: 1, ac: 14, speed: 30, hp: 10, mana: 0, abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 11, cha: 13 } },
    caster: { level: 1, ac: 12, speed: 30, hp: 8, mana: 10, abilities: { str: 8, dex: 13, con: 12, int: 16, wis: 12, cha: 11 } },
    goblin: { level: 1, ac: 15, speed: 30, hp: 7, mana: 0, abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 } },
    orc: { level: 2, ac: 13, speed: 30, hp: 15, mana: 0, abilities: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 } },
    skeleton: { level: 1, ac: 13, speed: 30, hp: 13, mana: 0, abilities: { str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5 } },
    dragon: { level: 10, ac: 18, speed: 40, hp: 178, mana: 30, abilities: { str: 23, dex: 10, con: 21, int: 14, wis: 13, cha: 17 } },
    lich: { level: 12, ac: 17, speed: 30, hp: 135, mana: 120, abilities: { str: 11, dex: 16, con: 16, int: 20, wis: 14, cha: 16 } },
  };
  const base = templates[preset] || templates.commoner;
  const abilities = {};
  for (const key of DND_ABILITIES) abilities[key] = preset === "dragon" || preset === "lich" ? base.abilities[key] : varyStat(base.abilities[key]);
  const hpMax = Math.max(1, base.hp + abilityMod(abilities.con));
  const manaMax = Math.max(0, base.mana + Math.max(0, abilityMod(abilities.int)) * 2);
  return {
    level: base.level,
    ac: base.ac,
    speed: base.speed,
    hp: hpMax,
    maxHp: hpMax,
    mana: manaMax,
    maxMana: manaMax,
    abilities,
  };
}

function dndStatsForPlayer(player) {
  const seed = player.id || MY_ID;
  const existing = dndSharedState.playerStats?.[seed];
  if (existing) return existing;
  const presets = ["fighter", "rogue", "caster"];
  const preset = presets[Math.abs(seed.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0)) % presets.length];
  return statBlock(preset);
}

function ensureDndPlayerStats() {
  const list = net.isHost ? [...players.values()] : lastState;
  if (!dndSharedState.playerStats) dndSharedState.playerStats = {};
  if (!dndSharedState.playerSizes) dndSharedState.playerSizes = {};
  let changed = false;
  for (const p of list) {
    if (!p?.id) continue;
    if (!dndSharedState.playerStats[p.id]) {
      dndSharedState.playerStats[p.id] = dndStatsForPlayer(p);
      changed = true;
    }
    if (!dndSharedState.playerSizes[p.id]) {
      dndSharedState.playerSizes[p.id] = 1;
      changed = true;
    }
  }
  if (changed) saveDndState();
}

function ensureAssetStats(asset) {
  if (!asset || asset.role === "object") return asset;
  if (!asset.stats) asset.stats = statBlock(asset.statPreset || (asset.role === "boss" ? "dragon" : asset.role === "enemy" ? "goblin" : "commoner"));
  return asset;
}

function statPercent(current, max) {
  if (!max || max <= 0) return 0;
  return Math.max(0, Math.min(1, current / max));
}

function drawStatBars(x, y, w, stats) {
  if (!stats) return;
  const barW = Math.max(34, Math.min(110, w));
  const left = x + (w - barW) / 2;
  let top = y - 12;
  drawBar(left, top, barW, 5, statPercent(stats.hp, stats.maxHp), "#ff5d5d");
  if (stats.maxMana > 0) {
    top += 7;
    drawBar(left, top, barW, 5, statPercent(stats.mana, stats.maxMana), "#4dd2ff");
  }
}

function drawBar(x, y, w, h, pct, color) {
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, x, y, w * pct, h, h / 2);
  ctx.fill();
}

function isPlayerEntity(entity) {
  return entity?.kind === "player" && !entity.role;
}

function showDndStats(entity) {
  const card = $("#dnd-stats-card");
  if (!card || !entity) return;
  const stats = entity.stats || dndStatsForPlayer(entity);
  dndStatsEntity = { ...entity, stats };
  card.dataset.kind = entity.kind || entity.role || "entity";
  card.dataset.id = entity.id || "";
  $("#dnd-stats-name").textContent = entity.name || "Unknown";
  $("#dnd-stats-type").textContent = entity.kind || entity.role || "entity";
  $("#dnd-stats-chips").innerHTML = `
    <span class="dnd-chip"><span>LVL</span>${stats.level || 1}</span>
    <span class="dnd-chip"><span>AC</span>${stats.ac || 10}</span>
    <span class="dnd-chip"><span>SPD</span>${stats.speed || 30} ft</span>`;
  if (dndQuickMode === "mana" && !(stats.maxMana > 0)) dndQuickMode = "hp";
  $("#dnd-stats-bars").innerHTML = `
    <div class="dnd-stat-bar-row${dndQuickMode === "hp" ? " active" : ""}" data-bar="hp" role="button" title="Show HP +/- buttons"><span>HP</span><div class="dnd-stat-bar"><i style="width:${Math.round(statPercent(stats.hp, stats.maxHp) * 100)}%;background:#ff5d5d"></i></div><b>${stats.hp}/${stats.maxHp}</b></div>
    ${stats.maxMana > 0 ? `<div class="dnd-stat-bar-row${dndQuickMode === "mana" ? " active" : ""}" data-bar="mana" role="button" title="Show mana +/- buttons"><span>Mana</span><div class="dnd-stat-bar"><i style="width:${Math.round(statPercent(stats.mana, stats.maxMana) * 100)}%;background:#4dd2ff"></i></div><b>${stats.mana}/${stats.maxMana}</b></div>` : ""}`;
  for (const row of card.querySelectorAll(".dnd-stat-bar-row[data-bar]")) {
    row.addEventListener("click", () => {
      dndQuickMode = row.dataset.bar;
      showDndStats(dndStatsEntity);
    });
  }
  buildQuickStatButtons(entity, stats);
  $("#dnd-stats-abilities").innerHTML = DND_ABILITIES.map((key) => `
    <button class="dnd-ability" type="button" data-ability="${key}" title="Roll ${key.toUpperCase()} check"><span>${key.toUpperCase()}</span><strong>${stats.abilities?.[key] ?? 10}</strong><em>${modText(stats.abilities?.[key] ?? 10)}</em></button>`).join("");
  for (const btn of card.querySelectorAll(".dnd-ability[data-ability]")) {
    btn.addEventListener("click", () => requestAbilityCheck(dndStatsEntity, btn.dataset.ability));
  }
  $("#dnd-stats-editor")?.classList.add("hidden");
  buildDndStatsEditor(entity, stats);
  $("#btn-dnd-stats-pin")?.classList.toggle("active", !!dndPinned && dndPinned.id === entity.id);
  card.classList.remove("hidden");
}

function applyStatDelta(entity, delta, field = "hp") {
  const live = !isPlayerEntity(entity) ? dndSharedState.assets.find((a) => a.id === entity.id) : null;
  const base = isPlayerEntity(entity) ? dndStatsForPlayer(entity) : (live?.stats || entity.stats || statBlock(entity.statPreset));
  const stats = { ...base, abilities: { ...(base.abilities || {}) } };
  if (field === "mana") stats.mana = Math.max(0, Math.min(stats.maxMana || 0, (Number(stats.mana) || 0) + delta));
  else stats.hp = Math.max(0, Math.min(stats.maxHp || 1, (Number(stats.hp) || 0) + delta));
  sendDndAction({ type: "stats", kind: isPlayerEntity(entity) ? "player" : "asset", id: entity.id, stats });
  showDndStats({ ...entity, stats });
}

function requestAbilityCheck(entity, ability) {
  if (!entity) return;
  const stats = entity.stats || dndStatsForPlayer(entity);
  const mod = abilityMod(stats.abilities?.[ability] ?? 10);
  const label = `${entity.name || "Entity"} ${String(ability).toUpperCase()} check`;
  if (net.isHost) rollDiceForPlayer(MY_ID, "1d20", { mod, label });
  else net.send({ t: "dnd-roll", formula: "1d20", mod, label });
}

function buildQuickStatButtons(entity, stats) {
  const quick = $("#dnd-stats-quick");
  if (!quick) return;
  quick.innerHTML = "";
  if (!entity.id) return;
  const mana = dndQuickMode === "mana";
  for (const delta of [-5, -1, 1, 5]) {
    const btn = document.createElement("button");
    btn.className = "dnd-quick-btn" + (mana ? " mana" : delta > 0 ? " heal" : "");
    btn.type = "button";
    btn.textContent = (delta > 0 ? "+" : "") + delta + (mana ? " MP" : " HP");
    btn.addEventListener("click", () => applyStatDelta({ ...entity, stats }, delta, mana ? "mana" : "hp"));
    quick.appendChild(btn);
  }
}

function buildDndStatsEditor(entity, stats) {
  const editor = $("#dnd-stats-editor");
  const actions = $("#dnd-stats-actions");
  if (!editor || !actions) return;
  editor.innerHTML = "";
  actions.innerHTML = "";
  const fields = [
    ["level", "Lvl"], ["ac", "AC"], ["speed", "Speed"],
    ["hp", "HP"], ["maxHp", "Max HP"], ["mana", "Mana"], ["maxMana", "Max Mana"],
    ...DND_ABILITIES.map((key) => ["ability:" + key, key.toUpperCase()]),
  ];
  for (const [key, label] of fields) {
    const wrap = document.createElement("label");
    wrap.className = "dnd-stat-edit-field";
    wrap.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.value = key.startsWith("ability:") ? (stats.abilities?.[key.split(":")[1]] ?? 10) : (stats[key] ?? 0);
    input.dataset.stat = key;
    wrap.appendChild(input);
    editor.appendChild(wrap);
  }
  const toggle = document.createElement("button");
  toggle.className = "btn btn-small";
  toggle.type = "button";
  toggle.textContent = "Edit stats";
  toggle.addEventListener("click", () => {
    const hidden = editor.classList.toggle("hidden");
    toggle.textContent = hidden ? "Edit stats" : "Hide editor";
    save.classList.toggle("hidden", hidden);
  });
  actions.appendChild(toggle);
  const save = document.createElement("button");
  save.className = "btn btn-small btn-primary hidden";
  save.type = "button";
  save.textContent = "Save stats";
  save.addEventListener("click", () => saveDndStatsFromEditor(entity));
  actions.appendChild(save);
  if (!isPlayerEntity(entity)) {
    const copy = document.createElement("button");
    copy.className = "btn btn-small";
    copy.type = "button";
    copy.textContent = "Duplicate";
    copy.addEventListener("click", () => duplicateSelectedDndAsset(entity.id));
    actions.appendChild(copy);
    const remove = document.createElement("button");
    remove.className = "btn btn-small btn-danger";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeSelectedDndAsset(entity.id));
    actions.appendChild(remove);
  }
}

function statsFromEditor(baseStats) {
  const next = { ...baseStats, abilities: { ...(baseStats.abilities || {}) } };
  for (const input of document.querySelectorAll("#dnd-stats-editor input[data-stat]")) {
    const value = Number(input.value);
    if (!Number.isFinite(value)) continue;
    const key = input.dataset.stat;
    if (key.startsWith("ability:")) next.abilities[key.split(":")[1]] = value;
    else next[key] = value;
  }
  next.maxHp = Math.max(1, Number(next.maxHp) || 1);
  next.hp = Math.max(0, Math.min(next.maxHp, Number(next.hp) || 0));
  next.maxMana = Math.max(0, Number(next.maxMana) || 0);
  next.mana = Math.max(0, Math.min(next.maxMana, Number(next.mana) || 0));
  return next;
}

function saveDndStatsFromEditor(entity) {
  if (!entity?.id) return;
  const base = isPlayerEntity(entity) ? dndStatsForPlayer(entity) : (entity.stats || statBlock(entity.statPreset));
  const stats = statsFromEditor(base);
  sendDndAction({ type: "stats", kind: isPlayerEntity(entity) ? "player" : "asset", id: entity.id, stats });
  showDndStats({ ...entity, stats });
}

function hideDndStats() {
  $("#dnd-stats-card")?.classList.add("hidden");
}

function loadDndPin() {
  try {
    const pin = JSON.parse(localStorage.getItem(DND_PIN_KEY) || "null");
    return pin && typeof pin === "object" && pin.id ? pin : null;
  } catch { return null; }
}

function saveDndPin() {
  try {
    if (dndPinned) localStorage.setItem(DND_PIN_KEY, JSON.stringify(dndPinned));
    else localStorage.removeItem(DND_PIN_KEY);
  } catch {}
}

function setDndPinPos(x, y) {
  const btn = $("#dnd-stats-pin-btn");
  if (!btn || !dndPinned) return;
  const size = btn.offsetWidth || 52;
  const px = Number.isFinite(Number(x)) ? Number(x) : 24;
  const py = Number.isFinite(Number(y)) ? Number(y) : 96;
  dndPinned.x = Math.max(4, Math.min((window.innerWidth || 360) - size - 4, px));
  dndPinned.y = Math.max(4, Math.min((window.innerHeight || 640) - size - 4, py));
  btn.style.left = `${dndPinned.x}px`;
  btn.style.top = `${dndPinned.y}px`;
}

function syncDndPinButton() {
  const btn = $("#dnd-stats-pin-btn");
  if (!btn) return;
  const show = !!dndPinned && selectedGame === "free-play";
  btn.classList.toggle("hidden", !show);
  if (show) {
    btn.textContent = dndPinned.icon || "\ud83d\udccc";
    setDndPinPos(dndPinned.x, dndPinned.y);
  }
}

function pinDndStats(pos = null) {
  if (!dndStatsEntity?.id) return;
  const rect = $("#dnd-stats-card")?.getBoundingClientRect();
  dndPinned = {
    id: dndStatsEntity.id,
    kind: isPlayerEntity(dndStatsEntity) ? "player" : "asset",
    icon: dndStatsEntity.icon || "\ud83d\udccc",
    x: pos?.x ?? rect?.left ?? 24,
    y: pos?.y ?? rect?.top ?? 96,
  };
  hideDndStats();
  syncDndPinButton();
  saveDndPin();
}

function clearDndPin() {
  dndPinned = null;
  saveDndPin();
  syncDndPinButton();
  $("#btn-dnd-stats-pin")?.classList.remove("active");
}

function resolvePinnedEntity() {
  if (!dndPinned) return null;
  if (dndPinned.kind === "player") {
    const list = net.isHost ? [...players.values()] : lastState;
    const p = list.find((x) => x?.id === dndPinned.id);
    return p ? { ...p, kind: "player", stats: dndStatsForPlayer(p) } : null;
  }
  const asset = dndSharedState.assets.find((a) => a.id === dndPinned.id);
  return asset ? { ...asset, kind: asset.role || "asset" } : null;
}

function showPinnedDndStats() {
  const entity = resolvePinnedEntity();
  if (!entity) {
    showToast("Pinned entity left the board", "info", "\ud83d\udccc");
    clearDndPin();
    return;
  }
  showDndStats(entity);
}

function playerAtCanvasPoint(pt, m) {
  for (let i = lastState.length - 1; i >= 0; i--) {
    const p = lastState[i];
    if (p.connected === false) continue;
    const px = Math.max(8, m.cell * playerTokenSize(p));
    const cx = m.ox + p.x * m.w;
    const cy = m.oy + p.y * m.h;
    if (Math.hypot(pt.x - cx, pt.y - cy) <= Math.max(14, px / 2)) return p;
  }
  return null;
}

function playerTokenSize(player) {
  return dndSharedState.playerSizes?.[player.id] || 1;
}

function dndAssetCatalog() {
  return [...DND_ASSETS, ...dndLocalLibrary];
}

function dndAssetById(id) {
  return dndAssetCatalog().find((a) => a.id === id) || DND_ASSETS[0];
}

function dndBoardMetrics(rect) {
  const board = dndSharedState.board || defaultDndState().board;
  const cell = DND_CELL_PX * dndZoom;
  const w = board.cols * cell;
  const h = board.rows * cell;
  if (!dndCam) dndCam = { x: board.cols / 2, y: board.rows / 2 };
  dndCam.x = Math.max(0, Math.min(board.cols, dndCam.x));
  dndCam.y = Math.max(0, Math.min(board.rows, dndCam.y));
  const ox = rect.width / 2 - dndCam.x * cell;
  const oy = rect.height / 2 - dndCam.y * cell;
  return { board, cell, w, h, ox, oy };
}

function clampDndCam(cam) {
  const board = dndSharedState.board || defaultDndState().board;
  return { x: Math.max(0, Math.min(board.cols, cam.x)), y: Math.max(0, Math.min(board.rows, cam.y)) };
}

function clampDndZoom(zoom) {
  return Math.max(DND_ZOOM_MIN, Math.min(DND_ZOOM_MAX, zoom));
}

function syncDndCanvasStyle() {
  // The canvas always fills the viewport; the camera pans/zooms the board inside it.
  canvas.style.width = "";
  canvas.style.height = "";
  screens.play.classList.remove("dnd-board-active");
}

function pointerToBoard(e) {
  const rect = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  const metrics = dndBoardMetrics(rect);
  return {
    x: (src.clientX - rect.left - metrics.ox) / metrics.cell,
    y: (src.clientY - rect.top - metrics.oy) / metrics.cell,
    metrics,
  };
}

function dndAssetAt(point) {
  for (let i = dndSharedState.assets.length - 1; i >= 0; i--) {
    const asset = dndSharedState.assets[i];
    if (point.x >= asset.x && point.x <= asset.x + asset.w && point.y >= asset.y && point.y <= asset.y + asset.h) return asset;
  }
  return null;
}

function sendDndAction(action) {
  if (net.isHost) applyDndAction(action, MY_ID, true);
  else net.send({ t: "dnd-action", action });
}

function dndPointerUpBoardPoint(e) {
  if (!e) return null;
  const src = e.changedTouches ? e.changedTouches[0] : e;
  if (src.clientX === undefined) return null;
  const rect = canvas.getBoundingClientRect();
  const m = dndBoardMetrics(rect);
  return { x: (src.clientX - rect.left - m.ox) / m.cell, y: (src.clientY - rect.top - m.oy) / m.cell };
}

function sendBoardPing(pt) {
  const ping = { x: pt.x, y: pt.y, color: myColor || profile.color || COLORS[0], name: profile.name };
  addBoardPing(ping);
  const msg = { t: "dnd-ping", ping };
  if (net.isHost) net.broadcast(msg);
  else net.send(msg);
}

function addBoardPing(ping) {
  activePings.push({ ...ping, start: performance.now() });
  if (activePings.length > 12) activePings.shift();
}

function cloneAsset(asset, overrides = {}) {
  return { ...JSON.parse(JSON.stringify(asset)), ...overrides };
}

function selectedDndAssets() {
  const ids = dndSelectedIds.size ? dndSelectedIds : new Set(dndSelectedId ? [dndSelectedId] : []);
  return dndSharedState.assets.filter((a) => ids.has(a.id));
}

function selectDndAsset(id, additive = false) {
  if (!additive) dndSelectedIds.clear();
  if (id) {
    if (additive && dndSelectedIds.has(id)) dndSelectedIds.delete(id);
    else dndSelectedIds.add(id);
  }
  dndSelectedId = id || Array.from(dndSelectedIds).at(-1) || null;
  dndSelectedPlayerId = null;
  syncDndUi();
}

function isInventoryOpen() {
  return !$("#inventory-panel")?.classList.contains("hidden");
}

function setInventoryOpen(open, closeOthers = true) {
  if (open && closeOthers) {
    drawMode = false;
    dndOpen = false;
    setMeasureMode(false);
  }
  $("#inventory-panel")?.classList.toggle("hidden", !open);
  if (open || closeOthers) syncBoardDock();
  renderInventory();
}

function renderInventory() {
  const list = $("#inventory-list");
  if (!list) return;
  list.innerHTML = "";
  if (!dndInventory.length) {
    const empty = document.createElement("div");
    empty.className = "inventory-empty";
    empty.textContent = "Empty";
    list.appendChild(empty);
    return;
  }
  for (const item of dndInventory) {
    const btn = document.createElement("button");
    btn.className = "inventory-item";
    btn.type = "button";
    btn.draggable = true;
    btn.innerHTML = `<span>${esc(item.icon || "●")}</span>${esc(item.name || "Item")}`;
    btn.addEventListener("dragstart", (e) => {
      dndInventoryDrag = item.id;
      e.dataTransfer?.setData("text/plain", item.id);
    });
    btn.addEventListener("click", () => showDndStats({ ...item, kind: item.role || "object" }));
    list.appendChild(btn);
  }
}

function addAssetsToInventory(assets, removeFromBoard = true) {
  if (!assets.length) return;
  for (const asset of assets) dndInventory.push(cloneAsset(asset, { id: `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`, x: 0, y: 0, local: true }));
  saveDndInventory();
  renderInventory();
  if (removeFromBoard) for (const asset of assets) sendDndAction({ type: "remove", id: asset.id });
}

function addInventoryItemToBoard(itemId, boardPoint) {
  const index = dndInventory.findIndex((item) => item.id === itemId);
  if (index < 0) return;
  const item = dndInventory[index];
  const board = dndSharedState.board || defaultDndState().board;
  const asset = cloneAsset(item, {
    id: `${MY_ID}-${Date.now()}`,
    x: Math.max(0, Math.min(board.cols - (item.w || 1), Math.round(boardPoint.x * 2) / 2)),
    y: Math.max(0, Math.min(board.rows - (item.h || 1), Math.round(boardPoint.y * 2) / 2)),
    local: false,
  });
  dndInventory.splice(index, 1);
  saveDndInventory();
  renderInventory();
  sendDndAction({ type: "add", asset });
}

function pointerOverInventory(e) {
  const panel = $("#inventory-panel");
  if (!panel || panel.classList.contains("hidden") || !e) return false;
  const src = e.changedTouches ? e.changedTouches[0] : e;
  const rect = panel.getBoundingClientRect();
  return src.clientX >= rect.left && src.clientX <= rect.right && src.clientY >= rect.top && src.clientY <= rect.bottom;
}

function replaceDndState(state) {
  dndSharedState = { ...defaultDndState(), ...(state || {}) };
  dndSelectedId = dndSharedState.assets.some((a) => a.id === dndSelectedId) ? dndSelectedId : null;
  for (const id of Array.from(dndSelectedIds)) if (!dndSharedState.assets.some((a) => a.id === id)) dndSelectedIds.delete(id);
  dndSelectedPlayerId = null;
  saveDndState();
  syncDndCanvasStyle();
  syncDndUi();
}

function applyDndAction(action, actorId = MY_ID, broadcast = true) {
  if (!action) return;
  if (action.type === "state") {
    replaceDndState(action.state);
  } else if (action.type === "add") {
    dndSharedState.assets.push(ensureAssetStats({ ...action.asset, ownerId: actorId }));
    selectDndAsset(action.asset.id, false);
    dndSelectedPlayerId = null;
  } else if (action.type === "move") {
    const asset = dndSharedState.assets.find((a) => a.id === action.id);
    if (asset) { asset.x = action.x; asset.y = action.y; }
  } else if (action.type === "resize") {
    const asset = dndSharedState.assets.find((a) => a.id === action.id);
    if (asset) { asset.w = action.w; asset.h = action.h; }
  } else if (action.type === "resize-player") {
    if (!dndSharedState.playerSizes) dndSharedState.playerSizes = {};
    dndSharedState.playerSizes[action.id] = action.size;
  } else if (action.type === "remove") {
    dndSharedState.assets = dndSharedState.assets.filter((a) => a.id !== action.id);
    if (dndSelectedId === action.id) dndSelectedId = null;
    dndSelectedIds.delete(action.id);
  } else if (action.type === "duplicate") {
    const asset = dndSharedState.assets.find((a) => a.id === action.id);
    if (asset) {
      const copy = ensureAssetStats(cloneAsset(asset, { id: `${actorId}-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: `${asset.name || "Entity"} Copy`, x: asset.x + 0.5, y: asset.y + 0.5, ownerId: actorId }));
      dndSharedState.assets.push(copy);
      selectDndAsset(copy.id, false);
      dndSelectedPlayerId = null;
    }
  } else if (action.type === "stats") {
    if (action.kind === "player") {
      if (!dndSharedState.playerStats) dndSharedState.playerStats = {};
      dndSharedState.playerStats[action.id] = action.stats;
    } else {
      const asset = dndSharedState.assets.find((a) => a.id === action.id);
      if (asset) asset.stats = action.stats;
    }
  } else if (action.type === "select") {
    selectDndAsset(action.id, !!action.additive);
    dndSelectedPlayerId = null;
  } else if (action.type === "select-player") {
    dndSelectedPlayerId = action.id;
    dndSelectedId = null;
  } else if (action.type === "grid") {
    dndSharedState.grid = !!action.grid;
  } else if (action.type === "board") {
    dndSharedState.board = action.board;
    dndViewInitialized = false;
  }
  if (action.type === "state") dndViewInitialized = false;
  saveDndState();
  syncDndCanvasStyle();
  syncDndUi();
  if (broadcast && net.isHost) net.broadcast({ t: "dnd-state", state: dndSharedState });
}

function sceneToState(scene) {
  const catalog = dndAssetCatalog();
  const assets = scene.assets.map(([assetId, name, x, y, w, h], index) => {
    const base = catalog.find((a) => a.id === assetId) || DND_ASSETS[0];
    return ensureAssetStats({ ...base, id: `scene-${scene.id}-${index}-${Date.now()}`, name, x, y, w, h });
  });
  return { ...defaultDndState(), grid: true, board: scene.board, bg: scene.bg, assets, playerStats: dndSharedState.playerStats || {} };
}

function setDndScene(sceneId) {
  const scene = DND_SCENES.find((s) => s.id === sceneId);
  if (!scene) return;
  if (dndSharedState.assets.length && !confirm("Replace the current board with this scene?")) return;
  sendDndAction({ type: "state", state: sceneToState(scene) });
}

function addSelectedDndAsset() {
  const selected = $("#dnd-asset")?.value || DND_ASSETS[0].id;
  const base = dndAssetById(selected);
  const board = dndSharedState.board || defaultDndState().board;
  const asset = {
    ...base,
    id: `${MY_ID}-${Date.now()}`,
    x: Math.max(0, Math.floor((board.cols - base.w) / 2)),
    y: Math.max(0, Math.floor((board.rows - base.h) / 2)),
    w: base.w || 1,
    h: base.h || 1,
  };
  ensureAssetStats(asset);
  sendDndAction({ type: "add", asset });
}

function createCustomDndAsset() {
  openCustomAssetModal();
}

function buildCustomAssetPresets() {
  const iconGrid = $("#custom-asset-icon-presets");
  const colorGrid = $("#custom-asset-color-presets");
  if (iconGrid && !iconGrid.children.length) {
    for (const icon of CUSTOM_ASSET_ICONS) {
      const btn = document.createElement("button");
      btn.className = "asset-preset-btn";
      btn.type = "button";
      btn.textContent = icon;
      btn.addEventListener("click", () => { $("#custom-asset-icon").value = icon; });
      iconGrid.appendChild(btn);
    }
  }
  if (colorGrid && !colorGrid.children.length) {
    for (const color of CUSTOM_ASSET_COLORS) {
      const btn = document.createElement("button");
      btn.className = "asset-color-btn";
      btn.type = "button";
      btn.style.background = color;
      btn.setAttribute("aria-label", color);
      btn.addEventListener("click", () => { $("#custom-asset-color").value = color; });
      colorGrid.appendChild(btn);
    }
  }
}

function openCustomAssetModal() {
  buildCustomAssetPresets();
  $("#custom-asset-name").value = "Custom Token";
  $("#custom-asset-icon").value = "⭐";
  $("#custom-asset-color").value = "#4dd2ff";
  $("#custom-asset-role").value = "object";
  $("#custom-asset-preset").value = "commoner";
  $("#custom-asset-width").value = "1";
  $("#custom-asset-height").value = "1";
  $("#modal-custom-asset")?.classList.remove("hidden");
  $("#modal-custom-asset")?.setAttribute("aria-hidden", "false");
  setTimeout(() => $("#custom-asset-name")?.focus(), 0);
}

function closeCustomAssetModal() {
  $("#modal-custom-asset")?.classList.add("hidden");
  $("#modal-custom-asset")?.setAttribute("aria-hidden", "true");
}

function customAssetFromModal() {
  const role = $("#custom-asset-role")?.value || "object";
  const preset = $("#custom-asset-preset")?.value || "commoner";
  const w = Math.max(0.5, Math.min(8, Number($("#custom-asset-width")?.value) || 1));
  const h = Math.max(0.5, Math.min(8, Number($("#custom-asset-height")?.value) || 1));
  const asset = {
    id: `local-${Date.now()}`,
    name: $("#custom-asset-name")?.value.trim() || "Custom Token",
    icon: ($("#custom-asset-icon")?.value.trim() || "⭐").slice(0, 4),
    color: $("#custom-asset-color")?.value || "#4dd2ff",
    w,
    h,
    role,
    statPreset: preset,
    local: true,
  };
  if (role !== "object") asset.stats = statBlock(preset);
  return asset;
}

function saveCustomAssetFromModal(addToBoard = false) {
  const asset = customAssetFromModal();
  dndLocalLibrary.push({ ...asset });
  saveDndLibrary();
  syncDndUi();
  if (addToBoard) {
    const board = dndSharedState.board || defaultDndState().board;
    sendDndAction({ type: "add", asset: { ...asset, id: `${MY_ID}-${Date.now()}`, x: Math.max(0, Math.floor((board.cols - asset.w) / 2)), y: Math.max(0, Math.floor((board.rows - asset.h) / 2)) } });
  }
  closeCustomAssetModal();
}

function saveSelectedAssetToLibrary() {
  const asset = dndSharedState.assets.find((a) => a.id === dndSelectedId);
  if (!asset) return;
  const name = prompt("Save asset as", asset.name || "Asset")?.trim();
  if (!name) return;
  const saved = { id: `local-${Date.now()}`, name, icon: asset.icon, color: asset.color, w: asset.w, h: asset.h, role: asset.role || "object", statPreset: asset.statPreset, stats: asset.stats, local: true };
  dndLocalLibrary.push(saved);
  saveDndLibrary();
  syncDndUi();
}

function resizeSelectedDndAsset(delta) {
  if (dndSelectedPlayerId) {
    const current = dndSharedState.playerSizes?.[dndSelectedPlayerId] || 1;
    const size = Math.max(0.5, Math.min(6, current + delta));
    sendDndAction({ type: "resize-player", id: dndSelectedPlayerId, size });
    return;
  }
  const asset = dndSharedState.assets.find((a) => a.id === dndSelectedId);
  if (!asset) return;
  const board = dndSharedState.board || defaultDndState().board;
  const w = Math.max(0.5, Math.min(board.cols, asset.w + delta));
  const h = Math.max(0.5, Math.min(board.rows, asset.h + delta));
  sendDndAction({ type: "resize", id: asset.id, w, h });
}

function duplicateSelectedDndAsset(id = dndSelectedId) {
  const ids = dndSelectedIds.size ? Array.from(dndSelectedIds) : (id ? [id] : []);
  for (const assetId of ids) sendDndAction({ type: "duplicate", id: assetId });
}

function removeSelectedDndAsset(id = dndSelectedId) {
  const ids = dndSelectedIds.size ? Array.from(dndSelectedIds) : (id ? [id] : []);
  if (!ids.length) return;
  if (!confirm(`Remove ${ids.length === 1 ? "this entity" : ids.length + " entities"} from Free Play?`)) return;
  for (const assetId of ids) sendDndAction({ type: "remove", id: assetId });
  hideDndStats();
}

function setDndBoardSize() {
  const board = dndSharedState.board || defaultDndState().board;
  const cols = Math.max(8, Math.min(80, Number(prompt("Board width in 5 ft squares", board.cols)) || board.cols));
  const rows = Math.max(8, Math.min(80, Number(prompt("Board height in 5 ft squares", board.rows)) || board.rows));
  sendDndAction({ type: "board", board: { cols, rows } });
}

function setDndZoom(next, focus = null) {
  const rect = canvas.getBoundingClientRect();
  next = clampDndZoom(next);
  if (!rect.width || !rect.height || next === dndZoom) return;
  const m = dndBoardMetrics(rect);
  const fx = focus ? focus.x : rect.width / 2;
  const fy = focus ? focus.y : rect.height / 2;
  const boardX = (fx - m.ox) / m.cell;
  const boardY = (fy - m.oy) / m.cell;
  dndZoom = next;
  const cell = DND_CELL_PX * dndZoom;
  dndCam = clampDndCam({ x: boardX + (rect.width / 2 - fx) / cell, y: boardY + (rect.height / 2 - fy) / cell });
  localStorage.setItem(DND_ZOOM_KEY, String(dndZoom));
}

function fitDndBoard() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const board = dndSharedState.board || defaultDndState().board;
  const margin = 24;
  const zoom = Math.min(
    (rect.width - margin * 2) / (board.cols * DND_CELL_PX),
    (rect.height - margin * 2) / (board.rows * DND_CELL_PX)
  );
  dndZoom = clampDndZoom(zoom);
  localStorage.setItem(DND_ZOOM_KEY, String(dndZoom));
  dndCam = { x: board.cols / 2, y: board.rows / 2 };
}

function syncBoardDock() {
  const inFreePlay = selectedGame === "free-play";
  $("#board-dock")?.classList.toggle("hidden", !inFreePlay);
  $("#btn-draw")?.classList.toggle("active", drawMode);
  $("#btn-dnd")?.classList.toggle("active", dndOpen);
  $("#btn-inventory")?.classList.toggle("active", isInventoryOpen());
  $("#draw-toolbar")?.classList.toggle("hidden", !inFreePlay || !drawMode);
  $("#dnd-toolbar")?.classList.toggle("hidden", !inFreePlay || !dndOpen);
  if (!inFreePlay) $("#inventory-panel")?.classList.add("hidden");
  $("#btn-dnd-measure")?.classList.toggle("active", measureMode);
  syncDndPinButton();
  syncDrawToolUi();
}

function setMeasureMode(enabled) {
  measureMode = !!enabled && selectedGame === "free-play";
  if (!measureMode) measureLine = null;
  $("#btn-dnd-measure")?.classList.toggle("active", measureMode);
}

function syncDndUi() {
  syncBoardDock();
  $("#btn-dnd-grid")?.classList.toggle("active", !!dndSharedState.grid);
  const hasAsset = !!dndSelectedId;
  const hasEntity = hasAsset || !!dndSelectedPlayerId;
  if ($("#btn-dnd-duplicate")) $("#btn-dnd-duplicate").disabled = !hasAsset;
  if ($("#btn-dnd-remove")) $("#btn-dnd-remove").disabled = !hasAsset;
  if ($("#btn-dnd-smaller")) $("#btn-dnd-smaller").disabled = !hasEntity;
  if ($("#btn-dnd-larger")) $("#btn-dnd-larger").disabled = !hasEntity;
  const scene = $("#dnd-scene");
  if (scene && !scene.options.length) {
    for (const s of DND_SCENES) scene.add(new Option(s.name, s.id));
  }
  const assetSelect = $("#dnd-asset");
  if (assetSelect) {
    const current = assetSelect.value;
    assetSelect.innerHTML = "";
    for (const a of dndAssetCatalog()) assetSelect.add(new Option(a.local ? `★ ${a.name}` : a.name, a.id));
    if (current) assetSelect.value = current;
  }
}

function isTypingTarget(target) {
  const tag = target?.tagName?.toLowerCase();
  return target?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
}

function showDndShortcutHelp() {
  alert([
    "DnD shortcuts",
    "D: toggle DnD tools",
    "G: toggle grid",
    "A: add selected asset",
    "N: create custom asset",
    "C: duplicate selected asset",
    "Delete/Backspace: remove selected asset",
    "+ / =: make selected entity larger",
    "- / _: make selected entity smaller",
    "B: board size",
    "F: fit board to screen",
    "M: measure distance",
    "Double-tap empty space: ping for everyone",
    "R: roll dice",
    "Escape: close popup/tools",
    "?: show this help",
  ].join("\n"));
}

function handleDndKeyboard(e) {
  if (selectedGame !== "free-play") return;
  if (!$("#modal-custom-asset")?.classList.contains("hidden")) {
    if (e.key === "Escape") closeCustomAssetModal();
    return;
  }
  if (profileOpen || chatOpen) return;
  if (isTypingTarget(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "d") {
    e.preventDefault();
    setDndOpen(!dndOpen);
  } else if (key === "g") {
    e.preventDefault();
    sendDndAction({ type: "grid", grid: !dndSharedState.grid });
  } else if (key === "a") {
    e.preventDefault();
    addSelectedDndAsset();
  } else if (key === "n") {
    e.preventDefault();
    createCustomDndAsset();
  } else if (key === "c") {
    if (!dndSelectedId) return;
    e.preventDefault();
    duplicateSelectedDndAsset();
  } else if (key === "Delete" || key === "Backspace") {
    if (!dndSelectedId) return;
    e.preventDefault();
    removeSelectedDndAsset();
  } else if (key === "+" || key === "=") {
    if (!dndSelectedId && !dndSelectedPlayerId) return;
    e.preventDefault();
    resizeSelectedDndAsset(0.5);
  } else if (key === "-" || key === "_") {
    if (!dndSelectedId && !dndSelectedPlayerId) return;
    e.preventDefault();
    resizeSelectedDndAsset(-0.5);
  } else if (key === "b") {
    e.preventDefault();
    setDndBoardSize();
  } else if (key === "f") {
    e.preventDefault();
    fitDndBoard();
  } else if (key === "m") {
    e.preventDefault();
    setMeasureMode(!measureMode);
  } else if (key === "r") {
    e.preventDefault();
    requestDiceRoll();
  } else if (key === "Escape") {
    e.preventDefault();
    if (measureMode) { setMeasureMode(false); return; }
    hideDndStats();
    setDndOpen(false);
  } else if (key === "?") {
    e.preventDefault();
    showDndShortcutHelp();
  }
}

function parseDice(formula) {
  const match = String(formula || "1d20").toLowerCase().match(/^(\d{1,2})d(\d{1,3})$/);
  const count = Math.max(1, Math.min(20, Number(match?.[1] || 1)));
  const sides = Math.max(2, Math.min(100, Number(match?.[2] || 20)));
  return { count, sides, formula: `${count}d${sides}` };
}

function rollDiceForPlayer(playerId, formula, extra = {}) {
  const dice = parseDice(formula);
  const mod = Math.trunc(Number(extra.mod) || 0);
  const label = extra.label ? String(extra.label).slice(0, 48) : "";
  const rolls = Array.from({ length: dice.count }, () => 1 + Math.floor(Math.random() * dice.sides));
  const total = rolls.reduce((sum, v) => sum + v, 0) + mod;
  const roll = { id: `roll-${Date.now()}-${Math.random().toString(36).slice(2)}`, fromId: playerId, formula: dice.formula, rolls, mod, label, total, ts: Date.now() };
  const pf = profiles.get(playerId) || { name: "Someone" };
  const modPart = mod ? (mod > 0 ? `+${mod}` : String(mod)) : "";
  const desc = label ? `${label} (${dice.formula}${modPart})` : `${dice.formula}${modPart}`;
  const detail = rolls.length > 1 || mod ? ` (${rolls.join(" + ")}${mod ? ` ${mod > 0 ? "+" : "−"} ${Math.abs(mod)}` : ""})` : "";
  const text = `🎲 ${pf.name} rolled ${desc}: ${total}${detail}`;
  chatLog.push({ fromId: playerId, text, ts: roll.ts });
  saveChatLog();
  renderChat();
  showDiceRoll(roll);
  if (net.isHost) {
    net.broadcast({ t: "chat", fromId: playerId, text, ts: roll.ts });
    net.broadcast({ t: "dnd-roll", roll });
  }
}

function requestDiceRoll() {
  const formula = $("#dnd-dice")?.value || "1d20";
  if (net.isHost) rollDiceForPlayer(MY_ID, formula);
  else net.send({ t: "dnd-roll", formula });
}

function showDiceRoll(roll) {
  activeDiceRoll = { ...roll, start: performance.now(), duration: 1400 };
}

// ============================================================ CANVAS ========
const canvas = $("#stage");
const ctx    = canvas.getContext("2d");
let dragging = false;

function addDrawingStroke(stroke, broadcast = true) {
  if (!stroke || !stroke.points || stroke.points.length < 2) return;
  if (stroke.id && drawingStrokes.some((s) => s.id === stroke.id)) return;
  if (broadcast) drawingRedoStack.length = 0;
  drawingStrokes.push(stroke);
  if (drawingStrokes.length > DRAWING_LIMIT) drawingStrokes.splice(0, drawingStrokes.length - DRAWING_LIMIT);
  saveDrawing();
  if (broadcast) sendDrawingStroke(stroke);
}

function replaceDrawing(strokes) {
  drawingStrokes.length = 0;
  drawingStrokes.push(...(Array.isArray(strokes) ? strokes.slice(-DRAWING_LIMIT) : []));
  drawingRedoStack.length = 0;
  saveDrawing();
}

function clearDrawing(broadcast = true) {
  drawingStrokes.length = 0;
  drawingRedoStack.length = 0;
  drawing = false;
  currentStroke = null;
  try { localStorage.removeItem(DRAWING_KEY); } catch {}
  if (broadcast) sendDrawingClear();
}

function clearDrawingWithConfirmation() {
  if (!drawingStrokes.length) return;
  if (!confirm("Clear all drawings for everyone?")) return;
  clearDrawing();
}

function sendDrawingStroke(stroke) {
  const msg = { t: "draw", stroke };
  if (net.isHost) net.broadcast(msg);
  else net.send(msg);
}

function sendDrawingClear() {
  const msg = { t: "draw-clear" };
  if (net.isHost) net.broadcast(msg);
  else net.send(msg);
}

function sendDrawingReplace() {
  const msg = { t: "drawing", strokes: drawingStrokes };
  if (net.isHost) net.broadcast(msg);
  else net.send(msg);
}

function undoDrawing() {
  const stroke = drawingStrokes.pop();
  if (!stroke) return;
  drawingRedoStack.push(stroke);
  saveDrawing();
  sendDrawingReplace();
}

function redoDrawing() {
  const stroke = drawingRedoStack.pop();
  if (!stroke) return;
  drawingStrokes.push(stroke);
  saveDrawing();
  sendDrawingReplace();
}

function hostCrown(id) {
  return id && id === currentHostId() ? "👑 " : "";
}

function colorAtCanvasPoint(pt) {
  syncCanvasSize();
  const dpr = window.devicePixelRatio || 1;
  const x = Math.max(0, Math.min(canvas.width - 1, Math.round(pt.x * dpr)));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.round(pt.y * dpr)));
  const pixel = ctx.getImageData(x, y, 1, 1).data;
  return "#" + [pixel[0], pixel[1], pixel[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function currentHostId() {
  if (lastHostOrder[0]) return lastHostOrder[0];
  if (net.isHost) return MY_ID;
  return null;
}

function drawStroke(stroke, m) {
  const points = stroke.points || [];
  if (points.length < 2) return;
  const sx = (p) => m.ox + p.x * m.w;
  const sy = (p) => m.oy + p.y * m.h;
  ctx.save();
  if (stroke.tool === "eraser") ctx.globalCompositeOperation = "destination-out";
  if (stroke.tool === "highlighter") ctx.globalAlpha = 0.38;
  ctx.strokeStyle = stroke.tool === "eraser" ? "#000" : (stroke.color || DRAW_DEFAULT_COLOR);
  ctx.lineWidth = (stroke.width || 4) * dndZoom;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(sx(points[0]), sy(points[0]));
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (sx(points[i]) + sx(points[i + 1])) / 2;
    const midY = (sy(points[i]) + sy(points[i + 1])) / 2;
    ctx.quadraticCurveTo(sx(points[i]), sy(points[i]), midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(sx(last), sy(last));
  ctx.stroke();
  ctx.restore();
}

function drawDndPlayerToken(player, m) {
  if (player.connected === false) return;
  const size = playerTokenSize(player);
  const px = Math.max(8, m.cell * size);
  const x = m.ox + player.x * m.w - px / 2;
  const y = m.oy + player.y * m.h - px / 2;
  const selected = player.id === dndSelectedPlayerId;
  const isMe = player.id === MY_ID;
  ctx.save();
  ctx.fillStyle = player.color || "#4dd2ff";
  ctx.globalAlpha = 0.9;
  roundRect(ctx, x + 3, y + 3, Math.max(8, px - 6), Math.max(8, px - 6), Math.min(14, px * 0.22));
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = selected ? "#fff" : isMe ? "rgba(255,255,255,0.82)" : "rgba(0,0,0,0.45)";
  ctx.lineWidth = selected ? 4 : 2;
  ctx.stroke();
  ctx.font = `${Math.max(18, Math.min(54, px * 0.45))}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(player.icon || "●", x + px / 2, y + px / 2);
  if (speaking.has(player.id)) {
    const pulse = 0.5 + 0.5 * Math.abs(Math.sin(Date.now() / 220));
    ctx.beginPath();
    ctx.arc(x + px / 2, y + px / 2, px / 2 + 5 + pulse * 5, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(124,252,155,${0.5 + 0.5 * pulse})`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillText(hostCrown(player.id) + player.name, x + px / 2, y - 5);
  drawStatBars(x, y + px + 12, px, dndStatsForPlayer(player));
  ctx.restore();
}

function renderDrawing(m) {
  for (const stroke of drawingStrokes) drawStroke(stroke, m);
  if (currentStroke) drawStroke(currentStroke, m);
}

function renderDndBoard(rect, m) {
  ctx.save();
  ctx.fillStyle = dndSharedState.bg || "#182033";
  ctx.fillRect(m.ox, m.oy, m.w, m.h);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(m.ox, m.oy, m.w, m.h);

  if (dndSharedState.grid) {
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= m.board.cols; c++) {
      const x = m.ox + c * m.cell;
      ctx.moveTo(x, m.oy);
      ctx.lineTo(x, m.oy + m.h);
    }
    for (let r = 0; r <= m.board.rows; r++) {
      const y = m.oy + r * m.cell;
      ctx.moveTo(m.ox, y);
      ctx.lineTo(m.ox + m.w, y);
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`${DND_GRID_FT} ft`, m.ox + 6, m.oy + 6);
  }

  for (const asset of dndSharedState.assets) drawDndAsset(asset, m);
  if (dndHoverName) {
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(12, rect.height - 46, Math.min(280, 24 + dndHoverName.length * 8), 30);
    ctx.fillStyle = "#fff";
    ctx.font = "700 14px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(dndHoverName, 24, rect.height - 31);
  }
  ctx.restore();
}

function drawDndAsset(asset, m) {
  ensureAssetStats(asset);
  const x = m.ox + asset.x * m.cell;
  const y = m.oy + asset.y * m.cell;
  const w = asset.w * m.cell;
  const h = asset.h * m.cell;
  const selected = asset.id === dndSelectedId || dndSelectedIds.has(asset.id);
  ctx.save();
  ctx.fillStyle = asset.color || "#4dd2ff";
  ctx.globalAlpha = 0.88;
  roundRect(ctx, x + 3, y + 3, Math.max(8, w - 6), Math.max(8, h - 6), Math.min(14, m.cell * 0.22));
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = selected ? "#fff" : "rgba(0,0,0,0.45)";
  ctx.lineWidth = selected ? 4 : 2;
  ctx.stroke();
  ctx.font = `${Math.max(20, Math.min(54, Math.min(w, h) * 0.45))}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(asset.icon || "●", x + w / 2, y + h / 2);
  drawStatBars(x, y, w, asset.stats);
  ctx.restore();
}

function renderDiceOverlay(rect) {
  if (!activeDiceRoll) return;
  const elapsed = performance.now() - activeDiceRoll.start;
  if (elapsed > activeDiceRoll.duration + 900) {
    activeDiceRoll = null;
    return;
  }
  const rolling = elapsed < activeDiceRoll.duration;
  const pf = profiles.get(activeDiceRoll.fromId) || { name: "Someone", color: "#4dd2ff" };
  const spin = rolling ? Math.floor(elapsed / 85) % activeDiceRoll.rolls.length : -1;
  const shown = rolling
    ? activeDiceRoll.rolls.map((v, i) => i === spin ? 1 + Math.floor(Math.random() * parseDice(activeDiceRoll.formula).sides) : v)
    : activeDiceRoll.rolls;
  ctx.save();
  ctx.translate(rect.width / 2, Math.max(120, rect.height * 0.22));
  ctx.font = "800 19px system-ui, sans-serif";
  const heading = `${pf.name} rolls ${activeDiceRoll.label || activeDiceRoll.formula}`;
  const boxW = Math.max(300, Math.min(rect.width - 24, ctx.measureText(heading).width + 48));
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  roundRect(ctx, -boxW / 2, -58, boxW, 116, 24);
  ctx.fill();
  ctx.strokeStyle = pf.color || "#4dd2ff";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#eef0ff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "800 19px system-ui, sans-serif";
  ctx.fillText(heading, 0, -26);
  ctx.font = rolling ? "900 34px system-ui, sans-serif" : "900 42px system-ui, sans-serif";
  ctx.fillText(rolling ? shown.join(" + ") : String(activeDiceRoll.total), 0, 18);
  ctx.restore();
}

function roundRect(context, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + w, y, x + w, y + h, radius);
  context.arcTo(x + w, y + h, x, y + h, radius);
  context.arcTo(x, y + h, x, y, radius);
  context.arcTo(x, y, x + w, y, radius);
  context.closePath();
}

function setDrawMode(enabled) {
  if (selectedGame !== "free-play") enabled = false;
  drawMode = enabled;
  if (enabled) {
    dndOpen = false;
    setInventoryOpen(false, false);
    setMeasureMode(false);
  }
  syncBoardDock();
}

function setDndOpen(enabled) {
  dndOpen = selectedGame === "free-play" && enabled;
  if (dndOpen) {
    drawMode = false;
    setInventoryOpen(false, false);
  }
  syncDndUi();
}

function setDrawTool(tool) {
  drawTool = tool;
  setDrawMode(true);
  syncDrawToolUi();
}

function setDrawColor(color) {
  drawColor = color || DRAW_DEFAULT_COLOR;
  localStorage.setItem(DRAW_COLOR_KEY, drawColor);
  setDrawTool("pen");
}

function setDrawSize(size) {
  drawSize = Math.max(1, Math.min(28, Number(size) || 4));
  localStorage.setItem(DRAW_SIZE_KEY, String(drawSize));
  syncDrawToolUi();
}

function syncDrawToolUi() {
  $("#btn-draw-pen")?.classList.toggle("active", drawTool === "pen");
  $("#btn-draw-highlighter")?.classList.toggle("active", drawTool === "highlighter");
  $("#btn-draw-eraser")?.classList.toggle("active", drawTool === "eraser");
  $("#btn-draw-eyedropper")?.classList.toggle("active", drawTool === "eyedropper");
  const input = $("#draw-color");
  if (input && input.value !== drawColor) input.value = drawColor;
  const size = $("#draw-size");
  if (size && Number(size.value) !== drawSize) size.value = String(drawSize);
}

const GAME_SAVE_PREFIX = "bp2p-game-state-";

function gameSaveKey(game) {
  return GAME_SAVE_PREFIX + game;
}

function loadSavedGameState(game) {
  if (!game || game === "free-play") return null;
  try { return JSON.parse(localStorage.getItem(gameSaveKey(game)) || "null"); } catch { return null; }
}

function saveGameState(game, state) {
  if (!game || game === "free-play" || !state) return;
  profileTask(`saveGameState(${game})`, () => {
    try { localStorage.setItem(gameSaveKey(game), JSON.stringify({ savedAt: Date.now(), state })); } catch {}
  });
}

const gameSaveTimers = new Map();
const GAME_SAVE_DEBOUNCE_MS = 2500;
const pendingGameSaves = new Map();

function snapshotActiveGame(reason = "snapshotActiveGame") {
  return activeGame?.getSnapshot ? profileTask(reason, () => activeGame.getSnapshot()) : null;
}

function saveActiveGameStateNow(reason = "saveActiveGameStateNow") {
  const state = snapshotActiveGame(`${reason}:getSnapshot`);
  if (state) saveGameState(selectedGame, state);
  return state;
}

function queueGameStateSave(game, state) {
  if (!game || game === "free-play" || !state) return;
  pendingGameSaves.set(game, state);
  runWhenIdle(() => {
    const latestState = pendingGameSaves.get(game);
    if (!latestState) return;
    pendingGameSaves.delete(game);
    saveGameState(game, latestState);
  });
}

function scheduleActiveGameSave() {
  if (!activeGame || selectedGame === "free-play") return;
  const game = selectedGame;
  clearTimeout(gameSaveTimers.get(game));
  gameSaveTimers.set(game, setTimeout(() => {
    if (selectedGame !== game || !activeGame) return;
    const state = snapshotActiveGame(`debounced save ${game}`);
    if (state) queueGameStateSave(game, state);
  }, GAME_SAVE_DEBOUNCE_MS));
}

function clearPendingGameSave(game) {
  clearTimeout(gameSaveTimers.get(game));
  gameSaveTimers.delete(game);
  pendingGameSaves.delete(game);
}

function clearSavedGameState(game) {
  if (!game || game === "free-play") return;
  try { localStorage.removeItem(gameSaveKey(game)); } catch {}
}

function promptForSavedGame(game) {
  const saved = loadSavedGameState(game);
  if (!saved?.state) return null;
  const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString() : "a previous session";
  if (confirm(`Continue saved ${gameName(game)} from ${when}?`)) return saved.state;
  clearSavedGameState(game);
  return null;
}

function savedGameStateOrNull(game) {
  return loadSavedGameState(game)?.state || null;
}

function rememberGamePlayed(game) {
  if (!game || game === "free-play") return;
  try { localStorage.setItem(LAST_GAME_KEY, game); } catch {}
}

function rememberedGameOrDefault() {
  const saved = localStorage.getItem(LAST_GAME_KEY);
  return saved && GAME_INFO[saved] ? saved : null;
}

function shouldRestorePlay() {
  return localStorage.getItem(RESTORE_PLAY_KEY) === "1";
}

function setRestorePlay(value) {
  try { localStorage.setItem(RESTORE_PLAY_KEY, value ? "1" : "0"); } catch {}
}

function gameName(game) {
  return window.BP2PGames?.[game]?.name || GAME_INFO[game]?.name || game;
}

async function setGameMode(game, broadcast = true, restoredState = undefined, promptHost = true) {
  const nextGame = game || "free-play";
  if (nextGame === "lobbies") {
    stopActiveGame();
    selectedGame = "lobbies";
    const select = $("#game-select");
    if (select && select.value !== "lobbies") select.value = "lobbies";
    show("menu");
    refreshLobbyCards();
    return;
  }
  if (selectedGame === nextGame && (nextGame === "free-play" || activeGame)) return;
  stopActiveGame();
  selectedGame = nextGame;
  rememberGamePlayed(selectedGame);
  const select = $("#game-select");
  if (select && select.value !== selectedGame) select.value = selectedGame;
  if (selectedGame !== "free-play") setDrawMode(false);
  else enterFreePlayMode();
  if (selectedGame !== "free-play") setDndOpen(false);
  const initialState = restoredState !== undefined
    ? restoredState
    : (promptHost && net.isHost ? promptForSavedGame(selectedGame) : savedGameStateOrNull(selectedGame));
  if (selectedGame !== "free-play") await startActiveGame(initialState);
  if (broadcast) {
    if (net.isHost) net.broadcast({ t: "game-mode", game: selectedGame });
    else net.send({ t: "game-mode", game: selectedGame });
  }
}

let activeGame = null;
let selectedGame = "";
let gameModeToken = 0;
const pendingGameStates = new Map();

function gameHostApi() {
  return {
    canvas,
    myId: MY_ID,
    isHost: () => net.isHost,
    getPlayers: () => net.isHost ? [...players.values()] : lastState,
    getProfile: (id) => profiles.get(id),
    isSpeaking: (id) => speaking.has(id),
    isCurrentHost: (id) => id && id === currentHostId(),
    hostCrown,
    sendInput: (input) => {
      if (!activeGame || selectedGame === "free-play") return;
      net.send({ t: "game-input", game: selectedGame, input });
    },
    broadcastState: (state) => {
      if (!activeGame || selectedGame === "free-play" || !net.isHost) return;
      scheduleActiveGameSave();
      sendGameState({ game: selectedGame, state });
    },
  };
}

function sendGameState({ game, state, peerId = null, fullOnly = false }) {
  if (!game || game === "free-play" || !state) return;
  const msg = { t: "game-state", game, state };
  const send = () => {
    profileTask(peerId ? `send game-state ${game} to peer` : `broadcast game-state ${game}`, () => {
      if (peerId) net.sendTo(peerId, msg);
      else net.broadcast(msg);
    });
  };
  if (fullOnly && state.full) setTimeout(send, 0);
  else send();
}

const GAME_INFO = {
  digger: { src: "js/games/digger.js", name: "Deep Digger" },
  "air-hockey": { src: "js/games/air-hockey.js", name: "Air Hockey" },
  "paint-panic": { src: "js/games/paint-panic.js", name: "Paint Panic" },
  tower: { src: "js/games/tower.js", name: "Tower Tumble" },
  "snow-brawl": { src: "js/games/snow-brawl.js", name: "Snow Brawl Royale" },
  "gentle-rain": { src: "js/games/gentle-rain.js", name: "A Gentle Rain" },
};

const loadingGameScripts = new Map();

function loadGameScript(game) {
  if (window.BP2PGames?.[game]) return Promise.resolve(true);
  const src = GAME_INFO[game]?.src;
  if (!src) return Promise.resolve(false);
  if (loadingGameScripts.has(game)) return loadingGameScripts.get(game);
  const promise = new Promise((resolve) => {
    const script = document.createElement("script");
    const separator = src.includes("?") ? "&" : "?";
    script.src = `${src}${separator}v=${encodeURIComponent(APP_VERSION)}`;
    script.onload = () => resolve(!!window.BP2PGames?.[game]);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  loadingGameScripts.set(game, promise);
  return promise;
}

function drawGameMessage(text) {
  const rect = syncCanvasSize();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#12121f";
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#eef0ff";
  ctx.font = "700 18px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, rect.width / 2, rect.height / 2);
}

async function startActiveGame(initialState = null, token = gameModeToken) {
  if (selectedGame === "free-play") return;
  drawGameMessage(`Loading ${gameName(selectedGame)}…`);
  const gameId = selectedGame;
  const loaded = await loadGameScript(gameId);
  if (selectedGame !== gameId || token !== gameModeToken) return;
  const game = window.BP2PGames?.[gameId];
  if (!loaded || !game?.create) {
    drawGameMessage(`${gameName(gameId)} could not load.`);
    return;
  }
  activeGame = game.create(gameHostApi(), initialState);
  activeGame.start?.();
  const pendingState = pendingGameStates.get(gameId);
  if (pendingState) {
    pendingGameStates.delete(gameId);
    activeGame.onState?.(pendingState);
  } else if (initialState) {
    activeGame.onState?.(initialState);
  }
  if (net.isHost) {
    const state = snapshotActiveGame(`start ${selectedGame} snapshot`);
    if (state) {
      queueGameStateSave(selectedGame, state);
      sendGameState({ game: selectedGame, state, fullOnly: true });
    }
  }
}

function stopActiveGame() {
  const game = selectedGame;
  clearPendingGameSave(game);
  saveActiveGameStateNow(`stop ${game}`);
  activeGame?.destroy?.();
  activeGame = null;
}

function enterFreePlayMode() {
  drawing = false;
  currentStroke = null;
  dragging = false;
  setDrawMode(false);
  syncDndUi();
  syncDndCanvasStyle();
  syncCanvasSize();
  renderFreePlayFrame();
}

function handleGameInput(id, game, input) {
  if (!net.isHost || game !== selectedGame || !activeGame) return;
  activeGame.onPeerInput?.(id, input);
}

function handleGameState(game, state) {
  if (selectedGame === "free-play") return;
  if (game !== selectedGame || !activeGame) {
    if (game) pendingGameStates.set(game, state);
    return;
  }
  activeGame.onState?.(state);
  scheduleActiveGameSave();
}

function notifyActiveGamePlayersChanged() {
  activeGame?.onPlayerList?.();
}

function queueGameStateForPeer(peerId) {
  if (selectedGame === "free-play" || !activeGame) return;
  let attempts = 0;
  const sendWhenReady = () => {
    if (selectedGame === "free-play" || !activeGame) return;
    const state = snapshotActiveGame(`join snapshot ${selectedGame}`);
    if (state) sendGameState({ game: selectedGame, state, peerId, fullOnly: true });
    else if (attempts++ < 10) setTimeout(sendWhenReady, 250);
  };
  setTimeout(sendWhenReady, 0);
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
    const time = entry.ts ? new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    el.innerHTML = `
      <div class="msg-avatar" style="background:${pf.color}">${pf.icon}</div>
      <div class="msg-body">
        <div class="msg-name" style="color:${pf.color}">${hostCrown(entry.fromId)}${esc(pf.name)}${time ? `<span class="msg-time">${time}</span>` : ""}</div>
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

function toggleChat() {
  if (chatOpen) closeChat();
  else openChat();
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

const LIVE_SR         = 16000; // sample rate — adequate for voice
const LIVE_CHUNK      = 256;   // samples per callback (~16 ms)
const LIVE_MIN_BUFFER = 0.03;  // target playout cushion
const LIVE_MAX_QUEUE  = 0.28;  // reset if queued audio drifts too far ahead

function handleLiveAudio(msg) {
  const { fromId, t } = msg;
  if (fromId === MY_ID) return; // ignore own echoes from host relay

  if (t === "audio-start") {
    markSpeaking(fromId);
  } else if (t === "audio-stop") {
    markSilent(fromId);
  } else if (t === "audio-pcm") {
    markSpeaking(fromId);
    playLivePcm(fromId, msg.pcm || msg.b64);
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

function playLivePcm(fromId, payload) {
  if (!playAudioCtx) playAudioCtx = new AudioContext({ sampleRate: LIVE_SR, latencyHint: "interactive" });
  if (playAudioCtx.state === "suspended") playAudioCtx.resume();

  // ArrayBuffer → Int16 → Float32. Base64 is kept for compatibility with older clients.
  let buffer;
  if (typeof payload === "string") {
    const binary = atob(payload);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    buffer = bytes.buffer;
  } else {
    buffer = payload instanceof ArrayBuffer ? payload : payload?.buffer;
  }
  if (!buffer) return;
  const int16   = new Int16Array(buffer);
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
  if (spk.nextTime < now || spk.nextTime > now + LIVE_MAX_QUEUE) spk.nextTime = now + LIVE_MIN_BUFFER;
  const playAt = Math.max(now + LIVE_MIN_BUFFER, spk.nextTime);
  node.start(playAt);
  spk.nextTime = playAt + buf.duration;
}

function sendLiveMsg(msg) {
  if (net.isHost) net.broadcastVoice(msg);
  else net.sendVoice(msg);
}

async function startLiveVoice() {
  if (liveStream) return;
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    liveCapCtx = new AudioContext({ sampleRate: LIVE_SR, latencyHint: "interactive" });
    const src  = liveCapCtx.createMediaStreamSource(liveStream);

    liveProcessor = liveCapCtx.createScriptProcessor(LIVE_CHUNK, 1, 1);
    liveProcessor.onaudioprocess = (e) => {
      const pcm   = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
      }
      sendLiveMsg({ t: "audio-pcm", fromId: MY_ID, pcm: int16.buffer });
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

// ============================================================ LIVE VIDEO ====
let cameraStream = null;
const remoteVideoIds = new Map(); // peerId -> clientId

async function startCamera() {
  if (cameraStream) return;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });
    addVideoTile(MY_ID, cameraStream, true);
    $("#btn-camera").classList.add("recording");
    announceCameraOn();
  } catch {
    cameraStream = null;
    $("#btn-camera").classList.remove("recording");
  }
}

function stopCamera() {
  if (!cameraStream) return;
  cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  removeVideoTile(MY_ID);
  $("#btn-camera").classList.remove("recording");
  sendVideoOff();
}

function toggleCamera() {
  if (cameraStream) stopCamera();
  else startCamera();
}

function announceCameraOn() {
  if (!cameraStream) return;
  if (net.isHost) {
    net.broadcast({ t: "video-on", fromId: MY_ID, peerId: net.peer?.id });
  } else {
    net.send({ t: "video-on" });
  }
}

function sendVideoOff() {
  liveVideoPeers.delete(MY_ID);
  if (net.isHost) net.broadcast({ t: "video-off", fromId: MY_ID });
  else net.send({ t: "video-off" });
}

function liveVideoList() {
  const live = [];
  if (cameraStream && net.peer?.id) live.push({ fromId: MY_ID, peerId: net.peer.id });
  for (const [fromId, peerId] of liveVideoPeers) live.push({ fromId, peerId });
  return live;
}

function callPeerForVideo(peerId, clientId = null) {
  if (!peerId || !cameraStream) return;
  const call = net.call(peerId, cameraStream);
  if (!call) return;
  if (clientId) remoteVideoIds.set(peerId, clientId);
  call.on("stream", (stream) => addVideoTile(remoteVideoIds.get(peerId) || clientId || peerId, stream));
  call.on("close", () => removeVideoTile(remoteVideoIds.get(peerId) || clientId || peerId));
}

function requestVideoFromPeer(peerId, clientId) {
  if (!peerId) return;
  remoteVideoIds.set(peerId, clientId || peerId);
  if (net.isHost) {
    if (peerId === net.peer?.id && cameraStream) return;
    else net.sendTo(peerId, { t: "video-request", requesterPeerId: net.peer?.id });
  } else {
    net.send({ t: "video-request", peerId });
  }
}

function handleMediaCall(call) {
  if (net.isHost && peerMap.get(call.peer)) remoteVideoIds.set(call.peer, peerMap.get(call.peer));
  call.answer(new MediaStream());
  call.on("stream", (stream) => addVideoTile(remoteVideoIds.get(call.peer) || call.peer, stream));
  call.on("close", () => removeVideoTile(remoteVideoIds.get(call.peer) || call.peer));
}

function addVideoTile(id, stream, muted = false) {
  if (!id || !stream) return;
  if (stream.getVideoTracks().length === 0) return;
  const tray = $("#video-tray");
  let tile = document.getElementById("video-" + cssId(id));
  if (!tile) {
    tile = document.createElement("div");
    tile.id = "video-" + cssId(id);
    tile.className = "video-tile";
    tile.innerHTML = `
      <video playsinline autoplay></video>
      <div class="video-label"><span class="video-name"></span><span class="live-pill">LIVE</span></div>`;
    tray.appendChild(tile);
  }
  const video = tile.querySelector("video");
  video.srcObject = stream;
  video.muted = muted;
  video.play().catch(() => {});
  const pf = profiles.get(id) || { name: id === MY_ID ? profile.name : "Camera" };
  tile.querySelector(".video-name").textContent = id === MY_ID ? "You" : pf.name;
}

function removeVideoTile(id) {
  if (!id) return;
  document.getElementById("video-" + cssId(id))?.remove();
}

function cssId(id) {
  return String(id).replace(/[^a-z0-9_-]/gi, "-");
}

// HUD mic button → toggle live voice (independent from in-chat record-to-thread PTT)
const hudMic = $("#btn-mic");
let lastMicTouch = 0;
function toggleLiveVoice() {
  if (liveStream) stopLiveVoice();
  else startLiveVoice();
}
hudMic.addEventListener("click", (e) => {
  if (Date.now() - lastMicTouch < 500) return;
  e.preventDefault();
  toggleLiveVoice();
});
hudMic.addEventListener("touchend", (e) => {
  e.preventDefault();
  lastMicTouch = Date.now();
  toggleLiveVoice();
}, { passive: false });

const cameraBtn = $("#btn-camera");
cameraBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  toggleCamera();
});

// ============================================================ PROFILE UI ====
let profileOpen = false;

function openProfileSheet() {
  if (profileOpen) {
    closeProfileSheet();
    return;
  }
  profileOpen = true;
  // Populate fields from current profile.
  $("#input-name").value = profile.name;
  const settingsCode = $("#settings-code-input");
  if (settingsCode) settingsCode.value = currentLobby?.code || net.code || "";
  buildColorPicker();
  buildIconPicker();
  updateProfilePreview();
  syncTopNav();
  $("#sheet-profile").classList.add("open");
  $("#scrim")?.classList.add("visible");
}

function toggleProfileSheet() {
  if (profileOpen) closeProfileSheet();
  else openProfileSheet();
}

function closeProfileSheet() {
  profileOpen = false;
  $("#sheet-profile")?.classList.remove("open");
  $("#scrim")?.classList.remove("visible");
}

function leaveLobby() {
  if (!net.isHost) {
    try { net.send({ t: "leave" }); } catch {}
  } else if (net.peerCount() > 0) {
    // Graceful handoff: tell remaining players to elect a new host right away.
    try { net.yieldHost("host left"); } catch {}
  }
  hasLeftLobby = true;
  autoMode = false;
  migrationPending = false;
  keepPlayingAfterMigration = false;
  yieldedHostForBackground = false;
  playStarted = false;
  setRestorePlay(false);
  stopHostLoop();
  stopLiveVoice();
  stopCamera();
  net.destroy();
  players.clear();
  peerMap.clear();
  liveVideoPeers.clear();
  usedColors.clear();
  lobbyListKey = "";
  lastState = [];
  lastHostOrder = [];
  drawing = false;
  currentStroke = null;
  setDrawMode(false);
  clearCurrentLobby();
  closeProfileSheet();
  show("menu");
  setStatus("");
  refreshLobbyCards();
}

function startPlaying(broadcast = true) {
  playStarted = true;
  setRestorePlay(true);
  rememberGamePlayed(selectedGame);
  show("play");
  syncDndCanvasStyle();
  if (broadcast && net.isHost) net.broadcast({ t: "play" });
}

function resetNetworkForLobby() {
  stopHostLoop();
  try { net.destroy(); } catch {}
  net = new PeerNet();
  wireNetEvents();
  players.clear();
  peerMap.clear();
  liveVideoPeers.clear();
  usedColors.clear();
  lobbyListKey = "";
  lastState = [];
  lastHostOrder = [];
  playStarted = false;
  migrationPending = false;
  setRestorePlay(false);
}

function hostCode(code) {
  code = sanitizeLobbyCode(code);
  if (code.length !== 4) { setStatus("Enter a 4-character code."); return; }
  rememberLobbyCode(code);
  resetNetworkForLobby();
  autoMode = false;
  hasLeftLobby = false;
  keepPlayingAfterMigration = false;
  yieldedHostForBackground = false;
  currentLobby = { code, role: "host", name: lobbyDisplayName(code) };
  syncTopNav();
  updateHostedLobbyInfo();
  setStatus("Hosting " + lobbyDisplayName(code) + "…");
  renderLobby();
  show("lobby");
  net.host(code);
}

function joinLobbyCode(code) {
  code = sanitizeLobbyCode(code);
  if (code.length !== 4) { setStatus("Enter a 4-character code."); return; }
  rememberLobbyCode(code);
  resetNetworkForLobby();
  playStarted = false;
  joinCode(code);
}

async function joinOrHostCode(code) {
  code = sanitizeLobbyCode(code);
  if (code.length !== 4) { setStatus("Enter a 4-character code."); return; }
  rememberLobbyCode(code);
  const btn = $("#btn-code-action");
  if (btn) btn.disabled = true;
  setStatus("Checking " + code + "…");
  try {
    const status = await PeerNet.probe(code, 1400);
    if (status.online) joinLobbyCode(code);
    else hostCode(code);
  } finally {
    if (btn) btn.disabled = false;
  }
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
  syncTopNav();
  updateActivityStatus();
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
      updateHostedLobbyInfo();
    }
    renderChat();
  } else {
    net.send(msg);
  }
  updateActivityStatus();
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
  if (code === "----") {
    $("#qr").innerHTML = "";
    qrText = "";
  } else if (joinUrl !== qrText) {
    drawQR(joinUrl);
  }
  const list = $("#player-list");
  const lobbyPlayers = net.isHost ? Array.from(players.values()) : lastState;
  const nextListKey = lobbyPlayers.map((p) => `${p.id}:${p.name}:${p.color}`).join("|");
  if (nextListKey !== lobbyListKey) {
    list.innerHTML = "";
    for (const p of lobbyPlayers) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="swatch" style="background:${p.color}"></span>${hostCrown(p.id)}${esc(p.name)}`;
      list.appendChild(li);
    }
    lobbyListKey = nextListKey;
  }
  $("#player-count").textContent = lobbyPlayers.length;
  $("#lobby-empty-hint")?.classList.toggle("hidden", lobbyPlayers.length > 1);
  syncTopNav();
}

function sanitizeLobbyCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function buildLobbyCards() {
  const grid = $("#lobby-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const lobby of ELEMENTAL_LOBBIES) {
    const card = document.createElement("div");
    card.className = "lobby-card " + lobby.name.toLowerCase();
    card.dataset.lobby = lobby.id;
    card.innerHTML = `
      <div>
        <div class="lobby-pill">${esc(lobby.id)}</div>
        <div class="lobby-name">${lobby.icon} ${esc(lobby.name)}</div>
        <div class="lobby-meta">Checking for a host…</div>
      </div>
      <div class="lobby-actions">
        <button class="btn lobby-action-btn" data-action="auto" type="button">Checking…</button>
      </div>`;
    card.querySelector('[data-action="auto"]').addEventListener("click", () => {
      const status = lobbyStatuses.get(lobby.id);
      if (status?.online) joinLobbyCode(lobby.id);
      else hostCode(lobby.id);
    });
    grid.appendChild(card);
  }
}

function renderLobbyCards() {
  for (const lobby of ELEMENTAL_LOBBIES) {
    const card = document.querySelector(`[data-lobby="${lobby.id}"]`);
    if (!card) continue;
    const status = lobbyStatuses.get(lobby.id);
    const meta = card.querySelector(".lobby-meta");
    const actionBtn = card.querySelector('[data-action="auto"]');
    if (!status) {
      meta.textContent = "Checking for a host…";
      actionBtn.textContent = "Checking…";
      actionBtn.disabled = true;
      actionBtn.className = "btn lobby-action-btn checking";
    } else if (status.online) {
      meta.textContent = `${status.info?.name || "Someone"} is hosting · v${status.info?.version || "?"} · ${status.info?.players || 1} player${(status.info?.players || 1) === 1 ? "" : "s"}`;
      actionBtn.textContent = "Join";
      actionBtn.disabled = false;
      actionBtn.className = "btn lobby-action-btn join";
    } else {
      meta.textContent = "Open lobby · become the host";
      actionBtn.textContent = "Host";
      actionBtn.disabled = false;
      actionBtn.className = "btn lobby-action-btn host";
    }
  }
}

async function refreshLobbyCards() {
  buildLobbyCards();
  renderLobbyCards();
  await Promise.all(ELEMENTAL_LOBBIES.map(async (lobby) => {
    lobbyStatuses.set(lobby.id, await PeerNet.probe(lobby.id));
    renderLobbyCards();
  }));
}

function activityStatus() {
  const hosting = net?.isHost && currentLobby?.code;
  return {
    id: MY_ID,
    name: profile.name,
    icon: profile.icon,
    color: myColor || profile.color || COLORS[0],
    status: hosting ? `Hosting ${currentLobby.name}` : currentLobby?.code ? `In ${currentLobby.name}` : "Browsing",
    lobby: currentLobby?.code || "",
    lobbyName: currentLobby?.name || "",
    hosting: !!hosting,
  };
}

function updateActivityStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastActivityUpdate < 3000) return;
  lastActivityUpdate = now;
  activity?.update?.();
}

function renderOnlineUsers(users = onlineUsers) {
  onlineUsers = users.filter((u) => u.id !== MY_ID);
  const count = $("#online-count");
  const list = $("#online-list");
  const lobbyPlayers = net.isHost ? Array.from(players.values()) : lastState;
  const lobbyIds = new Set(lobbyPlayers.map((p) => p.id));
  const byId = new Map(onlineUsers.map((u) => [u.id, u]));
  const lobbyUsers = lobbyPlayers
    .filter((p) => p.id !== MY_ID && p.connected !== false)
    .map((p) => ({ ...byId.get(p.id), id: p.id, name: p.name, icon: p.icon, color: p.color, status: "In this lobby", lobby: currentLobby?.code || net.code || "" }));
  const otherUsers = onlineUsers
    .filter((u) => !lobbyIds.has(u.id))
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  const sortedUsers = [...lobbyUsers, ...otherUsers];
  if (count) count.textContent = String(lobbyPlayers.length || onlineUsers.length + 1);
  if (!list) return;
  list.innerHTML = "";
  const me = activityStatus();
  list.appendChild(onlineUserButton(me, true));
  for (const user of sortedUsers) list.appendChild(onlineUserButton(user, false));
}

function onlineUserButton(user, isMe) {
  const row = document.createElement("div");
  row.className = "online-user";
  row.innerHTML = `
    <span class="online-user-avatar" style="background:${user.color || COLORS[0]}">${esc(user.icon || "●")}</span>
    <span class="online-user-main"><span class="online-user-name">${esc(isMe ? user.name + " (you)" : user.name)}</span><span class="online-user-status">${esc(user.status || "Online")}</span></span>`;
  if (!isMe) {
    const actions = document.createElement("span");
    actions.className = "online-user-actions";
    if (user.hosting && user.lobby) {
      const join = document.createElement("button");
      join.className = "btn btn-small online-user-action";
      join.type = "button";
      join.textContent = "Join";
      join.addEventListener("click", () => {
        joinLobbyCode(user.lobby);
        $("#online-dropdown")?.removeAttribute("open");
      });
      actions.appendChild(join);
    } else if (net.isHost && currentLobby?.code && user.status !== "In this lobby") {
      const invite = document.createElement("button");
      invite.className = "btn btn-small online-user-action";
      invite.type = "button";
      invite.textContent = "Invite";
      invite.addEventListener("click", () => {
        activity.sendInvite(user.id, { code: currentLobby.code, name: currentLobby.name });
        setStatus(`Invited ${user.name}.`);
        showToast(`Invite sent to ${user.name}`, "success", "📨");
        $("#online-dropdown")?.removeAttribute("open");
      });
      actions.appendChild(invite);
    }
    if (actions.children.length) row.appendChild(actions);
  }
  return row;
}

function startActivity() {
  activity.on("roster", renderOnlineUsers);
  activity.on("invite", (msg) => {
    const lobby = msg.lobby;
    if (!lobby?.code) return;
    if (confirm(`${msg.from?.name || "Someone"} invited you to ${lobby.name || lobby.code}. Join now?`)) joinLobbyCode(lobby.code);
  });
  activity.start(activityStatus);
  updateActivityStatus(true);
  renderOnlineUsers([]);
}

let qr = null;
let qrText = "";
let lobbyListKey = "";
function drawQR(text) {
  const el = $("#qr");
  el.innerHTML = "";
  qrText = text;
  qr = new QRCode(el, { text, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
}

function setStatus(text) {
  const s = $("#join-status");
  if (s) s.textContent = text;
}

// ============================================================ TOASTS ========
const TOAST_MS = 3200;
function showToast(text, type = "info", icon = "") {
  const stack = $("#toast-stack");
  if (!stack) return;
  while (stack.children.length >= 3) stack.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = "toast" + (type && type !== "info" ? " " + type : "");
  el.setAttribute("role", "status");
  el.textContent = icon ? `${icon} ${text}` : text;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener("click", dismiss);
  stack.appendChild(el);
  setTimeout(dismiss, TOAST_MS);
}

// Keep --nav-h in sync with the real navbar height (safe-area insets on
// notched phones make it taller than the 58px fallback).
const topNavEl = $("#top-navbar");
function syncNavHeight() {
  const h = Math.ceil(topNavEl?.getBoundingClientRect().height || 58);
  document.documentElement.style.setProperty("--nav-h", `${h}px`);
}
if (topNavEl && "ResizeObserver" in window) new ResizeObserver(syncNavHeight).observe(topNavEl);
window.addEventListener("resize", syncNavHeight);
syncNavHeight();

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

function pointerToCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return { x: src.clientX - rect.left, y: src.clientY - rect.top };
}

function pointerToBoardNorm(e) {
  const rect = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  const m = dndBoardMetrics(rect);
  return {
    x: clamp01((src.clientX - rect.left - m.ox) / m.w),
    y: clamp01((src.clientY - rect.top - m.oy) / m.h),
  };
}

function startPinch(e) {
  const rect = canvas.getBoundingClientRect();
  const [a, b] = [e.touches[0], e.touches[1]];
  const cx = (a.clientX + b.clientX) / 2 - rect.left;
  const cy = (a.clientY + b.clientY) / 2 - rect.top;
  const m = dndBoardMetrics(rect);
  return {
    dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
    zoom: dndZoom,
    boardX: (cx - m.ox) / m.cell,
    boardY: (cy - m.oy) / m.cell,
  };
}

function pointerPressure(e) {
  const src = e.touches ? e.touches[0] : e;
  return clamp01(src.force || src.pressure || 0.5);
}

function onDown(e) {
  if (selectedGame !== "free-play") return;
  // Don't drag when a sheet or chat panel is open.
  if (profileOpen || chatOpen) return;
  if (e.touches && e.touches.length > 1) {
    // Second finger: switch to pinch-zoom and cancel any in-progress gesture.
    e.preventDefault();
    dndDrag = null;
    dndPlayerDrag = null;
    dndPan = null;
    dndPointerDown = null;
    drawing = false;
    currentStroke = null;
    dndPinch = startPinch(e);
    return;
  }
  const boardPoint = pointerToBoard(e);
  if (measureMode) {
    e.preventDefault();
    measureLine = { x1: boardPoint.x, y1: boardPoint.y, x2: boardPoint.x, y2: boardPoint.y, active: true };
    return;
  }
  // Double-tap/click on empty space pings that board spot for everyone.
  const asset = dndAssetAt(boardPoint);
  if (asset && !drawMode) {
    e.preventDefault();
    selectDndAsset(asset.id, e.shiftKey);
    const index = dndSharedState.assets.indexOf(asset);
    dndSharedState.assets.splice(index, 1);
    dndSharedState.assets.push(asset);
    const dragAssets = dndSelectedIds.has(asset.id) ? selectedDndAssets() : [asset];
    dndDrag = { id: asset.id, copy: !!e.ctrlKey, assets: dragAssets.map((a) => ({ id: a.id, x: a.x, y: a.y, dx: boardPoint.x - a.x, dy: boardPoint.y - a.y })), moved: false };
    dndPointerDown = { kind: "asset", entity: asset, x: boardPoint.x, y: boardPoint.y };
    sendDndAction({ type: "select", id: asset.id, additive: e.shiftKey });
    return;
  }
  const player = playerAtCanvasPoint(pointerToCanvas(e), boardPoint.metrics);
  if (player && !drawMode) {
    e.preventDefault();
    const point = pointerToBoardNorm(e);
    dndSelectedId = null;
    dndSelectedPlayerId = player.id;
    dndPointerDown = { kind: "player", entity: { ...player, kind: "player", stats: dndStatsForPlayer(player) }, x: boardPoint.x, y: boardPoint.y };
    sendDndAction({ type: "select-player", id: player.id });
    syncDndUi();
    if (player.id === MY_ID) dndPlayerDrag = { id: player.id, dx: point.x - player.x, dy: point.y - player.y, moved: false };
    return;
  }
  if (drawMode) {
    e.preventDefault();
    drawing = true;
    const point = pointerToBoardNorm(e);
    if (drawTool === "eyedropper") {
      setDrawColor(colorAtCanvasPoint(pointerToCanvas(e)));
      drawing = false;
      return;
    }
    const pressure = pointerPressure(e);
    const screenWidth = drawTool === "eraser" ? drawSize * 3 : drawTool === "highlighter" ? drawSize * 3.2 : drawSize + pressure * 1.4;
    currentStroke = {
      id: MY_ID + "-" + Date.now(),
      tool: drawTool,
      color: drawTool === "eraser" ? null : drawColor,
      width: screenWidth / (dndZoom || 1),
      points: [point],
    };
    return;
  }
  // Empty space: pan the camera.
  e.preventDefault();
  const src = e.touches ? e.touches[0] : e;
  dndBoardMetrics(canvas.getBoundingClientRect()); // ensures dndCam exists
  dndPan = { startX: src.clientX, startY: src.clientY, camX: dndCam.x, camY: dndCam.y, moved: false };
}
function onMove(e) {
  if (selectedGame !== "free-play") return;
  if (dndPinch && e.touches && e.touches.length > 1) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const [a, b] = [e.touches[0], e.touches[1]];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    const cx = (a.clientX + b.clientX) / 2 - rect.left;
    const cy = (a.clientY + b.clientY) / 2 - rect.top;
    dndZoom = clampDndZoom(dndPinch.zoom * (dist / dndPinch.dist));
    const cell = DND_CELL_PX * dndZoom;
    dndCam = clampDndCam({
      x: dndPinch.boardX + (rect.width / 2 - cx) / cell,
      y: dndPinch.boardY + (rect.height / 2 - cy) / cell,
    });
    localStorage.setItem(DND_ZOOM_KEY, String(dndZoom));
    return;
  }
  if (e.touches && e.touches.length > 1) return;
  if (measureLine?.active) {
    e.preventDefault();
    const point = pointerToBoard(e);
    measureLine.x2 = point.x;
    measureLine.y2 = point.y;
    return;
  }
  if (dndPan) {
    e.preventDefault();
    const src = e.touches ? e.touches[0] : e;
    const cell = DND_CELL_PX * dndZoom;
    if (Math.hypot(src.clientX - dndPan.startX, src.clientY - dndPan.startY) > 6) dndPan.moved = true;
    dndCam = clampDndCam({
      x: dndPan.camX - (src.clientX - dndPan.startX) / cell,
      y: dndPan.camY - (src.clientY - dndPan.startY) / cell,
    });
    return;
  }
  if (dndDrag) {
    e.preventDefault();
    const point = pointerToBoard(e);
    const board = dndSharedState.board || defaultDndState().board;
    for (const dragged of dndDrag.assets || []) {
      const asset = dndSharedState.assets.find((a) => a.id === dragged.id);
      if (!asset) continue;
      if (Math.hypot(point.x - (dragged.x + dragged.dx), point.y - (dragged.y + dragged.dy)) > 0.08) dndDrag.moved = true;
      asset.x = Math.max(0, Math.min(board.cols - asset.w, Math.round((point.x - dragged.dx) * 2) / 2));
      asset.y = Math.max(0, Math.min(board.rows - asset.h, Math.round((point.y - dragged.dy) * 2) / 2));
    }
    return;
  }
  if (dndPlayerDrag) {
    e.preventDefault();
    const point = pointerToBoardNorm(e);
    const x = clamp01(point.x - dndPlayerDrag.dx);
    const y = clamp01(point.y - dndPlayerDrag.dy);
    const start = dndPointerDown?.entity;
    if (start && Math.hypot(x - start.x, y - start.y) > 0.01) dndPlayerDrag.moved = true;
    if (net.isHost) {
      const me = players.get(MY_ID);
      if (me) { me.x = x; me.y = y; }
    } else {
      net.send({ t: "input", x, y });
    }
    return;
  }
  const hover = dndAssetAt(pointerToBoard(e));
  dndHoverName = hover?.name || "";
  if (drawing && currentStroke) {
    e.preventDefault();
    const point = pointerToBoardNorm(e);
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
function onUp(e) {
  if (measureLine?.active) {
    measureLine.active = false;
    return;
  }
  if (dndPinch) {
    if (e?.touches && e.touches.length >= 2) { dndPinch = startPinch(e); return; }
    dndPinch = null;
    return;
  }
  if (dndDrag) {
    const asset = dndSharedState.assets.find((a) => a.id === dndDrag.id);
    if (dndDrag.moved && isInventoryOpen() && pointerOverInventory(e)) {
      const inventoryAssets = (dndDrag.assets || []).map((a) => dndSharedState.assets.find((item) => item.id === a.id)).filter(Boolean);
      if (dndDrag.copy) {
        addAssetsToInventory(inventoryAssets, false);
        for (const dragged of dndDrag.assets || []) {
          const moved = dndSharedState.assets.find((a) => a.id === dragged.id);
          if (moved) { moved.x = dragged.x; moved.y = dragged.y; }
        }
      } else {
        addAssetsToInventory(inventoryAssets, true);
      }
    } else if (dndDrag.moved && dndDrag.copy) {
      for (const dragged of dndDrag.assets || []) {
        const moved = dndSharedState.assets.find((a) => a.id === dragged.id);
        if (moved) {
          const copyX = moved.x;
          const copyY = moved.y;
          moved.x = dragged.x;
          moved.y = dragged.y;
          sendDndAction({ type: "add", asset: cloneAsset(moved, { id: `${MY_ID}-${Date.now()}-${Math.random().toString(36).slice(2)}`, x: copyX, y: copyY }) });
        }
      }
    } else if (dndDrag.moved) {
      for (const dragged of dndDrag.assets || []) {
        const moved = dndSharedState.assets.find((a) => a.id === dragged.id);
        if (moved) sendDndAction({ type: "move", id: moved.id, x: moved.x, y: moved.y });
      }
    }
    if (!dndDrag.moved && asset) showDndStats({ ...asset, kind: asset.role || "asset" });
  } else if (dndPan) {
    if (!dndPan.moved) {
      const now = Date.now();
      const pt = dndPointerUpBoardPoint(e);
      if (pt && lastTapInfo && now - lastTapInfo.t < 420 && Math.hypot(pt.x - lastTapInfo.x, pt.y - lastTapInfo.y) < 1.2) {
        sendBoardPing(pt);
        lastTapInfo = null;
      } else {
        lastTapInfo = pt ? { x: pt.x, y: pt.y, t: now } : null;
      }
      if (dndSelectedId || dndSelectedIds.size || dndSelectedPlayerId) {
        sendDndAction({ type: "select", id: null });
        hideDndStats();
      }
      if (measureLine && !measureMode) measureLine = null;
    }
  } else if (dndPlayerDrag) {
    if (!dndPlayerDrag.moved && dndPointerDown?.entity) showDndStats(dndPointerDown.entity);
  } else if (dndPointerDown?.entity) {
    showDndStats(dndPointerDown.entity);
  }
  dndDrag = null;
  dndPlayerDrag = null;
  dndPointerDown = null;
  dndPan = null;
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
window.addEventListener("keydown", handleDndKeyboard);
canvas.addEventListener("wheel", (e) => {
  if (selectedGame !== "free-play") return;
  e.preventDefault();
  setDndZoom(dndZoom * Math.exp(-e.deltaY * 0.0016), pointerToCanvas(e));
}, { passive: false });
canvas.addEventListener("dragover", (e) => {
  if (selectedGame !== "free-play" || !dndInventoryDrag) return;
  e.preventDefault();
});
canvas.addEventListener("drop", (e) => {
  if (selectedGame !== "free-play" || !dndInventoryDrag) return;
  e.preventDefault();
  addInventoryItemToBoard(dndInventoryDrag, pointerToBoard(e));
  dndInventoryDrag = null;
});

function renderMeasureLine(m) {
  if (!measureLine) return;
  const x1 = m.ox + measureLine.x1 * m.cell;
  const y1 = m.oy + measureLine.y1 * m.cell;
  const x2 = m.ox + measureLine.x2 * m.cell;
  const y2 = m.oy + measureLine.y2 * m.cell;
  const cells = Math.hypot(measureLine.x2 - measureLine.x1, measureLine.y2 - measureLine.y1);
  const feet = Math.round(cells * DND_GRID_FT);
  ctx.save();
  ctx.strokeStyle = "#ffd24d";
  ctx.lineWidth = 2.5;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [px, py] of [[x1, y1], [x2, y2]]) {
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd24d";
    ctx.fill();
  }
  if (cells > 0.05) {
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const label = `${feet} ft`;
    ctx.font = "800 13px system-ui, sans-serif";
    const tw = ctx.measureText(label).width + 16;
    ctx.fillStyle = "rgba(0,0,0,0.78)";
    roundRect(ctx, midX - tw / 2, midY - 24, tw, 22, 11);
    ctx.fill();
    ctx.fillStyle = "#ffd24d";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, midX, midY - 13);
  }
  ctx.restore();
}

const PING_MS = 2200;
function renderPings(m) {
  if (!activePings.length) return;
  const now = performance.now();
  activePings = activePings.filter((p) => now - p.start < PING_MS);
  for (const ping of activePings) {
    const t = (now - ping.start) / PING_MS;
    const x = m.ox + ping.x * m.cell;
    const y = m.oy + ping.y * m.cell;
    const wave = (t * 3) % 1;
    ctx.save();
    ctx.strokeStyle = ping.color || "#4dd2ff";
    ctx.globalAlpha = (1 - wave) * (1 - t * 0.5);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 6 + wave * 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1 - t * 0.6;
    ctx.fillStyle = ping.color || "#4dd2ff";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    if (ping.name) {
      ctx.font = "800 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillText(ping.name, x, y - 12);
    }
    ctx.restore();
  }
}

function renderFreePlayFrame() {
  const rect = syncCanvasSize();
  if (!dndViewInitialized && rect.width > 0 && rect.height > 0) {
    fitDndBoard();
    dndViewInitialized = true;
  }
  ctx.clearRect(0, 0, rect.width, rect.height);
  const m = dndBoardMetrics(rect);
  renderDndBoard(rect, m);
  renderDrawing(m);

  for (const p of lastState) drawDndPlayerToken(p, m);
  renderMeasureLine(m);
  renderPings(m);
  renderDiceOverlay(rect);
}

function render() {
  if (selectedGame === "free-play") renderFreePlayFrame();

  requestAnimationFrame(render);
}

$("#btn-code-action")?.addEventListener("click", () => joinOrHostCode($("#code-input").value));

$("#btn-refresh-lobbies")?.addEventListener("click", refreshLobbyCards);

$("#btn-start").addEventListener("click", () => startPlaying(true));
$("#game-select")?.addEventListener("change", (e) => setGameMode(e.target.value, true, undefined, true).catch(console.error));
$("#btn-draw")?.addEventListener("click", () => setDrawMode(!drawMode));
$("#btn-draw-pen")?.addEventListener("click", () => setDrawTool("pen"));
$("#btn-draw-highlighter")?.addEventListener("click", () => setDrawTool("highlighter"));
$("#btn-draw-eraser")?.addEventListener("click", () => setDrawTool("eraser"));
$("#btn-draw-eyedropper")?.addEventListener("click", () => setDrawTool("eyedropper"));
$("#draw-color")?.addEventListener("input", (e) => setDrawColor(e.target.value));
$("#draw-size")?.addEventListener("input", (e) => setDrawSize(e.target.value));
$("#btn-draw-undo")?.addEventListener("click", undoDrawing);
$("#btn-draw-redo")?.addEventListener("click", redoDrawing);
$("#btn-draw-clear")?.addEventListener("click", clearDrawingWithConfirmation);
$("#btn-dnd")?.addEventListener("click", () => setDndOpen(!dndOpen));
$("#btn-inventory")?.addEventListener("click", () => setInventoryOpen(!isInventoryOpen()));
$("#btn-inventory-close")?.addEventListener("click", () => setInventoryOpen(false));
$("#btn-dnd-grid")?.addEventListener("click", () => sendDndAction({ type: "grid", grid: !dndSharedState.grid }));
$("#btn-dnd-measure")?.addEventListener("click", () => setMeasureMode(!measureMode));
$("#dnd-scene")?.addEventListener("change", (e) => setDndScene(e.target.value));
$("#btn-dnd-add")?.addEventListener("click", addSelectedDndAsset);
$("#btn-dnd-custom")?.addEventListener("click", createCustomDndAsset);
$("#btn-dnd-save")?.addEventListener("click", saveSelectedAssetToLibrary);
$("#btn-dnd-duplicate")?.addEventListener("click", () => duplicateSelectedDndAsset());
$("#btn-dnd-remove")?.addEventListener("click", () => removeSelectedDndAsset());
$("#btn-dnd-smaller")?.addEventListener("click", () => resizeSelectedDndAsset(-0.5));
$("#btn-dnd-larger")?.addEventListener("click", () => resizeSelectedDndAsset(0.5));
$("#btn-dnd-board")?.addEventListener("click", setDndBoardSize);
$("#btn-dnd-zoom-out")?.addEventListener("click", () => setDndZoom(dndZoom / 1.25));
$("#btn-dnd-zoom-in")?.addEventListener("click", () => setDndZoom(dndZoom * 1.25));
$("#btn-dnd-fit")?.addEventListener("click", fitDndBoard);
$("#btn-dnd-roll")?.addEventListener("click", requestDiceRoll);
$("#btn-dnd-stats-close")?.addEventListener("click", hideDndStats);
$("#btn-dnd-stats-pin")?.addEventListener("click", () => {
  if (dndPinned && dndPinned.id === dndStatsEntity?.id) clearDndPin();
  else pinDndStats();
});
const dndPinBtnEl = $("#dnd-stats-pin-btn");
dndPinBtnEl?.addEventListener("pointerdown", (e) => {
  if (!dndPinned) return;
  e.preventDefault();
  dndPinBtnEl.setPointerCapture?.(e.pointerId);
  const rect = dndPinBtnEl.getBoundingClientRect();
  dndPinDrag = { moved: false, startX: e.clientX, startY: e.clientY, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
});
dndPinBtnEl?.addEventListener("pointermove", (e) => {
  if (!dndPinDrag) return;
  if (!dndPinDrag.moved && Math.hypot(e.clientX - dndPinDrag.startX, e.clientY - dndPinDrag.startY) < 6) return;
  dndPinDrag.moved = true;
  setDndPinPos(e.clientX - dndPinDrag.dx, e.clientY - dndPinDrag.dy);
});
dndPinBtnEl?.addEventListener("pointerup", () => {
  if (!dndPinDrag) return;
  const wasDrag = dndPinDrag.moved;
  dndPinDrag = null;
  if (wasDrag) saveDndPin();
  else showPinnedDndStats();
});
dndPinBtnEl?.addEventListener("pointercancel", () => {
  if (dndPinDrag?.moved) saveDndPin();
  dndPinDrag = null;
});
// Dragging the details card by its header converts it into the floating pin button.
const dndStatsHeaderEl = $("#dnd-stats-header");
dndStatsHeaderEl?.addEventListener("pointerdown", (e) => {
  if (e.target.closest("button") || !dndStatsEntity?.id) return;
  e.preventDefault();
  dndStatsHeaderDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
});
window.addEventListener("pointermove", (e) => {
  if (!dndStatsHeaderDrag || e.pointerId !== dndStatsHeaderDrag.pointerId) return;
  if (Math.hypot(e.clientX - dndStatsHeaderDrag.startX, e.clientY - dndStatsHeaderDrag.startY) < 12) return;
  dndStatsHeaderDrag = null;
  pinDndStats({ x: e.clientX - 26, y: e.clientY - 26 });
  dndPinDrag = { moved: true, startX: e.clientX, startY: e.clientY, dx: 26, dy: 26 };
  dndPinBtnEl?.setPointerCapture?.(e.pointerId);
});
window.addEventListener("pointerup", (e) => {
  if (dndStatsHeaderDrag?.pointerId === e.pointerId) dndStatsHeaderDrag = null;
  if (dndPinDrag) { if (dndPinDrag.moved) saveDndPin(); dndPinDrag = null; }
});
window.addEventListener("resize", () => { if (dndPinned) syncDndPinButton(); });
$("#btn-custom-asset-close")?.addEventListener("click", closeCustomAssetModal);
$("#btn-custom-asset-save")?.addEventListener("click", () => saveCustomAssetFromModal(false));
$("#btn-custom-asset-add")?.addEventListener("click", () => saveCustomAssetFromModal(true));
$("#modal-custom-asset")?.addEventListener("click", (e) => {
  if (e.target?.id === "modal-custom-asset") closeCustomAssetModal();
});
const startupGame = shouldRestorePlay() ? (rememberedGameOrDefault() || "free-play") : "lobbies";
setGameMode(startupGame).catch(console.error);
syncDrawToolUi();
syncDndUi();

// Auto-join from QR link (?join=CODE).
const joinParam = new URLSearchParams(location.search).get("join");
const autoJoinCode = joinParam?.trim().toUpperCase();
const initialCode = sanitizeLobbyCode(autoJoinCode) || preferredLobbyCode();
if ($("#code-input")) $("#code-input").value = initialCode;
$("#code-input")?.addEventListener("input", (e) => {
  e.target.value = sanitizeLobbyCode(e.target.value);
  if (e.target.value.length === 4) rememberLobbyCode(e.target.value);
});

// ============================================================ PROFILE ACTIONS
$("#btn-profile").addEventListener("click", toggleProfileSheet);
$("#btn-lobby-settings").addEventListener("click", toggleProfileSheet);
$("#btn-menu-settings")?.addEventListener("click", toggleProfileSheet);
$("#btn-close-profile").addEventListener("click", closeProfileSheet);
$("#menu-version").textContent = `Version ${APP_VERSION}`;
$("#app-version").textContent = APP_VERSION;
$("#btn-check-update").addEventListener("click", checkForUpdates);
$("#btn-leave-lobby").addEventListener("click", leaveLobby);
$("#btn-settings-join")?.addEventListener("click", () => joinLobbyCode($("#settings-code-input").value));
$("#btn-settings-host")?.addEventListener("click", () => hostCode($("#settings-code-input").value || preferredLobbyCode()));
$("#btn-share-lobby")?.addEventListener("click", async () => {
  const code = currentLobby?.code || net.code;
  if (!code) { $("#settings-lobby-status").textContent = "You are not in a lobby."; return; }
  const url = `${location.origin}${location.pathname}?join=${code}`;
  try {
    if (navigator.share) await navigator.share({ title: "ClasslessRPG lobby", text: `Join my ClasslessRPG lobby: ${code}`, url });
    else await navigator.clipboard.writeText(url);
    $("#settings-lobby-status").textContent = "Lobby link shared.";
    showToast("Lobby link shared", "success", "🔗");
  } catch {
    $("#settings-lobby-status").textContent = url;
  }
});
$("#btn-keep-awake").addEventListener("click", toggleKeepAwake);
syncWakeUi();
$("#btn-enable-notifications").addEventListener("click", enableJoinNotifications);
syncNotificationUi();

// Escape closes the topmost overlay (modal > settings > chat).
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#modal-custom-asset")?.classList.contains("hidden")) { closeCustomAssetModal(); return; }
  if (profileOpen) { closeProfileSheet(); return; }
  if (chatOpen) closeChat();
});
$("#scrim")?.addEventListener("click", closeProfileSheet);

// ============================================================ CHAT ACTIONS ==
$("#btn-chat").addEventListener("click", toggleChat);
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
startActivity();
refreshLobbyCards();
const savedLobby = getStoredLobby();
if (autoJoinCode) joinLobbyCode(autoJoinCode);
else if (savedLobby?.code && savedLobby?.role === "host") hostCode(savedLobby.code);
else if (savedLobby?.code) joinLobbyCode(savedLobby.code);
else show("menu");
render();
