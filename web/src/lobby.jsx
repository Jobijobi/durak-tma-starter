// web/src/lobby.jsx
import React, { useEffect, useRef, useState } from 'react';

// Источник адреса бэкенда
const SERVER_ORIGIN =
  (typeof window !== 'undefined' && window.__SERVER_ORIGIN) ||
  import.meta.env.VITE_SERVER_ORIGIN ||
  window.location.origin;

const serverURL = new URL(SERVER_ORIGIN);
const wsScheme = serverURL.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL = `${wsScheme}://${serverURL.host}/ws`;

const suitEmoji = (s) => ({ C: '♣️', D: '♦️', H: '♥️', S: '♠️' }[s] || s);
const prettyCard = (c) => {
  const m = String(c).match(/^(\d+|[JQKA])([CDHS])$/);
  if (!m) return String(c);
  return `${m[1]}${suitEmoji(m[2])}`;
};

export default function Lobby() {
  const [status, setStatus] = useState('Подключение…');
  const [ready, setReady] = useState(false);
  const [rooms, setRooms] = useState([]);
  const [me, setMe] = useState(null);
  const [myRoom, setMyRoom] = useState(null);
  const [roomCode, setRoomCode] = useState('');

  // игра
  const [hand, setHand] = useState([]);
  const [counts, setCounts] = useState({});
  const [trump, setTrump] = useState(null);
  const [deckLeft, setDeckLeft] = useState(0);
  const [table, setTable] = useState([]); // [{a, byA, d?, byD?}]
  const [attackerId, setAttackerId] = useState(null);
  const [defenderId, setDefenderId] = useState(null);

  // выбор атаки, которую бьём
  const [defendIndex, setDefendIndex] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const pingTimer = useRef(null);

  useEffect(() => {
    const tg = window?.Telegram?.WebApp ?? { initData: '' };
    try { tg.expand?.(); tg.ready?.(); } catch {}

    const connect = () => {
      clearTimeout(reconnectTimer.current);
      setStatus('Подключение…');
      setReady(false);

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setReady(true);
        setStatus('WS открыт, авторизация…');
        ws.send(JSON.stringify({ type: 'auth', initData: tg.initData || '' }));

        clearInterval(pingTimer.current);
        pingTimer.current = setInterval(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
        }, 20000);
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.type === 'hello') return;

        if (msg.type === 'auth_ok') {
          setMe(msg.user);
          setStatus('Авторизован');
          ws.send(JSON.stringify({ type: 'list_rooms' }));
          return;
        }

        if (msg.type === 'error') {
          setStatus('Ошибка: ' + (msg.msg || ''));
          return;
        }

        if (msg.type === 'rooms') {
          setRooms(msg.list || []);
          return;
        }

        if (msg.type === 'room_created') {
          setMyRoom(msg.room);
          setStatus('Комната создана: ' + msg.room.id);
          resetGameView();
          return;
        }

        if (msg.type === 'joined') {
          setMyRoom(msg.room);
          setStatus('Вошёл в комнату: ' + msg.room.id);
          resetGameView();
          return;
        }

        if (msg.type === 'left') {
          setMyRoom(null);
          setStatus('Покинул комнату');
          resetGameView();
          return;
        }

        if (msg.type === 'room_update') {
          setRooms((prev) => {
            const map = new Map(prev.map((r) => [r.id, r]));
            map.set(msg.room.id, msg.room);
            return Array.from(map.values());
          });
          if (myRoom?.id === msg.room.id) setMyRoom(msg.room);
          return;
        }

        if (msg.type === 'state') {
          setHand(msg.hand || []);
          setCounts(msg.counts || {});
          setTrump(msg.trump || null);
          setDeckLeft(msg.deckLeft ?? 0);
          setTable(msg.table || []);
          setAttackerId(msg.attackerId ?? null);
          setDefenderId(msg.defenderId ?? null);
          if (!(msg.table || []).some(p => !p.d)) setDefendIndex(null);
          setStatus('Состояние обновлено');
          return;
        }
      };

      ws.onerror = () => console.debug('[WS] error');

      ws.onclose = (e) => {
        setReady(false);
        setStatus(`WS закрыт (code=${e.code}, reason=${e.reason || '-'})`);
        clearInterval(pingTimer.current);
        reconnectTimer.current = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      clearInterval(pingTimer.current);
      try { wsRef.current?.close(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetGameView = () => {
    setHand([]); setCounts({}); setTrump(null); setDeckLeft(0);
    setTable([]); setAttackerId(null); setDefenderId(null);
    setDefendIndex(null);
  };

  const send = (obj) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) { setStatus('WS не готов'); return; }
    ws.send(JSON.stringify(obj));
  };

  const listRooms  = () => send({ type: 'list_rooms' });
  const createRoom = () => send({ type: 'create_room' });
  const joinRoom   = () => roomCode && send({ type: 'join_room', roomId: roomCode.trim() });
  const leaveRoom  = () => send({ type: 'leave_room' });
  const startGame  = () => send({ type: 'start_game' });
  const endTurn    = () => send({ type: 'end_turn' });
  const take       = () => send({ type: 'take' });

  const iAmAttacker = me && attackerId === me.id;
  const iAmDefender = me && defenderId === me.id;

  // клик по карте в руке
  const onCardClick = (c) => {
    if (!ready || !myRoom) return;
    if (iAmAttacker) {
      send({ type: 'attack', card: c });
      return;
    }
    if (iAmDefender && defendIndex !== null) {
      send({ type: 'defend', attackIndex: defendIndex, card: c });
      setDefendIndex(null);
      return;
    }
  };

  // выбор какой атаке поставить защиту
  const selectDefend = (idx) => {
    if (!iAmDefender) return;
    setDefendIndex(idx);
  };

  const roleLabel = iAmAttacker ? 'Атакующий' : iAmDefender ? 'Защитник' : 'Наблюдатель';

  return (
    <div className="container" style={{ maxWidth: 820, margin: '24px auto', padding: '0 16px' }}>
      <section className="card" style={{ border: '1px solid #ddd', borderRadius: 12, padding: 16 }}>
        <h1 style={{ marginTop: 0 }}>Лобби</h1>

        <div style={{ color: '#444', marginBottom: 6 }}>
          <b>Статус:</b> {status} {ready ? '✅' : '⏳'}
        </div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
          server: <code>{WS_URL}</code>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
          <button className="btn" onClick={listRooms}  disabled={!ready}>Обновить список</button>
          <button className="btn" onClick={createRoom} disabled={!ready}>Создать комнату</button>

          <input
            className="input"
            placeholder="код комнаты"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
            style={{ flex: 1, minWidth: 160, padding: '6px 10px', border: '1px solid #ccc', borderRadius: 8 }}
          />
          <button className="btn" onClick={joinRoom}  disabled={!ready}>Войти</button>
          <button className="btn" onClick={leaveRoom} disabled={!ready}>Выйти</button>

          <button className="btn" onClick={startGame} disabled={!ready || !myRoom}>Начать игру</button>
          <button className="btn" onClick={endTurn}   disabled={!ready || !iAmAttacker || !myRoom}>Бито</button>
          <button className="btn" onClick={take}      disabled={!ready || !iAmDefender || !myRoom}>Взять</button>
        </div>

        {me && (
          <div className="pill" style={{ display: 'inline-block', padding: '4px 6px', border: '1px solid #ccc', borderRadius: 6, marginBottom: 12 }}>
            <b>Я:</b> {me.name} (id: {me.id}) • роль: <b>{roleLabel}</b>
          </div>
        )}

        <h3 style={{ marginBottom: 6 }}>Комнаты</h3>
        <ul style={{ marginTop: 0, paddingLeft: 18 }}>
          {rooms.length === 0 && <li>пока пусто</li>}
          {rooms.map((r) => (
            <li key={r.id}>
              <code>{r.id}</code>&nbsp;— игроков: {r.players?.length ?? 0}
              {myRoom?.id === r.id && <span style={{ marginLeft: 8, color: '#888' }}>(моя)</span>}
            </li>
          ))}
        </ul>

        <div className="card" style={{ border: '1px dashed #ccc', borderRadius: 12, padding: 12, marginTop: 16 }}>
          <b>Игра:</b>
          <div style={{ marginTop: 8, fontSize: 13, color: '#555' }}>
            <div><b>Козырь:</b> {trump ? prettyCard(trump) : '—'} &nbsp; • &nbsp; <b>В колоде:</b> {deckLeft}</div>
            <div><b>Атакующий:</b> {attackerId || '—'} &nbsp; • &nbsp; <b>Защитник:</b> {defenderId || '—'}</div>
          </div>

          <div style={{ marginTop: 12 }}>
            <b>Стол:</b>
            <div style={{ marginTop: 6, display: 'flex', gap: 10, flexDirection: 'column' }}>
              {(table || []).length === 0 && <span style={{ color: '#666' }}>—</span>}
              {(table || []).map((p, i) => {
                const open = !p.d;
                const selectable = iAmDefender && open;
                return (
                  <div
                    key={i}
                    onClick={() => selectable && selectDefend(i)}
                    style={{
                      padding: 6,
                      border: '1px solid #ccc',
                      borderRadius: 8,
                      cursor: selectable ? 'pointer' : 'default',
                      background: defendIndex === i ? '#eef6ff' : 'transparent'
                    }}
                    title={selectable ? 'Выбрать эту атаку для защиты' : ''}
                  >
                    <b>{i + 1}.</b>{' '}
                    <span className="pill" style={{ padding: '2px 6px', border: '1px solid #ccc', borderRadius: 6 }}>
                      {prettyCard(p.a)} <span style={{ color: '#888' }}>({p.byA})</span>
                    </span>
                    {'  →  '}
                    {p.d ? (
                      <span className="pill" style={{ padding: '2px 6px', border: '1px solid #ccc', borderRadius: 6 }}>
                        {prettyCard(p.d)} <span style={{ color: '#888' }}>({p.byD})</span>
                      </span>
                    ) : (
                      <span style={{ color: '#666' }}>—</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <b>Моя рука:</b>
            <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {hand?.map((c, i) => (
                <span
                  key={i}
                  onClick={() => onCardClick(c)}
                  className="pill"
                  style={{ padding: '4px 6px', border: '1px solid #ccc', borderRadius: 6, cursor: 'pointer' }}
                  title={iAmAttacker ? 'Атаковать картой' : iAmDefender ? (defendIndex !== null ? 'Поставить защиту' : 'Сначала выберите атаку на столе') : ''}
                >
                  {prettyCard(c)}
                </span>
              ))}
              {(!hand || hand.length === 0) && <span style={{ color: '#666' }}>—</span>}
            </div>
          </div>

          <div style={{ marginTop: 8, fontSize: 13, color: '#555' }}>
            <b>Карты у игроков:</b>{' '}
            {Object.keys(counts).length
              ? Object.entries(counts).map(([uid, n], idx) => (
                  <span key={uid}>{idx ? ', ' : ''}{uid}: {n}</span>
                ))
              : '—'}
          </div>
        </div>
      </section>
    </div>
  );
}
