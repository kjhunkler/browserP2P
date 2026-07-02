/*
 * peer-net.js — a tiny star-topology networking layer over PeerJS.
 *
 * One peer is the HOST (owns authoritative game state). Every other peer is a
 * CLIENT that connects directly to the host. Game data then flows phone-to-phone
 * over the local Wi-Fi; the only thing that touches the internet is PeerJS's
 * signaling handshake when the connection is first established.
 *
 * This file knows nothing about the game itself — it just moves messages around
 * and emits events. Swap the demo in app.js for any game and this layer is reused.
 *
 * Events (listen with net.on('name', fn)):
 *   ready        ()                  peer registered with the broker
 *   peer-join    (peerId)            a client connected (host only)
 *   peer-leave   (peerId)            a client disconnected (host only)
 *   connected    ()                  we reached the host (client only)
 *   host-closed  ()                  the host went away (client only)
 *   host-yield   (reason)            the host intentionally yielded (client only)
 *   message      ({ from, data })    a message arrived
 *   error        (err)               something went wrong
 */

const PREFIX = "bp2p-"; // namespaces our room codes on the shared public broker
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L ambiguity
const CODE_LEN = 4;
const INTERNAL = "__bp2p";
const HEARTBEAT_MS = 1000;
const HOST_WATCHDOG_MS = 3500;
const ACTIVITY_ID = PREFIX + "activity";

