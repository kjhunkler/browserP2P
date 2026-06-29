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
- **Joining:** tap **Play** and the app auto-joins — it tries to reach the one
  well-known host on your network and, if nobody is hosting yet, *becomes* the
  host. First device in is the host; everyone after joins automatically. No code,
  no QR. (A 4-char code / QR flow is kept under "advanced" for when you want more
  than one game at once.)

  > Caveat: the public PeerJS broker is global, not per-LAN, so the well-known
  > auto-join id is shared with anyone running the app at the same instant. Fine
  > for personal use. If you ever collide, set `AUTO_CHANNEL` in `js/app.js` to a
  > private string to scope it to your group.

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
