/**
 * AI Bridge — Background Processor (menu-bar command)
 *
 * Runs silently in the menu bar. Polls ~/.raycast-ai-bridge/request.json
 * every cycle and processes requests via AI.ask — NO deep links, NO Raycast
 * window activation. Completely invisible.
 */
import { AI, Icon, LocalStorage, MenuBarExtra, environment } from "@raycast/api";
import { existsSync, readFileSync, unlinkSync, writeFileSync, watch, type FSWatcher } from "fs";
import { useEffect, useRef, useState } from "react";
import { homedir } from "os";
import { join } from "path";

const BRIDGE_DIR    = join(homedir(), ".raycast-ai-bridge");
const REQUEST_FILE  = join(BRIDGE_DIR, "request.json");
const RESPONSE_FILE = join(BRIDGE_DIR, "response.json");
const STREAM_FILE   = join(BRIDGE_DIR, "stream.txt");

const KEY_ENABLED = "bridge_enabled";
const POLL_FALLBACK_MS = 2000; // fallback poll — fs.watch handles the fast path
const ENABLED_CACHE_MS = 10000;

interface BridgeRequest {
  id         : string;
  prompt     : string;
  model      : string;
  creativity?: number;
  system?    : string;
}

interface BridgeResponse {
  id     : string;
  content: string;
  model  : string;
  error? : string;
  done   : boolean;
}

