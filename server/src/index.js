// server/src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

// ─── ENV ───────────────────────────────────────────────────────────────────────
const FRONT = process.env.FRONT_ORIGIN ?? 'https://durak-tma-starter-1.onrender.com';
const BOT_TOKEN = process.env.BOT_TOKEN || ''; // можно пустым — будет "гость"

// ─── HTTP (health + CORS) ─────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: FRONT, methods: ['GET', 'POST'], credentials: true }));

// Health для Render по корню и отдельный /health
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// ─── WS сервер ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── Глобальные ловушки/логирование ошибок (не даём процессу упасть) ──────────
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
server.on('error', (e) => console.error('[server error]', e));
wss.on('error', (e) => console.error('[ws error]', e));

// ─── Telegram WebApp подпись (если BOT_TOKEN задан) ───────────────────────────
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

  try { return JSON.parse(obj.user); } catch { return null; }
}

// ─── Утилиты для карт ─────────────────────────────────────────────────────────
const RANKS = ['6','7','8','9','10','J','Q','K','A'];
const rankOf = (c) => String(c).replace(/[CDHS]$/, '');
const suitOf = (c) => String(c).slice(-1);
const rankValue = (r) => RANKS.indexOf(r);

// бьёт ли карта `card` карту `target` с козырной мастью `trumpSuit`
function beats(card, target, trumpSuit) {
  const s1 = suitOf(card), s2 = suitOf(target);
  const r1 = rankValue(rankOf(card)), r2 = rankValue(rankOf(target));
  if (s1 === s2) return r1 > r2;
  if (s1 === trumpSuit && s2 !== trumpSuit) return true;
  return false;
}

// разрешена ли атака картой с таким рангом (если на столе уже есть карты)
function canAttackCard(room, card) {
  const game = room.game;
  if (!game || !game.table || game.table.length === 0) return true;
  const r = rankOf(card);
  for (const p of game.table) {
    if (p?.a && rankOf(p.a) === r) return true;
    if (p?.d && rankOf(p.d) === r) return true;
  }
  return false;
}

// ─── Простые комнаты (in-memory) ──────────────────────────────────────────────
const rooms = new Map(); // roomId -> { id, ownerId, players:Set<string>, createdAt, game? }
const roomSnapshot = (r) => ({
  id: r.id,
  ownerId: r.ownerId,
  players: Array.from(r.players),
  createdAt: r.createdAt,
});

