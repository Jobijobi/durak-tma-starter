import React, { useEffect, useMemo, useState } from 'react';

const SERVER_WS = 'wss://durak-tma-starter-1.onrender.com/ws';

export default function Lobby() {
  const [status, setStatus] = useState('Подключение…');
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState('');
  const [ws, setWs] = useState(null);

  const initData = useMemo(
    () => (window.Telegram?.WebApp?.initData || ''),
    []
  );

  useEffect(() => {
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.expand?.();
      window.Telegram.WebApp.ready?.();
    }
  }, []);

  useEffect(() => {
    const sock = new WebSocket(SERVER_WS);
    sock.onopen = () => setStatus('WS открыт');
    sock.onerror = () => setStatus('WS ошибка');
    sock.onclose = () => setStatus('WS закрыт');
    sock.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'hello') {
          sock.send(JSON.stringify({ type: 'auth', initData }));
        }
        if (msg.type === 'auth_ok') {
          setStatus(`Готово. Вы: ${msg.user?.name || msg.user?.id}`);
          sock.send(JSON.stringify({ type: 'list_rooms' }));
        }
        if (msg.type === 'rooms') setRooms(msg.list || []);
        if (msg.type === 'room_created' || msg.type === 'joined') {
          setStatus(`Комната: ${msg.room?.id}`);
        }
        if (msg.type === 'room_update') {
          setRooms((old) =>
            old.map((r) => (r.id === msg.room.id ? msg.room : r))
          );
        }
      } catch {}
    };
    setWs(sock);
    return () => sock.close();
  }, [initData]);

  const listRooms = () => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'list_rooms' }));
  const createRoom = () => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'create_room' }));
  const joinRoom = () => {
    if (!roomId.trim()) return;
    ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'join_room', roomId: roomId.trim() }));
  };
  const leaveRoom = () => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'leave_room' }));

  return (
    <div style={{maxWidth:820, margin:'24px auto', padding:'0 16px',
                 fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, Arial'}}>
      <h2>Лобби</h2>
      <div style={{color:'#444', marginBottom:12}}>Статус: {status}</div>

      <div style={{display:'flex', gap:8, flexWrap:'wrap', margin:'12px 0'}}>
        <button onClick={listRooms}>Обновить список</button>
        <button onClick={createRoom}>Создать комнату</button>
        <input
          value={roomId}
          onChange={(e)=>setRoomId(e.target.value)}
          placeholder="код комнаты"
          style={{flex:1, minWidth:160, padding:'6px 10px'}}
        />
        <button onClick={joinRoom}>Войти</button>
        <button onClick={leaveRoom}>Выйти</button>
      </div>

      <ul>
        {rooms.map((r) => (
          <li key={r.id}>
            <b>{r.id}</b> — игроков: {r.players?.length ?? 0} {r.ownerId ? `(owner ${r.ownerId})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
