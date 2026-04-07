import {
  Action,
  ActionPanel,
  AI,
  Clipboard,
  Color,
  Icon,
  List,
  LocalStorage,
  Toast,
  environment,
  getPreferenceValues,
  showHUD,
  showToast,
} from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { SERVER_SCRIPT } from "./server-template";

// ─── Paths ────────────────────────────────────────────────────────────────────
const BRIDGE_DIR          = join(homedir(), ".raycast-ai-bridge");
const PID_FILE            = join(BRIDGE_DIR, "server.pid");
const SERVER_JS           = join(BRIDGE_DIR, "server.js");
const SELECTED_MODELS_FILE = join(BRIDGE_DIR, "selected-models.json");
const AVAILABLE_MODELS_FILE = join(BRIDGE_DIR, "available-models.json");

// ─── All known Raycast AI model IDs grouped by provider ───────────────────────
// key = AI.Model-compatible string value, value = display label
const MODEL_CATALOG: Record<string, { label: string; provider: string }> = {
  // OpenAI
  "openai-gpt-4o"        : { label: "GPT-4o",          provider: "OpenAI" },
  "openai-gpt-4o-mini"   : { label: "GPT-4o Mini",      provider: "OpenAI" },
  "openai-gpt-4.1"       : { label: "GPT-4.1",          provider: "OpenAI" },
  "openai-gpt-4.1-mini"  : { label: "GPT-4.1 Mini",     provider: "OpenAI" },
  "openai-gpt-4.1-nano"  : { label: "GPT-4.1 Nano",     provider: "OpenAI" },
  "openai_o1-o1"         : { label: "o1",               provider: "OpenAI" },
  "openai_o1-o3"         : { label: "o3",               provider: "OpenAI" },
  "openai_o1-o3-mini"    : { label: "o3-mini",          provider: "OpenAI" },
  "openai_o1-o4-mini"    : { label: "o4-mini",          provider: "OpenAI" },
  // Anthropic
  "anthropic-claude-haiku-3-5" : { label: "Claude 3.5 Haiku",   provider: "Anthropic" },
  "anthropic-claude-sonnet-3-5": { label: "Claude 3.5 Sonnet",  provider: "Anthropic" },
  "anthropic-claude-sonnet-4"  : { label: "Claude Sonnet 4",    provider: "Anthropic" },
  "anthropic-claude-sonnet-4-5": { label: "Claude 4.5 Sonnet",  provider: "Anthropic" },
  "anthropic-claude-sonnet-4-6": { label: "Claude 4.6 Sonnet",  provider: "Anthropic" },
  "anthropic-claude-opus-4"    : { label: "Claude Opus 4",      provider: "Anthropic" },
  "anthropic-claude-opus-4-5"  : { label: "Claude 4.5 Opus",    provider: "Anthropic" },
  "anthropic-claude-opus-4-6"  : { label: "Claude 4.6 Opus",    provider: "Anthropic" },
  // Google
  "google-gemini-2.0-flash"      : { label: "Gemini 2.0 Flash",     provider: "Google" },
  "google-gemini-2.5-flash"      : { label: "Gemini 2.5 Flash",     provider: "Google" },
  "google-gemini-2.5-flash-lite" : { label: "Gemini 2.5 Flash Lite",provider: "Google" },
  "google-gemini-2.5-pro"        : { label: "Gemini 2.5 Pro",       provider: "Google" },
  // xAI
  "xai-grok-3"          : { label: "Grok 3 Beta",   provider: "xAI" },
  "xai-grok-3-mini"     : { label: "Grok 3 Mini",   provider: "xAI" },
  "xai-grok-4"          : { label: "Grok 4",        provider: "xAI" },
  "xai-grok-4-fast"     : { label: "Grok 4 Fast",   provider: "xAI" },
  // Mistral
  "mistral-codestral-latest"      : { label: "Codestral",      provider: "Mistral" },
  "mistral-mistral-large-latest"  : { label: "Mistral Large",  provider: "Mistral" },
  "mistral-mistral-medium-latest" : { label: "Mistral Medium", provider: "Mistral" },
  "mistral-mistral-small-latest"  : { label: "Mistral Small",  provider: "Mistral" },
  // Together AI
  "together-deepseek-ai/DeepSeek-R1"   : { label: "DeepSeek R1",  provider: "Together AI" },
  "together-deepseek-ai/DeepSeek-V3"   : { label: "DeepSeek V3",  provider: "Together AI" },
  "together-moonshotai/Kimi-K2.5"      : { label: "Kimi K2.5",    provider: "Together AI" },
  // Perplexity
  "perplexity-sonar"     : { label: "Sonar",     provider: "Perplexity" },
  "perplexity-sonar-pro" : { label: "Sonar Pro", provider: "Perplexity" },
  // Groq
  "groq-llama-3.3-70b-versatile"                        : { label: "Llama 3.3 70B",   provider: "Groq" },
  "groq-llama-3.1-8b-instant"                           : { label: "Llama 3.1 8B",    provider: "Groq" },
  "groq-meta-llama/llama-4-scout-17b-16e-instruct"      : { label: "Llama 4 Scout",   provider: "Groq" },
  "groq-moonshotai/kimi-k2-instruct"                    : { label: "Kimi K2",         provider: "Groq" },
  "groq-qwen/qwen3-32b"                                 : { label: "Qwen 3 32B",      provider: "Groq" },
};

