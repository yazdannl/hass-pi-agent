/**
 * Real embedded engine (issue #WSWMV / #AJAC6).
 *
 * One ModelRuntime + one AgentSession embedded in-process (no subprocess). Serves
 * the webapp dist/ statically and bridges the live AgentSession event stream to a
 * WebSocket in the same wire shape the frontend already consumes (see src/types.ts),
 * so the existing Lit UI drives the real agent against the dev VM. Single-flight:
 * one running turn at a time.
 *
 *   cd webapp && npx tsx server/engine.ts       # → http://127.0.0.1:8771
 *
 * Local dev config comes from the repo .env (HA_URL/HA_TOKEN/HA_CONFIG_PATH).
 */
import { createServer } from "node:http";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, resolveCliModel, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const distDir = resolve(__dirname, "..", "dist");
const PORT = Number(process.env.PI_ENGINE_PORT ?? 8771);

// ── repo .env → process.env (local dev only; in the add-on, env comes from
// s6 container_environment so this file is absent — tolerate that).
try {
  for (const line of readFileSync(resolve(repoRoot, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env (container) */ }

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

// ── Stats overview (real, off the HA API) ───────────────────
interface StatsOverview { entities: number; automations: number; scripts: number; lights: number; sensors: number; areas: number; }
let statsCache: StatsOverview | null = null;
async function fetchStats(): Promise<StatsOverview | null> {
  if (statsCache) return statsCache;
  const url = process.env.HA_URL, token = process.env.HA_TOKEN;
  if (!url || !token) return null;
  const template = `{"entities": {{ states | list | count }}, "automations": {{ states.automation | list | count }}, "scripts": {{ states.script | list | count }}, "lights": {{ states.light | list | count }}, "sensors": {{ states.sensor | list | count }}, "areas": {{ areas() | list | count }}}`;
  try {
    const r = await fetch(`${url}/api/template`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ template }) });
    if (!r.ok) return null;
    statsCache = JSON.parse(await r.text()) as StatsOverview;
    return statsCache;
  } catch { return null; }
}

// ── Boot the embedded agent ─────────────────────────────────
// Load ONLY the Home Assistant extension, explicitly — no cwd/.pi auto-discovery,
// no dev-env tool leak. Configurable path so the add-on points at /opt/ha-extension.
const HA_EXTENSION = process.env.HA_EXTENSION_PATH || resolve(repoRoot, ".pi", "extensions", "home-assistant", "index.ts");
// Agent working dir = the HA agent scratch (mounted config in dev, /homeassistant/agent in prod).
const agentCwd = process.env.HA_CONFIG_PATH ? resolve(process.env.HA_CONFIG_PATH, "agent") : resolve(repoRoot, ".engine-scratch");
// Isolated agentDir/auth so nothing auto-discovers AND we never read the operator's
// global ~/.pi auth.json (which holds a subscription Anthropic rejects here). Auth
// comes ONLY from add-on-config env keys (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, …).
const engineAgentDir = process.env.PI_ENGINE_AGENTDIR || resolve(__dirname, "..", ".engine-agentdir");
mkdirSync(agentCwd, { recursive: true });
mkdirSync(engineAgentDir, { recursive: true });

console.log("[engine] booting ModelRuntime…");
const modelRuntime = await ModelRuntime.create({
  authPath: resolve(engineAgentDir, "auth.json"),
  modelsPath: resolve(engineAgentDir, "models.json"),
});

const loader = new DefaultResourceLoader({
  cwd: agentCwd,
  agentDir: engineAgentDir,
  additionalExtensionPaths: [HA_EXTENSION],
});
await loader.reload();

// ── Model + provider config (in-app setup: issue #RPRNX) ────
// Persisted canonically to the add-on's Supervisor options (survives restart,
// update, and reinstall). The engine reads its own options on boot and writes
// them back on save via the Supervisor API. The API key applies to the live
// runtime via setRuntimeApiKey (in-memory) — re-applied on every boot from the
// stored option. Env (PI_DEFAULT_*/ambient key vars) is a local-dev fallback.
const API_KEY_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "xai", "groq", "mistral", "cerebras", "huggingface", "opencode", "opencode-go"];
const OAUTH_PROVIDERS = ["github-copilot"];
const CUSTOM_PROVIDER = "custom-openai-compatible";
const NO_AUTH_PLACEHOLDER = "pi-agent-no-auth"; // Pi docs use a dummy apiKey for keyless compatible endpoints.
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google (Gemini)", openrouter: "OpenRouter",
  xai: "xAI (Grok)", groq: "Groq", mistral: "Mistral", cerebras: "Cerebras", huggingface: "Hugging Face",
  "github-copilot": "GitHub Copilot", opencode: "OpenCode Zen", "opencode-go": "OpenCode Go",
};
const SUPERVISOR = "http://supervisor";
const supervisorToken = (): string | undefined => process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN;

async function readAddonOptions(): Promise<Record<string, unknown>> {
  const tok = supervisorToken();
  if (!tok) return {};
  try {
    const r = await fetch(`${SUPERVISOR}/addons/self/info`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return {};
    const j = (await r.json()) as { data?: { options?: Record<string, unknown> } };
    return j.data?.options ?? {};
  } catch { return {}; }
}
async function writeAddonOptions(patch: Record<string, unknown>): Promise<boolean> {
  const tok = supervisorToken();
  if (!tok) return false;
  try {
    const current = await readAddonOptions();
    const r = await fetch(`${SUPERVISOR}/addons/self/options`, {
      method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ options: { ...current, ...patch } }),
    });
    return r.ok;
  } catch { return false; }
}
// AI config is grouped under the `ai` option (renders as a collapsed section in
// the Supervisor UI). Read/write it as a nested object.
async function readAi(): Promise<{ provider?: string; model?: string; api_key?: string }> {
  const ai = (await readAddonOptions()).ai;
  return ai && typeof ai === "object" ? (ai as { provider?: string; model?: string; api_key?: string }) : {};
}

