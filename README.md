# AI Bridge — Raycast Extension

Expose every Raycast AI model as a local **OpenAI-compatible HTTP endpoint** you can curl, paste into any tool, or use from an SSH session.

```
POST http://localhost:3099/v1/chat/completions
```

---

## Requirements

| Requirement | Notes |
|---|---|
| **macOS only** | Raycast does not exist on Windows or Linux |
| **Raycast** | https://raycast.com — free download |
| **Raycast Pro** | Required for AI features (any paid plan) |
| **Node.js ≥ 18** | Already installed if you use Raycast extensions |

> **Windows / Linux:** This extension will not work. Raycast is a macOS-exclusive app.
> For a Windows alternative, look into [Raycast for Windows](https://www.raycast.com/windows) (waitlist as of 2025) or use the OpenAI API directly.

---

## Install

### Option A — Import from this folder (recommended)

1. Clone or download this repo:
   ```bash
   git clone https://github.com/seankrux/raycast-ai-bridge
   cd raycast-ai-bridge
   npm install
   ```
2. Open Raycast (`⌘Space` → Raycast)
3. Run the command **Import Extension**
4. Point it to this folder
5. Raycast will register both commands automatically

### Option B — Dev mode (live reload)

```bash
cd raycast-ai-bridge
npm install
npm run dev        # keeps extension hot-reloading while you edit
```

### Option C — Production build

```bash
npm install
npm run build      # compiles to dist/, then import the folder in Raycast
```

---

## Commands

| Command | Mode | Purpose |
|---|---|---|
| **AI Bridge — Manage** | View | Control panel: toggle on/off, scan models, select models, copy endpoint URL |
| **AI Bridge — Process Request** | No-view (background) | Handles incoming requests — triggered automatically by the HTTP server |

You only ever open **AI Bridge — Manage** manually. The Process command runs silently in the background via a deep link.

---

## Usage

### 1. Open the control panel

Raycast → type **AI Bridge Manage** → Enter

### 2. Scan your available models

Press `⌘R` on the **Scan Available Models** row.
The extension probes each model against your Raycast Pro subscription (batches of 4, ~8 seconds total). Available models get a green **verified** tag. Unavailable ones get a red tag.

### 3. Select which models to expose

Each model has a checkbox (Enter to toggle). Per-provider **Select All / Deselect All** shortcuts are at the top of each provider section.

### 4. Turn it on

Press Enter on the **Bridge: OFF** row → it switches to **ON**.

The endpoint URL appears immediately below, paste-ready:

```
http://localhost:3099/v1/chat/completions
```

The HTTP server runs as a **persistent detached process** — it stays alive even after you close Raycast.

### 5. Turn it off

Press Enter on the **Bridge: ON** row → server stops.

---

## Using the endpoint

### curl

```bash
curl http://localhost:3099/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic-claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### From an SSH session (e.g. Haiku on remote machine)

Forward the port over SSH so the remote machine can reach your Mac:

```bash
# On your Mac — start the bridge first, then SSH with reverse tunnel
ssh -R 3099:localhost:3099 user@remote-host

# On the remote machine
curl http://localhost:3099/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"openai-gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

### Claude Code / any OpenAI-compatible CLI

```bash
export OPENAI_API_BASE=http://localhost:3099/v1
export OPENAI_API_KEY=raycast   # any non-empty string works
```

### List available models

```bash
curl http://localhost:3099/v1/models
```

### Health check

```bash
curl http://localhost:3099/health
```

---

## Configuration

Open Raycast Preferences → Extensions → AI Bridge → **HTTP Port**
Default: `3099`. Change if that port is taken.

---

## How it works

```
SSH / curl / CLI tool
        │  POST /v1/chat/completions
        ▼
  HTTP Server (Node.js, detached)
  ~/.raycast-ai-bridge/server.js
        │  writes request.json
        │  open raycast://extensions/seancrooks/ai-bridge/process
        ▼
  Raycast (AI Bridge — Process)
        │  calls AI.ask() with your Raycast Pro subscription
        │  writes response.json
        ▼
  HTTP Server reads response.json → returns OpenAI-format JSON
        │
        ▼
  Your tool gets the answer
```

All IPC is via `~/.raycast-ai-bridge/` — no network calls leave your Mac.

---

## Files created at runtime

| Path | Contents |
|---|---|
| `~/.raycast-ai-bridge/server.js` | Auto-generated HTTP server script |
| `~/.raycast-ai-bridge/server.pid` | PID of the running server |
| `~/.raycast-ai-bridge/request.json` | Pending request (consumed immediately) |
| `~/.raycast-ai-bridge/response.json` | Response written by Raycast (consumed immediately) |
| `~/.raycast-ai-bridge/selected-models.json` | Your saved model selection |
| `~/.raycast-ai-bridge/available-models.json` | Models verified by the last scan |

---

## Supported models (scanned at runtime)

| Provider | Models |
|---|---|
| OpenAI | GPT-4o, GPT-4o Mini, GPT-4.1, o1, o3, o4-mini, … |
| Anthropic | Claude 3.5 Haiku, Claude Sonnet 4/4.5/4.6, Claude Opus 4/4.5/4.6 |
| Google | Gemini 2.0 Flash, Gemini 2.5 Flash, Gemini 2.5 Pro |
| xAI | Grok 3, Grok 4 |
| Mistral | Codestral, Mistral Large/Medium/Small |
| Together AI | DeepSeek R1/V3, Kimi K2.5 |
| Perplexity | Sonar, Sonar Pro |
| Groq | Llama 3.3 70B, Llama 3.1 8B, Llama 4 Scout, Kimi K2, Qwen 3 32B |

Which models are actually available depends on your Raycast Pro plan. Use **Scan Models** (`⌘R`) to detect yours.

---

## Troubleshooting

**Bridge shows ON but server isn't responding**
→ Toggle OFF then ON again. This kills any stale process and restarts the server.

**"AI Bridge is off" HUD when a request comes in**
→ Open AI Bridge Manage and toggle ON. The enabled state persists across Raycast restarts.

**Port already in use**
→ Change the port in Raycast Preferences → Extensions → AI Bridge.
Or kill the old server: `kill $(cat ~/.raycast-ai-bridge/server.pid)`

**Request times out (504)**
→ Raycast needs to be running (not quit) for AI.ask to work. Keep Raycast in the menu bar.
