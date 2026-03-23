const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Serve the eye tracker HTML for any route
  const file = path.join(__dirname, 'eye_tracker_v2.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`CenterGaze running on port ${PORT}`);
});