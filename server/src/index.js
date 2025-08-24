// server/src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

// ───────────────────────────────────────────────────────────────────────────────
// ENV
// FRONT — домен фронта (открывается через кнопку в боте)
const FRONT = process.env.FRONT_ORIGIN ?? 'https://durak-tma-starter-1.onrender.com';
// BOT_TOKEN — токен твоего телеграм-бота (для проверки initData)
const BOT_TOKEN = process.env.BOT_TOKEN || '';
// ALLOW_DEV=1 — временно разрешает логин «без Telegram», чтобы тестировать лобби
const ALLOW_DEV = process.env.ALLOW_DEV === '1';

// ───────────────────────────────────────────────────────────────────────────────
// HTTP (health + CORS)
const app = express();
app.use(
  cors({
    origin: FRONT,
    methods: ['GET', 'POST'],
    credentials: true,
  }),
);
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// ───────────────────────────────────────────────────────────────────────────────
// WS сервер
const wss = new WebSocketServer({ server, path: '/ws' });

// Проверка подписи Telegram WebApp initData
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);

  // собираем словарь без hash
  const map = {};
  for (const [k, v] of params.entries()) map[k] = v;

  const hash = map.hash;
  delete map.hash;

  const dataCheckString = Object.keys(map)
    .sort()
    .map((k) => `${k}=${map[k]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (hmac !== hash) return null;

  try {
    return JSON.parse(map.user); // { id, first_name, ... }
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Простые комнаты (in-memory)
const rooms = new Map(); // roomId -> { id, ownerId, players:Set<number>, createdAt, game? }
const roomSnapshot = (r) => ({
  id: r.id,
  ownerId: r.ownerId,
  players: Array.from(r.players),
  createdAt: r.createdAt,
});

function broadcastToRoom(roomId, payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.roomId === roomId) {
      client.send(data);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Карточная «логика» (минимум для демо)
function newDeck() {
  const suits = ['C', 'D', 'H', 'S']; // трефы, бубны, червы, пики
  const ranks = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push(r + s); // "6C", "10H"…
  return deck;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function dealSixEach(room) {
  const deck = shuffle(newDeck());
  const trump = deck[deck.length - 1];
  const hands = new Map();
  for (const uid of room.players) hands.set(uid, []);
  for (let r = 0; r < 6; r++) {
    for (const uid of room.players) hands.get(uid).push(deck.pop());
  }
  room.game = { deck, trump, hands };
}
function sendStateToRoom(room) {
  if (!room.game) return;
  const counts = {};
  for (const uid of room.players) counts[uid] = room.game.hands.get(uid)?.length ?? 0;

  for (const client of wss.clients) {
    if (client.readyState !== 1 || client.roomId !== room.id) continue;
    const uid = client.user.id;
    const myHand = room.game.hands.get(uid) ?? [];
    client.send(
      JSON.stringify({
        type: 'state',
        roomId: room.id,
        hand: myHand, // только свои карты
        counts, // сколько карт у всех
        trump: room.game.trump,
      }),
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Логика WS
wss.on('connection', (ws) => {
  // heartbeat
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // базовое приветствие (не даёт прав)
  ws.send(JSON.stringify({ type: 'hello', msg: 'connected' }));

  let authed = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', msg: 'bad json' }));
      return;
    }

    // разрешаем ping до auth
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      return;
    }

    // 1) Авторизация первым сообщением
    if (!authed) {
      if (msg.type !== 'auth') {
        console.log('[WS] got non-auth first message → reject');
        ws.send(JSON.stringify({ type: 'error', msg: 'auth required' }));
        return;
      }

      const user = verifyInitData(msg.initData);
      console.log('[WS] auth:', {
        initDataPresent: Boolean(msg.initData && String(msg.initData).length > 0),
        userId: user?.id ?? null,
        allowDev: ALLOW_DEV,
      });

      if (!user?.id) {
        if (ALLOW_DEV) {
          // DEV-режим: пускаем фейкового пользователя
          ws.user = { id: Date.now(), name: 'Dev' };
          authed = true;
          ws.send(JSON.stringify({ type: 'auth_ok', user: ws.user }));
          return;
        }
        ws.send(JSON.stringify({ type: 'error', msg: 'bad initData' }));
        console.log('[WS] close 4001 (bad auth)');
        ws.close(4001, 'bad auth');
        return;
      }

      ws.user = { id: user.id, name: user.first_name || 'Игрок' };
      authed = true;
      ws.send(JSON.stringify({ type: 'auth_ok', user: ws.user }));
      return;
    }

    // 2) Сообщения ЛОББИ (для авторизованных)
    if (msg.type === 'list_rooms') {
      const list = Array.from(rooms.values()).map(roomSnapshot);
      ws.send(JSON.stringify({ type: 'rooms', list }));
      return;
    }

    if (msg.type === 'create_room') {
      const id = crypto.randomUUID().slice(0, 6);
      const room = { id, ownerId: ws.user.id, players: new Set([ws.user.id]), createdAt: Date.now() };
      rooms.set(id, room);
      ws.roomId = id;
      ws.send(JSON.stringify({ type: 'room_created', room: roomSnapshot(room) }));
      broadcastToRoom(id, { type: 'room_update', room: roomSnapshot(room) });
      return;
    }

    if (msg.type === 'join_room' && typeof msg.roomId === 'string') {
      const room = rooms.get(msg.roomId);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', msg: 'room not found' }));
        return;
      }
      room.players.add(ws.user.id);
      ws.roomId = room.id;
      ws.send(JSON.stringify({ type: 'joined', room: roomSnapshot(room) }));
      broadcastToRoom(room.id, { type: 'room_update', room: roomSnapshot(room) });
      if (room.game) sendStateToRoom(room); // если игра уже шла — пришлём состояние
      return;
    }

    if (msg.type === 'leave_room') {
      if (!ws.roomId) {
        ws.send(JSON.stringify({ type: 'left' }));
        return;
      }
      const room = rooms.get(ws.roomId);
      if (room) {
        room.players.delete(ws.user.id);
        broadcastToRoom(room.id, { type: 'room_update', room: roomSnapshot(room) });
        if (room.players.size === 0) rooms.delete(room.id);
      }
      ws.roomId = null;
      ws.send(JSON.stringify({ type: 'left' }));
      return;
    }

    // ── старт игры ─────────────────────────────────────────────────────────────
    if (msg.type === 'start_game') {
      const room = rooms.get(ws.roomId);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', msg: 'no room' }));
        return;
      }
      if (room.ownerId !== ws.user.id) {
        ws.send(JSON.stringify({ type: 'error', msg: 'only owner can start' }));
        return;
      }
      dealSixEach(room);
      sendStateToRoom(room);
      return;
    }
  });

  ws.on('close', (code, reason) => {
    console.log('[WS] closed', code, reason?.toString() || '');
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        room.players.delete(ws.user?.id);
        broadcastToRoom(room.id, { type: 'room_update', room: roomSnapshot(room) });
        if (room.players.size === 0) rooms.delete(room.id);
      }
    }
  });
});

// keep-alive
const HEARTBEAT = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  });
}, 30_000);
wss.on('close', () => clearInterval(HEARTBEAT));

// ───────────────────────────────────────────────────────────────────────────────
// START
const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () => {
  console.log('Server running on', PORT);
  console.log('Allowed origin:', FRONT);
  console.log('Has BOT_TOKEN for auth:', !!BOT_TOKEN);
  console.log('ALLOW_DEV:', ALLOW_DEV);
});