// Validation uses an isolated in-memory credential store so a failed test never
// overwrites a saved provider key in auth.json.
type MemoryCredentialStore = NonNullable<NonNullable<Parameters<typeof ModelRuntime.create>[0]>["credentials"]>;
function memoryCredentialStore(): MemoryCredentialStore {
  const entries = new Map<string, Awaited<ReturnType<MemoryCredentialStore["read"]>>>();
  return {
    async read(id) { return entries.get(id); },
    async list() { return [...entries].flatMap(([providerId, credential]) => credential ? [{ providerId, type: credential.type }] : []); },
    async modify(id, update) {
      const next = await update(entries.get(id));
      if (next) entries.set(id, next);
      return entries.get(id);
    },
    async delete(id) { entries.delete(id); },
  };
}

interface ModelsJsonState { raw?: string; config: Record<string, unknown>; providers: Record<string, any>; }
async function readModelsJson(): Promise<ModelsJsonState> {
  let raw: string | undefined;
  try { raw = await readFile(resolve(engineAgentDir, "models.json"), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  let config: Record<string, unknown> = {};
  if (raw !== undefined) {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid models config");
    config = parsed as Record<string, unknown>;
  }
  const value = config.providers ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid providers config");
  return { raw, config, providers: value as Record<string, any> };
}
async function writePrivateFile(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
async function restoreModelsJson(state: ModelsJsonState): Promise<void> {
  const path = resolve(engineAgentDir, "models.json");
  if (state.raw === undefined) await unlink(path).catch(() => {});
  else await writePrivateFile(path, state.raw);
}

// Web search config lives under the `websearch` option (app-managed, like `ai`).
// The in-app setup writes it; init-pi maps it to WEBSEARCH_* env at boot; the
// extension registers the web_search tool from that env at loader.reload().
const WS_PROVIDERS = ["perplexity", "perplexity_openrouter", "brave"] as const;
type WsProvider = typeof WS_PROVIDERS[number];
async function readWebsearch(): Promise<{ enabled?: boolean; provider?: string; api_key?: string }> {
  const ws = (await readAddonOptions()).websearch;
  return ws && typeof ws === "object" ? (ws as { enabled?: boolean; provider?: string; api_key?: string }) : {};
}
let wsEnabled = false;
let wsProvider = "perplexity";

let curProvider = "";
let curModel = "";
type RuntimeModel = NonNullable<ReturnType<typeof resolveCliModel>["model"]>;
let model: RuntimeModel | undefined;
{
  const ai = await readAi();
  curProvider = ai.provider || process.env.PI_DEFAULT_PROVIDER || "";
  curModel = ai.model || process.env.PI_DEFAULT_MODEL || "";
  if (curProvider && ai.api_key) {
    try { await modelRuntime.setRuntimeApiKey(curProvider, ai.api_key); }
    catch { console.warn("[engine] stored provider credential could not be applied"); }
  }
  const spec = curProvider && curModel ? `${curProvider}/${curModel}` : (process.env.PI_DEFAULT_MODEL ?? "");
  if (spec) {
    const r = resolveCliModel({ cliModel: spec, modelRuntime });
    if (r.error) console.error("[engine] model resolve error:", r.error);
    else { model = r.model; if (r.warning) console.warn("[engine]", r.warning); }
  }
}
{
  const ws = await readWebsearch();
  wsProvider = ws.provider || "perplexity";
  wsEnabled = !!ws.enabled && !!ws.api_key;
}

const TOPIC_MIN_MESSAGES = 10;

// ── Per-user sessions (issue #NANH3) ────────────────────────
// Each HA user (X-Remote-User-Id from ingress) gets its OWN active session,
// event stream, and single-flight lock. Sessions run in parallel across users;
// one turn at a time PER user. Session STORAGE is isolated via a per-user
// sessionDir (cwd stays agentCwd, so tools/scratch/write-guard are unchanged).
interface UserSession {
  session: AgentSession | null;
  unsub: (() => void) | null;
  sm: ReturnType<typeof SessionManager.create> | null;
  clients: Set<WebSocket>;
  busy: boolean;
  lockHeld: boolean;
  lastActivity: number;
}
const users = new Map<string, UserSession>();
const MAX_USERS = 5;
const IDLE_MS = 30 * 60 * 1000;

function sanitizeUserId(id: string | undefined): string {
  const s = (id ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  return s || "default";
}
function userDir(userId: string): string {
  return join(engineAgentDir, "sessions", "users", userId);
}
function newUserSession(): UserSession {
  return { session: null, unsub: null, sm: null, clients: new Set(), busy: false, lockHeld: false, lastActivity: Date.now() };
}

// Per-user event fan-out: broadcast only to the clients of that user.
function broadcastTo(u: UserSession, msg: unknown): void {
  const s = JSON.stringify(msg);
  for (const ws of u.clients) { try { ws.send(s); } catch { /* dropped */ } }
}
// Broadcast to every connected client (config/websearch status — shared state).
function broadcastAll(msg: unknown): void {
  const s = JSON.stringify(msg);
  for (const u of users.values()) for (const ws of u.clients) { try { ws.send(s); } catch { /* dropped */ } }
}

// Per-user single-flight: interactive prompts acquire immediately (reject if held).
function acquireNow(u: UserSession): boolean { if (u.lockHeld) return false; u.lockHeld = true; return true; }
function releaseLock(u: UserSession): void { u.lockHeld = false; }

// pi_agent.ask runs its own isolated ephemeral session; it queues behind other
// ask calls only (never blocks or is blocked by interactive user turns).
let askLockHeld = false;
const askWaiters: Array<() => void> = [];
function acquireAsk(): Promise<void> { return new Promise((res) => { if (!askLockHeld) { askLockHeld = true; res(); } else askWaiters.push(res); }); }
function releaseAsk(): void { askLockHeld = false; const next = askWaiters.shift(); if (next) { askLockHeld = true; next(); } }

/** Map a real AgentSessionEvent → the frontend wire shape (src/types.ts ServerEvent), scoped to one user's clients. */
function toWire(u: UserSession, e: AgentSessionEvent): void {
  switch (e.type) {
    case "agent_start": broadcastTo(u, { type: "agent_start" }); broadcastTo(u, { type: "working", label: "Thinking" }); break;
    case "message_start": broadcastTo(u, { type: "working", label: "" }); broadcastTo(u, { type: "message_start" }); break;
    case "message_update": {
      const a = (e as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
      if (a?.type === "text_delta" && a.delta) broadcastTo(u, { type: "text_delta", delta: a.delta });
      else if (a?.type === "thinking_delta" && a.delta) broadcastTo(u, { type: "thinking_delta", delta: a.delta });
      break;
    }
    case "message_end": broadcastTo(u, { type: "message_end" }); break;
    case "tool_execution_start": {
      const t = e as { toolName?: string; toolCallId?: string; id?: string; args?: unknown; input?: unknown };
      broadcastTo(u, { type: "working", label: "" });
      broadcastTo(u, { type: "tool_start", id: t.toolCallId ?? t.id ?? "", toolName: t.toolName ?? "tool", args: (t.args ?? t.input ?? {}) as Record<string, unknown> });
      break;
    }
    case "tool_execution_end": {
      const t = e as { toolName?: string; toolCallId?: string; id?: string; isError?: boolean; result?: { content?: Array<{ type: string; text?: string }>; details?: unknown } };
      const text = (t.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      // Only treat as structured when details carries a real HaDetails `kind`.
      // A stray/empty `details: {}` must fall back to the markdown text, else the
      // UI renders an empty block (it has no kind to render).
      const details = t.result?.details as { kind?: string } | undefined;
      const result = details && details.kind ? { kind: "details", details, data: text } : { kind: "text", data: text };
      broadcastTo(u, { type: "tool_end", id: t.toolCallId ?? t.id ?? "", toolName: t.toolName ?? "tool", isError: !!t.isError, result });
      break;
    }
    case "turn_end": broadcastTo(u, { type: "turn_end" }); break;
    case "agent_end": broadcastTo(u, { type: "agent_end" }); u.busy = false; break;
    default: break; // queue_update / compaction_* / auto_retry_* — not surfaced yet
  }
}
async function handlePrompt(u: UserSession, text: string): Promise<void> {
  if (!u.session) { broadcastTo(u, { type: "notice", text: "Not configured yet." }); return; }
  if (!acquireNow(u)) { broadcastTo(u, { type: "notice", text: "Busy — one turn at a time." }); return; }
  u.busy = true;
  u.lastActivity = Date.now();
  try {
    await u.session.prompt(text);
  } catch {
    broadcastTo(u, { type: "text_delta", delta: "\n[The request failed. Check the provider configuration and try again.]" });
    broadcastTo(u, { type: "agent_end" });
  } finally {
    u.busy = false;
    u.lastActivity = Date.now();
    releaseLock(u);
  }
  void maybeGenerateTopic(u);
}

// ── Auto-topic: once a chat has ~10 messages, generate a short session title
// via a one-shot model call and persist it into the transcript (appendSessionInfo),
// so the header/list stop saying "New chat". Runs single-flight; best-effort.
function msgText(m: Record<string, unknown>): string {
  return ((m.content ?? []) as Array<Record<string, unknown>>)
    .filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join(" ").trim();
}

async function generateTopic(msgs: Array<Record<string, unknown>>): Promise<string> {
  const s = (await createAgentSession({ resourceLoader: loader, cwd: agentCwd, sessionManager: SessionManager.inMemory(agentCwd), model, modelRuntime })).session;
  const excerpt = msgs.filter((m) => m.role === "user" || m.role === "assistant")
    .slice(0, 8).map((m) => `${m.role}: ${msgText(m)}`).join("\n").slice(0, 2000);
  let out = "";
  const off = s.subscribe((e) => {
    const a = (e as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
    if (e.type === "message_update" && a?.type === "text_delta" && a.delta) out += a.delta;
  });
  const timer = setTimeout(() => { void s.abort().catch(() => {}); }, 60_000);
  try {
    await s.prompt(`Give a very short topic title (3-5 words) for this Home Assistant conversation, written in the SAME language the user writes in (Danish if the user writes Danish, otherwise English). Do NOT use any tools. Reply with ONLY the title — no quotes, no punctuation.\n\n${excerpt}`);
  } catch { /* ignore */ } finally {
    clearTimeout(timer); off(); try { s.dispose(); } catch { /* ignore */ }
  }
  return out.trim().replace(/^["'#\s]+|["'\s]+$/g, "").split("\n")[0].slice(0, 64);
}

async function maybeGenerateTopic(u: UserSession): Promise<void> {
  try {
    if (!u.session || !u.sm || u.sm.getSessionName()) return;
    if ((u.session.messages ?? []).length < TOPIC_MIN_MESSAGES) return;
    if (!acquireNow(u)) return; // user busy — retry after the next turn
    u.busy = true;
    let title = "";
    try { title = await generateTopic((u.session.messages ?? []) as Array<Record<string, unknown>>); }
    finally { u.busy = false; releaseLock(u); }
    if (title && u.sm && !u.sm.getSessionName()) {
      u.sm.appendSessionInfo(title);
      broadcastTo(u, { type: "session_title", title });
    }
  } catch { /* best-effort */ }
}

// ── pi_agent.ask: queued fresh-context one-shot (voice/automation entry) ──
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
const ASK_MAX_PENDING = 5;
let askPending = 0;

async function fireLogbook(name: string, message: string): Promise<void> {
  const url = process.env.HA_URL, token = process.env.HA_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/api/events/logbook_entry`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, message, domain: "pi_agent" }) });
  } catch { /* best-effort */ }
}

async function handleAsk(question: string, overrides: { provider?: string; model?: string }): Promise<void> {
  await acquireAsk(); // queue behind other ask calls only (isolated from user turns)
  let askModel = model;
  if (overrides.provider && overrides.model) {
    const r = resolveCliModel({ cliModel: `${overrides.provider}/${overrides.model}`, modelRuntime });
    if (!r.error) askModel = r.model;
  }
  const askSession = (await createAgentSession({ resourceLoader: loader, cwd: agentCwd, sessionManager: SessionManager.inMemory(agentCwd), model: askModel, modelRuntime })).session;
  let answer = "";
  const unsub = askSession.subscribe((e) => {
    const a = (e as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
    if (e.type === "message_update" && a?.type === "text_delta" && a.delta) answer += a.delta;
  });
  const timer = setTimeout(() => { void askSession.abort().catch(() => {}); }, ASK_TIMEOUT_MS);
  try {
    await askSession.prompt(question);
  } catch {
    if (!answer) answer = "The request failed. Check the provider configuration and try again.";
  } finally {
    clearTimeout(timer);
    unsub();
    try { askSession.dispose(); } catch { /* ignore */ }
    releaseAsk();
  }
  await fireLogbook("Pi Agent", answer.trim() || "(no answer)");
}

// ── Session lifecycle: /new, /sessions list, resume ───────
async function startSessionFor(u: UserSession, sm: ReturnType<typeof SessionManager.create>): Promise<void> {
  if (u.unsub) { u.unsub(); u.unsub = null; }
  if (u.session) { try { u.session.dispose(); } catch { /* ignore */ } }
  u.sm = sm;
  // Not configured yet (no provider/model/key) — defer session creation until the
  // in-app setup saves a working combo (saveCombo sets `model`).
  if (!model) { u.session = null; return; }
  const created = await createAgentSession({ resourceLoader: loader, cwd: agentCwd, sessionManager: sm, model, modelRuntime });
  u.session = created.session;
  u.unsub = u.session.subscribe((e) => toWire(u, e));
  u.busy = false;
}

// Get-or-create a user's session slot. Enforces the MAX_USERS cap by evicting the
// least-recently-used idle (not busy) user first. Creates the session lazily.
async function getOrCreateUser(userId: string): Promise<UserSession> {
  let u = users.get(userId);
  if (u) { u.lastActivity = Date.now(); return u; }
  if (users.size >= MAX_USERS) {
    const victim = [...users.entries()].filter(([, s]) => !s.busy).sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0];
    if (victim) { disposeUser(victim[0]); }
  }
  u = newUserSession();
  users.set(userId, u);
  await startSessionFor(u, SessionManager.create(agentCwd, userDir(userId)));
  return u;
}

function disposeUser(userId: string): void {
  const u = users.get(userId);
  if (!u) return;
  if (u.unsub) { try { u.unsub(); } catch { /* ignore */ } }
  if (u.session) { try { u.session.dispose(); } catch { /* ignore */ } }
  users.delete(userId);
}

function relTime(iso?: string): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

async function listSessions(userId: string): Promise<Array<{ path: string; id: string; title: string; when: string; count: number }>> {
  const list = (await SessionManager.list(agentCwd, userDir(userId))) as unknown as Array<Record<string, unknown>>;
  return list
    .map((s) => ({
      path: String(s.path ?? ""),
      id: String(s.id ?? ""),
      title: (String(s.name ?? "").trim() || String(s.firstMessage ?? "").trim() || "Chat").slice(0, 64),
      when: relTime((s.modified ?? s.created) as string),
      count: Number(s.messageCount ?? 0),
      _t: new Date(String(s.modified ?? s.created ?? 0)).getTime(),
    }))
    .filter((s) => s.count > 0 && s.path)
    .sort((a, b) => b._t - a._t)
    .map(({ _t, ...s }) => s);
}

/** Reconstruct the frontend timeline (src/types.ts Entry[]) from a resumed session's messages. */
function historyEntries(u: UserSession): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const toolById: Record<string, Record<string, unknown>> = {};
  let n = 0;
  const nid = () => `h${n++}`;
  for (const m of (u.session?.messages ?? []) as Array<Record<string, unknown>>) {
    const role = m.role as string;
    const content = (m.content ?? []) as Array<Record<string, unknown>>;
    if (role === "user") {
      const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
      if (text) out.push({ kind: "user", id: nid(), text });
    } else if (role === "assistant") {
      let text = "";
      for (const c of content) {
        if (c.type === "text") text += (c.text as string) ?? "";
        else if (c.type === "toolCall") {
          const id = String(c.toolCallId ?? c.id ?? nid());
          const entry = { kind: "tool", id, toolName: String(c.toolName ?? c.name ?? "tool"), args: (c.args ?? c.input ?? {}) as Record<string, unknown>, running: false, isError: false, result: { kind: "text", data: "" } };
          toolById[id] = entry;
          out.push(entry);
        }
      }
      if (text.trim()) out.push({ kind: "assistant", id: nid(), text: text.trim(), thinking: "", streaming: false });
    } else if (role === "toolResult") {
      const id = String(m.toolCallId ?? content[0]?.toolCallId ?? "");
      const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      const e = toolById[id];
      if (e) { e.result = { kind: "text", data: text }; e.isError = !!m.isError; }
    }
  }
  return out;
}

// No global session at boot — sessions are created per HA user on WS connect
// (issue #NANH3). Probe once (throwaway) just to log readiness + tool count.
if (model) {
  try {
    const probe = (await createAgentSession({ resourceLoader: loader, cwd: agentCwd, sessionManager: SessionManager.inMemory(agentCwd), model, modelRuntime })).session;
    const tools = probe.agent.state.tools;
    console.log("[engine] ready — model=%s tools=%d (ha_*=%d)",
      probe.model?.id ?? "(default)", tools.length, tools.filter((t) => t.name.startsWith("ha_")).length);
    try { probe.dispose(); } catch { /* ignore */ }
  } catch { console.log("[engine] ready — model=%s", model.id); }
} else {
  console.log("[engine] ready — awaiting in-app provider/model/key setup");
}

// ── In-app provider setup ───────────────────────────────────
// Provider IDs, models, authentication and compatible-endpoint requests all come
// from the pinned Pi ModelRuntime. API-key validation uses memory-only credentials.
async function listApiKeyProviders(): Promise<Array<{ id: string; name: string; models: Array<{ id: string; name: string }>; baseUrl?: string; modelId?: string; authConfigured?: boolean }>> {
  try { await Promise.race([modelRuntime.refresh({ allowNetwork: true }), new Promise((r) => setTimeout(r, 15000))]); } catch { /* static catalogs remain available */ }
  const out: Array<{ id: string; name: string; models: Array<{ id: string; name: string }>; baseUrl?: string; modelId?: string; authConfigured?: boolean }> = [];
  for (const id of [...API_KEY_PROVIDERS, ...OAUTH_PROVIDERS]) {
    if (!modelRuntime.getProvider(id)) continue;
    let models: Array<{ id: string; name: string }> = [];
    try { models = modelRuntime.getModels(id).map((m) => ({ id: m.id, name: (m as { name?: string }).name ?? m.id })); } catch { models = []; }
    if (models.length) {
      let authConfigured = false;
      try { authConfigured = modelRuntime.getProviderAuthStatus(id).configured; } catch { /* shown as not connected */ }
      out.push({ id, name: PROVIDER_LABELS[id] ?? id, models, ...(id === "github-copilot" ? { authConfigured } : {}) });
    }
  }
  let custom: { baseUrl?: string; modelId?: string } = {};
  try {
    const config = (await readModelsJson()).providers[CUSTOM_PROVIDER];
    if (typeof config?.baseUrl === "string" && typeof config?.models?.[0]?.id === "string") {
      custom = { baseUrl: config.baseUrl, modelId: config.models[0].id };
    }
  } catch { /* omit malformed saved custom endpoint details */ }
  out.push({ id: CUSTOM_PROVIDER, name: "Custom OpenAI-compatible endpoint", models: [], ...custom });
  return out;
}

function configStatus(): { configured: boolean; provider?: string; model?: string } {
  let authed = false;
  try { authed = curProvider ? modelRuntime.getProviderAuthStatus(curProvider).configured : false; } catch { authed = false; }
  return { configured: !!model && authed, provider: curProvider, model: curModel };
}

type LiveModel = { stopReason?: string; content?: Array<{ type: string; text?: string }> };
async function testLiveModel(runtime: ModelRuntime, selectedModel: NonNullable<ReturnType<typeof resolveCliModel>["model"]>): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completion = runtime.completeSimple(selectedModel, { messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word OK." }], timestamp: Date.now() }] }, { maxTokens: 8, signal: controller.signal });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 30000); });
    const msg = await Promise.race([completion, timeout]) as LiveModel;
    return msg?.stopReason !== "error" && !!(msg?.content ?? []).some((c) => c.type === "text" && (c.text ?? "").trim());
  } catch { controller.abort(); return false; }
  finally { if (timer) clearTimeout(timer); }
}

async function testInIsolatedRuntime(provider: string, modelId: string, apiKey: string, custom?: Record<string, unknown>): Promise<boolean> {
  let runtime: ModelRuntime | undefined;
  try {
    runtime = await ModelRuntime.create({ credentials: memoryCredentialStore(), modelsPath: resolve(engineAgentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    if (custom) runtime.registerProvider(provider, custom as Parameters<ModelRuntime["registerProvider"]>[1]);
    else if (apiKey) await runtime.setRuntimeApiKey(provider, apiKey);
    const resolved = resolveCliModel({ cliModel: `${provider}/${modelId}`, modelRuntime: runtime });
    return !!resolved.model && !resolved.error && await testLiveModel(runtime, resolved.model);
  } catch { return false; }
}

async function validateCombo(provider: string, modelId: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!API_KEY_PROVIDERS.includes(provider)) return { ok: false, error: "Unsupported provider" };
  if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 200 || /[\u0000-\u001f\u007f]/.test(modelId)) return { ok: false, error: "Choose a valid model" };
  if (typeof apiKey !== "string" || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) return { ok: false, error: "Invalid API key input" };
  const cur = await readAi();
  const key = apiKey.trim() || (cur.provider === provider ? cur.api_key ?? "" : "");
  if (!key) {
    let configured = false;
    try { configured = modelRuntime.getProviderAuthStatus(provider).configured; } catch { /* reported below */ }
    if ((provider === "opencode" || provider === "opencode-go") && !configured) return { ok: false, error: "Enter your OpenCode API key" };
    const resolved = resolveCliModel({ cliModel: `${provider}/${modelId}`, modelRuntime });
    return resolved.model && !resolved.error && await testLiveModel(modelRuntime, resolved.model)
      ? { ok: true } : { ok: false, error: "Connection test failed. Check the selected model and credentials." };
  }
  return await testInIsolatedRuntime(provider, modelId, key)
    ? { ok: true } : { ok: false, error: "Connection test failed. Check the selected model and credentials." };
}

async function applySelection(provider: string, modelId: string): Promise<void> {
  curProvider = provider; curModel = modelId;
  const resolved = resolveCliModel({ cliModel: `${provider}/${modelId}`, modelRuntime });
  if (!resolved.error && resolved.model) model = resolved.model;
  for (const [uid, u] of users) {
    if (u.session && model) { try { await u.session.setModel(model); } catch { /* ignore */ } }
    else { try { await startSessionFor(u, u.sm ?? SessionManager.create(agentCwd, userDir(uid))); } catch { /* ignore */ } }
  }
  broadcastAll({ type: "config_status", data: configStatus() });
}

async function saveCombo(provider: string, modelId: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const v = await validateCombo(provider, modelId, apiKey);
  if (!v.ok) return v;
  const cur = await readAi();
  // A blank key only reuses the key for the same provider; switching clears the
  // legacy singleton instead of assigning one provider's key to another.
  const savedKey = apiKey.trim() || (cur.provider === provider ? cur.api_key ?? "" : "");
  const previousOptions = await readAddonOptions();
  const ai = { provider, model: modelId, ...(savedKey ? { api_key: savedKey } : {}) };
  const wrote = await writeAddonOptions({ ai });
  if (!wrote && supervisorToken()) return { ok: false, error: "Could not save provider settings" };
  if (savedKey) {
    try { await modelRuntime.setRuntimeApiKey(provider, savedKey); }
    catch {
      await writeAddonOptions({ ai: previousOptions.ai ?? {} });
      return { ok: false, error: "Could not save provider credentials" };
    }
  }
  await applySelection(provider, modelId);
  return { ok: true };
}

function validateCustomEndpoint(baseUrl: string, modelId: string, apiKey: string): { baseUrl: string; modelId: string; apiKey: string } | undefined {
  if (typeof baseUrl !== "string" || baseUrl.length > 2048 || typeof modelId !== "string" || typeof apiKey !== "string" || apiKey.length > 4096) return;
  const endpoint = baseUrl.trim();
  const id = modelId.trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id) || /[\u0000-\u001f\u007f]/.test(apiKey)) return;
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return;
    return { baseUrl: url.toString().replace(/\/$/, ""), modelId: id, apiKey: apiKey.trim() };
  } catch { return; }
}

function customProviderConfig(baseUrl: string, modelId: string, apiKey: string) {
  return {
    name: "Custom OpenAI-compatible endpoint", baseUrl, api: "openai-completions", apiKey: apiKey || NO_AUTH_PLACEHOLDER,
    models: [{ id: modelId, name: modelId, api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  };
}

async function saveCustomEndpoint(baseUrlInput: string, modelInput: string, keyInput: string): Promise<{ ok: boolean; error?: string }> {
  const input = validateCustomEndpoint(baseUrlInput, modelInput, keyInput);
  if (!input) return { ok: false, error: "Enter a valid HTTP(S) endpoint and model ID" };
  let state: ModelsJsonState;
  try { state = await readModelsJson(); } catch { return { ok: false, error: "Could not read the saved model configuration" }; }
  const previous = state.providers[CUSTOM_PROVIDER];
  const sameEndpoint = previous?.baseUrl === input.baseUrl;
  const effectiveKey = input.apiKey || (sameEndpoint && typeof previous?.apiKey === "string" ? previous.apiKey : NO_AUTH_PLACEHOLDER);
  const providerConfig = customProviderConfig(input.baseUrl, input.modelId, effectiveKey);
  if (!await testInIsolatedRuntime(CUSTOM_PROVIDER, input.modelId, "", providerConfig)) {
    return { ok: false, error: "Connection test failed. Check the endpoint, model ID, and API key." };
  }

  const providers = { ...state.providers, [CUSTOM_PROVIDER]: providerConfig };
  try {
    await writePrivateFile(resolve(engineAgentDir, "models.json"), JSON.stringify({ ...state.config, providers }, null, 2));
    await modelRuntime.refresh({ providers: [CUSTOM_PROVIDER], allowNetwork: false });
    const resolved = resolveCliModel({ cliModel: `${CUSTOM_PROVIDER}/${input.modelId}`, modelRuntime });
    if (resolved.error || !resolved.model) throw new Error("model unavailable");
  } catch {
    await restoreModelsJson(state).catch(() => {});
    await modelRuntime.refresh({ providers: [CUSTOM_PROVIDER], allowNetwork: false }).catch(() => {});
    return { ok: false, error: "Could not activate the tested endpoint; previous settings were kept" };
  }
  const wroteOptions = await writeAddonOptions({ ai: { provider: CUSTOM_PROVIDER, model: input.modelId } });
  if (!wroteOptions && supervisorToken()) {
    await restoreModelsJson(state).catch(() => {});
    await modelRuntime.refresh({ providers: [CUSTOM_PROVIDER], allowNetwork: false }).catch(() => {});
    return { ok: false, error: "Could not save provider settings; previous settings were kept" };
  }
  await applySelection(CUSTOM_PROVIDER, input.modelId);
  return { ok: true };
}

function safeAuthUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|api[_-]?key|key|authorization[_-]?code|code)$/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return; }
}

async function loginCopilot(modelId: string, notify: (event: Record<string, unknown>) => void): Promise<{ ok: boolean; error?: string }> {
  if (typeof modelId !== "string" || !modelId.trim() || !modelRuntime.getModel("github-copilot", modelId)) return { ok: false, error: "Choose a GitHub Copilot model" };
  try {
    const interaction: Parameters<typeof modelRuntime.login>[2] = {
      prompt: async (prompt) => {
        // Pi asks for an optional GitHub Enterprise domain; blank selects github.com.
        if (prompt.type === "text" && prompt.message.startsWith("GitHub Enterprise URL/domain")) return "";
        throw new Error("Unsupported GitHub Copilot sign-in prompt");
      },
      notify(event) {
        if (event.type === "device_code") {
          const auth = event as { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number };
          const verificationUri = safeAuthUrl(auth.verificationUri);
          if (verificationUri && auth.userCode.length <= 64) notify({ type: "device_code", userCode: auth.userCode, verificationUri, expiresInSeconds: auth.expiresInSeconds });
        } else if (event.type === "auth_url") {
          const auth = event as { url: string };
          const url = safeAuthUrl(auth.url);
          if (url) notify({ type: "auth_url", url });
        } else notify({ type: event.type === "progress" ? "progress" : "info" });
      },
    };
    if (!modelRuntime.getProviderAuthStatus("github-copilot").configured) {
      await modelRuntime.login("github-copilot", "oauth", interaction);
    }
  } catch { return { ok: false, error: "GitHub Copilot sign-in did not complete. Try again." }; }
  const resolved = resolveCliModel({ cliModel: `github-copilot/${modelId}`, modelRuntime });
  if (!resolved.model || resolved.error || !await testLiveModel(modelRuntime, resolved.model)) {
    return { ok: false, error: "GitHub Copilot sign-in worked, but the selected model could not be tested." };
  }
  const previousOptions = await readAddonOptions();
  const wrote = await writeAddonOptions({ ai: { provider: "github-copilot", model: modelId } });
  if (!wrote && supervisorToken()) { await writeAddonOptions({ ai: previousOptions.ai ?? {} }); return { ok: false, error: "Could not save provider settings" }; }
  await applySelection("github-copilot", modelId);
  return { ok: true };
}

// ── HTTP static (webapp/dist) ───────────────────────────────
const server = createServer(async (req, res) => {
  try {
    const url = (req.url ?? "/").split("?")[0];
    let file = join(distDir, url === "/" ? "index.html" : url.replace(/^\/+/, ""));
    try { if ((await stat(file)).isDirectory()) file = join(file, "index.html"); } catch { file = join(distDir, "index.html"); }
    if (!file.startsWith(distDir)) { res.writeHead(403).end(); return; }
    let body: Buffer;
    try { body = await readFile(file); } catch { body = await readFile(join(distDir, "index.html")); file = join(distDir, "index.html"); }
    const ext = extname(file);
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable" });
    res.end(body);
  } catch { res.writeHead(500).end("server error"); }
});

// ── Web search config (mirrors the AI provider flow) ────────
// A tool can't be hot-swapped like a model key: it must re-register. reloadTools
// re-runs loader.reload() (re-executes the extension → registerWebSearchTool reads
// the new WEBSEARCH_* env) and rebuilds the active session so web_search appears
// live, with no add-on restart.
async function reloadTools(): Promise<void> {
  // A tool can't be hot-swapped: recreate each active user's session so the new
  // WEBSEARCH_* tool set re-registers. Rare admin action (websearch enable/disable).
  try { await loader.reload(); } catch (e) { console.error("[engine] loader.reload:", (e as Error).message); }
  if (!model) return;
  for (const [uid, u] of users) {
    try { await startSessionFor(u, u.sm ?? SessionManager.create(agentCwd, userDir(uid))); } catch (e) { console.error("[engine] reload session:", (e as Error).message); }
  }
}
function websearchStatus(): { enabled: boolean; provider: string; providers: string[] } {
  return { enabled: wsEnabled, provider: wsProvider, providers: [...WS_PROVIDERS] };
}
async function validateWebsearch(provider: string, key: string): Promise<{ ok: boolean; error?: string }> {
  if (!WS_PROVIDERS.includes(provider as WsProvider)) return { ok: false, error: "Unsupported provider" };
  if (!key) return { ok: false, error: "Missing API key" };
  try {
    if (provider === "brave") {
      const r = await fetch("https://api.search.brave.com/res/v1/web/search?q=test&count=1", { headers: { Accept: "application/json", "X-Subscription-Token": key } });
      return r.ok ? { ok: true } : { ok: false, error: `Brave HTTP ${r.status}` };
    }
    const endpoint = provider === "perplexity_openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.perplexity.ai/chat/completions";
    const m = provider === "perplexity_openrouter" ? "perplexity/sonar" : "sonar";
    const r = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: m, messages: [{ role: "user", content: "ping" }], max_tokens: 16 }) });
    if (r.ok) return { ok: true };
    return { ok: false, error: `Provider rejected the request (HTTP ${r.status})` };
  } catch { return { ok: false, error: "Could not reach the search provider" }; }
}
async function saveWebsearch(provider: string, key: string): Promise<{ ok: boolean; error?: string }> {
  const cur = await readWebsearch();
  const finalKey = key || (cur.provider === provider ? cur.api_key || "" : "");
  const v = await validateWebsearch(provider, finalKey);
  if (!v.ok) return v;
  const wrote = await writeAddonOptions({ websearch: { enabled: true, provider, api_key: finalKey } });
  if (!wrote) return { ok: false, error: "Failed to persist config" };
  process.env.WEBSEARCH_ENABLED = "true";
  process.env.WEBSEARCH_PROVIDER = provider;
  process.env.WEBSEARCH_API_KEY = finalKey;
  wsEnabled = true; wsProvider = provider;
  await reloadTools();
  broadcastAll({ type: "websearch_status", data: websearchStatus() });
  return { ok: true };
}
async function disableWebsearch(): Promise<void> {
  const cur = await readWebsearch();
  await writeAddonOptions({ websearch: { enabled: false, provider: cur.provider || "perplexity", api_key: cur.api_key || "" } });
  process.env.WEBSEARCH_ENABLED = "false";
  wsEnabled = false;
  await reloadTools();
  broadcastAll({ type: "websearch_status", data: websearchStatus() });
}

let configQueue: Promise<unknown> = Promise.resolve();
function queueConfig<T>(operation: () => Promise<T>): Promise<T> {
  const result = configQueue.then(operation, operation);
  configQueue = result.then(() => undefined, () => undefined);
  return result;
}

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  // Identify the HA user from the ingress headers (issue #NANH3). Sessions are
  // isolated per user; fallback "default" for local dev / non-ingress access.
  const hdr = (k: string): string => { const v = req.headers[k]; return Array.isArray(v) ? v[0] : (v ?? ""); };
  const userId = sanitizeUserId(hdr("x-remote-user-id") || hdr("x-remote-user-name"));
  const sendTo = (msg: unknown) => { try { ws.send(JSON.stringify(msg)); } catch { /* dropped */ } };
  // Shared status (model/websearch config + stats) goes out immediately.
  sendTo({ type: "config_status", data: configStatus() });
  sendTo({ type: "websearch_status", data: websearchStatus() });
  void fetchStats().then((s) => { if (s) sendTo({ type: "stats", data: s }); });
  void listSessions(userId).then((s) => sendTo({ type: "sessions", data: s }));
  // Resolve this user's session slot, register the client, and restore the open
  // chat (DMDQW: page reload keeps the same session instead of a blank new chat).
  const ready = getOrCreateUser(userId).then((u) => {
    u.clients.add(ws);
    ws.on("close", () => u.clients.delete(ws));
    if (u.session) {
      sendTo({ type: "history", data: historyEntries(u) });
      const title = u.sm?.getSessionName?.();
      if (title) sendTo({ type: "session_title", title });
    }
    return u;
  });
  ws.on("message", (raw) => {
    const rawText = raw.toString();
    if (Buffer.byteLength(rawText) > 65536) return;
    let cmd: { type?: string; text?: string; path?: string; provider?: string; model?: string; modelId?: string; baseUrl?: string; apiKey?: string };
    try { cmd = JSON.parse(rawText); } catch { return; }
    void ready.then((u) => {
      switch (cmd.type) {
        case "prompt": if (cmd.text) void handlePrompt(u, cmd.text); break;
        case "abort": if (u.session) void u.session.abort().then(() => broadcastTo(u, { type: "aborted" })); break;
        case "list_sessions": void listSessions(userId).then((s) => sendTo({ type: "sessions", data: s })); break;
        case "new_session": void startSessionFor(u, SessionManager.create(agentCwd, userDir(userId))).then(() => broadcastTo(u, { type: "session_cleared" })); break;
        case "open_session": if (cmd.path) void startSessionFor(u, SessionManager.open(cmd.path, userDir(userId))).then(() => broadcastTo(u, { type: "history", data: historyEntries(u) })); break;
        case "list_providers": void listApiKeyProviders().then((p) => sendTo({ type: "providers", data: p })); break;
        case "save_config": void queueConfig(() => saveCombo(cmd.provider ?? "", cmd.model ?? "", cmd.apiKey ?? "")).then((r) => sendTo({ type: "config_result", data: r }), () => sendTo({ type: "config_result", data: { ok: false, error: "Could not save provider settings" } })); break;
        case "save_custom_config": void queueConfig(() => saveCustomEndpoint(cmd.baseUrl ?? "", cmd.modelId ?? "", cmd.apiKey ?? "")).then((r) => sendTo({ type: "config_result", data: r }), () => sendTo({ type: "config_result", data: { ok: false, error: "Could not save provider settings" } })); break;
        case "login_provider": void queueConfig(() => loginCopilot(cmd.model ?? "", (event) => sendTo({ type: "provider_auth_event", data: event }))).then((r) => sendTo({ type: "config_result", data: r }), () => sendTo({ type: "config_result", data: { ok: false, error: "Sign-in did not complete" } })); break;
        case "save_websearch": void saveWebsearch(cmd.provider ?? "", cmd.apiKey ?? "").then((r) => sendTo({ type: "websearch_result", data: r })); break;
        case "disable_websearch": void disableWebsearch(); break;
      }
    });
  });
});

// Idle eviction: dispose sessions idle > IDLE_MS (not busy, no live clients) to
// free heap — the JSONL persists on disk and reopens on demand (issue #NANH3).
setInterval(() => {
  const now = Date.now();
  for (const [uid, u] of [...users]) {
    if (!u.busy && u.clients.size === 0 && now - u.lastActivity > IDLE_MS) disposeUser(uid);
  }
}, 60_000).unref?.();

server.listen(PORT, "0.0.0.0", () => console.log(`[engine] http+ws on http://127.0.0.1:${PORT}`));

// ── pi_agent.ask API (internal, port 9199) — preserves the HA component contract ──
const ASK_PORT = Number(process.env.PI_ASK_PORT ?? 9199);
const askServer = createServer((req, res) => {
  const j = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "POST" && req.url === "/ask") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed: { question?: unknown; provider?: string; model?: string };
      try { parsed = JSON.parse(body); } catch { j(400, { error: "Invalid JSON" }); return; }
      if (!parsed.question || typeof parsed.question !== "string") { j(400, { error: "Missing 'question' field" }); return; }
      if (askPending >= ASK_MAX_PENDING) { j(429, { error: "Too many pending requests" }); return; }
      askPending += 1;
      void handleAsk(parsed.question, { provider: parsed.provider, model: parsed.model }).finally(() => { askPending -= 1; });
      j(202, { status: "accepted" });
    });
  } else if (req.method === "GET" && req.url === "/health") {
    j(200, { status: "ok", pending: askPending, busy: askLockHeld || [...users.values()].some((u) => u.busy) });
  } else {
    res.writeHead(404).end();
  }
});
askServer.listen(ASK_PORT, "0.0.0.0", () => console.log(`[engine] ask API on :${ASK_PORT}/ask`));
