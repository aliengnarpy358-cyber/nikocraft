// A minimal, dependency-free WebSocket server (RFC 6455), just enough to run
// Nikocraft's multiplayer sync: text-frame JSON messages, no compression,
// no fragmentation support on receive beyond simple continuation reassembly.
// Kept dependency-free so hosting a LAN world never needs `npm install`.

const crypto = require('crypto');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKeyFor(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, data]);
}

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => { this.alive = false; this.emit('close'); });
    socket.on('error', () => { this.alive = false; });
  }
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = this.buffer.readUInt32BE(6); // payloads here are always small; ignore high 32 bits
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return; // wait for more data
      let payload = this.buffer.slice(offset, offset + len);
      if (masked) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }
      this.buffer = this.buffer.slice(offset + len);
      if (opcode === 0x8) { this.close(); return; } // close frame
      if (opcode === 0x9) { this._sendRaw(0xA, payload); continue; } // ping -> pong
      if (opcode === 0x1) { this.emit('message', payload.toString('utf8')); }
      // binary/continuation frames are not used by this app; ignore.
    }
  }
  _sendRaw(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) {}
  }
  send(str) {
    if (!this.alive) return;
    try { this.socket.write(encodeFrame(str)); } catch (e) {}
  }
  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this._sendRaw(0x8, Buffer.alloc(0)); this.socket.end(); } catch (e) {}
    this.emit('close');
  }
}

// Attaches WebSocket upgrade handling to an existing http.Server.
// onConnection(conn, req) is called for each new WebSocket client.
function attachWebSocketServer(httpServer, onConnection) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade !== 'websocket' || !key) { socket.destroy(); return; }
    const accept = acceptKeyFor(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    const conn = new WSConnection(socket);
    onConnection(conn, req);
  });
}

module.exports = { attachWebSocketServer };
