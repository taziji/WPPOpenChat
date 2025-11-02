import fs from 'fs';
import https from 'https';
import express from 'express';
import { WebSocketServer } from 'ws';

const HTTPS_HOST = '127.0.0.1';
const HTTPS_PORT = 7071;
const CERT_PATH = './certs/localhost.pem';
const KEY_PATH = './certs/localhost-key.pem';

const app = express();
app.use(express.json({ limit: '1mb' }));

const clients = new Set();

app.post('/send', (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ ok: false, error: 'Body must be JSON object' });
    return;
  }

  const payload = JSON.stringify(req.body);
  let delivered = 0;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
      delivered += 1;
    }
  }

  res.json({ ok: true, delivered });
});

const server = https.createServer(
  {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH)
  },
  app
);

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  console.log('[WSS] client connected from', req.socket.remoteAddress);
  clients.add(ws);

  ws.on('message', (data) => {
    console.log('[WSS] recv:', data.toString());
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('[WSS] client disconnected');
  });
});

server.listen(HTTPS_PORT, HTTPS_HOST, () => {
  console.log(`HTTPS+WSS server listening on https://${HTTPS_HOST}:${HTTPS_PORT}`);
});
