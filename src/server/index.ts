import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createCodexConnectionHandler } from './codex-server';
import { createGoldRushConnectionHandler } from './goldrush-server';

const app = express();
app.use(express.static(path.resolve(process.cwd(), 'public')));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const server = createServer(app);

const codexPath = process.env.CODEX_WS_PATH || '/ws/codex';
const goldrushPath = process.env.GOLDRUSH_WS_PATH || '/ws/goldrush';

const codexWss = new WebSocketServer({ noServer: true });
codexWss.on('connection', createCodexConnectionHandler());

const goldrushWss = new WebSocketServer({ noServer: true });
goldrushWss.on('connection', createGoldRushConnectionHandler());

server.on('upgrade', (request, socket, head) => {
  try {
    const { pathname } = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (pathname === codexPath) {
      codexWss.handleUpgrade(request, socket, head, (ws) => {
        codexWss.emit('connection', ws, request);
      });
    } else if (pathname === goldrushPath) {
      goldrushWss.handleUpgrade(request, socket, head, (ws) => {
        goldrushWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

const port = Number(process.env.PORT || 4000);
server.listen(port, () => {
  console.log(`Unified server listening on http://localhost:${port}`);
  console.log(`Codex WS path: ${codexPath}`);
  console.log(`GoldRush WS path: ${goldrushPath}`);
});
