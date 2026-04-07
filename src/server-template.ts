/**
 * Embedded HTTP server script.
 * Written to ~/.raycast-ai-bridge/server.js at runtime and spawned as a
 * detached child process. Pure Node.js — no Raycast API.
 */
export const SERVER_SCRIPT = /* js */ `
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const BRIDGE_DIR  = path.join(os.homedir(), '.raycast-ai-bridge');
const REQ_FILE    = path.join(BRIDGE_DIR, 'request.json');
const RESP_FILE   = path.join(BRIDGE_DIR, 'response.json');
const STREAM_FILE = path.join(BRIDGE_DIR, 'stream.txt');
const PID_FILE    = path.join(BRIDGE_DIR, 'server.pid');
const PORT        = parseInt(process.env.BRIDGE_PORT || '3099', 10);
const BIND_ADDR   = process.env.BRIDGE_BIND || '127.0.0.1';
const TIMEOUT_MS  = 180_000;
const POLL_MS     = 50;


// Auto-generate alias map so any ray/* name resolves to a Raycast model ID.
function buildAliases() {
  const aliases = {};
  const sources = ['selected-models.json', 'available-models.json'];
  const allIds = new Set();
  for (const file of sources) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, file), 'utf-8'));
      arr.forEach(id => allIds.add(id));
    } catch {}
  }

  const PREFIXES = [
    ['openai_o1-', 'OpenAI'],
    ['openai-',    'OpenAI'],
    ['anthropic-', 'Anthropic'],
    ['google-',    'Google'],
    ['xai-',       'xAI'],
    ['mistral-',   'Mistral'],
    ['together-',  'Together'],
    ['perplexity-','Perplexity'],
    ['groq-',      'Groq'],
  ];

  for (const id of allIds) {
    for (const [prefix] of PREFIXES) {
      if (id.startsWith(prefix)) {
        let shortName = id.slice(prefix.length);
        if (shortName.includes('/')) shortName = shortName.split('/').pop();
        const cleaned = shortName.replace(/-latest$/, '').replace(/-versatile$/, '').replace(/-instant$/, '');
        aliases['ray/' + cleaned.toLowerCase()] = id;
        if (cleaned !== shortName) {
          aliases['ray/' + shortName.toLowerCase()] = id;
        }
        break;
      }
    }
    aliases[id] = id;
  }
  return aliases;
}

const MODEL_ALIASES = buildAliases();

function resolveModel(name) {
  if (name.startsWith('rb/')) {
    const rayName = 'ray/' + name.slice(3);
    if (MODEL_ALIASES[rayName]) return MODEL_ALIASES[rayName];
  }
  return MODEL_ALIASES[name] || name;
}

// ── fs.watch-based response waiter (instant detection, no polling delay) ──
function waitForResponse(id, timeout) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    let watcher = null;
    let fallbackTimer = null;

    const tryRead = () => {
      try {
        const raw = fs.readFileSync(RESP_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data.id !== id) return false;
        cleanup();
        try { fs.unlinkSync(RESP_FILE); } catch {}
        resolve(data);
        return true;
      } catch { return false; }
    };

    const cleanup = () => {
      if (watcher) { try { watcher.close(); } catch {} watcher = null; }
      if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    };

    // Try fs.watch for near-instant detection
    try {
      watcher = fs.watch(BRIDGE_DIR, (_, filename) => {
        if (filename === 'response.json') tryRead();
      });
      watcher.on('error', () => {}); // ignore watch errors
    } catch {}

    // Fallback poll in case fs.watch misses events
    fallbackTimer = setInterval(() => {
      if (tryRead()) return;
      if (Date.now() > deadline) {
        cleanup();
        reject(new Error('Timed out waiting for Raycast AI response'));
      }
    }, 200);

    // Initial check
    tryRead();
  });
}

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' };

// ── Request queue — serializes requests instead of rejecting with 429 ──
const MAX_QUEUE = 10;
const queue = [];       // Array of { resolve } — waiters for their turn
let busy = false;
let busySince = 0;
const BUSY_TIMEOUT = 180_000;

function acquireLock() {
  // Auto-release stuck lock
  if (busy && Date.now() - busySince > BUSY_TIMEOUT) {
    busy = false;
    // Drain stale request file
    try { fs.unlinkSync(REQ_FILE); } catch {}
  }
  if (!busy) {
    busy = true;
    busySince = Date.now();
    return Promise.resolve();
  }
  // Wait in queue
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE) {
      return reject(new Error('Queue full (' + MAX_QUEUE + ' waiting)'));
    }
    queue.push({ resolve });
  });
}

function releaseLock() {
  if (queue.length > 0) {
    const next = queue.shift();
    busySince = Date.now();
    next.resolve(); // hand lock to next waiter
  } else {
    busy = false;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, JSON_HEADERS);
    return res.end(JSON.stringify({ status: 'ok', port: PORT, pid: process.pid, busy, queued: queue.length }));
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    let ids = [];
    try { ids = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'selected-models.json'), 'utf-8')); } catch {}
    res.writeHead(200, JSON_HEADERS);
    return res.end(JSON.stringify({
      object: 'list',
      data: ids.map(id => ({ id, object: 'model', created: 0, owned_by: 'raycast' })),
    }));
  }

  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch {
        res.writeHead(400, JSON_HEADERS);
        return res.end(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request' } }));
      }

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
        model     : resolveModel(data.model || 'openai-gpt-4o'),
        creativity: typeof data.temperature === 'number' ? data.temperature : 0.5,
        system    : systemMsg ? (typeof systemMsg.content === 'string' ? systemMsg.content : '') : undefined,
      };

      // Acquire lock (waits in queue if busy)
      acquireLock().then(() => {
        try {
          fs.writeFileSync(REQ_FILE, JSON.stringify(request));
        } catch (e) {
          releaseLock();
          res.writeHead(500, JSON_HEADERS);
          return res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
        }

        const wantStream = !!data.stream;

        if (wantStream) {
          res.writeHead(200, {
            ...CORS,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.flushHeaders();

          const NL2 = String.fromCharCode(10) + String.fromCharCode(10);
          let lastLen = 0;
          const deadline = Date.now() + TIMEOUT_MS;
          let done = false;

          res.on('close', () => {
            if (!done) { finish(); releaseLock(); }
          });

          let streamWatcher = null;
          try {
            streamWatcher = fs.watch(BRIDGE_DIR, (_, filename) => {
              if (done) return;
              if (filename === 'stream.txt') emitDelta();
              if (filename === 'response.json') checkDone();
            });
            streamWatcher.on('error', () => {});
          } catch {}

          const emitDelta = () => {
            try {
              const content = fs.readFileSync(STREAM_FILE, 'utf-8');
              if (content.length > lastLen) {
                const delta = content.slice(lastLen);
                lastLen = content.length;
                res.write('data: ' + JSON.stringify({
                  id: 'chatcmpl-' + id,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: request.model,
                  choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                }) + NL2);
              }
            } catch {}
          };

          const finish = () => {
            if (done) return;
            done = true;
            if (streamWatcher) { try { streamWatcher.close(); } catch {} }
            clearInterval(fallbackTimer);
          };

          const checkDone = () => {
            try {
              const respData = JSON.parse(fs.readFileSync(RESP_FILE, 'utf-8'));
              if (respData.id !== id) return;
              finish();
              try { fs.unlinkSync(RESP_FILE); } catch {}
              releaseLock();

              if (respData.error) {
                res.write('data: ' + JSON.stringify({
                  id: 'chatcmpl-' + id, object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000), model: request.model,
                  choices: [{ index: 0, delta: { content: '[Bridge Error] ' + respData.error }, finish_reason: null }],
                }) + NL2);
              } else {
                emitDelta();
              }
              res.write('data: ' + JSON.stringify({
                id: 'chatcmpl-' + id, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000), model: respData.model || request.model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              }) + NL2);
              res.write('data: [DONE]' + NL2);
              res.end();
            } catch {}
          };

          const fallbackTimer = setInterval(() => {
            if (done) return;
            if (Date.now() > deadline) {
              finish();
              releaseLock();
              res.write('data: [DONE]' + NL2);
              res.end();
              return;
            }
            emitDelta();
            checkDone();
          }, 250);

        } else {
          res.on('close', () => { releaseLock(); });

          waitForResponse(id, TIMEOUT_MS).then(
            (resp) => {
              releaseLock();
              if (resp.error) {
                res.writeHead(500, JSON_HEADERS);
                res.end(JSON.stringify({ error: { message: resp.error, type: 'bridge_error' } }));
              } else {
                res.writeHead(200, JSON_HEADERS);
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
              releaseLock();
              res.writeHead(504, JSON_HEADERS);
              res.end(JSON.stringify({ error: { message: err.message, type: 'timeout' } }));
            }
          );
        }
      }, (err) => {
        // acquireLock rejected — queue full
        res.writeHead(429, JSON_HEADERS);
        res.end(JSON.stringify({ error: { message: err.message, type: 'rate_limit' } }));
      });
    });
    return;
  }

  res.writeHead(404, JSON_HEADERS);
  res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found' } }));
});

server.listen(PORT, BIND_ADDR, () => {
  try { fs.writeFileSync(PID_FILE, process.pid.toString()); } catch {}
  console.log('[AI Bridge] Listening on http://' + BIND_ADDR + ':' + PORT);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
`;
