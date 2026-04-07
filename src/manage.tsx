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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync, spawn } from "child_process";
import http from "http";
import { SERVER_SCRIPT } from "./server-template";

// ─── Paths ────────────────────────────────────────────────────────────────────
const BRIDGE_DIR          = join(homedir(), ".raycast-ai-bridge");
const PID_FILE            = join(BRIDGE_DIR, "server.pid");
const SERVER_JS           = join(BRIDGE_DIR, "server.js");
const SELECTED_MODELS_FILE = join(BRIDGE_DIR, "selected-models.json");
const AVAILABLE_MODELS_FILE = join(BRIDGE_DIR, "available-models.json");

// ─── Auto-discover all Raycast AI models from the API enum ───────────────────
// AI.Model is a TypeScript enum — at runtime Object.values gives all model ID strings.
// We derive provider and display label from the ID so nothing goes stale.

const PROVIDER_PREFIXES: [string, string][] = [
  ["openai_o1-",   "OpenAI"],
  ["openai-",      "OpenAI"],
  ["anthropic-",   "Anthropic"],
  ["google-",      "Google"],
  ["xai-",         "xAI"],
  ["mistral-",     "Mistral"],
  ["together-",    "Together AI"],
  ["perplexity-",  "Perplexity"],
  ["groq-",        "Groq"],
];

function detectProvider(id: string): string {
  for (const [prefix, name] of PROVIDER_PREFIXES) {
    if (id.startsWith(prefix)) return name;
  }
  return "Other";
}

function makeLabel(id: string): string {
  // Strip provider prefix to get the model name portion
  for (const [prefix] of PROVIDER_PREFIXES) {
    if (id.startsWith(prefix)) {
      let name = id.slice(prefix.length);
      // Clean up common patterns
      name = name.replace(/-latest$/, "");
      name = name.replace(/-versatile$/, "");
      name = name.replace(/-instant$/, "");
      // Remove org prefix for together/groq models (e.g. "deepseek-ai/DeepSeek-R1" → "DeepSeek-R1")
      if (name.includes("/")) name = name.split("/").pop()!;
      // Title-case words separated by hyphens
      return name
        .split("-")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    }
  }
  return id;
}

interface ModelMeta { label: string; provider: string }

// Deduplicate: the enum has deprecated aliases that map to the same string value
const ALL_MODEL_IDS: string[] = [...new Set(
  (Object.values(AI.Model) as unknown[]).filter((v): v is string => typeof v === "string")
)];

const MODEL_CATALOG: Record<string, ModelMeta> = {};
for (const id of ALL_MODEL_IDS) {
  MODEL_CATALOG[id] = { label: makeLabel(id), provider: detectProvider(id) };
}

const PROVIDER_ORDER = ["OpenAI", "Anthropic", "Google", "xAI", "Mistral", "Together AI", "Perplexity", "Groq", "Other"];
const PROVIDERS = PROVIDER_ORDER.filter(p =>
  ALL_MODEL_IDS.some(id => MODEL_CATALOG[id]?.provider === p)
);

// ─── Persistence keys ─────────────────────────────────────────────────────────
const KEY_ENABLED        = "bridge_enabled";
const KEY_SELECTED       = "bridge_selected_models";
const KEY_AVAILABLE      = "bridge_available_models";
const KEY_TAILSCALE      = "bridge_tailscale";
const KEY_TS_PERSIST     = "bridge_tailscale_persist";

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

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isServerRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  return isProcessAlive(pid);
}

function killServer() {
  const pid = readPid();
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch {}
  // Clean up stale PID file
  try { unlinkSync(PID_FILE); } catch {}
}

/** HTTP health check — more reliable than PID check */
function checkServerHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          // Update PID file if server reports a different PID
          if (j.pid) {
            const currentPid = readPid();
            if (currentPid !== j.pid) {
              try { writeFileSync(PID_FILE, String(j.pid)); } catch {}
            }
          }
          resolve(j.status === "ok");
        } catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function startServer(port: number, bindAddr = "127.0.0.1") {
  ensureBridgeDir();
  writeFileSync(SERVER_JS, SERVER_SCRIPT);
  const child = spawn(process.execPath, [SERVER_JS], {
    env    : { ...process.env, BRIDGE_PORT: String(port), BRIDGE_BIND: bindAddr },
    detached: true,
    stdio  : "ignore",
  });
  child.unref();
}

