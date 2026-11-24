# ⚔️ Puzzle Duel

A competitive two-player puzzle race in the browser. Both players get the **exact same puzzle**, generated from a shared seed, at the same moment. The fastest solver takes the round, and whoever wins most rounds takes the match.

It's a static site: no build step and no backend. Host it on GitHub Pages (or any static host) and share a room link.

## Ways to play
- **⚡ Quick Match (ranked)**: get paired with a random player near your skill level, with no account or sign-in. See below.
- **Online with a friend**: create a room and send the link, the 5-letter code, or show the QR code. See *How friend rooms connect* below.
- **🎉 Party room (3–8 players)**: one code for the whole group, with a live leaderboard of everyone's progress. Points go by finishing order: 5, 3 and 2 for the top three, 1 for anyone else who finishes, 0 for not finishing. A round ends when everyone is done, 20 seconds after half the players have finished, or at the time limit. The host's phone is the hub (`js/party.js`). Late arrivals play from the next match.
- **Daily Challenge**: everyone gets the same 3 puzzles each day. Share a challenge link and your friend races your ghost asynchronously. Tracks daily streaks.
- **Vs Bot**: Rookie, Pro, Master, or **Adaptive**. The Adaptive bot speeds up when you win and slows down when you lose, settling at your level.
- **Pass & Play**: two players on one device. Player 2 races player 1's recorded ghost.
- **Practice**: tap any puzzle on the home screen to race your personal-best ghost.

## Puzzles (13)
🔢 Number Hunt · 🧩 Slide · 💡 Lights Out · 🃏 Memory · 💣 Mine Dash (guaranteed no-guess) · 🔷 Mini Sudoku (unique solution) · 🔐 Code Breaker · ➗ Quick Math · 🖼️ Picross · 🚰 Pipes · 👀 Odd One Out · 🔤 Unscramble · 🧠 Flash Recall

Each puzzle has Easy, Normal and Hard levels.

## Competitive features
- Live opponent progress bars, latency indicator, emotes
- Best of 3, 5 or 7, with tiebreak rounds
- **Loser picks** mode: the round loser chooses the next puzzle
- **❄️ Freeze power-up**: reach 50% progress to earn one freeze per round, which locks your rival's board for 3 seconds (Space bar or button)
- Penalties for wrong taps and mine hits; time limit per round (when time runs out, most progress wins)
- Head-to-head records per rival, personal bests, match stats, shareable result summaries
- **QR codes** for room invites, daily challenge links and the game itself: scan with a phone camera to join
- Installable PWA with offline fallback (bot, practice, daily and pass-and-play work offline)

## How friend rooms connect
Rooms use two independent routes, so a game still connects when one of them is blocked:
1. **Direct (WebRTC via PeerJS).** This is the fastest route. The free PeerJS cloud server introduces the two phones, and STUN and TURN servers help them reach each other.
2. **Relay (MQTT over secure WebSockets).** This is the backup route. Messages pass through public MQTT brokers (`broker.emqx.io`, `broker.hivemq.com`) on topics named after the room code. It only needs a normal web connection, so it works behind strict mobile-carrier networks and firewalls, and when the PeerJS server is down. The relay client is in `js/relay.js`.

The host listens on both routes. The guest tries the direct route first and also tries the relay if the direct link hasn't opened within about 3.5 seconds. Whichever route connects first carries the game, and the ping indicator says "relay" when the backup is in use. Relay traffic goes through public servers, but the game sends nothing sensitive: names, progress and emotes.

If a connection drops **during a match**, both players see a 30-second "Reconnecting…" screen. The friend's phone rejoins automatically. Quick Match uses a private resume code derived from the match. The match then continues with scores intact, and the interrupted round restarts with a fresh puzzle. If the player doesn't come back in time, they're treated as having left (a forfeit in ranked). Choosing **Leave** is immediate.

