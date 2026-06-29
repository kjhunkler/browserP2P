# browserP2P

A zero-install template for **seamless local multiplayer in the browser**. Everyone
plays on their phone, the page is served as static files (e.g. GitHub Pages over
HTTPS), and the game runs **peer-to-peer over your local Wi-Fi** — no game server
to run or pay for.

## How it works

A browser tab can't be a TCP/WebSocket server, so instead of a server we use
**WebRTC**: browsers connect *directly* to each other.

- **Topology:** one phone is the **host peer** (owns the authoritative game
  state). Every other phone is a **client peer** that connects straight to it.
  After that, game data flows phone-to-phone over the LAN.
- **Signaling:** WebRTC needs a one-time handshake to introduce peers. We use
  [PeerJS](https://peerjs.com/) and its free public broker for that. **Only the
  handshake touches the internet** — the gameplay is local. (HTTPS is fine here;
  the old `ws://` mixed-content problem doesn't apply to WebRTC.)
- **Joining:** the host shows a 4-character code and a QR. Scanning the QR opens
  the page with `?join=CODE` pre-filled.

```
  [ host phone ]              broker (internet, handshake only)
    | owns state  <----------- introduces peers ----------->
    |  ^  ^
    |  |  |   direct WebRTC over local Wi-Fi
  [c1][c2][c3]  client phones send input, render host's state
```

## Files

| File | Role |
|------|------|
| `index.html`     | UI: menu / lobby / play screens |
| `css/style.css`  | mobile-first styling |
| `js/peer-net.js` | **reusable** star-topology layer over PeerJS (game-agnostic) |
| `js/app.js`      | the demo game (drag-a-dot) built on top of it |

`peer-net.js` is the part you keep. To build a real game, replace the demo logic
in `app.js`: clients send inputs to the host, the host runs an authoritative loop
and broadcasts state, everyone renders it.

## Run locally

It's just static files. From the repo root:

```bash
python -m http.server 8000
# then open http://localhost:8000 on two browser tabs/devices
```

Host in one tab, join with the code in another. (Two tabs on one machine still
connect through WebRTC, so it's a faithful test.)

## Deploy

Push to GitHub and enable **Pages** on the `main` branch — that's the whole
deploy. The signaling broker is PeerJS's hosted one, so there's nothing else to
stand up.

## Limits to know

- **Same network for low latency.** Peers on different networks may need a TURN
  relay (PeerJS's free broker does signaling, not relaying). For same-Wi-Fi play
  you won't need it.
- **Public broker.** Fine for hobby use; for production, run your own PeerServer.
- **Reliable channel.** The demo uses PeerJS's default reliable/ordered channel —
  great for turn-based and moderate real-time. For twitchy action you'd switch to
  an unreliable channel.
