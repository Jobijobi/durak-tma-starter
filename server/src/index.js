// server/src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

// ───────────────────────────────────────────────────────────────────────────────
// ENV
const FRONT = process.env.FRONT_ORIGIN ?? 'https://durak-tma-starter-1.onrender.com';
const BOT_TOKEN = process.env.BOT_TOKEN || ''; // нужен для проверки initData из Telegram

// ───────────────────────────────────────────────────────────────────────────────
// HTTP (health + CORS)
const app = express();
app.use(cors({ origin: FRONT, methods: ['GET', 'POST'], credentials: true }));
app.get('/health', (_req, res) => res.json({ ok: true }));
const server = http.createServer(app);

// ───────────────────────────────────────────────────────────────────────────────
// WS сервер
const wss = new WebSocketServer({ server, path: '/ws' });

// Проверка подписи Telegram WebApp initData
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);

  const obj = Object.fromEntries(params.entries());
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

// ───────────────────────────────────────────────────────────────────────────────
// Карточные утилиты (36 карт: 6..A)
const RANKS = ['6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function dealCards(state, playerId, n = 6) {
  while (state.deck.length && state.hands[playerId].length < n) {
    state.hands[playerId].push(state.deck.pop()); // добор с "верха" колоды
  }
}
function rankOf(card){ return card.slice(0, card.length - 1); }
function suitOf(card){ return card.slice(-1); }
function rankValue(card){ return RANKS.indexOf(rankOf(card)); }
function canBeat(defCard, atkCard, trumpSuit) {
  const sD = suitOf(defCard), sA = suitOf(atkCard);
  if (sD === sA) return rankValue(defCard) > rankValue(atkCard);
  if (sD === trumpSuit && sA !== trumpSuit) return true;
  return false;
}
function dealUpTo6(state, order) {
  for (const pid of order) dealCards(state, pid, 6);
}
function switchRoles2p(state) {
  const a = state.attacker, d = state.defender;
  state.attacker = d;
  state.defender = a;
}
function allDefended(table){
  return table.length > 0 && table.every(p => p.d);
}
function allowedRanksOnTable(table){
  const ranks = new Set();
  for (const p of table) { ranks.add(rankOf(p.a)); if (p.d) ranks.add(rankOf(p.d)); }
  return ranks;
}

// ───────────────────────────────────────────────────────────────────────────────
// Простые комнаты (in-memory)
const rooms = new Map(); // roomId -> { id, ownerId, players:Set<string>, createdAt, game|null }

const roomSnapshot = (r) => ({
  id: r.id,
  ownerId: r.ownerId,
  players: Array.from(r.players),
  createdAt: r.createdAt,
  game: r.game ? {
    trump: r.game.trump,
    trumpSuit: r.game.trumpSuit,
    deckCount: r.game.deck.length,
    attacker: r.game.attacker,
    defender: r.game.defender,
    // стол показываем без раскрытия карт защиты
    table: r.game.table.map(p => ({ a: p.a, d: p.d ? 'X' : null })),
    // сколько карт в руках у каждого
    counts: Object.fromEntries(Object.entries(r.game.hands).map(([pid, hand]) => [pid, hand.length])),
  } : null
});