function makeCode() {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

class PeerNet {
  constructor() {
    this.peer = null;
    this.isHost = false;
    this.code = null;
    this.conns = new Map(); // host: peerId -> DataConnection
    this.voiceConns = new Map(); // host: peerId -> voice DataConnection
    this.hostConn = null; // client: connection to the host
    this.hostVoiceConn = null; // client: voice connection to the host
    this.mediaCalls = new Map(); // peerId -> MediaConnection
    this._handlers = new Map();
    this._closed = false;
    this._heartbeatTimer = null;
    this._watchdogTimer = null;
    this._lastHostSeen = 0;
    this._hostClosedEmitted = false;
    this.lobbyInfo = {};
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return this;
  }

  _isInternal(data) {
    return data && data.t === INTERNAL;
  }

  _handleInternal(data, conn) {
    if (!this._isInternal(data)) return false;
    if (data.kind === "hb") {
      this._markHostSeen();
      if (conn?.open) conn.send({ t: INTERNAL, kind: "ack", ts: Date.now() });
    } else if (data.kind === "yield") {
      this._markHostSeen();
      if (!this.isHost) this._emit("host-yield", data.reason || "host yielded");
    }
    return true;
  }

  _markHostSeen() {
    this._lastHostSeen = Date.now();
  }

  _emitHostClosedOnce() {
    if (this._closed || this._hostClosedEmitted) return;
    this._hostClosedEmitted = true;
    this._stopWatchdog();
    this._emit("host-closed");
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._closed || !this.isHost) return;
      const msg = { t: INTERNAL, kind: "hb", ts: Date.now() };
      for (const conn of this.conns.values()) if (conn.open) conn.send(msg);
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._hostClosedEmitted = false;
    this._markHostSeen();
    this._watchdogTimer = setInterval(() => {
      if (this._closed || this.isHost) return;
      if (Date.now() - this._lastHostSeen > HOST_WATCHDOG_MS) this._emitHostClosedOnce();
    }, 500);
  }

  _stopWatchdog() {
    clearInterval(this._watchdogTimer);
    this._watchdogTimer = null;
  }

  _emit(event, payload) {
    const set = this._handlers.get(event);
    if (set) for (const fn of set) fn(payload);
  }

  setLobbyInfo(info) {
    this.lobbyInfo = { ...info };
  }

  /* ----- HOST ----- */
  // Registers under a fresh room code; retries if the code is already taken.
  host(fixedCode = null) {
    this._closed = false;
    this.isHost = true;
    if (fixedCode) {
      const code = String(fixedCode).trim();
      const peer = new Peer(PREFIX + code, { debug: 1 });
      this.peer = peer;

      peer.on("open", () => {
        if (this._closed) return;
        this.code = code;
        this._startHeartbeat();
        this._emit("ready");
      });

      this._acceptConnections(peer);
      peer.on("error", (err) => { if (!this._closed) this._emit("error", err); });
      return;
    }

    const tryCode = (attemptsLeft) => {
      if (this._closed) return;
      const code = makeCode();
      const peer = new Peer(PREFIX + code, { debug: 1 });
      this.peer = peer;

      peer.on("open", () => {
        if (this._closed) return;
        this.code = code;
        this._startHeartbeat();
        this._emit("ready");
      });

      this._acceptConnections(peer);

      peer.on("error", (err) => {
        if (this._closed) return;
        // Code collision on the public broker — pick another and retry.
        if (err.type === "unavailable-id" && attemptsLeft > 0) {
          peer.destroy();
          tryCode(attemptsLeft - 1);
        } else {
          this._emit("error", err);
        }
      });
    };
    tryCode(5);
  }

  // Wire a host peer to track incoming client connections. Shared by host()
  // and the auto() election path.
  _acceptConnections(peer) {
    peer.on("connection", (conn) => {
      if (conn.label === "voice") {
        this._acceptVoiceConnection(conn);
        return;
      }
      if (conn.label === "probe") {
        conn.on("open", () => {
          if (!this._closed && conn.open) conn.send({ t: INTERNAL, kind: "lobby-info", info: this.lobbyInfo || {}, code: this.code });
          setTimeout(() => conn.close?.(), 150);
        });
        return;
      }
      conn.on("open", () => {
        if (this._closed) return;
        this.conns.set(conn.peer, conn);
        this._emit("peer-join", conn.peer);
      });
      conn.on("data", (data) => { if (!this._closed && !this._handleInternal(data, conn)) this._emit("message", { from: conn.peer, data }); });
      conn.on("close", () => {
        if (this._closed) return;
        this.conns.delete(conn.peer);
        this._emit("peer-leave", conn.peer);
      });
    });
    this._acceptMediaCalls(peer);
  }

  static probe(code, timeoutMs = 1800) {
    return new Promise((resolve) => {
      const peer = new Peer({ debug: 0 });
      let done = false;
      let openFallback = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(openFallback);
        try { conn?.close?.(); } catch {}
        try { peer.destroy(); } catch {}
        resolve(result);
      };
      let conn = null;
      let connOpened = false;
      const timer = setTimeout(() => finish({ online: false }), timeoutMs);
      peer.on("open", () => {
        conn = peer.connect(PREFIX + code, { label: "probe", reliable: true });
        conn.on("open", () => {
          connOpened = true;
          openFallback = setTimeout(() => finish({ online: true, info: null, code }), 350);
        });
        conn.on("data", (data) => {
          if (data?.t === INTERNAL && data.kind === "lobby-info") finish({ online: true, info: data.info || {}, code: data.code || code });
        });
        conn.on("close", () => finish(connOpened ? { online: true, info: null, code } : { online: false }));
        conn.on("error", () => finish({ online: false }));
      });
      peer.on("error", () => finish({ online: false }));
    });
  }

  _acceptVoiceConnection(conn) {
    conn.on("open", () => {
      if (this._closed) return;
      this.voiceConns.set(conn.peer, conn);
      this._emit("voice-open", conn.peer);
    });
    conn.on("data", (data) => { if (!this._closed) this._emit("voice-message", { from: conn.peer, data }); });
    conn.on("close", () => {
      if (this._closed) return;
      this.voiceConns.delete(conn.peer);
      this._emit("voice-close", conn.peer);
    });
  }

  _connectVoiceToHost(peer, hostId) {
    if (!peer || this._closed) return;
    const conn = peer.connect(hostId, { label: "voice", reliable: false });
    this.hostVoiceConn = conn;
    conn.on("open", () => { if (!this._closed) this._emit("voice-open", "host"); });
    conn.on("data", (data) => { if (!this._closed) this._emit("voice-message", { from: "host", data }); });
    conn.on("close", () => { if (!this._closed) this._emit("voice-close", "host"); });
  }

  _acceptMediaCalls(peer) {
    peer.on("call", (call) => {
      if (this._closed) return;
      this.mediaCalls.set(call.peer, call);
      this._emit("media-call", call);
      call.on("close", () => {
        this.mediaCalls.delete(call.peer);
        this._emit("media-close", call.peer);
      });
    });
  }

  /* ----- AUTO (one game per network) ----- */
  // Open the app and "just join": try to reach the single well-known host on
  // this channel; if nobody is hosting, become the host. First device in wins
  // the host role, everyone after auto-joins it. No codes, no QR.
  //
  // NOTE: the public PeerJS broker is global, not per-LAN, so this fixed id is
  // shared with anyone running the app at the same moment. Pass a `channel`
  // string to scope it to your group if you ever collide.
  auto(channel) {
    this._closed = false;
    this._autoId = PREFIX + "auto" + (channel ? "-" + channel : "");
    this.code = this._autoId.slice(PREFIX.length);
    this._tryJoinThenHost();
  }

  _tryJoinThenHost(attempt = 0) {
    if (this._closed) return;
    if (attempt > 10) { this._emit("error", { type: "election-failed" }); return; }

    this.isHost = false;
    const peer = new Peer({ debug: 1 });
    this.peer = peer;
    let settled = false;

    peer.on("open", () => {
      if (this._closed) return;
      const conn = peer.connect(this._autoId, { reliable: true });
      this.hostConn = conn;

      // Safety net: host registered but not responding (e.g. stale broker slot
      // from a recently-closed tab). Give it 2.5s then try to claim the host role.
      const timer = setTimeout(() => {
        if (settled || this._closed) return;
        settled = true;
        peer.destroy();
        this._becomeHost(attempt);
      }, 2500);

      conn.on("open", () => {
        if (settled || this._closed) return;
        settled = true;
        clearTimeout(timer);
        this._acceptMediaCalls(peer);
        this._connectVoiceToHost(peer, this._autoId);
        this._startWatchdog();
        this._emit("connected");
      });
      conn.on("data",  (data) => { if (!this._closed) { this._markHostSeen(); if (!this._handleInternal(data, conn)) this._emit("message", { from: "host", data }); } });
      conn.on("close", ()     => { if (this.hostConn === conn) this._emitHostClosedOnce(); });
    });

    peer.on("error", (err) => {
      if (this._closed) return;
      // No host registered yet — become it.
      if (err.type === "peer-unavailable" && !settled) {
        settled = true;
        peer.destroy();
        this._becomeHost(attempt);
      } else if (!settled) {
        this._emit("error", err);
      }
    });
  }

  _becomeHost(attempt = 0) {
    if (this._closed) return;
    this.isHost = true;
    const peer = new Peer(this._autoId, { debug: 1 });
    this.peer = peer;

    peer.on("open", () => { if (!this._closed) { this._startHeartbeat(); this._emit("ready"); } });
    this._acceptConnections(peer);

    peer.on("error", (err) => {
      if (this._closed) return;
      if (err.type === "unavailable-id") {
        // Another device registered the host id just before us (race), or a
        // stale broker slot from a previous session hasn't expired yet.
        // Back off with exponential delay and try joining again.
        peer.destroy();
        const backoff = Math.min(300 * Math.pow(2, attempt), 6000);
        setTimeout(() => { if (!this._closed) this._tryJoinThenHost(attempt + 1); }, backoff);
      } else {
        this._emit("error", err);
      }
    });
  }

  /* ----- CLIENT ----- */
  join(code) {
    this._closed = false;
    this.isHost = false;
    this.code = code;
    const peer = new Peer({ debug: 1 }); // random id assigned by the broker
    this.peer = peer;

    peer.on("open", () => {
      if (this._closed) return;
      const conn = peer.connect(PREFIX + code, { reliable: true });
      this.hostConn = conn;
      conn.on("open", () => {
        if (this._closed) return;
        this._acceptMediaCalls(peer);
        this._connectVoiceToHost(peer, PREFIX + code);
        this._startWatchdog();
        this._emit("connected");
      });
      conn.on("data", (data) => { if (!this._closed) { this._markHostSeen(); if (!this._handleInternal(data, conn)) this._emit("message", { from: "host", data }); } });
      conn.on("close", () => { if (this.hostConn === conn) this._emitHostClosedOnce(); });
    });

    peer.on("error", (err) => { if (!this._closed) this._emit("error", err); });
  }

  /* ----- messaging ----- */
  // Host -> every client.
  broadcast(msg) {
    for (const conn of this.conns.values()) {
      if (conn.open) conn.send(msg);
    }
  }

  // Host -> one client.
  sendTo(peerId, msg) {
    const conn = this.conns.get(peerId);
    if (conn && conn.open) conn.send(msg);
  }

  // Client -> host.
  send(msg) {
    if (this.hostConn && this.hostConn.open) this.hostConn.send(msg);
  }

  // Host -> every client over the dedicated live-voice channel.
  broadcastVoice(msg) {
    for (const [peerId, conn] of this.conns) {
      const voiceConn = this.voiceConns.get(peerId);
      if (voiceConn?.open) voiceConn.send(msg);
      else if (conn.open) conn.send(msg);
    }
  }

  // Host -> one client over the dedicated live-voice channel.
  sendVoiceTo(peerId, msg) {
    const conn = this.voiceConns.get(peerId);
    if (conn && conn.open) conn.send(msg);
    else this.sendTo(peerId, msg);
  }

  // Client -> host over the dedicated live-voice channel.
  sendVoice(msg) {
    if (this.hostVoiceConn && this.hostVoiceConn.open) this.hostVoiceConn.send(msg);
    else this.send(msg);
  }

  call(peerId, stream) {
    if (!this.peer || this._closed) return null;
    const call = this.peer.call(peerId, stream);
    if (call) this.mediaCalls.set(peerId, call);
    return call;
  }

  peerCount() {
    return this.isHost ? this.conns.size : this.hostConn ? 1 : 0;
  }

  yieldHost(reason = "host yielded") {
    if (!this.isHost || this._closed) return;
    this.broadcast({ t: INTERNAL, kind: "yield", reason, ts: Date.now() });
  }

  // Re-run the auto election on an existing instance (e.g. after the host
  // leaves). Tears down the current connection and participates in a new
  // host election on the same channel, keeping all registered event handlers.
  migrate(channel, preferHost = false) {
    this._migrateTo(PREFIX + "auto" + (channel ? "-" + channel : ""), preferHost);
  }

  // Same election flow, but for a fixed-code lobby: the winner re-registers
  // the room code so remaining players stay in the same lobby.
  migrateCode(code, preferHost = false) {
    this._migrateTo(PREFIX + String(code).trim(), preferHost);
  }

  _migrateTo(fullId, preferHost) {
    this.destroy();
    this._closed = false;
    this.isHost = false;
    this._autoId = fullId;
    this.code = fullId.slice(PREFIX.length);
    if (preferHost) this._becomeHost();
    else this._tryJoinThenHost();
  }

  destroy() {
    this._closed = true;
    this._stopHeartbeat();
    this._stopWatchdog();
    for (const conn of this.conns.values()) conn.close?.();
    for (const conn of this.voiceConns.values()) conn.close?.();
    this.hostConn?.close?.();
    this.hostVoiceConn?.close?.();
    for (const call of this.mediaCalls.values()) call.close?.();
    if (this.peer) this.peer.destroy();
    this.peer = null;
    this.isHost = false;
    this.code = null;
    this._autoId = null;
    this.conns.clear();
    this.voiceConns.clear();
    this.mediaCalls.clear();
    this.hostConn = null;
    this.hostVoiceConn = null;
  }
}

