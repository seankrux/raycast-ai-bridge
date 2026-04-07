/**
 * AI Bridge — Background Processor (menu-bar command)
 *
 * Runs silently in the menu bar. Polls ~/.raycast-ai-bridge/request.json
 * every 500ms and processes requests via AI.ask — NO deep links, NO Raycast
 * window activation. Completely invisible.
 */
import { AI, Icon, LocalStorage, MenuBarExtra, environment } from "@raycast/api";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { useEffect, useRef, useState } from "react";
import { homedir } from "os";
import { join } from "path";

const BRIDGE_DIR    = join(homedir(), ".raycast-ai-bridge");
const REQUEST_FILE  = join(BRIDGE_DIR, "request.json");
const RESPONSE_FILE = join(BRIDGE_DIR, "response.json");
const STREAM_FILE   = join(BRIDGE_DIR, "stream.txt");

const KEY_ENABLED = "bridge_enabled";
const POLL_MS = 200;

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

// Heuristics to detect if AI.ask() was cut off mid-response
const TRUNCATION_SIGNALS = [
  /\d+\.\s*$/,                    // ends with "3. " (numbered list cut off)
  /[-–—]\s*$/,                    // ends with dash
  /[,;:]\s*$/,                    // ends mid-sentence
  /\b(and|or|the|a|an|to|of|in|for|with|that|this|but|is|are|was|were|will|would|can|could|should|have|has|had)\s*$/i,
  /```[a-z]*\s*\n(?!.*```)/s,    // opened code fence never closed
  /\|\s*$/,                       // table row cut off
];
const COMPLETION_SIGNALS = [
  /[.!?…"'`)\]}>]\s*$/,          // ends with sentence-ending punctuation
  /```\s*$/,                      // closed code fence
  /\n\s*$/,                       // ends with blank line
];
const MAX_CONTINUATIONS = 4;

function looksComplete(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return true;
  for (const sig of TRUNCATION_SIGNALS) {
    if (sig.test(trimmed)) return false;
  }
  for (const sig of COMPLETION_SIGNALS) {
    if (sig.test(trimmed)) return true;
  }
  // If response is short (< 200 chars), assume it's complete (simple answers)
  if (trimmed.length < 200) return true;
  return true; // default to complete
}

async function askWithStream(
  prompt: string,
  model: AI.Model,
  creativity: number,
  onData: (fullText: string) => void,
): Promise<string> {
  const answer = AI.ask(prompt, { model, creativity });
  let accumulated = "";
  let lastWrite = 0;
  answer.on("data", (chunk: string) => {
    accumulated += chunk;
    const now = Date.now();
    if (now - lastWrite > 60) {
      onData(accumulated);
      lastWrite = now;
    }
  });
  const final = await answer;
  onData(final);
  return final;
}

async function processRequest(request: BridgeRequest): Promise<void> {
  try { if (existsSync(RESPONSE_FILE)) unlinkSync(RESPONSE_FILE); } catch {}

  const fullPrompt = request.system
    ? `${request.system}\n\n${request.prompt}`
    : request.prompt;

  try {
    writeFileSync(STREAM_FILE, "");
    let fullContent = "";

    // Initial request
    const firstAnswer = await askWithStream(
      fullPrompt,
      request.model as AI.Model,
      request.creativity ?? 0.5,
      (text) => { writeFileSync(STREAM_FILE, text); },
    );
    fullContent = firstAnswer;

    // Auto-continue if truncated
    for (let i = 0; i < MAX_CONTINUATIONS; i++) {
      if (looksComplete(fullContent)) break;

      const contPrompt = request.system
        ? `${request.system}\n\n${request.prompt}\n\nYour previous response (continue EXACTLY where you left off, do NOT repeat any of this):\n${fullContent}\n\nContinue:`
        : `${request.prompt}\n\nYour previous response (continue EXACTLY where you left off, do NOT repeat any of this):\n${fullContent}\n\nContinue:`;

      const contAnswer = await askWithStream(
        contPrompt,
        request.model as AI.Model,
        request.creativity ?? 0.5,
        (text) => { writeFileSync(STREAM_FILE, fullContent + text); },
      );
      fullContent += contAnswer;
    }

    writeFileSync(STREAM_FILE, fullContent);
    const response: BridgeResponse = {
      id     : request.id,
      content: fullContent,
      model  : request.model,
      done   : true,
    };
    writeFileSync(RESPONSE_FILE, JSON.stringify(response));
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const response: BridgeResponse = {
      id     : request.id,
      content: "",
      model  : request.model,
      error  : msg,
      done   : true,
    };
    writeFileSync(RESPONSE_FILE, JSON.stringify(response));
  }
}

export default function Command() {
  const [busy, setBusy] = useState(false);
  const [lastModel, setLastModel] = useState("");
  const busyRef = useRef(false);

  useEffect(() => {
    if (!environment.canAccess(AI)) return;

    const timer = setInterval(async () => {
      // Don't overlap
      if (busyRef.current) return;

      // Check if bridge is enabled
      const enabled = await LocalStorage.getItem<string>(KEY_ENABLED);
      if (enabled !== "true") return;

      // Check for pending request
      if (!existsSync(REQUEST_FILE)) return;

      let request: BridgeRequest;
      try {
        request = JSON.parse(readFileSync(REQUEST_FILE, "utf-8"));
      } catch {
        return;
      }

      // Consume immediately
      try { unlinkSync(REQUEST_FILE); } catch {}

      busyRef.current = true;
      setBusy(true);
      setLastModel(request.model);

      await processRequest(request);

      busyRef.current = false;
      setBusy(false);
    }, POLL_MS);

    return () => clearInterval(timer);
  }, []);

  const title = busy ? `AI: ${lastModel.split("-").pop()}...` : undefined;

  return (
    <MenuBarExtra
      icon={busy ? Icon.CircleProgress : Icon.Bolt}
      title={title}
      tooltip={busy ? `Processing: ${lastModel}` : "AI Bridge — idle"}
    >
      <MenuBarExtra.Item
        title={busy ? `Processing: ${lastModel}` : "AI Bridge — idle"}
        icon={busy ? Icon.CircleProgress : Icon.CheckCircle}
      />
    </MenuBarExtra>
  );
}
