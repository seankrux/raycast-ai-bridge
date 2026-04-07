/**
 * Embedded HTTP server script.
 * Written to ~/.raycast-ai-bridge/server.js at runtime and spawned as a
 * detached child process. Pure Node.js — no Raycast API.
 */
export const SERVER_SCRIPT = /* js */ `
'use strict';
const http = require('http');
const fs   = require('fs');
const { exec } = require('child_process');
const path = require('path');
const os   = require('os');

const BRIDGE_DIR  = path.join(os.homedir(), '.raycast-ai-bridge');
const REQ_FILE    = path.join(BRIDGE_DIR, 'request.json');
const RESP_FILE   = path.join(BRIDGE_DIR, 'response.json');
const PID_FILE    = path.join(BRIDGE_DIR, 'server.pid');
const PORT        = parseInt(process.env.BRIDGE_PORT || '3099', 10);
const TIMEOUT_MS  = 90_000;
const POLL_MS     = 150;

// Deep-link that triggers the process command inside Raycast
const DEEP_LINK = 'raycast://extensions/seancrooks/ai-bridge/process';

function triggerRaycast() {
  exec('open "' + DEEP_LINK + '"', () => {});
}

function waitForResponse(id, resolve, reject) {
  const deadline = Date.now() + TIMEOUT_MS;
  const timer = setInterval(() => {
    if (Date.now() > deadline) {
      clearInterval(timer);
      return reject(new Error('Timed out waiting for Raycast AI response'));
    }
    if (!fs.existsSync(RESP_FILE)) return;
    try {
      const data = JSON.parse(fs.readFileSync(RESP_FILE, 'utf-8'));
      if (data.id !== id) return;
      clearInterval(timer);
      try { fs.unlinkSync(RESP_FILE); } catch {}
      resolve(data);
    } catch {}
  }, POLL_MS);
}

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

let busy = false; // one request at a time (Raycast AI is single-threaded per extension)

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // ── GET /health ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', port: PORT, pid: process.pid }));
  }

  // ── GET /v1/models ───────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/v1/models') {
    let ids = [];
    try {
      ids = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'selected-models.json'), 'utf-8'));
    } catch {}
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: ids.map(id => ({ id, object: 'model', created: 0, owned_by: 'raycast' })),
    }));
  }

  // ── POST /v1/chat/completions ─────────────────────────────────────────────
  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    if (busy) {
      res.writeHead(429, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Bridge busy — one request at a time', type: 'rate_limit' } }));
    }

    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch {
        res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request' } }));
      }

      // Build flat prompt from messages array (OpenAI format)
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const systemMsg = messages.find(m => m.role === 'system');
      const userMsgs  = messages.filter(m => m.role !== 'system');
      const prompt = userMsgs.map(m => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.filter(p => p.type === 'text').map(p => p.text).join('\\n');
        return '';
      }).join('\\n\\n');

      const id = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const request = {
        id,
        prompt,
        model     : data.model || 'openai-gpt-4o',
        creativity: typeof data.temperature === 'number' ? data.temperature : 0.5,
        system    : systemMsg ? (typeof systemMsg.content === 'string' ? systemMsg.content : '') : undefined,
      };

      busy = true;
      try {
        fs.writeFileSync(REQ_FILE, JSON.stringify(request));
      } catch (e) {
        busy = false;
        res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
      }

      triggerRaycast();

      waitForResponse(
        id,
        (resp) => {
          busy = false;
          if (resp.error) {
            res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: resp.error, type: 'bridge_error' } }));
          } else {
            res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id     : 'chatcmpl-' + id,
              object : 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model  : resp.model,
              choices: [{
                index        : 0,
                message      : { role: 'assistant', content: resp.content },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }));
          }
        },
        (err) => {
          busy = false;
          res.writeHead(504, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message, type: 'timeout' } }));
        }
      );
    });
    return;
  }

  res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  try { fs.writeFileSync(PID_FILE, process.pid.toString()); } catch {}
  console.log('[AI Bridge] Listening on http://127.0.0.1:' + PORT);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
`;