**🩺 Connection check** (home screen footer, or "Trouble connecting?" in a room) tests the PeerJS server, whether this network allows direct links (STUN, TURN, strict NAT), and each relay broker. It says in plain words whether friend games will work. **Copy diagnostics** produces a report that includes a log of recent connection events (`js/diagnostics.js`).

Other safeguards:
- The host keeps the **same room code** when its connection drops, for example when switching apps to send the code, and reconnects as soon as it's back on screen.
- The share buttons stay disabled until the room is really open. The lobby shows which routes are open.
- A guest gets a clear error after 25 seconds instead of an endless spinner.
- The join box accepts a pasted invite link as well as a code. Opening an invite link in an already-open page joins the room.

## Quick Match: how it works without a backend
The free PeerJS broker only lets you register an ID and connect to an ID, so it doubles as a tiny waiting list. Every rating band of 200 points has a well-known waiting-room ID.
1. **Scan:** try to connect to the waiting rooms for nearby bands. If someone answers, play them.
2. **Wait:** otherwise, claim your own band's waiting room for a few seconds. If the claim fails because someone got there first, join them instead.
3. **Widen:** repeat, widening to neighbouring bands each cycle, until after about 30 seconds every skill level is included.

Once two players connect, the waiting player releases the ID while keeping the live connection open, so the room is free for the next pair. All of this is in `js/matchmaker.js`.

**Ratings** use standard Elo: everyone starts at 1000, with K=40 for a player's first 10 games and K=24 after that. Ratings are stored on each device, so there's no account, and a player can edit their own rating if they really want to. Ranked matches always use the same settings: best of 3, normal difficulty, all puzzles, freeze on. Leaving a ranked match counts as a loss, applied the next time that player opens the app. If your opponent leaves, you win by forfeit.

## Install as an app
Puzzle Duel is an installable web app (PWA). It goes on your home screen or desktop, opens full-screen, and its solo modes (Bot, Practice, Daily, Pass & Play) work offline.
- **Android (Chrome, Edge, Samsung Internet):** tap **Install** on the banner at the top of the home screen, or **📲 Install app** in the footer.
- **iPhone / iPad:** in Safari, tap **Share** → **Add to Home Screen** → **Add**. The in-app Install button shows these steps.
- **Desktop Chrome / Edge:** click the **Install app** button, or the install icon in the address bar.
- **Mac Safari:** **File → Add to Dock…**

The installed app adds home-screen shortcuts for **Quick Match**, **Daily Challenge** and **Vs Bot** (long-press the icon on Android or right-click on desktop), and the phone's Back button returns to the menu.

## Rooms
Two players per room. Any number of rooms can run at once.

## Development
- Plain HTML, CSS and JS. Dependencies are vendored: PeerJS (MIT, see `vendor/peerjs.LICENSE`) and qrcode-generator by Kazuhiko Arase (MIT, notice in `vendor/qrcode.js`).
- Files: `index.html`, `style.css`, `js/util.js` (seeded RNG, sound, helpers), `js/net.js` (networking), `js/matchmaker.js` (Quick Match and Elo), `js/puzzles.js` (all puzzles), `js/app.js` (lobby and match flow), `sw.js` (offline cache).
- **Tests:** `npm install`, then `npm test`. They run in a headless Chromium with Playwright, and GitHub Actions runs them on every push. They cover:
  - every puzzle: identical for both players at every difficulty, and solvable through its real controls
  - all game modes
  - online matches
  - Quick Match, including Elo and the forfeit rules
  - install, Back button and QR codes
  - friend-room connectivity when things fail, using a stand-in for the PeerJS cloud (`tests/mock-peer.js`) and real local MQTT brokers
- To test online play without internet, add `?net=bc` to the URL. This switches to a BroadcastChannel transport between two tabs of the same browser (open the invite link in a second tab).

## Hosting on GitHub Pages
Settings → Pages → Source: **Deploy from a branch** → `main` / **(root)** → Save. The game will then be at `https://<user>.github.io/puzzle-duel/`.