// Truncation detection — only check last 120 chars for speed
const TRUNCATION_RE = /(?:\d+\.\s*$|[-–—]\s*$|[,;:]\s*$|\b(?:and|or|the|a|an|to|of|in|for|with|that|this|but|is|are|was|were|will|would|can|could|should|have|has|had)\s*$|```[a-z]*\s*\n(?![\s\S]*```)|\|\s*$)/i;
const COMPLETION_RE = /(?:[.!?…"'`)\]}>]\s*$|```\s*$|\n\s*$)/;
const MAX_CONTINUATIONS = 20;
const CONT_TAIL_CHARS = 800; // only send last N chars in continuation prompt

function looksComplete(text: string): boolean {
  const tail = text.trimEnd().slice(-120);
  if (!tail) return true;
  if (TRUNCATION_RE.test(tail)) return false;
  if (COMPLETION_RE.test(tail)) return true;
  if (text.length < 200) return true;
  return true;
}

async function processRequest(request: BridgeRequest): Promise<void> {
  try { unlinkSync(RESPONSE_FILE); } catch {}

  const basePrompt = request.system
    ? `${request.system}\n\n${request.prompt}`
    : request.prompt;
  const model      = request.model as AI.Model;
  const creativity = request.creativity ?? 0.5;

  try {
    writeFileSync(STREAM_FILE, "");
    let full = "";
    let lastFlush = 0;

    const flush = () => {
      const now = Date.now();
      if (now - lastFlush > 50) {
        writeFileSync(STREAM_FILE, full);
        lastFlush = now;
      }
    };

    // Initial request — data handler streams incrementally, await gives final text
    const answer = AI.ask(basePrompt, { model, creativity });
    answer.on("data", (chunk: string) => { full += chunk; flush(); });
    full = await answer; // overwrite with authoritative final text
    writeFileSync(STREAM_FILE, full);

    // Auto-continue if truncated
    for (let i = 0; i < MAX_CONTINUATIONS && !looksComplete(full); i++) {
      const tail = full.slice(-CONT_TAIL_CHARS);
      // Use only the user prompt (not system) in continuation to save context
      const contPrompt = `${request.prompt}\n\n---\nYour previous response ended with:\n${tail}\n\nContinue EXACTLY where you left off. Do NOT repeat anything above.`;

      const prefixLen = full.length;
      const cont = AI.ask(contPrompt, { model, creativity });
      cont.on("data", (chunk: string) => {
        // Append chunk to full, but only from the continuation portion
        full = full.slice(0, prefixLen) + chunk;
        flush();
      });
      const contResult = await cont;
      full = full.slice(0, prefixLen) + contResult; // overwrite with authoritative
      writeFileSync(STREAM_FILE, full);
    }

    writeFileSync(RESPONSE_FILE, JSON.stringify({
      id: request.id, content: full, model: request.model, done: true,
    } satisfies BridgeResponse));
  } catch (error: unknown) {
    writeFileSync(RESPONSE_FILE, JSON.stringify({
      id: request.id, content: "", model: request.model,
      error: error instanceof Error ? error.message : String(error), done: true,
    } satisfies BridgeResponse));
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function friendlyModel(id: string): string {
  // "openai-gpt-4o" → "GPT-4o", "anthropic-claude-3-5-sonnet" → "Claude 3.5 Sonnet"
  const stripped = id
    .replace(/^(openai[-_]?|anthropic[-_]?|google[-_]?|xai[-_]?|mistral[-_]?|together[-_]?|perplexity[-_]?|groq[-_]?)/, "")
    .replace(/-latest$/, "");
  return stripped
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default function Command() {
  const [busy, setBusy] = useState(false);
  const [lastModel, setLastModel] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [reqCount, setReqCount] = useState(0);
  const [lastError, setLastError] = useState("");
  const [lastDuration, setLastDuration] = useState(0);
  const busyRef = useRef(false);
  const enabledRef = useRef(false);
  const enabledAtRef = useRef(0);
  const startedAtRef = useRef(0);

  // Elapsed time ticker — updates every second while busy
  useEffect(() => {
    if (!busy) return;
    const tid = setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current);
    }, 1000);
    return () => clearInterval(tid);
  }, [busy]);

  useEffect(() => {
    if (!environment.canAccess(AI)) return;

    let fallbackTid: ReturnType<typeof setTimeout>;
    let watcher: FSWatcher | null = null;

    let consuming = false;
    const tryConsume = async () => {
      if (busyRef.current || consuming) return;
      consuming = true;

      // Cache the LocalStorage check
      const now = Date.now();
      if (now - enabledAtRef.current > ENABLED_CACHE_MS) {
        enabledRef.current = (await LocalStorage.getItem<string>(KEY_ENABLED)) === "true";
        enabledAtRef.current = now;
      }
      if (!enabledRef.current) { consuming = false; return; }

      let request: BridgeRequest;
      try {
        request = JSON.parse(readFileSync(REQUEST_FILE, "utf-8"));
      } catch {
        consuming = false;
        return;
      }

      try { unlinkSync(REQUEST_FILE); } catch {}

      const t0 = Date.now();
      busyRef.current = true;
      startedAtRef.current = t0;
      setBusy(true);
      setElapsed(0);
      setLastModel(request.model);
      setLastError("");
      setReqCount(c => c + 1);

      await processRequest(request);

      const duration = Date.now() - t0;
      busyRef.current = false;
      consuming = false;
      setLastDuration(duration);
      setBusy(false);

      // Check if the response had an error
      try {
        const resp: BridgeResponse = JSON.parse(readFileSync(RESPONSE_FILE, "utf-8"));
        if (resp.error) setLastError(resp.error);
      } catch {}
    };

    // fs.watch — wakes up instantly when request.json appears, near-zero CPU when idle
    try {
      watcher = watch(BRIDGE_DIR, (_, filename) => {
        if (filename === "request.json") tryConsume();
      });
      watcher.on("error", () => {});
    } catch {}

    // Fallback poll every 2s in case fs.watch misses an event
    const fallbackPoll = () => {
      tryConsume();
      fallbackTid = setTimeout(fallbackPoll, POLL_FALLBACK_MS);
    };
    fallbackTid = setTimeout(fallbackPoll, 500);

    return () => {
      if (watcher) { try { watcher.close(); } catch {} }
      clearTimeout(fallbackTid);
    };
  }, []);

  return (
    <MenuBarExtra
      icon={Icon.Bolt}
      isLoading={busy}
      tooltip={busy ? `Processing: ${friendlyModel(lastModel)}` : "AI Bridge"}
    >
      {busy ? (
        <>
          <MenuBarExtra.Section title="Processing">
            <MenuBarExtra.Item
              title={friendlyModel(lastModel)}
              subtitle={formatElapsed(elapsed)}
              icon={Icon.CircleProgress}
            />
          </MenuBarExtra.Section>
          <MenuBarExtra.Section>
            <MenuBarExtra.Item title={`Request #${reqCount}`} icon={Icon.Document} />
          </MenuBarExtra.Section>
        </>
      ) : (
        <>
          <MenuBarExtra.Section title="Status">
            <MenuBarExtra.Item
              title="Idle"
              subtitle="Waiting for requests"
              icon={Icon.CheckCircle}
            />
          </MenuBarExtra.Section>
          {lastModel && (
            <MenuBarExtra.Section title="Last Request">
              <MenuBarExtra.Item
                title={friendlyModel(lastModel)}
                subtitle={lastDuration > 0 ? formatElapsed(lastDuration) : undefined}
                icon={lastError ? Icon.ExclamationMark : Icon.CheckCircle}
              />
              {lastError && (
                <MenuBarExtra.Item
                  title={lastError.slice(0, 60)}
                  icon={Icon.XMarkCircle}
                />
              )}
            </MenuBarExtra.Section>
          )}
          <MenuBarExtra.Section>
            <MenuBarExtra.Item
              title={`${reqCount} request${reqCount !== 1 ? "s" : ""} processed`}
              icon={Icon.BarChart}
            />
          </MenuBarExtra.Section>
        </>
      )}
    </MenuBarExtra>
  );
}
