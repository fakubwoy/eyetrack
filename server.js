const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── tunables ──────────────────────────────────────────────────────────────────
const MAX_MESSAGE_BYTES = 200 * 1024;  // 200 KB hard cap per WS message
const MAX_DOCTORS       = 5;            // sanity limit — this is a 1-patient tool
const MAX_PATIENTS      = 1;
// ─────────────────────────────────────────────────────────────────────────────

let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch(e) {
  console.warn('ws module not found. Run: npm install ws');
}

// Read HTML files once at startup into memory
const STATIC = {};
function preload(name, file) {
  try {
    STATIC[name] = fs.readFileSync(path.join(__dirname, file));
    console.log(`[static] loaded ${file} (${(STATIC[name].length/1024).toFixed(1)} KB)`);
  } catch(e) {
    console.warn(`[static] could not preload ${file}:`, e.message);
  }
}
preload('patient', 'patient.html');
preload('doctor',  'doctor.html');

process.on('SIGHUP', () => {
  console.log('[reload] SIGHUP — reloading static files');
  preload('patient', 'patient.html');
  preload('doctor',  'doctor.html');
});

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  let buf;
  if (url === '/' || url === '/patient') buf = STATIC.patient;
  else if (url === '/doctor')            buf = STATIC.doctor;

  if (buf) {
    res.writeHead(200, {
      'Content-Type':  'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } else {
    res.writeHead(302, { Location: '/' });
    res.end();
  }
});

// ── WebSocket relay ───────────────────────────────────────────────────────────
const clients = { patient: new Set(), doctor: new Set() };

if (WebSocketServer) {
  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_MESSAGE_BYTES,
  });

  wss.on('connection', (ws, req) => {
    const url  = req.url || '';
    const role = url.includes('doctor') ? 'doctor' : 'patient';

    if (role === 'doctor'  && clients.doctor.size  >= MAX_DOCTORS)  { ws.close(1008, 'limit'); return; }
    if (role === 'patient' && clients.patient.size >= MAX_PATIENTS) { ws.close(1008, 'limit'); return; }

    clients[role].add(ws);
    console.log(`[WS] +${role}  patients=${clients.patient.size} doctors=${clients.doctor.size}`);

    ws.on('message', (raw, isBinary) => {
      if (role !== 'patient') return;

      // Crucial Fix: ensure we decode buffers into strings before sending text frames
      // Otherwise, the browser receives a Blob object and JSON.parse() fails.
      const payload = isBinary ? raw : raw.toString('utf8');

      for (const doc of clients.doctor) {
        if (doc.readyState !== 1) continue;
        if (doc.bufferedAmount > MAX_MESSAGE_BYTES * 3) continue;
        doc.send(payload, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      clients[role].delete(ws);
      console.log(`[WS] -${role}  patients=${clients.patient.size} doctors=${clients.doctor.size}`);
    });

    ws.on('error', (err) => {
      console.error(`[WS] ${role} error:`, err.message);
      clients[role].delete(ws);
    });
  });
}

server.listen(PORT, () => {
  console.log(`CenterGaze on :${PORT}`);
  console.log(`  Patient → http://localhost:${PORT}/`);
  console.log(`  Doctor  → http://localhost:${PORT}/doctor`);

  setInterval(() => {
    const mem = process.memoryUsage();
    console.log(
      `[health] rss=${(mem.rss/1e6).toFixed(1)}MB` +
      ` heap=${(mem.heapUsed/1e6).toFixed(1)}/${(mem.heapTotal/1e6).toFixed(1)}MB` +
      ` patients=${clients.patient.size} doctors=${clients.doctor.size}`
    );
  }, 60_000);
});