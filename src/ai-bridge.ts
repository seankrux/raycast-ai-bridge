import { AI, environment, showHUD } from "@raycast/api";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BRIDGE_DIR = join(homedir(), ".raycast-ai-bridge");
const REQUEST_FILE = join(BRIDGE_DIR, "request.json");
const RESPONSE_FILE = join(BRIDGE_DIR, "response.json");
const STREAM_FILE = join(BRIDGE_DIR, "stream.txt");
const MODELS_FILE = join(BRIDGE_DIR, "models.json");

// CLI-friendly name → actual AI.Model enum string value (from @raycast/api types)
const MODELS: Record<string, string> = {
  // OpenAI
  "gpt-4o": "openai-gpt-4o",
  "gpt-4o-mini": "openai-gpt-4o-mini",
  "gpt-4": "openai-gpt-4",
  "gpt-4-turbo": "openai-gpt-4-turbo",
  "gpt-4.1": "openai-gpt-4.1",
  "gpt-4.1-mini": "openai-gpt-4.1-mini",
  "gpt-4.1-nano": "openai-gpt-4.1-nano",
  "gpt-5": "openai_o1-gpt-5",
  "gpt-5-mini": "openai-gpt-5-mini",
  "gpt-5-nano": "openai-gpt-5-nano",
  "gpt-5.1": "openai-gpt-5.1",
  "gpt-5.1-codex": "openai-gpt-5.1-codex",
  "gpt-5.2": "openai-gpt-5.2",
  "gpt-5.3-codex": "openai-gpt-5.3-codex",
  "gpt-5.4": "openai-gpt-5.4",
  "gpt-5.4-mini": "openai-gpt-5.4-mini",
  "o1": "openai_o1-o1",
  "o3": "openai_o1-o3",
  "o3-mini": "openai_o1-o3-mini",
  "o4-mini": "openai_o1-o4-mini",
  // Anthropic
  "claude-4.5-haiku": "anthropic-claude-4-5-haiku",
  "claude-4-sonnet": "anthropic-claude-sonnet-4",
  "claude-4.5-sonnet": "anthropic-claude-sonnet-4-5",
  "claude-4.6-sonnet": "anthropic-claude-sonnet-4-6",
  "claude-4.5-opus": "anthropic-claude-opus-4-5",
  "claude-4.6-opus": "anthropic-claude-opus-4-6",
  // Google
  "gemini-2.5-pro": "google-gemini-2.5-pro",
  "gemini-2.5-flash": "google-gemini-2.5-flash",
  "gemini-2.5-flash-lite": "google-gemini-2.5-flash-lite",
  "gemini-3-flash": "google-gemini-3-flash",
  "gemini-3.1-pro": "google-gemini-3.1-pro",
  "gemini-3.1-flash-lite": "google-gemini-3.1-flash-lite",
  // xAI
  "grok-4": "xai-grok-4",
  "grok-4-fast": "xai-grok-4-fast",
  "grok-4.1-fast": "xai-grok-4-1-fast",
  "grok-4.20": "xai-grok-4.20",
  "grok-code-fast": "xai-grok-code-fast",
  "grok-3-beta": "xai-grok-3",
  "grok-3-mini": "xai-grok-3-mini",
  // Mistral
  "codestral": "mistral-codestral-latest",
  "mistral-large": "mistral-mistral-large-latest",
  "mistral-medium": "mistral-mistral-medium-latest",
  "mistral-small-3": "mistral-mistral-small-latest",
  "mistral-nemo": "mistral-open-mistral-nemo",
  // Together AI
  "deepseek-r1": "together-deepseek-ai/DeepSeek-R1",
  "deepseek-v3": "together-deepseek-ai/DeepSeek-V3",
  "qwen3-235b": "together-Qwen/Qwen3-235B-A22B-Instruct-2507-tput",
  "kimi-k2.5": "together-moonshotai/Kimi-K2.5",
  // Perplexity
  "sonar": "perplexity-sonar",
  "sonar-pro": "perplexity-sonar-pro",
  // Groq
  "llama-3.3-70b": "groq-llama-3.3-70b-versatile",
  "llama-3.1-8b": "groq-llama-3.1-8b-instant",
  "llama-4-scout": "groq-meta-llama/llama-4-scout-17b-16e-instruct",
  "kimi-k2": "groq-moonshotai/kimi-k2-instruct",
  "qwen3-32b": "groq-qwen/qwen3-32b",
  "gpt-oss-20b": "groq-openai/gpt-oss-20b",
  "gpt-oss-120b": "groq-openai/gpt-oss-120b",
};

interface BridgeRequest {
  id: string;
  prompt: string;
  model?: string;
  creativity?: number;
  system?: string;
}

interface BridgeResponse {
  id: string;
  content: string;
  model: string;
  error?: string;
  done: boolean;
}

export default async function Command() {
  if (!environment.canAccess(AI)) {
    await showHUD("Raycast Pro required for AI Bridge");
    return;
  }

  // Ensure bridge directory exists
  if (!existsSync(BRIDGE_DIR)) {
    mkdirSync(BRIDGE_DIR, { recursive: true });
  }

  // Write available models list
  writeFileSync(MODELS_FILE, JSON.stringify(Object.keys(MODELS), null, 2));

  // Check for request file
  if (!existsSync(REQUEST_FILE)) {
    await showHUD("AI Bridge ready — no pending request");
    return;
  }

  let request: BridgeRequest;
  try {
    const raw = readFileSync(REQUEST_FILE, "utf-8");
    request = JSON.parse(raw);
  } catch {
    await showHUD("Invalid request file");
    return;
  }

  // Remove request file immediately to prevent re-processing
  unlinkSync(REQUEST_FILE);

  // Resolve model
  const modelKey = request.model || "gpt-4o";
  const modelValue = MODELS[modelKey];
  if (!modelValue) {
    const errorResp: BridgeResponse = {
      id: request.id,
      content: "",
      model: modelKey,
      error: `Unknown model: ${modelKey}. Available: ${Object.keys(MODELS).join(", ")}`,
      done: true,
    };
    writeFileSync(RESPONSE_FILE, JSON.stringify(errorResp, null, 2));
    return;
  }

  await showHUD(`AI Bridge: ${modelKey}...`);

  // Build the prompt with optional system instruction
  const fullPrompt = request.system
    ? `${request.system}\n\n${request.prompt}`
    : request.prompt;

  try {
    // Clear stream file
    writeFileSync(STREAM_FILE, "");

    // Use AI.ask with the actual model string value
    const answer = AI.ask(fullPrompt, {
      model: modelValue as any,
      creativity: request.creativity ?? 0.5,
    });

    let accumulated = "";
    answer.on("data", (chunk: string) => {
      accumulated += chunk;
      writeFileSync(STREAM_FILE, accumulated);
    });

    const finalAnswer = await answer;

    const response: BridgeResponse = {
      id: request.id,
      content: finalAnswer,
      model: modelKey,
      done: true,
    };
    writeFileSync(RESPONSE_FILE, JSON.stringify(response, null, 2));
    await showHUD(`AI Bridge done (${modelKey})`);
  } catch (error: any) {
    const errorResp: BridgeResponse = {
      id: request.id,
      content: "",
      model: modelKey,
      error: error.message || "Unknown error",
      done: true,
    };
    writeFileSync(RESPONSE_FILE, JSON.stringify(errorResp, null, 2));
    await showHUD(`AI Bridge error: ${error.message}`);
  }
}