const ALL_MODEL_IDS = Object.keys(MODEL_CATALOG);
const PROVIDERS = [...new Set(Object.values(MODEL_CATALOG).map((m) => m.provider))];

// ─── Persistence keys ─────────────────────────────────────────────────────────
const KEY_ENABLED        = "bridge_enabled";
const KEY_SELECTED       = "bridge_selected_models";
const KEY_AVAILABLE      = "bridge_available_models";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ensureBridgeDir() {
  if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
}

function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function isServerRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, no kill
    return true;
  } catch { return false; }
}

function killServer() {
  const pid = readPid();
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch {}
}

function startServer(port: number) {
  ensureBridgeDir();
  writeFileSync(SERVER_JS, SERVER_SCRIPT);
  const child = spawn(process.execPath, [SERVER_JS], {
    env    : { ...process.env, BRIDGE_PORT: String(port) },
    detached: true,
    stdio  : "ignore",
  });
  child.unref();
}

function saveSelectedModels(ids: string[]) {
  ensureBridgeDir();
  writeFileSync(SELECTED_MODELS_FILE, JSON.stringify(ids));
}

async function probeModel(modelId: string): Promise<boolean> {
  try {
    await Promise.race([
      AI.ask("Say: ok", { model: modelId as AI.Model, creativity: 0 }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8_000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
interface Prefs { port: string }

export default function Command() {
  const { port: portPref } = getPreferenceValues<Prefs>();
  const port = parseInt(portPref || "3099", 10);
  const endpointUrl = `http://localhost:${port}/v1/chat/completions`;

  const [isEnabled, setIsEnabled]         = useState(false);
  const [serverOk, setServerOk]           = useState(false);
  const [availableModels, setAvailable]   = useState<string[]>([]);
  const [selectedModels, setSelected]     = useState<Set<string>>(new Set());
  const [isScanning, setScanning]         = useState(false);
  const [scanProgress, setScanProgress]   = useState("");
  const [loaded, setLoaded]               = useState(false);
  const scanRef = useRef(false);

  // ── Load persisted state ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const [en, sel, avail] = await Promise.all([
        LocalStorage.getItem<string>(KEY_ENABLED),
        LocalStorage.getItem<string>(KEY_SELECTED),
        LocalStorage.getItem<string>(KEY_AVAILABLE),
      ]);
      if (en === "true") setIsEnabled(true);
      if (sel) {
        try { setSelected(new Set(JSON.parse(sel))); } catch {}
      } else {
        // Default: all models selected
        setSelected(new Set(ALL_MODEL_IDS));
      }
      if (avail) {
        try { setAvailable(JSON.parse(avail)); } catch {}
      }
      setServerOk(isServerRunning());
      setLoaded(true);
    })();
  }, []);

  // ── Server health poll while command is open ──────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    const t = setInterval(() => setServerOk(isServerRunning()), 3_000);
    return () => clearInterval(t);
  }, [loaded]);

  // ── Toggle bridge on/off ──────────────────────────────────────────────────
  const toggle = useCallback(async () => {
    if (!environment.canAccess(AI)) {
      await showToast({ style: Toast.Style.Failure, title: "Raycast Pro required for AI access" });
      return;
    }
    const next = !isEnabled;
    setIsEnabled(next);
    await LocalStorage.setItem(KEY_ENABLED, String(next));

    if (next) {
      if (!isServerRunning()) {
        startServer(port);
        await showToast({ style: Toast.Style.Success, title: "AI Bridge started", message: endpointUrl });
      } else {
        await showToast({ style: Toast.Style.Success, title: "AI Bridge enabled", message: endpointUrl });
      }
      setServerOk(true);
      // Persist current selection to disk for the server
      saveSelectedModels([...selectedModels]);
    } else {
      killServer();
      setServerOk(false);
      await showToast({ style: Toast.Style.Success, title: "AI Bridge stopped" });
    }
  }, [isEnabled, port, endpointUrl, selectedModels]);

  // ── Scan available models ─────────────────────────────────────────────────
  const scanModels = useCallback(async () => {
    if (scanRef.current) return;
    if (!environment.canAccess(AI)) {
      await showToast({ style: Toast.Style.Failure, title: "Raycast Pro required" });
      return;
    }
    scanRef.current = true;
    setScanning(true);
    setAvailable([]);
    setScanProgress("Scanning…");

    const toast = await showToast({ style: Toast.Style.Animated, title: "Scanning AI models…" });

    const results: string[] = [];
    // Probe in batches of 4 concurrently
    const BATCH = 4;
    for (let i = 0; i < ALL_MODEL_IDS.length; i += BATCH) {
      const batch = ALL_MODEL_IDS.slice(i, i + BATCH);
      const outcomes = await Promise.all(batch.map(id => probeModel(id)));
      outcomes.forEach((ok, j) => {
        if (ok) results.push(batch[j]);
      });
      const done = Math.min(i + BATCH, ALL_MODEL_IDS.length);
      setScanProgress(`${done} / ${ALL_MODEL_IDS.length} probed — ${results.length} available`);
      toast.message = scanProgress;
    }

    setAvailable(results);
    // Default-select all available models
    setSelected(new Set(results));
    await LocalStorage.setItem(KEY_AVAILABLE, JSON.stringify(results));
    await LocalStorage.setItem(KEY_SELECTED, JSON.stringify(results));
    saveSelectedModels(results);

    toast.style = Toast.Style.Success;
    toast.title = `Found ${results.length} available model${results.length !== 1 ? "s" : ""}`;
    toast.message = undefined;
    setScanProgress("");
    setScanning(false);
    scanRef.current = false;
  }, []);

  // ── Toggle individual model ───────────────────────────────────────────────
  const toggleModel = useCallback(async (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      const arr = [...next];
      LocalStorage.setItem(KEY_SELECTED, JSON.stringify(arr));
      saveSelectedModels(arr);
      return next;
    });
  }, []);

  const selectAll = useCallback(async (ids: string[]) => {
    setSelected(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.add(id));
      const arr = [...next];
      LocalStorage.setItem(KEY_SELECTED, JSON.stringify(arr));
      saveSelectedModels(arr);
      return next;
    });
  }, []);

  const deselectAll = useCallback(async (ids: string[]) => {
    setSelected(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.delete(id));
      const arr = [...next];
      LocalStorage.setItem(KEY_SELECTED, JSON.stringify(arr));
      saveSelectedModels(arr);
      return next;
    });
  }, []);

  // Always show all models — after scan, verified/unavailable tags indicate status
  const displayModels = ALL_MODEL_IDS;
  const hasScanResults = availableModels.length > 0;

  if (!loaded) return <List isLoading />;

  // ── Status section values ─────────────────────────────────────────────────
  const statusColor  = isEnabled && serverOk ? Color.Green : isEnabled ? Color.Orange : Color.SecondaryText;
  const statusIcon   = isEnabled && serverOk ? Icon.CheckCircle : isEnabled ? Icon.Clock : Icon.Circle;
  const statusLabel  = isEnabled && serverOk ? "ON — server running" : isEnabled ? "ON — starting…" : "OFF";

  return (
    <List
      navigationTitle="AI Bridge"
      isLoading={isScanning}
      searchBarPlaceholder="Filter models…"
    >
      {/* ── Status ── */}
      <List.Section title="Bridge Status">
        <List.Item
          icon={{ source: statusIcon, tintColor: statusColor }}
          title={`Bridge: ${statusLabel}`}
          subtitle={isEnabled && serverOk ? endpointUrl : ""}
          accessories={
            isEnabled && serverOk
              ? [{ tag: { value: `port ${port}`, color: Color.Green } }]
              : []
          }
          actions={
            <ActionPanel>
              <Action
                title={isEnabled ? "Turn Off" : "Turn On"}
                icon={isEnabled ? Icon.Stop : Icon.Play}
                onAction={toggle}
              />
              {isEnabled && serverOk && (
                <>
                  <Action.CopyToClipboard
                    title="Copy Endpoint URL"
                    content={endpointUrl}
                    shortcut={{ modifiers: ["cmd"], key: "c" }}
                  />
                  <Action.CopyToClipboard
                    title="Copy Base URL"
                    content={`http://localhost:${port}`}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                  />
                  <Action
                    title="Copy & Open in Browser"
                    icon={Icon.Globe}
                    onAction={async () => {
                      await Clipboard.copy(endpointUrl);
                      await showHUD(`Copied: ${endpointUrl}`);
                    }}
                    shortcut={{ modifiers: ["cmd"], key: "o" }}
                  />
                </>
              )}
            </ActionPanel>
          }
        />
        {/* Endpoint row — always visible when on */}
        {isEnabled && serverOk && (
          <List.Item
            icon={{ source: Icon.Link, tintColor: Color.Blue }}
            title={endpointUrl}
            subtitle="OpenAI-compatible endpoint — paste ready"
            accessories={[{ icon: Icon.Clipboard, tooltip: "⌘C to copy" }]}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy Endpoint URL" content={endpointUrl} />
                <Action
                  title="Turn Off Bridge"
                  icon={Icon.Stop}
                  onAction={toggle}
                />
              </ActionPanel>
            }
          />
        )}
      </List.Section>

      {/* ── Model Scanner ── */}
      <List.Section title="AI Models">
        <List.Item
          icon={{ source: Icon.RotateClockwise, tintColor: isScanning ? Color.Orange : Color.Blue }}
          title={isScanning ? `Scanning… ${scanProgress}` : "Scan Available Models"}
          subtitle={
            isScanning
              ? "Testing each model with your Raycast subscription…"
              : availableModels.length > 0
              ? `${availableModels.length} available · ${selectedModels.size} selected`
              : `${ALL_MODEL_IDS.length} models in catalog — click to scan`
          }
          actions={
            <ActionPanel>
              <Action
                title="Scan / Refresh Models"
                icon={Icon.RotateClockwise}
                onAction={scanModels}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
              />
            </ActionPanel>
          }
        />
      </List.Section>

      {/* ── Model list by provider ── */}
      {PROVIDERS.map(provider => {
        const providerModels = displayModels.filter(
          id => MODEL_CATALOG[id]?.provider === provider
        );
        if (providerModels.length === 0) return null;

        const allSelected  = providerModels.every(id => selectedModels.has(id));
        const noneSelected = providerModels.every(id => !selectedModels.has(id));

        return (
          <List.Section
            key={provider}
            title={provider}
            subtitle={`${providerModels.filter(id => selectedModels.has(id)).length} / ${providerModels.length} selected`}
          >
            {/* Select All / Deselect All row */}
            <List.Item
              icon={{ source: allSelected ? Icon.CheckCircle : Icon.Circle, tintColor: Color.SecondaryText }}
              title={allSelected ? "Deselect All" : "Select All"}
              subtitle={provider}
              actions={
                <ActionPanel>
                  <Action
                    title={allSelected ? "Deselect All" : "Select All"}
                    icon={allSelected ? Icon.XMarkCircle : Icon.CheckCircle}
                    onAction={() => allSelected ? deselectAll(providerModels) : selectAll(providerModels)}
                  />
                </ActionPanel>
              }
            />
            {/* Individual models */}
            {providerModels.map(id => {
              const meta    = MODEL_CATALOG[id];
              const checked = selectedModels.has(id);
              return (
                <List.Item
                  key={id}
                  icon={{
                    source: checked ? Icon.CheckCircle : Icon.Circle,
                    tintColor: checked ? Color.Green : Color.SecondaryText,
                  }}
                  title={meta?.label ?? id}
                  subtitle={id}
                  accessories={[
                    ...(hasScanResults
                      ? availableModels.includes(id)
                        ? [{ tag: { value: "verified", color: Color.Green } }]
                        : [{ tag: { value: "not available", color: Color.Red } }]
                      : []
                    ),
                  ]}
                  actions={
                    <ActionPanel>
                      <Action
                        title={checked ? "Deselect" : "Select"}
                        icon={checked ? Icon.XMarkCircle : Icon.CheckCircle}
                        onAction={() => toggleModel(id)}
                      />
                      <Action
                        title="Select All in Provider"
                        icon={Icon.CheckCircle}
                        onAction={() => selectAll(providerModels)}
                      />
                      <Action
                        title="Deselect All in Provider"
                        icon={Icon.XMarkCircle}
                        onAction={() => deselectAll(providerModels)}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
                      />
                      <Action.CopyToClipboard
                        title="Copy Model ID"
                        content={id}
                        shortcut={{ modifiers: ["cmd"], key: "." }}
                      />
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        );
      })}
    </List>
  );
}
