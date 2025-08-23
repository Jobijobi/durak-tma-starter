// server/src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';

// Разрешённый фронт (можно переопределить переменной FRONT_ORIGIN)
const FRONT = process.env.FRONT_ORIGIN ?? 'https://durak-tma-starter-1.onrender.com';

const app = express();

// CORS только для HTTP (это норм; WS не требует CORS)
app.use(cors({
  origin: FRONT,
  methods: ['GET', 'POST'],
  credentials: true,
}));

// Простой healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

// HTTP-сервер + WebSocket на /ws
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// WS-логика
wss.on('connection', (ws) => {
  // heartbeat-флаги
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // привет при подключении
  ws.send(JSON.stringify({ type: 'hello', msg: 'connected' }));

  // входящие сообщения
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', msg: 'bad json' }));
      return;
    }

    // ответ на пинг
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      return;
    }

    // очень простой демо-броадкаст "join"
    if (msg.type === 'join') {
      ws.user = { id: msg.user?.id ?? null, name: msg.user?.name ?? null };
      const payload = JSON.stringify({ type: 'joined', user: ws.user });
      wss.clients.forEach((c) => {
        if (c.readyState === ws.OPEN) c.send(payload);
      });
      return;
    }
  });
});

// keep-alive: каждые 30с
const HEARTBEAT = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30_000);

wss.on('close', () => clearInterval(HEARTBEAT));

const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () => {
  console.log('Server running on', PORT);
  console.log('Health: GET /health');
  console.log('WS path: /ws');
  console.log('Allowed origin:', FRONT);
});
