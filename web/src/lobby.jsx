// web/src/lobby.jsx
import React, { useEffect, useRef, useState } from 'react';

/**
 * Адрес бэкенда берём из web/.env:
 *   VITE_SERVER_ORIGIN=https://durak-tma-starter.onrender.com
 * Если переменной нет, используем текущий origin (на случай локалки).
 * Для отладки можно переопределить глобально:
 *   window.__SERVER_ORIGIN = 'https://....onrender.com'
 */
const SERVER_ORIGIN =
  (typeof window !== 'undefined' && window.__SERVER_ORIGIN) ||
  import.meta.env.VITE_SERVER_ORIGIN ||
  window.location.origin;

const serverURL = new URL(SERVER_ORIGIN);
const wsScheme = serverURL.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL = `${wsScheme}://${serverURL.host}/ws`;

console.log('[WS] SERVER_ORIGIN =', SERVER_ORIGIN);
console.log('[WS] WS_URL        =', WS_URL);

export default function Lobby() {
  const [status, setStatus] = useState('Подключение…');
  const [ready, setReady]   = useState(false);
  const [rooms, setRooms]   = useState([]);
  const [me, setMe]         = useState(null);
  const [myRoom, setMyRoom] = useState(null);
  const [roomCode, setRoomCode] = useState('');

  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  useEffect(() => {
    const tg = window?.Telegram?.WebApp ?? { initData: '' };
    try { tg.expand?.(); tg.ready?.(); } catch {}

    const connect = () => {
      clearTimeout(reconnectTimer.current);
      setStatus('Подключение…');
      setReady(false);

      // ⬇️ если не из Telegram (initData пустой) — добавляем guest=1
      const url = new URL(WS_URL);
      if (!tg.initData) url.searchParams.set('guest', '1');
      console.log('[WS] opening', url.toString());

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setReady(true);
        setStatus('WS открыт, авторизация…');
        ws.send(JSON.stringify({ type: 'auth', initData: tg.initData || '' }));
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
          return;
        }

        if (msg.type === 'joined') {
          setMyRoom(msg.room);
          setStatus('Вошёл в комнату: ' + msg.room.id);
          return;
        }

        if (msg.type === 'left') {
          setMyRoom(null);
          setStatus('Покинул комнату');
          return;
        }

        if (msg.type === 'room_update') {
          setRooms(prev => {
            const map = new Map(prev.map(r => [r.id, r]));
            map.set(msg.room.id, msg.room);
            return Array.from(map.values());
          });
          if (myRoom?.id === msg.room.id) setMyRoom(msg.room);
        }
      };

      ws.onerror = () => console.debug('[WS] error');

      ws.onclose = (e) => {
        setReady(false);
        setStatus(`WS закрыт (code=${e.code}, reason=${e.reason || '-'})`);
        reconnectTimer.current = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      try { wsRef.current?.close(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = (obj) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) { setStatus('WS не готов'); return; }
    ws.send(JSON.stringify(obj));
  };

  const listRooms  = () => send({ type: 'list_rooms' });
  const createRoom = () => send({ type: 'create_room' });
  const joinRoom   = () => roomCode && send({ type: 'join_room', roomId: roomCode.trim() });
  const leaveRoom  = () => send({ type: 'leave_room' });

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
        </div>

        {me && (
          <div className="pill" style={{ display: 'inline-block', padding: '4px 6px', border: '1px solid #ccc', borderRadius: 6, marginBottom: 12 }}>
            <b>Я:</b> {me.name} (id: {me.id})
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
          <b>Моя комната:</b>
          {!myRoom && <div style={{ marginTop: 6, color: '#666' }}>ещё не в комнате</div>}
          {myRoom && (
            <div style={{ marginTop: 6 }}>
              <div><b>id:</b> <code>{myRoom.id}</code></div>
              <div><b>ownerId:</b> {myRoom.ownerId}</div>
              <div style={{ marginTop: 6, fontSize: 13, color: '#555' }}>
                участники: {myRoom.players?.join(', ') || '—'}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
