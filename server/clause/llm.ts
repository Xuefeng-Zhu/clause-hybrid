import Anthropic from "@anthropic-ai/sdk";
import { getProviderConfig, type ProviderConfig } from "./config.js";
import { assertServerModelAllowed, isContestMode } from "./contest-mode.js";

/**
 * One structured "tool call" to whichever model is configured.
 * Gemini (GEMINI_API_KEY) is preferred; Anthropic (ANTHROPIC_API_KEY) is the fallback.
 * Callers pass Anthropic-style content blocks; they are translated for Gemini.
 * The model only fills a schema; every limit is still decided in code by the caller.
 */
export type LlmProvider = "gemini" | "claude";

export function llmProvider(providers?: ProviderConfig): LlmProvider | undefined {
  // Contest mode: no direct provider, ever. Every server AI step takes its offline path.
  if (isContestMode()) return undefined;
  const { gemini, anthropic } = providers ?? getProviderConfig();
  if (gemini.apiKey) return "gemini";
  if (anthropic.apiKey) return "claude";
  return undefined;
}

export function llmModelLabel(): string {
  const p = llmProvider();
  if (p === "gemini") return getProviderConfig().gemini.model;
  if (p === "claude") return getProviderConfig().anthropic.model;
  if (isContestMode()) return "offline rules (contest mode: server model providers off)";
  return "offline fixtures (no GEMINI_API_KEY / ANTHROPIC_API_KEY)";
}

export interface ToolCallRequest {
  system: string;
  content: string | Anthropic.ContentBlockParam[];
  toolName: string;
  description: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

/**
 * Run the live model path; if the model is unavailable (outage, rate limit) fall back to the
 * offline path when it can handle this input. Limits are still enforced in code either way.
 */
export async function withOfflineFallback<T>(
  live: () => Promise<T>,
  offline: () => T | Promise<T>,
): Promise<{ value: T; usedFallback: boolean; ms: number }> {
  const started = Date.now();
  try {
    const value = await live();
    return { value, usedFallback: false, ms: Date.now() - started };
  } catch (err) {
    try {
      const value = await offline();
      console.warn(`[clause] model call failed, using offline fallback: ${(err as Error).message}`);
      return { value, usedFallback: true, ms: Date.now() - started };
    } catch {
      throw err;
    }
  }
}

/** Which server path produced an AI result. Never on-device or browser AI Logic. */
export type ServerParsedBy = "gemini" | "anthropic" | "offline-fixture";

/**
 * Provenance for AI output produced on the server, so the UI can badge it honestly:
 * "Server · <model> · <latency>" for a live model call, "Offline rules" for the fixture path.
 */
export interface ServerAiSource {
  source: "server" | "offline";
  model: string;
  ms: number;
  parsedBy: ServerParsedBy;
}

export function serverAiSource(usedOffline: boolean, ms: number): ServerAiSource {
  const p = llmProvider();
  const rounded = Math.max(0, Math.round(ms));
  if (usedOffline || !p) {
    return { source: "offline", model: "offline-fixture", ms: rounded, parsedBy: "offline-fixture" };
  }
  const { gemini, anthropic } = getProviderConfig();
  return {
    source: "server",
    model: p === "gemini" ? gemini.model : anthropic.model,
    ms: rounded,
    parsedBy: p === "claude" ? "anthropic" : "gemini",
  };
}

export async function callTool(req: ToolCallRequest): Promise<unknown> {
  assertServerModelAllowed(req.toolName);
  const providers = getProviderConfig();
  const p = llmProvider(providers);
  if (p === "gemini") return callGemini(req, providers.gemini);
  if (p === "claude") return callClaude(req, providers.anthropic);
  throw new Error("No model configured. Set GEMINI_API_KEY (or ANTHROPIC_API_KEY).");
}

async function callClaude(req: ToolCallRequest, { apiKey, model }: ProviderConfig["anthropic"]): Promise<unknown> {
  assertServerModelAllowed("anthropic");
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    tools: [{ name: req.toolName, description: req.description, input_schema: req.schema as Anthropic.Tool.InputSchema }],
    tool_choice: { type: "tool", name: req.toolName },
    messages: [{ role: "user", content: req.content }],
  });
  const call = msg.content.find((b) => b.type === "tool_use");
  if (!call || call.type !== "tool_use") throw new Error(`Model did not call ${req.toolName}.`);
  return call.input;
}

/** Strip JSON-schema keys Gemini's function declarations reject. */
function cleanSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "$schema" || k === "$id" || k === "additionalProperties") continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

function toGeminiParts(content: ToolCallRequest["content"]): GeminiPart[] {
  if (typeof content === "string") return [{ text: content }];
  return content.flatMap((b): GeminiPart[] => {
    if (b.type === "text") return [{ text: b.text }];
    if ((b.type === "image" || b.type === "document") && b.source.type === "base64") {
      return [{ inline_data: { mime_type: b.source.media_type, data: b.source.data } }];
    }
    return [];
  });
}

async function callGemini(req: ToolCallRequest, { apiKey, model, fallbackModels }: ProviderConfig["gemini"]): Promise<unknown> {
  assertServerModelAllowed("gemini");
  const body = {
    system_instruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: toGeminiParts(req.content) }],
    tools: [
      {
        function_declarations: [
          { name: req.toolName, description: req.description, parametersJsonSchema: cleanSchema(req.schema) },
        ],
      },
    ],
    tool_config: { function_calling_config: { mode: "ANY", allowed_function_names: [req.toolName] } },
    generationConfig: {
      maxOutputTokens: Math.max(req.maxTokens, 2048) * 4,
      temperature: 0,
      // Extraction into a fixed schema needs little reasoning; keep latency demo-friendly.
      thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING || "low" }, // guard:allow-env-credential — deployment model reasoning level
    },
  };
  type GeminiJson = {
    error?: { message?: string };
    candidates?: { content?: { parts?: { functionCall?: { name: string; args: unknown } }[] } }[];
  };
  // Gemini returns 429/503 ("high demand") in bursts, and under load a call can hang. Retry
  // transient errors and timeouts on the next model (same key, separate capacity), within an
  // overall budget so the caller can fall back to the offline path instead of spinning.
  const perAttemptMs = Number(process.env.GEMINI_ATTEMPT_TIMEOUT_MS) || 25_000; // guard:allow-env-credential — deployment timeout in milliseconds
  const budgetMs = Number(process.env.GEMINI_BUDGET_MS) || 60_000; // guard:allow-env-credential — deployment time budget in milliseconds
  const started = Date.now();
  const models = [model, model, ...fallbackModels.filter((fallback) => fallback !== model)];
  let lastError = "unknown";
  for (let attempt = 0; attempt < models.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 1000 : 300));
    const remaining = budgetMs - (Date.now() - started);
    if (remaining < 3_000) break;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${models[attempt]}:generateContent`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey! },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(perAttemptMs, remaining)),
      });
    } catch (err) {
      lastError = `${models[attempt]}: ${(err as Error).message}`; // timeout or network error: try the next model
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as GeminiJson;
    if (res.ok) {
      const call = json.candidates?.[0]?.content?.parts?.find((p) => p.functionCall)?.functionCall;
      if (!call) throw new Error(`Gemini did not call ${req.toolName}.`);
      return call.args;
    }
    lastError = `${res.status}: ${json.error?.message ?? "unknown"}`;
    if (![429, 500, 502, 503, 504].includes(res.status)) break;
  }
  throw new Error(`Gemini error ${lastError}`);
}