class PeerActivity {
  constructor() {
    this.peer = null;
    this.hostConn = null;
    this.conns = new Map();
    this.users = new Map();
    this._handlers = new Map();
    this._closed = false;
    this._isHost = false;
    this._statusFn = () => ({});
    this._tick = null;
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return this;
  }

  _emit(event, payload) {
    const set = this._handlers.get(event);
    if (set) for (const fn of set) fn(payload);
  }

  start(statusFn) {
    this._closed = false;
    this._statusFn = statusFn || this._statusFn;
    this._connectOrHost();
    this._tick = setInterval(() => this.update(), 10000);
  }

  _payload() {
    return { t: 'activity', kind: 'update', user: this._statusFn() };
  }

  _connectOrHost() {
    const peer = new Peer({ debug: 0 });
    this.peer = peer;
    let settled = false;
    peer.on('open', () => {
      if (this._closed) return;
      const conn = peer.connect(ACTIVITY_ID, { label: 'activity', reliable: true });
      this.hostConn = conn;
      const timer = setTimeout(() => {
        if (settled || this._closed) return;
        settled = true;
        peer.destroy();
        this._becomeHost();
      }, 1800);
      conn.on('open', () => {
        if (this._closed) return;
        settled = true;
        clearTimeout(timer);
        conn.send(this._payload());
        this._emit('roster', [this._statusFn()]);
      });
      conn.on('data', (msg) => this._handleClientMsg(msg));
      conn.on('close', () => this._retry());
    });
    peer.on('error', (err) => {
      if (this._closed) return;
      if (err.type === 'peer-unavailable' && !settled) {
        settled = true;
        peer.destroy();
        this._becomeHost();
      }
    });
  }

