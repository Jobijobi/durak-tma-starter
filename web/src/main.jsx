import React from 'react';
import { createRoot } from 'react-dom/client';
import Lobby from './lobby.jsx';   // <- именно .jsx
createRoot(document.getElementById('root')).render(<Lobby />);
