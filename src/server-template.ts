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

// Alias map: droid sends "ray/*" names, bridge translates to Raycast model IDs
const MODEL_ALIASES = {
  'ray/gpt-4o':          'openai-gpt-4o',
  'ray/gpt-4o-mini':     'openai-gpt-4o-mini',
  'ray/gpt-4.1':         'openai-gpt-4.1',
  'ray/gpt-4.1-mini':    'openai-gpt-4.1-mini',
  'ray/gpt-4.1-nano':    'openai-gpt-4.1-nano',
  'ray/o1':              'openai_o1-o1',
  'ray/o3':              'openai_o1-o3',
  'ray/o3-mini':         'openai_o1-o3-mini',
  'ray/o4-mini':         'openai_o1-o4-mini',
  'ray/claude-3.5-haiku':   'anthropic-claude-haiku-3-5',
  'ray/claude-3.5-sonnet':  'anthropic-claude-sonnet-3-5',
  'ray/claude-sonnet-4':    'anthropic-claude-sonnet-4',
  'ray/claude-4.5-sonnet':  'anthropic-claude-sonnet-4-5',
  'ray/claude-4.6-sonnet':  'anthropic-claude-sonnet-4-6',
  'ray/claude-opus-4':      'anthropic-claude-opus-4',
  'ray/claude-4.5-opus':    'anthropic-claude-opus-4-5',
  'ray/claude-4.6-opus':    'anthropic-claude-opus-4-6',
  'ray/gemini-2.0-flash':     'google-gemini-2.0-flash',
  'ray/gemini-2.5-flash':     'google-gemini-2.5-flash',
  'ray/gemini-2.5-flash-lite':'google-gemini-2.5-flash-lite',
  'ray/gemini-2.5-pro':       'google-gemini-2.5-pro',
  'ray/grok-3':          'xai-grok-3',
  'ray/grok-3-mini':     'xai-grok-3-mini',
  'ray/grok-4':          'xai-grok-4',
  'ray/grok-4-fast':     'xai-grok-4-fast',
  'ray/codestral':       'mistral-codestral-latest',
  'ray/mistral-large':   'mistral-mistral-large-latest',
  'ray/mistral-medium':  'mistral-mistral-medium-latest',
  'ray/mistral-small':   'mistral-mistral-small-latest',
  'ray/deepseek-r1':     'together-deepseek-ai/DeepSeek-R1',
  'ray/deepseek-v3':     'together-deepseek-ai/DeepSeek-V3',
  'ray/kimi-k2.5':       'together-moonshotai/Kimi-K2.5',
  'ray/sonar':           'perplexity-sonar',
  'ray/sonar-pro':       'perplexity-sonar-pro',
  'ray/llama-3.3-70b':   'groq-llama-3.3-70b-versatile',
  'ray/llama-3.1-8b':    'groq-llama-3.1-8b-instant',
  'ray/llama-4-scout':   'groq-meta-llama/llama-4-scout-17b-16e-instruct',
  'ray/kimi-k2':         'groq-moonshotai/kimi-k2-instruct',
  'ray/qwen3-32b':       'groq-qwen/qwen3-32b',
};

function resolveModel(name) {
  return MODEL_ALIASES[name] || name;
}

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

      triggerRaycast();

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

server.listen(PORT, '127.0.0.1', () => {
  try { fs.writeFileSync(PID_FILE, process.pid.toString()); } catch {}
  console.log('[AI Bridge] Listening on http://127.0.0.1:' + PORT);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
`;