// ─── Колода/раздача ───────────────────────────────────────────────────────────
function newDeck() {
  const suits = ['C','D','H','S']; // ♣ ♦ ♥ ♠
  const ranks = ['6','7','8','9','10','J','Q','K','A'];
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
function nextId(order, id) {
  const i = order.indexOf(id);
  if (i < 0) return order[0];
  return order[(i + 1) % order.length];
}
function dealSixEach(room) {
  const deck = shuffle(newDeck());
  const trump = deck[deck.length - 1]; // карта-козырь
  const trumpSuit = suitOf(trump);

  const order = Array.from(room.players);          // фиксируем порядок
  const hands = new Map();
  for (const uid of order) hands.set(uid, []);

  for (let r = 0; r < 6; r++) {
    for (const uid of order) hands.get(uid).push(deck.pop());
  }

  // первый атакующий — владелец (проще для демо)
  const attackerId = room.ownerId;
  const defenderId = nextId(order, attackerId);

  room.game = {
    deck, trump, trumpSuit,
    hands, order,
    table: [],             // [{ a, byA, d?, byD? }]
    attackerId, defenderId
  };
}
function drawToSixAfterBout(room, startId, defenderId) {
  const g = room.game;
  if (!g) return;

  // добирают по кругу, начиная с startId, защитник — последним
  let pid = startId;
  const pass = new Set();
  while (true) {
    const hand = g.hands.get(pid) || [];
    while (hand.length < 6 && g.deck.length > 0) {
      hand.push(g.deck.pop());
    }
    g.hands.set(pid, hand);
    pass.add(pid);
    if (pid === defenderId) break;
    pid = nextId(g.order, pid);
    if (pass.size > g.order.length + 1) break; // защита от зацикливания
  }
}

// ─── Рассылка состояния игрокам ───────────────────────────────────────────────
function sendStateToRoom(room) {
  const g = room.game;
  if (!g) return;

  const counts = {};
  for (const uid of room.players) counts[uid] = g.hands.get(uid)?.length ?? 0;

  for (const client of wss.clients) {
    if (client.readyState !== 1 || client.roomId !== room.id) continue;
    const uid = client.user.id;
    const myHand = g.hands.get(uid) ?? [];
    client.send(JSON.stringify({
      type: 'state',
      roomId: room.id,
      hand: myHand,                   // показываем ТОЛЬКО свою руку
      counts,
      trump: g.trump,
      deckLeft: g.deck?.length ?? 0,
      table: g.table || [],
      attackerId: g.attackerId,
      defenderId: g.defenderId,
    }));
  }
}

// ─── WS: соединение/логика ────────────────────────────────────────────────────
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

    // ── 1) Авторизация ────────────────────────────────────────────────────────
    if (!authed) {
      if (msg.type !== 'auth') { try { ws.send(JSON.stringify({ type: 'error', msg: 'auth required' })); } catch {}; return; }
      let tgUser = null;
      try { tgUser = verifyInitData(msg.initData); } catch {}
      if (tgUser?.id) {
        ws.user = { id: String(tgUser.id), name: tgUser.first_name || 'Игрок' };
        console.log('[WS] tg auth ->', ws.user.id);
      } else {
        const gid = 'guest-' + crypto.randomBytes(3).toString('hex');
        ws.user = { id: gid, name: 'Гость' };
        console.log('[WS] guest auth ->', gid);
      }
      authed = true;
      try { ws.send(JSON.stringify({ type: 'auth_ok', user: ws.user })); } catch {}
      return;
    }

    // ── 2) Лобби ─────────────────────────────────────────────────────────────
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

    // ── 3) Игра: старт ───────────────────────────────────────────────────────
    if (msg.type === 'start_game') {
      const room = rooms.get(ws.roomId);
      if (!room) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no room' })); } catch {}; return; }
      if (room.ownerId !== ws.user.id) { try { ws.send(JSON.stringify({ type: 'error', msg: 'only owner can start' })); } catch {}; return; }

      dealSixEach(room);
      room.game.table = [];
      console.log('[WS] start_game in', room.id, 'trump', room.game?.trump);
      sendStateToRoom(room);
      return;
    }

    // ── 4) Игра: атака/защита ────────────────────────────────────────────────
    if (msg.type === 'attack' && typeof msg.card === 'string') {
      const room = rooms.get(ws.roomId);
      const g = room?.game;
      if (!g) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); } catch {}; return; }
      if (g.attackerId !== ws.user.id) { try { ws.send(JSON.stringify({ type: 'error', msg: 'not your attack' })); } catch {}; return; }

      const hand = g.hands.get(ws.user.id) || [];
      const idx = hand.indexOf(msg.card);
      if (idx === -1) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no such card' })); } catch {}; return; }

      // правило по рангу
      if (!canAttackCard(room, msg.card)) { try { ws.send(JSON.stringify({ type: 'error', msg: 'rank not on table' })); } catch {}; return; }

      // ограничение по количеству: нельзя больше, чем карт у защитника
      const openAttacks = (g.table || []).filter(p => !p.d).length;
      const defHandLen = g.hands.get(g.defenderId)?.length ?? 0;
      if (openAttacks >= defHandLen) { try { ws.send(JSON.stringify({ type: 'error', msg: 'too many attacks' })); } catch {}; return; }

      const card = hand.splice(idx, 1)[0];
      g.hands.set(ws.user.id, hand);
      g.table = g.table || [];
      g.table.push({ a: card, byA: ws.user.id });

      sendStateToRoom(room);
      return;
    }

    if (msg.type === 'defend' && typeof msg.card === 'string' && Number.isInteger(msg.attackIndex)) {
      const room = rooms.get(ws.roomId);
      const g = room?.game;
      if (!g) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); } catch {}; return; }
      if (g.defenderId !== ws.user.id) { try { ws.send(JSON.stringify({ type: 'error', msg: 'not your defend' })); } catch {}; return; }

      const pair = g.table?.[msg.attackIndex];
      if (!pair || pair.d) { try { ws.send(JSON.stringify({ type: 'error', msg: 'bad attack index' })); } catch {}; return; }

      const hand = g.hands.get(ws.user.id) || [];
      const idx = hand.indexOf(msg.card);
      if (idx === -1) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no such card' })); } catch {}; return; }

      if (!beats(msg.card, pair.a, g.trumpSuit)) { try { ws.send(JSON.stringify({ type: 'error', msg: 'card does not beat' })); } catch {}; return; }

      const card = hand.splice(idx, 1)[0];
      g.hands.set(ws.user.id, hand);
      pair.d = card;
      pair.byD = ws.user.id;

      sendStateToRoom(room);
      return;
    }

    // ── 5) Игра: БИТО (конец удачной защиты) ─────────────────────────────────
    if (msg.type === 'end_turn') {
      const room = rooms.get(ws.roomId);
      const g = room?.game;
      if (!g) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); } catch {}; return; }
      if (g.attackerId !== ws.user.id) { try { ws.send(JSON.stringify({ type: 'error', msg: 'only attacker can end' })); } catch {}; return; }

      if (!g.table?.length || g.table.some(p => !p.d)) {
        try { ws.send(JSON.stringify({ type: 'error', msg: 'not all defended' })); } catch {};
        return;
      }

      // всё уходит в сброс
      g.discard = g.discard || [];
      for (const p of g.table) { if (p?.a) g.discard.push(p.a); if (p?.d) g.discard.push(p.d); }
      g.table = [];

      // добор до 6: с атакующего, защитник — последний
      drawToSixAfterBout(room, g.attackerId, g.defenderId);

      // роли сдвигаются
      g.attackerId = nextId(g.order, g.attackerId);
      g.defenderId = nextId(g.order, g.attackerId);

      sendStateToRoom(room);
      return;
    }

    // ── 6) Игра: ВЗЯТЬ (защитник) ─────────────────────────────────────────────
    if (msg.type === 'take') {
      const room = rooms.get(ws.roomId);
      const g = room?.game;
      if (!g) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); } catch {}; return; }
      if (g.defenderId !== ws.user.id) { try { ws.send(JSON.stringify({ type: 'error', msg: 'only defender can take' })); } catch {}; return; }
      if (!g.table?.length) { try { ws.send(JSON.stringify({ type: 'error', msg: 'table empty' })); } catch {}; return; }

      // защитник забирает все карты со стола
      const defHand = g.hands.get(g.defenderId) || [];
      for (const p of g.table) { if (p?.a) defHand.push(p.a); if (p?.d) defHand.push(p.d); }
      g.hands.set(g.defenderId, defHand);
      g.table = [];

      // добор до 6: с атакующего, защитник — последним
      drawToSixAfterBout(room, g.attackerId, g.defenderId);

      // атакующий остаётся тем же; новый защитник — следующий
      g.defenderId = nextId(g.order, g.defenderId);

      sendStateToRoom(room);
      return;
    }

    // ── (dev) очистить стол владельцем комнаты ────────────────────────────────
    if (msg.type === 'clear_table') {
      const room = rooms.get(ws.roomId);
      const g = room?.game;
      if (!g) { try { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); } catch {}; return; }
      if (room.ownerId !== ws.user.id) { try { ws.send(JSON.stringify({ type: 'error', msg: 'owner only' })); } catch {}; return; }
      g.table = [];
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
