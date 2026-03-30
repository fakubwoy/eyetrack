const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── tunables ──────────────────────────────────────────────────────────────────
const MAX_MESSAGE_BYTES = 200 * 1024;  // 200 KB hard cap per WS message
                                        // a 640×480 JPEG @ q0.82 is ~25-40 KB,
                                        // so this gives plenty of headroom while
                                        // blocking runaway payloads
const MAX_DOCTORS       = 5;            // sanity limit — this is a 1-patient tool
const MAX_PATIENTS      = 1;
// ─────────────────────────────────────────────────────────────────────────────

let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch(e) {
  console.warn('ws module not found. Run: npm install ws');
}

// Read HTML files once at startup into memory — avoids a disk read on every page load
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

// Re-read on SIGHUP so you can hot-reload without a full restart (Railway: not needed, but handy)
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
      'Cache-Control': 'no-store',     // always fresh during development
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
    maxPayload: MAX_MESSAGE_BYTES,   // ws library enforces this before emitting 'message'
                                      // — oversized frames are dropped & connection closed
                                      // rather than buffered into memory
  });

  wss.on('connection', (ws, req) => {
    const url  = req.url || '';
    const role = url.includes('doctor') ? 'doctor' : 'patient';

    // Enforce connection limits
    if (role === 'doctor'  && clients.doctor.size  >= MAX_DOCTORS)  { ws.close(1008, 'limit'); return; }
    if (role === 'patient' && clients.patient.size >= MAX_PATIENTS) { ws.close(1008, 'limit'); return; }

    clients[role].add(ws);
    console.log(`[WS] +${role}  patients=${clients.patient.size} doctors=${clients.doctor.size}`);

    ws.on('message', (raw, isBinary) => {
      if (role !== 'patient') return;  // only patients push data

      // ── Relay to every connected doctor ──────────────────────────────────
      // Pass the raw Buffer directly — no .toString() conversion.
      // 'ws' accepts Buffer for text frames and will forward as-is, saving
      // one full string allocation + copy per frame (≈25-40 KB × 15fps = real savings).
      for (const doc of clients.doctor) {
        if (doc.readyState !== 1 /* OPEN */) continue;

        // Backpressure: skip this doctor if their send buffer is already full.
        // This prevents the Node process from accumulating unbounded in-memory
        // queues when the doctor's connection is slow or the tab is backgrounded.
        if (doc.bufferedAmount > MAX_MESSAGE_BYTES * 3) continue;

        doc.send(raw, { binary: isBinary });
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

  // ── Periodic resource report (every 60s) ─────────────────────────────────
  // Visible in Railway's log stream so you can spot memory leaks at a glance
  setInterval(() => {
    const mem = process.memoryUsage();
    console.log(
      `[health] rss=${(mem.rss/1e6).toFixed(1)}MB` +
      ` heap=${(mem.heapUsed/1e6).toFixed(1)}/${(mem.heapTotal/1e6).toFixed(1)}MB` +
      ` patients=${clients.patient.size} doctors=${clients.doctor.size}`
    );
  }, 60_000);
});