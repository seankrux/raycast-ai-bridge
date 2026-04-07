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
const PID_FILE    = path.join(BRIDGE_DIR, 'server.pid');
const PORT        = parseInt(process.env.BRIDGE_PORT || '3099', 10);
const BIND_ADDR   = process.env.BRIDGE_BIND || '127.0.0.1';
const TIMEOUT_MS  = 180_000;
const POLL_MS     = 80;


// Auto-generate alias map so any ray/* name resolves to a Raycast model ID.
// Reads both selected-models.json AND available-models.json to cover everything.
// Droid sends "ray/<short-name>", bridge translates to full Raycast model ID.
function buildAliases() {
  const aliases = {};
  // Read ALL known model IDs (selected + available + any we've seen)
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
    // Generate ray/<short> alias by stripping the provider prefix
    for (const [prefix] of PREFIXES) {
      if (id.startsWith(prefix)) {
        let shortName = id.slice(prefix.length);
        // Clean up org prefixes (e.g. "deepseek-ai/DeepSeek-R1" → "DeepSeek-R1")
        if (shortName.includes('/')) shortName = shortName.split('/').pop();
        // Remove common suffixes for cleaner aliases
        const cleaned = shortName.replace(/-latest$/, '').replace(/-versatile$/, '').replace(/-instant$/, '');
        // Register BOTH the cleaned alias and the full short name to avoid collisions
        aliases['ray/' + cleaned.toLowerCase()] = id;
        if (cleaned !== shortName) {
          aliases['ray/' + shortName.toLowerCase()] = id;
        }
        break;
      }
    }
    // Also allow the raw model ID as-is
    aliases[id] = id;
  }
  return aliases;
}

const MODEL_ALIASES = buildAliases();

function resolveModel(name) {
  // Support both ray/ and rb/ prefixes (rb = raycast-bridge, avoids droid's provider detection)
  if (name.startsWith('rb/')) {
    const rayName = 'ray/' + name.slice(3);
    if (MODEL_ALIASES[rayName]) return MODEL_ALIASES[rayName];
  }
  return MODEL_ALIASES[name] || name;
}

// No triggerRaycast needed — the menu-bar command polls for request.json automatically

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
        model     : resolveModel(data.model || 'openai-gpt-4o'),
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

      const wantStream = !!data.stream;

      // Menu-bar command polls for request.json — no trigger needed

      if (wantStream) {
        // ── SSE streaming mode ──────────────────────────────────────────
        res.writeHead(200, {
          ...CORS,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const STREAM_FILE = path.join(BRIDGE_DIR, 'stream.txt');
        const NL2 = String.fromCharCode(10) + String.fromCharCode(10); // \\n\\n for SSE
        let lastLen = 0;
        const deadline = Date.now() + TIMEOUT_MS;

        const streamTimer = setInterval(() => {
          // Stream partial content from stream.txt (written by Raycast during AI.ask)
          try {
            if (fs.existsSync(STREAM_FILE)) {
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
            }
          } catch {}

          // Check for final response
          if (fs.existsSync(RESP_FILE)) {
            try {
              const respData = JSON.parse(fs.readFileSync(RESP_FILE, 'utf-8'));
              if (respData.id === id) {
                clearInterval(streamTimer);
                try { fs.unlinkSync(RESP_FILE); } catch {}
                busy = false;

                if (respData.error) {
                  // Send error as visible content so the user sees it
                  res.write('data: ' + JSON.stringify({
                    id: 'chatcmpl-' + id,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: request.model,
                    choices: [{ index: 0, delta: { content: '[Bridge Error] ' + respData.error }, finish_reason: null }],
                  }) + NL2);
                  res.write('data: ' + JSON.stringify({
                    id: 'chatcmpl-' + id,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  }) + NL2);
                } else {
                  // Send any remaining content
                  try {
                    const final = fs.readFileSync(STREAM_FILE, 'utf-8');
                    if (final.length > lastLen) {
                      res.write('data: ' + JSON.stringify({
                        id: 'chatcmpl-' + id,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: respData.model,
                        choices: [{ index: 0, delta: { content: final.slice(lastLen) }, finish_reason: null }],
                      }) + NL2);
                    }
                  } catch {}
                  // Send stop
                  res.write('data: ' + JSON.stringify({
                    id: 'chatcmpl-' + id,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: respData.model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  }) + NL2);
                }
                res.write('data: [DONE]' + NL2);
                res.end();
                return;
              }
            } catch {}
          }

          if (Date.now() > deadline) {
            clearInterval(streamTimer);
            busy = false;
            res.write('data: [DONE]' + NL2);
            res.end();
          }
        }, POLL_MS);

      } else {
        // ── Non-streaming mode ──────────────────────────────────────────
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
      }
    });
    return;
  }

  res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found' } }));
});

server.listen(PORT, BIND_ADDR, () => {
  try { fs.writeFileSync(PID_FILE, process.pid.toString()); } catch {}
  console.log('[AI Bridge] Listening on http://' + BIND_ADDR + ':' + PORT);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
`;