function broadcastToRoom(roomId, payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.roomId === roomId) client.send(data);
  }
}
function broadcastState(room){
  // публичная сводка
  broadcastToRoom(room.id, { type: 'state', room: roomSnapshot(room) });
  // каждому — приватно его руку
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (client.roomId !== room.id) continue;
    const pid = String(client.user?.id);
    const st = room.game;
    client.send(JSON.stringify({
      type: 'hand',
      roomId: room.id,
      cards: st.hands[pid] || [],
      trump: st.trump,
      trumpSuit: st.trumpSuit,
      you: pid
    }));
  }
}
function endIfFinished(room){
  const st = room.game;
  if (!st) return true;
  const deckEmpty = st.deck.length === 0;
  const pids = Array.from(room.players).map(String);
  const emptyPlayers = pids.filter(pid => st.hands[pid].length === 0);
  if (deckEmpty && emptyPlayers.length) {
    const winner = emptyPlayers[0];
    broadcastToRoom(room.id, { type: 'game_over', winner });
    room.game = null;
    return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────────
// Логика WS
wss.on('connection', (ws) => {
  // heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // привет (не даёт прав)
  ws.send(JSON.stringify({ type: 'hello', msg: 'connected' }));

  let authed = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { ws.send(JSON.stringify({ type: 'error', msg: 'bad json' })); return; }

    // ping можно до auth
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); return; }

    // 1) Авторизация первым сообщением
    if (!authed) {
      if (msg.type !== 'auth') { ws.send(JSON.stringify({ type: 'error', msg: 'auth required' })); return; }
      const user = verifyInitData(msg.initData);
      if (!user?.id) { ws.send(JSON.stringify({ type: 'error', msg: 'bad initData' })); ws.close(4001, 'bad auth'); return; }
      ws.user = { id: String(user.id), name: user.first_name || 'Игрок' };
      authed = true;
      ws.send(JSON.stringify({ type: 'auth_ok', user: ws.user }));
      return;
    }

    // 2) Лобби
    if (msg.type === 'list_rooms') {
      const list = Array.from(rooms.values()).map(roomSnapshot);
      ws.send(JSON.stringify({ type: 'rooms', list }));
      return;
    }

    if (msg.type === 'create_room') {
      const id = crypto.randomUUID().slice(0, 6);
      const room = {
        id,
        ownerId: ws.user.id,
        players: new Set([ws.user.id]),
        createdAt: Date.now(),
        game: null
      };
      rooms.set(id, room);
      ws.roomId = id;
      ws.send(JSON.stringify({ type: 'room_created', room: roomSnapshot(room) }));
      broadcastToRoom(id, { type: 'room_update', room: roomSnapshot(room) });
      return;
    }

    if (msg.type === 'join_room' && typeof msg.roomId === 'string') {
      const room = rooms.get(msg.roomId);
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'room not found' })); return; }
      room.players.add(ws.user.id);
      ws.roomId = room.id;
      ws.send(JSON.stringify({ type: 'joined', room: roomSnapshot(room) }));
      broadcastToRoom(room.id, { type: 'room_update', room: roomSnapshot(room) });
      return;
    }

    if (msg.type === 'leave_room') {
      if (!ws.roomId) { ws.send(JSON.stringify({ type: 'left' })); return; }
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

    // 3) Игра: старт партии (нужно >=2 игроков)
    if (msg.type === 'start_game') {
      if (!ws.roomId) { ws.send(JSON.stringify({ type: 'error', msg: 'join a room first' })); return; }
      const room = rooms.get(ws.roomId);
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'room not found' })); return; }
      const pids = Array.from(room.players).map(String);
      if (pids.length < 2) { ws.send(JSON.stringify({ type: 'error', msg: 'need 2+ players' })); return; }

      const deck = shuffle(buildDeck());
      const trump = deck[0];              // козырь (показываем всем)
      const trumpSuit = suitOf(trump);

      const hands = {};
      for (const pid of pids) hands[pid] = [];
      const state = {
        deck,
        trump,
        trumpSuit,
        hands,          // { pid: [карты] }
        table: [],      // [{a:'9♠', d:null|card}]
        discard: [],    // сброшенные
        attacker: pids[0],
        defender: pids[1],
      };
      for (const pid of pids) dealCards(state, pid, 6);

      room.game = state;

      // приватные руки
      for (const client of wss.clients) {
        if (client.readyState !== 1) continue;
        if (client.roomId !== room.id) continue;
        const pid = String(client.user?.id);
        client.send(JSON.stringify({
          type: 'hand',
          roomId: room.id,
          cards: state.hands[pid] || [],
          trump: state.trump,
          trumpSuit: state.trumpSuit,
          you: pid
        }));
      }
      // публичная сводка
      broadcastToRoom(room.id, { type: 'game_started', room: roomSnapshot(room) });
      return;
    }

    // 4) Игра: атака картой
    if (msg.type === 'attack' && typeof msg.card === 'string') {
      if (!ws.roomId) { ws.send(JSON.stringify({ type: 'error', msg: 'join a room first' })); return; }
      const room = rooms.get(ws.roomId);
      const st = room?.game;
      if (!st) { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); return; }
      const pid = String(ws.user.id);
      if (pid !== st.attacker) { ws.send(JSON.stringify({ type: 'error', msg: 'not your attack' })); return; }

      const defCount = st.hands[st.defender].length;
      const maxAttacks = Math.min(6, defCount);
      if (st.table.length >= maxAttacks) { ws.send(JSON.stringify({ type: 'error', msg: 'no more attacks' })); return; }

      const i = st.hands[pid].indexOf(msg.card);
      if (i === -1) { ws.send(JSON.stringify({ type: 'error', msg: 'no such card' })); return; }

      if (st.table.length > 0) {
        const allowed = allowedRanksOnTable(st.table);
        if (!allowed.has(rankOf(msg.card))) { ws.send(JSON.stringify({ type: 'error', msg: 'rank not allowed' })); return; }
      }

      st.hands[pid].splice(i, 1);
      st.table.push({ a: msg.card, d: null });

      broadcastState(room);
      return;
    }

    // 5) Игра: защита картой (бьём первую незащищённую)
    if (msg.type === 'defend' && typeof msg.card === 'string') {
      if (!ws.roomId) { ws.send(JSON.stringify({ type: 'error', msg: 'join a room first' })); return; }
      const room = rooms.get(ws.roomId);
      const st = room?.game;
      if (!st) { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); return; }
      const pid = String(ws.user.id);
      if (pid !== st.defender) { ws.send(JSON.stringify({ type: 'error', msg: 'not your defend' })); return; }

      const i = st.hands[pid].indexOf(msg.card);
      if (i === -1) { ws.send(JSON.stringify({ type: 'error', msg: 'no such card' })); return; }

      const target = st.table.find(p => !p.d);
      if (!target) { ws.send(JSON.stringify({ type: 'error', msg: 'nothing to defend' })); return; }

      if (!canBeat(msg.card, target.a, st.trumpSuit)) { ws.send(JSON.stringify({ type: 'error', msg: 'cannot beat' })); return; }

      st.hands[pid].splice(i, 1);
      target.d = msg.card;

      broadcastState(room);
      return;
    }

    // 6) Игра: пас (атакующий завершает ход, если всё побито)
    if (msg.type === 'pass') {
      if (!ws.roomId) { ws.send(JSON.stringify({ type: 'error', msg: 'join a room first' })); return; }
      const room = rooms.get(ws.roomId);
      const st = room?.game;
      if (!st) { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); return; }
      const pid = String(ws.user.id);
      if (pid !== st.attacker) { ws.send(JSON.stringify({ type: 'error', msg: 'not your turn' })); return; }

      if (!allDefended(st.table)) { ws.send(JSON.stringify({ type: 'error', msg: 'not all defended' })); return; }

      for (const p of st.table) { // сброс
        st.discard.push(p.a);
        if (p.d) st.discard.push(p.d);
      }
      st.table = [];

      dealUpTo6(st, [st.attacker, st.defender]); // добор
      switchRoles2p(st);                          // смена ролей

      broadcastState(room);
      if (!endIfFinished(room)) { /* игра продолжается */ }
      return;
    }

    // 7) Игра: взять (защитник забирает стол)
    if (msg.type === 'take') {
      if (!ws.roomId) { ws.send(JSON.stringify({ type: 'error', msg: 'join a room first' })); return; }
      const room = rooms.get(ws.roomId);
      const st = room?.game;
      if (!st) { ws.send(JSON.stringify({ type: 'error', msg: 'no game' })); return; }
      const pid = String(ws.user.id);
      if (pid !== st.defender) { ws.send(JSON.stringify({ type: 'error', msg: 'not your take' })); return; }

      for (const p of st.table) { // всё со стола в руку защитника
        st.hands[pid].push(p.a);
        if (p.d) st.hands[pid].push(p.d);
      }
      st.table = [];

      dealUpTo6(st, [st.attacker, st.defender]); // добор
      // роли НЕ меняются (в 2-х игроках атакующий остаётся тем же)

      broadcastState(room);
      if (!endIfFinished(room)) { /* игра продолжается */ }
      return;
    }
  });

  ws.on('close', () => {
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

// ───────────────────────────────────────────────────────────────────────────────
// START
const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () => {
  console.log('Server running on', PORT);
  console.log('Allowed origin:', FRONT);
  console.log('Has BOT_TOKEN for auth:', !!BOT_TOKEN);
});