function getTailscaleIp(): string | null {
  try {
    const out = execSync("tailscale ip -4 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim();
    return out || null;
  } catch {
    return null;
  }
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
  const [tailscale, setTailscale]         = useState(false);
  const [tsPersist, setTsPersist]         = useState(false);
  const [tailscaleIp, setTailscaleIp]     = useState<string | null>(null);
  const scanRef = useRef(false);

  // ── Load persisted state ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const [en, sel, avail, ts, tsp] = await Promise.all([
        LocalStorage.getItem<string>(KEY_ENABLED),
        LocalStorage.getItem<string>(KEY_SELECTED),
        LocalStorage.getItem<string>(KEY_AVAILABLE),
        LocalStorage.getItem<string>(KEY_TAILSCALE),
        LocalStorage.getItem<string>(KEY_TS_PERSIST),
      ]);
      if (en === "true") setIsEnabled(true);
      if (ts === "true") setTailscale(true);
      if (tsp === "true") setTsPersist(true);
      setTailscaleIp(getTailscaleIp());
      if (sel) {
        try { setSelected(new Set(JSON.parse(sel))); } catch {}
      } else {
        // Default: all models selected
        setSelected(new Set(ALL_MODEL_IDS));
      }
      if (avail) {
        try { setAvailable(JSON.parse(avail)); } catch {}
      }
      // Check server health via HTTP (more reliable than PID)
      checkServerHealth(port).then(ok => setServerOk(ok));
      // Always write full model catalog to disk so server can build aliases
      ensureBridgeDir();
      writeFileSync(AVAILABLE_MODELS_FILE, JSON.stringify(ALL_MODEL_IDS));
      setLoaded(true);
    })();
  }, []);

  // ── Server health poll with auto-restart ────────────────────────────────
  const restartingRef = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    const t = setInterval(async () => {
      const healthy = await checkServerHealth(port);
      setServerOk(healthy);

      // Auto-restart if bridge is enabled but server is dead
      if (isEnabled && !healthy && !restartingRef.current) {
        restartingRef.current = true;
        // Kill any zombie process
        killServer();
        const bind = tailscale ? "0.0.0.0" : "127.0.0.1";
        startServer(port, bind);
        // Give it a moment to start
        setTimeout(async () => {
          const ok = await checkServerHealth(port);
          setServerOk(ok);
          restartingRef.current = false;
          if (ok) {
            await showToast({ style: Toast.Style.Success, title: "AI Bridge auto-restarted" });
          }
        }, 2000);
      }
    }, 3_000);
    return () => clearInterval(t);
  }, [loaded, isEnabled, port, tailscale]);

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
      // If persist is off, reset tailscale on restart
      const useTailscale = tsPersist ? tailscale : false;
      if (!tsPersist && tailscale) {
        setTailscale(false);
        await LocalStorage.setItem(KEY_TAILSCALE, "false");
      }
      const bind = useTailscale ? "0.0.0.0" : "127.0.0.1";
      if (!isServerRunning()) {
        startServer(port, bind);
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
  }, [isEnabled, port, endpointUrl, selectedModels, tailscale, tsPersist]);

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
    // Write available models to disk so the server can build aliases for all of them
    ensureBridgeDir();
    writeFileSync(AVAILABLE_MODELS_FILE, JSON.stringify(ALL_MODEL_IDS));
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

  // ── Toggle Tailscale ─────────────────────────────────────────────────────
  const toggleTailscale = useCallback(async () => {
    const ip = getTailscaleIp();
    setTailscaleIp(ip);

    if (!tailscale && !ip) {
      await showToast({ style: Toast.Style.Failure, title: "Tailscale not found", message: "Install Tailscale or check it's running" });
      return;
    }

    const next = !tailscale;
    setTailscale(next);
    await LocalStorage.setItem(KEY_TAILSCALE, String(next));

    // Restart server with new bind address if bridge is on
    if (isEnabled) {
      killServer();
      await new Promise(r => setTimeout(r, 500));
      startServer(port, next ? "0.0.0.0" : "127.0.0.1");
      await showToast({
        style: Toast.Style.Success,
        title: next ? "Tailscale enabled" : "Tailscale disabled",
        message: next ? `Listening on ${ip}:${port}` : `Listening on localhost:${port}`,
      });
    } else {
      await showToast({
        style: Toast.Style.Success,
        title: next ? "Tailscale will be enabled on next start" : "Tailscale disabled",
      });
    }
  }, [tailscale, isEnabled, port]);

  const toggleTsPersist = useCallback(async () => {
    const next = !tsPersist;
    setTsPersist(next);
    await LocalStorage.setItem(KEY_TS_PERSIST, String(next));
    await showToast({
      style: Toast.Style.Success,
      title: next ? "Tailscale persists on restart" : "Tailscale resets on restart",
    });
  }, [tsPersist]);

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
                  {availableModels.length > 0 && (
                    <>
                      <Action.CopyToClipboard
                        title="Copy Verified Models (comma separated)"
                        content={availableModels.join(", ")}
                        shortcut={{ modifiers: ["cmd"], key: "m" }}
                      />
                      <Action.CopyToClipboard
                        title="Copy Verified Models (one per line)"
                        content={availableModels.join("\n")}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
                      />
                    </>
                  )}
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

      {/* ── Tailscale ── */}
      <List.Section title="Network">
        <List.Item
          icon={{
            source: tailscale ? Icon.CheckCircle : Icon.Circle,
            tintColor: tailscale ? Color.Blue : Color.SecondaryText,
          }}
          title={tailscale ? "Tailscale: ON" : "Tailscale: OFF"}
          subtitle={
            tailscale && tailscaleIp
              ? `Accessible on Tailnet at ${tailscaleIp}:${port}`
              : "Enable to expose bridge on your Tailnet"
          }
          accessories={
            tailscale && tailscaleIp
              ? [{ tag: { value: tailscaleIp, color: Color.Blue } }]
              : tailscaleIp
              ? [{ tag: { value: "available", color: Color.SecondaryText } }]
              : [{ tag: { value: "not detected", color: Color.Red } }]
          }
          actions={
            <ActionPanel>
              <Action
                title={tailscale ? "Disable Tailscale" : "Enable Tailscale"}
                icon={tailscale ? Icon.Stop : Icon.Play}
                onAction={toggleTailscale}
              />
              {tailscale && tailscaleIp && (
                <>
                  <Action.CopyToClipboard
                    title="Copy Tailscale Endpoint"
                    content={`http://${tailscaleIp}:${port}/v1/chat/completions`}
                    shortcut={{ modifiers: ["cmd"], key: "t" }}
                  />
                  <Action.CopyToClipboard
                    title="Copy Tailscale Base URL"
                    content={`http://${tailscaleIp}:${port}`}
                  />
                </>
              )}
            </ActionPanel>
          }
        />
        {tailscale && tailscaleIp && isEnabled && serverOk && (
          <List.Item
            icon={{ source: Icon.Link, tintColor: Color.Blue }}
            title={`http://${tailscaleIp}:${port}/v1/chat/completions`}
            subtitle="Tailscale endpoint — paste ready"
            accessories={[{ icon: Icon.Clipboard, tooltip: "Cmd+C to copy" }]}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="Copy Tailscale Endpoint"
                  content={`http://${tailscaleIp}:${port}/v1/chat/completions`}
                />
              </ActionPanel>
            }
          />
        )}
        <List.Item
          icon={{
            source: tsPersist ? Icon.CheckCircle : Icon.Circle,
            tintColor: tsPersist ? Color.Green : Color.SecondaryText,
          }}
          title={tsPersist ? "Persist on restart: ON" : "Persist on restart: OFF"}
          subtitle={
            tsPersist
              ? "Tailscale stays enabled when bridge restarts"
              : "Tailscale resets to OFF when bridge restarts"
          }
          actions={
            <ActionPanel>
              <Action
                title={tsPersist ? "Disable Persist" : "Enable Persist"}
                icon={tsPersist ? Icon.XMarkCircle : Icon.CheckCircle}
                onAction={toggleTsPersist}
              />
            </ActionPanel>
          }
        />
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
