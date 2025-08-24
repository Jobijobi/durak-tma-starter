import React from 'react';
import { createRoot } from 'react-dom/client';
import Lobby from './lobby.js';

function App() {
  return <Lobby />;
}

createRoot(document.getElementById('root')).render(<App />);
