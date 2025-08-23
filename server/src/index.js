
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';

const app = express();
app.use(cors());
app.get('/health', (_req,res)=>res.json({ok:true}));

const server = http.createServer(app);
const wss = new WebSocketServer({server, path:'/ws'});

wss.on('connection', ws => {
  ws.send(JSON.stringify({type:'hello', msg:'connected'}));
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, ()=>console.log("Server running on", PORT));
