// web/src/lobby.jsx
import React, { useEffect, useRef, useState } from 'react';

// ВАЖНО: тут должен быть ДОМЕН СЕРВЕРА (WS), а не фронта!
const WS_URL = 'wss://durak-tma-starter.onrender.com/ws';

export default function Lobby() {
  const [status, setStatus] = useState('Подключение…');
  const [rooms, setRooms]   = useState([]);
  const [me, setMe]         = useState(null);
  const [myRoom, setMyRoom] = useState(null);
  const [roomCode, setRoomCode] = useState('');
  const wsRef = useRef(null);

  useEffect(() => {
    // На всякий случай, если открыли не в Telegram
    const tg = window?.Telegram?.WebApp ?? { initData: '' };
    try { tg.expand?.(); tg.ready?.(); } catch {}

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('WS открыт, авторизация…');
      // Отправляем initData на сервер для проверки подписи
      ws.send(JSON.stringify({ type: 'auth', initData: tg.initData || '' }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'hello') {
        // просто привет с сервера
      }
      if (msg.type === 'auth_ok') {
        setMe(msg.user);
        setStatus('Авторизован');
      }
      if (msg.type === 'error') {
        setStatus('Ошибка: ' + (msg.msg || ''));
      }
      if (msg.type === 'rooms') {
        setRooms(msg.list || []);
      }
      if (msg.type === 'room_created') {
        setMyRoom(msg.room);
        setStatus('Комната создана: ' + msg.room.id);
      }
      if (msg.type === 'joined') {
        setMyRoom(msg.room);
        setStatus('Вошёл в комнату: ' + msg.room.id);
      }
      if (msg.type === 'left') {
        setMyRoom(null);
        setStatus('Покинул комнату');
      }
      if (msg.type === 'room_update') {
        if (myRoom && msg.room?.id === myRoom.id) {
          setMyRoom(msg.room);
        }
        // обновим список, чтобы увидеть актуальные составы
        setRooms((prev) => {
          const map = new Map(prev.map(r => [r.id, r]));
          map.set(msg.room.id, msg.room);
          return Array.from(map.values());
        });
      }
      if (msg.type === 'pong') {
        // ответ на пинг
      }
    };

    ws.onclose = (e) => {
      setStatus(`WS закрыт (code=${e.code}, reason=${e.reason || '-'})`);
      console.log('WS CLOSE', e);
    };
    ws.onerror = (e) => {
      console.log('WS ERROR', e);
    };

    // пинг каждые 20с
    const t = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 20000);

    return () => {
      clearInterval(t);
      try { ws.close(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = (obj) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) {
      setStatus('WS не готов');
      return;
    }
    ws.send(JSON.stringify(obj));
  };

  const listRooms   = () => send({ type: 'list_rooms' });
  const createRoom  = () => send({ type: 'create_room' });
  const joinRoom    = () => roomCode && send({ type: 'join_room', roomId: roomCode.trim() });
  const leaveRoom   = () => send({ type: 'leave_room' });

  return (
    <div className="container" style={{ maxWidth: 820, margin: '24px auto', padding: '0 16px' }}>
      <section className="card" style={{ border: '1px solid #ddd', borderRadius: 12, padding: 16 }}>
        <h1 style={{ marginTop: 0 }}>Лобби</h1>
        <div style={{ color: '#444', marginBottom: 12 }}>
          <b>Статус:</b> {status}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
          <button className="btn" onClick={listRooms}>Обновить список</button>
          <button className="btn" onClick={createRoom}>Создать комнату</button>

          <input
            className="input"
            placeholder="код комнаты"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
            style={{ flex: 1, minWidth: 160, padding: '6px 10px', border: '1px solid #ccc', borderRadius: 8 }}
          />
          <button className="btn" onClick={joinRoom}>Войти</button>
          <button className="btn" onClick={leaveRoom}>Выйти</button>
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
