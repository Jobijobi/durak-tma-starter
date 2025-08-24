// server/src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

// ─── ENV ───────────────────────────────────────────────────────────────────────
const FRONT = process.env.FRONT_ORIGIN ?? 'https://durak-tma-starter-1.onrender.com';
const BOT_TOKEN = process.env.BOT_TOKEN || ''; // можно оставить пустым: будет гостевой режим

// ─── HTTP (health + CORS) ─────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: FRONT, methods: ['GET', 'POST'], credentials: true }));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// ─── WS сервер ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

// Проверка подписи Telegram WebApp initData (если BOT_TOKEN задан)
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);

  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  const hash = obj.hash;
  delete obj.hash;

  const dataCheckString = Object.keys(obj)
    .sort()
    .map((k) => `${k}=${obj[k]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (hmac !== hash) return null;

  try {
    return JSON.parse(obj.user); // { id, first_name, ... }
  } catch {
    return null;
  }
}

// ─── Простые комнаты (in-memory) ──────────────────────────────────────────────
const rooms = new Map(); // roomId -> { id, ownerId, players:Set<string>, createdAt, game? }
const roomSnapshot = (r) => ({
  id: r.id,
  ownerId: r.ownerId,
  players: Array.from(r.players),
  createdAt: r.createdAt,
});

function broadcastToRoom(roomId, payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.roomId === roomId) client.send(data);
  }
}

// ─── Мини-«карточная» логика ───────────────────────────────────────────────────
function newDeck() {
  const suits = ['C', 'D', 'H', 'S']; // ♣ ♦ ♥ ♠
  const ranks = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push(r + s);
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
        hand: myHand,
        counts,
        trump: room.game.trump,
        table: room.game.table || [], // ← НОВОЕ: отправляем «стол»
      }),
    );
  }
}

// ─── WS: соединение ────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('[WS] +connection from', req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress);

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('error', (e) => console.error('[WS] socket error:', e?.message || e));

  try { ws.send(JSON.stringify({ type: 'hello', msg: 'connected' })); } catch {}

  let authed = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { try { ws.send(JSON.stringify({ type: 'error', msg: 'bad json' })); } catch {}; return; }

    // пинг до авторизации разрешён
    if (msg.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch {}; return; }

    // 1) Авторизация
    if (!authed) {
      if (msg.type !== 'auth') { try { ws.send(JSON.stringify({ type: 'error', msg: 'auth required' })); } catch {}; return; }

      let tgUser = null;
      try { tgUser = verifyInitData(msg.initData); } catch {}
      if (tgUser?.id) {
        ws.user = { id: String(tgUser.id), name: tgUser.first_name || 'Игрок' };
        console.log('[WS] tg auth ->', ws.user.id);
      } else {
        // ГОСТЕВОЙ доступ (важно: не рвём сокет — иначе будет цикл 1005)
        const gid = 'guest-' + crypto.randomBytes(3).toString('hex');
        ws.user = { id: gid, name: 'Гость' };
        console.log('[WS] guest auth ->', gid);
      }
      authed = true;
      try { ws.send(JSON.stringify({ type: 'auth_ok', user: ws.user })); } catch {}
      return;
    }

    // 2) Лобби
    if (msg.type === 'list_rooms') {
      try { ws.send(JSON.stringify({ type: 'rooms', list: Array.from(rooms.values()).map(roomSnapshot) })); } catch {}
      return;
    }

    if (msg.type === 'create_room') {
      const id = crypto.randomUUID().slice(0, 6);
      const room = { id, ownerId: ws.user.id, players: new Set([ws.user.id]), createdAt: Date.now() };
      rooms.set(id, room);
      ws.roomId = id;
      console.log('[WS] room created', id, 'owner', ws.user.id);
      try { ws.send(JSON.stringify({ type: 'room_created', room: roomSnapshot(room) })); } catch {}
      broadcastToRoom(id, { type: 'room_update', room: roomSnapshot(room) });
      return;
    }

    if (msg.type === 'join_room' && typeof msg.roomId === 'string') {
      const room = rooms.get(msg.roomId);
      if (!room) { try { ws.send(JSON.stringify({ type: 'error', msg: 'room not found' })); } catch {}; return; }
      room.players.add(ws.user.id);
      ws.roomId = room.id;
      console.log('[WS] joined', room.id, 'user', ws.user.id);
      try { ws.send(JSON.stringify({ type: 'joined', room: roomSnapshot(room) })); } catch {}
      broadcastToRoom(room.id, { type: 'room_update', room: roomSnapshot(room) });
      if (room.game) sendStateToRoom(room);
      return;
    }

    if (msg.type === 'leave_room') {
      if (!ws.roomId) { try { ws.send(JSON.stringify({ type: 'left' })); } catch {}; return; }
      const room = rooms.get(ws.roomId);
      if (room) {
        room.players.delete(ws.user.id);
        broadcastToRoom(room.id, { type: 'room_update', room: roomSnapshot(room) });
        if (room.players.size === 0) rooms.delete(room.id);
      }
      ws.roomId = null;
      try { ws.send(JSON.stringify({ type: 'left' })); } catch {}
      return;
    }

    // 3) Старт игры
    if (msg.type === 'start_game') {
      const room = rooms.get(ws.roomId);
      if (!room) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no room' })); } catch {}; return; }
      if (room.ownerId !== ws.user.id) { try { ws.send(JSON.stringify({ type: 'error', msg: 'only owner can start' })); } catch {}; return; }

      dealSixEach(room);
      room.game.table = []; // ← НОВОЕ: «стол» для открытых карт
      console.log('[WS] start_game in', room.id, 'trump', room.game?.trump);
      sendStateToRoom(room);
      return;
    }

    // 4) Игровые демо-команды
    if (msg.type === 'play_any') {
      const room = rooms.get(ws.roomId);
      if (!room?.game) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); } catch {}; return; }
      const hand = room.game.hands.get(ws.user.id) || [];
      if (hand.length === 0) { try { ws.send(JSON.stringify({ type: 'error', msg: 'empty hand' })); } catch {}; return; }
      const card = hand.shift();
      room.game.table = room.game.table || [];
      room.game.table.push({ by: ws.user.id, card });
      sendStateToRoom(room);
      return;
    }

    if (msg.type === 'clear_table') {
      const room = rooms.get(ws.roomId);
      if (!room?.game) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); } catch {}; return; }
      if (room.ownerId !== ws.user.id) { try { ws.send(JSON.stringify({ type: 'error', msg: 'owner only' })); } catch {}; return; }
      room.game.table = [];
      sendStateToRoom(room);
      return;
    }
  });

  ws.on('close', (code, reason) => {
    console.log('[WS] -close', code, reason?.toString() || '');
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
    try { ws.ping(); } catch {}
  });
}, 30_000);
wss.on('close', () => clearInterval(HEARTBEAT));

// ─── START ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () => {
  console.log('Server running on', PORT);
  console.log('Allowed origin:', FRONT);
  console.log('Has BOT_TOKEN for auth:', !!BOT_TOKEN);
});
