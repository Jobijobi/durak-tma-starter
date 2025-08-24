// web/src/main.jsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import Lobby from './lobby.jsx'; // <-- ВАЖНО: нижний регистр и .jsx

createRoot(document.getElementById('root')).render(<Lobby />);