  _becomeHost() {
    if (this._closed) return;
    this._isHost = true;
    const peer = new Peer(ACTIVITY_ID, { debug: 0 });
    this.peer = peer;
    peer.on('open', () => this.update());
    peer.on('connection', (conn) => {
      if (conn.label !== 'activity') return;
      conn.on('open', () => this.conns.set(conn.peer, conn));
      conn.on('data', (msg) => this._handleHostMsg(conn.peer, msg));
      conn.on('close', () => {
        this.conns.delete(conn.peer);
        for (const [id, user] of this.users) if (user.peerId === conn.peer) this.users.delete(id);
        this._broadcastRoster();
      });
    });
    peer.on('error', (err) => {
      if (this._closed) return;
      if (err.type === 'unavailable-id') this._retry();
    });
  }

  _retry() {
    if (this._closed) return;
    try { this.peer?.destroy(); } catch {}
    this.peer = null;
    this.hostConn = null;
    this._isHost = false;
    setTimeout(() => { if (!this._closed) this._connectOrHost(); }, 1200 + Math.random() * 1000);
  }

  _handleHostMsg(peerId, msg) {
    if (msg?.t !== 'activity') return;
    if (msg.kind === 'update' && msg.user?.id) {
      this.users.set(msg.user.id, { ...msg.user, peerId, updated: Date.now() });
      this._broadcastRoster();
    } else if (msg.kind === 'invite' && msg.to) {
      this._routeInvite(msg);
    }
  }

