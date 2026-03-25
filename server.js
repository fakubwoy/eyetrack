const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Try to load 'ws' - if not available, we gracefully skip WebSocket
let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch(e) {
  console.warn('ws module not found. Run: npm install ws');
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/patient') {
    serveFile(res, path.join(__dirname, 'patient.html'));
  } else if (url === '/doctor') {
    serveFile(res, path.join(__dirname, 'doctor.html'));
  } else {
    res.writeHead(302, { Location: '/' });
    res.end();
  }
});

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
}

// WebSocket relay: patient → doctor
const clients = { patient: new Set(), doctor: new Set() };

if (WebSocketServer) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const url = req.url;
    const role = url.includes('doctor') ? 'doctor' : 'patient';
    clients[role].add(ws);
    console.log(`[WS] ${role} connected. Patients: ${clients.patient.size}, Doctors: ${clients.doctor.size}`);

    ws.on('message', (raw) => {
      if (role !== 'patient') return; // only patients send data
      // Relay to all connected doctors
      for (const doc of clients.doctor) {
        if (doc.readyState === 1) { // OPEN
          doc.send(raw.toString());
        }
      }
    });

    ws.on('close', () => {
      clients[role].delete(ws);
      console.log(`[WS] ${role} disconnected.`);
    });

    ws.on('error', () => clients[role].delete(ws));
  });
}

server.listen(PORT, () => {
  console.log(`CenterGaze running on port ${PORT}`);
  console.log(`  Patient: http://localhost:${PORT}/`);
  console.log(`  Doctor:  http://localhost:${PORT}/doctor`);
});