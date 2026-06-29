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
 *   message      ({ from, data })    a message arrived
 *   error        (err)               something went wrong
 */

const PREFIX = "bp2p-"; // namespaces our room codes on the shared public broker
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L ambiguity
const CODE_LEN = 4;

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
    this.hostConn = null; // client: connection to the host
    this._handlers = new Map();
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

  /* ----- HOST ----- */
  // Registers under a fresh room code; retries if the code is already taken.
  host() {
    this.isHost = true;
    const tryCode = (attemptsLeft) => {
      const code = makeCode();
      const peer = new Peer(PREFIX + code, { debug: 1 });
      this.peer = peer;

      peer.on("open", () => {
        this.code = code;
        this._emit("ready");
      });

      peer.on("connection", (conn) => {
        conn.on("open", () => {
          this.conns.set(conn.peer, conn);
          this._emit("peer-join", conn.peer);
        });
        conn.on("data", (data) => this._emit("message", { from: conn.peer, data }));
        conn.on("close", () => {
          this.conns.delete(conn.peer);
          this._emit("peer-leave", conn.peer);
        });
      });

      peer.on("error", (err) => {
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

  /* ----- CLIENT ----- */
  join(code) {
    this.isHost = false;
    this.code = code;
    const peer = new Peer({ debug: 1 }); // random id assigned by the broker
    this.peer = peer;

    peer.on("open", () => {
      const conn = peer.connect(PREFIX + code, { reliable: true });
      this.hostConn = conn;
      conn.on("open", () => this._emit("connected"));
      conn.on("data", (data) => this._emit("message", { from: "host", data }));
      conn.on("close", () => this._emit("host-closed"));
    });

    peer.on("error", (err) => this._emit("error", err));
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

  peerCount() {
    return this.isHost ? this.conns.size : this.hostConn ? 1 : 0;
  }

  destroy() {
    if (this.peer) this.peer.destroy();
    this.peer = null;
    this.conns.clear();
    this.hostConn = null;
  }
}