  _handleClientMsg(msg) {
    if (msg?.t !== 'activity') return;
    if (msg.kind === 'roster') {
      this.users = new Map((msg.users || []).map((u) => [u.id, u]));
      this._emit('roster', Array.from(this.users.values()));
    } else if (msg.kind === 'invite') {
      this._emit('invite', msg);
    }
  }

  _broadcastRoster() {
    const cutoff = Date.now() - 30000;
    for (const [id, user] of this.users) if ((user.updated || 0) < cutoff) this.users.delete(id);
    const users = Array.from(this.users.values()).map(({ peerId, ...user }) => user);
    this._emit('roster', users);
    const msg = { t: 'activity', kind: 'roster', users };
    for (const conn of this.conns.values()) if (conn.open) conn.send(msg);
  }

  _routeInvite(msg) {
    if (msg.to === this._statusFn().id) {
      this._emit('invite', msg);
      return;
    }
    const target = this.users.get(msg.to);
    const conn = target && this.conns.get(target.peerId);
    if (conn?.open) conn.send(msg);
  }

  update() {
    if (this._closed) return;
    const payload = this._payload();
    if (this._isHost) {
      if (payload.user?.id) this.users.set(payload.user.id, { ...payload.user, updated: Date.now() });
      this._broadcastRoster();
    } else if (this.hostConn?.open) {
      this.hostConn.send(payload);
    }
  }

  sendInvite(to, lobby) {
    const msg = { t: 'activity', kind: 'invite', to, from: this._statusFn(), lobby };
    if (this._isHost) this._routeInvite(msg);
    else if (this.hostConn?.open) this.hostConn.send(msg);
  }

  destroy() {
    this._closed = true;
    clearInterval(this._tick);
    for (const conn of this.conns.values()) conn.close?.();
    this.hostConn?.close?.();
    this.peer?.destroy?.();
  }
}
