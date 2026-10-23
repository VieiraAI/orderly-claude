import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * Just enough WebSocket to speak the Chrome DevTools Protocol.
 *
 * Chrome's `--screenshot` flag waits for a load event, so it never fires on a
 * page holding a long-lived connection (SSE, or a Vite HMR socket). Driving the
 * browser over CDP lets us decide ourselves when the page is ready.
 */
class WS {
  constructor(socket) {
    this.socket = socket;
    this.handlers = new Set();
    this.buf = Buffer.alloc(0);
    this.frag = [];
    socket.on('data', (d) => this.onData(d));
  }

  static connect(wsUrl, timeout = 8000) {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      const socket = net.connect(Number(u.port), u.hostname, () => {
        socket.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('websocket timeout')); }, timeout);
      socket.once('error', (e) => { clearTimeout(timer); reject(e); });

      let head = Buffer.alloc(0);
      const onHead = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) return;
        if (!/HTTP\/1\.1 101/.test(head.slice(0, end).toString())) {
          clearTimeout(timer); socket.destroy(); return reject(new Error('websocket upgrade refused'));
        }
        socket.removeListener('data', onHead);
        clearTimeout(timer);
        const ws = new WS(socket);
        const rest = head.slice(end + 4);
        if (rest.length) ws.onData(rest);
        resolve(ws);
      };
      socket.on('data', onHead);
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;

      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);

      if (opcode === 0x8) { this.socket.end(); return; }
      if (opcode === 0x9) { this.sendFrame(payload, 0xa); continue; }
      if (opcode === 0xa) continue;

      this.frag.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(this.frag).toString('utf8');
      this.frag = [];
      let msg; try { msg = JSON.parse(text); } catch { continue; }
      for (const h of this.handlers) h(msg);
    }
  }

  sendFrame(payload, opcode = 0x1) {
    const len = payload.length;
    const mask = crypto.randomBytes(4);
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(obj) { this.sendFrame(Buffer.from(JSON.stringify(obj), 'utf8')); }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  close() { try { this.socket.end(); } catch {} }
}

export class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Set();
    ws.on((msg) => {
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }

  static async attach(wsUrl) { return new CDP(await WS.connect(wsUrl)); }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); }
      }, 20000);
    });
  }

  once(method, sessionId, timeout = 6000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.listeners.delete(fn); resolve(null); }, timeout);
      const fn = (msg) => {
        if (msg.method !== method) return;
        if (sessionId && msg.sessionId !== sessionId) return;
        clearTimeout(timer); this.listeners.delete(fn); resolve(msg.params);
      };
      this.listeners.add(fn);
    });
  }

  close() { this.ws.close(); }
}

export function httpJSON(url, timeout = 700) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
  });
}
