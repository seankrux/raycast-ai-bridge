/**
 * AI Bridge — Process Request (no-view command)
 *
 * Triggered automatically by the HTTP server via:
 *   open "raycast://extensions/seancrooks/ai-bridge/process"
 *
 * Reads ~/.raycast-ai-bridge/request.json, calls AI.ask, writes response.json.
 */
import { AI, LocalStorage, environment, showHUD } from "@raycast/api";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BRIDGE_DIR    = join(homedir(), ".raycast-ai-bridge");
const REQUEST_FILE  = join(BRIDGE_DIR, "request.json");
const RESPONSE_FILE = join(BRIDGE_DIR, "response.json");
const STREAM_FILE   = join(BRIDGE_DIR, "stream.txt");

const KEY_ENABLED = "bridge_enabled";

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

export default async function Command() {
  if (!environment.canAccess(AI)) {
    await showHUD("AI Bridge: Raycast Pro required");
    return;
  }

  // Bail if bridge is toggled off
  const enabled = await LocalStorage.getItem<string>(KEY_ENABLED);
  if (enabled !== "true") {
    await showHUD("AI Bridge is off — enable it in AI Bridge Manage");
    return;
  }

  if (!existsSync(REQUEST_FILE)) {
    await showHUD("AI Bridge: no pending request");
    return;
  }

  let request: BridgeRequest;
  try {
    request = JSON.parse(readFileSync(REQUEST_FILE, "utf-8"));
  } catch {
    await showHUD("AI Bridge: invalid request file");
    return;
  }

  // Consume the request immediately to prevent double-processing
  try { unlinkSync(REQUEST_FILE); } catch {}

  // Remove any stale response for this slot
  try { if (existsSync(RESPONSE_FILE)) unlinkSync(RESPONSE_FILE); } catch {}

  await showHUD(`AI Bridge: ${request.model}…`);

  const fullPrompt = request.system
    ? `${request.system}\n\n${request.prompt}`
    : request.prompt;

  try {
    writeFileSync(STREAM_FILE, "");

    const answer = AI.ask(fullPrompt, {
      model      : request.model as AI.Model,
      creativity : request.creativity ?? 0.5,
    });

    let accumulated = "";
    answer.on("data", (chunk: string) => {
      accumulated += chunk;
      writeFileSync(STREAM_FILE, accumulated);
    });

    const finalAnswer = await answer;

    const response: BridgeResponse = {
      id     : request.id,
      content: finalAnswer,
      model  : request.model,
      done   : true,
    };
    writeFileSync(RESPONSE_FILE, JSON.stringify(response));
    await showHUD(`AI Bridge: done (${request.model})`);
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
    await showHUD(`AI Bridge error: ${msg.slice(0, 60)}`);
  }
}
