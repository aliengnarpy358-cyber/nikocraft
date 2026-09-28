// Nikocraft LAN server — serves the game over HTTP and hosts a real shared
// multiplayer session over WebSocket on the same port.
//
// World model: terrain is procedurally generated from a seed, so it never
// needs to be transmitted. This server is the single source of truth for
// the *seed*, the sparse *block edits* on top of that terrain, and *chest
// contents* — everyone who joins gets that state and then receives live
// updates as players place/break blocks, move around, and open chests.
// It's saved to lan-world-save.json periodically so restarting the server
// doesn't lose the shared world.
//
// Usage: double-click "Start LAN World.bat", or run `node lan-server.js` directly.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { attachWebSocketServer } = require('./ws-lite.js');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const ROOT = __dirname;
const DEFAULT_FILE = 'nikocraft.html';
const SAVE_FILE = path.join(ROOT, 'lan-world-save.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

/* ---------------- shared world state ---------------- */
function loadWorld() {
  try {
    const d = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    if (d && d.seed) return { seed: d.seed, edits: d.edits || {}, chests: d.chests || {}, gameTime: d.gameTime ?? 0.03 };
  } catch (e) {}
  return { seed: String(Math.floor(Math.random() * 1e9)), edits: {}, chests: {}, gameTime: 0.03 };
}
const world = loadWorld();
let saveDirty = false;
function persistWorld() {
  if (!saveDirty) return;
  saveDirty = false;
  fs.writeFile(SAVE_FILE, JSON.stringify(world), () => {});
}
setInterval(persistWorld, 5000);

/* ---------------- http static file server ---------------- */
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/' + DEFAULT_FILE;
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- multiplayer session ---------------- */
let nextId = 1;
const players = new Map(); // id -> { conn, name, skin, x,y,z,yaw,pitch,dim }

function send(conn, obj) { conn.send(JSON.stringify(obj)); }
function broadcast(obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const [id, p] of players) if (id !== exceptId) p.conn.send(msg);
}
function playerList() {
  return [...players.entries()].map(([id, p]) => ({ id, name: p.name, skin: p.skin, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, dim: p.dim }));
}

attachWebSocketServer(server, (conn) => {
  let id = null;

  conn.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.t === 'join') {
      id = nextId++;
      const name = String(msg.name || ('Player' + id)).slice(0, 20);
      players.set(id, { conn, name, skin: msg.skin || null, x: 0, y: 40, z: 0, yaw: 0, pitch: 0, dim: 0 });
      send(conn, { t: 'init', id, seed: world.seed, edits: world.edits, chests: world.chests, gameTime: world.gameTime, players: playerList() });
      broadcast({ t: 'playerJoin', id, name, skin: msg.skin || null, x: 0, y: 40, z: 0, yaw: 0, pitch: 0, dim: 0 }, id);
      console.log('  + ' + name + ' joined (' + players.size + ' online)');
      return;
    }
    if (id === null) return; // must join first
    const me = players.get(id); if (!me) return;

    if (msg.t === 'move') {
      me.x = msg.x; me.y = msg.y; me.z = msg.z; me.yaw = msg.yaw; me.pitch = msg.pitch; me.dim = msg.dim;
      broadcast({ t: 'playerMove', id, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, pitch: msg.pitch, dim: msg.dim, anim: msg.anim }, id);
    } else if (msg.t === 'block') {
      const k = msg.dim + ':' + msg.cx + ',' + msg.cz;
      if (!world.edits[k]) world.edits[k] = {};
      world.edits[k][msg.i] = msg.id;
      saveDirty = true;
      broadcast({ t: 'block', dim: msg.dim, cx: msg.cx, cz: msg.cz, i: msg.i, id: msg.id, x: msg.x, y: msg.y, z: msg.z }, id);
    } else if (msg.t === 'chest') {
      if (msg.slots) world.chests[msg.key] = msg.slots; else delete world.chests[msg.key];
      saveDirty = true;
      broadcast({ t: 'chest', key: msg.key, slots: msg.slots }, id);
    } else if (msg.t === 'time') {
      world.gameTime = msg.gameTime;
      broadcast({ t: 'time', gameTime: msg.gameTime }, id);
    } else if (msg.t === 'chat') {
      broadcast({ t: 'chat', name: me.name, msg: String(msg.msg || '').slice(0, 200) }, null);
    } else if (msg.t === 'skin') {
      me.skin = msg.skin;
      broadcast({ t: 'playerSkin', id, skin: msg.skin }, id);
    }
  });

  conn.on('close', () => {
    if (id === null) return;
    const me = players.get(id);
    players.delete(id);
    persistWorld();
    if (me) { broadcast({ t: 'playerLeave', id }, null); console.log('  - ' + me.name + ' left (' + players.size + ' online)'); }
  });
});

server.listen(PORT, () => {
  const addrs = lanAddresses();
  console.log('');
  console.log('  Nikocraft is now hosted on your network, with shared multiplayer.');
  console.log('');
  console.log('  On this PC:      http://localhost:' + PORT + '/');
  if (addrs.length) {
    console.log('  On other devices on the same Wi-Fi/network:');
    for (const a of addrs) console.log('                     http://' + a + ':' + PORT + '/');
  } else {
    console.log('  No LAN network address was found (are you connected to a network?).');
  }
  console.log('');
  console.log('  Anyone who opens that link and chooses "Play together" joins the same');
  console.log('  world (seed ' + world.seed + ') and can see each other. Press Ctrl+C to stop hosting.');
  console.log('');
});
