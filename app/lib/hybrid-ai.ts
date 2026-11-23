/**
 * Hybrid inference wrapper around Firebase AI Logic.
 *
 * On-device (Gemini Nano via Chrome's Prompt API) when available, cloud Gemini otherwise.
 * Every result says where it ran, which model, and how long it took, so the UI can show it
 * and the server can record it. The model only ever returns structured JSON; money decisions
 * stay in deterministic code.
 */
import { getGenerativeModel, InferenceMode, type AI, type Part } from "firebase/ai";
import { z } from "zod";

import { stripNulls } from "../../shared/clause-ai/validate.js";
import {
  type AiStep,
  getDefaultCloudModel,
  getFirebaseAI,
  getRemoteConfigStepMode,
  getRemoteConfigString,
  type HybridMode,
} from "./firebase";

export { stripNulls, type AiStep, type HybridMode };
export type AiSource = "on_device" | "in_cloud";

export interface HybridResult<T> {
  value: T;
  source: AiSource;
  model: string;
  ms: number;
}

export interface HybridImageInput {
  mimeType: "image/jpeg" | "image/png";
  base64: string;
}

/** Extra inline files (e.g. PDF proof). Cloud only: Chrome's on-device model can't read PDFs. */
export interface HybridFileInput {
  mimeType: "image/jpeg" | "image/png" | "application/pdf";
  base64: string;
}

export interface HybridRequest<S extends z.ZodTypeAny> {
  system: string;
  prompt: string;
  image?: HybridImageInput;
  files?: HybridFileInput[];
  schema: S;
  step?: AiStep;
  mode?: HybridMode;
  cloudModel?: string;
  /** Injected in tests. */
  ai?: AI;
}

export const ON_DEVICE_MODEL_LABEL = "Gemini Nano";
export const NEEDS_CONNECTION_MESSAGE = "Needs a connection. Nothing was sent.";

export interface NeedsConnectionResult {
  status: "needs-connection";
  kind: "needs-connection";
  message: string;
}

export function needsConnectionResult(): NeedsConnectionResult {
  return {
    status: "needs-connection",
    kind: "needs-connection",
    message: NEEDS_CONNECTION_MESSAGE,
  };
}

export const ON_DEVICE_UNAVAILABLE_MESSAGE = "On-device model not available. Nothing was sent.";
export const ON_DEVICE_FAILED_MESSAGE = "The on-device model couldn't read this. Nothing was sent.";

/**
 * Strict private mode (ONLY_ON_DEVICE) refused to run, or ran and failed. Either way nothing left
 * the browser: no Firebase AI Logic call and no Clause server fallback.
 */
export interface NothingSentResult {
  status: "on-device-unavailable" | "on-device-failed";
  kind: "on-device-unavailable" | "on-device-failed";
  message: string;
  availability?: OnDeviceAvailability;
  reason?: string;
}

export function onDeviceUnavailableResult(availability: OnDeviceAvailability): NothingSentResult {
  return {
    status: "on-device-unavailable",
    kind: "on-device-unavailable",
    message: ON_DEVICE_UNAVAILABLE_MESSAGE,
    availability,
  };
}

export function onDeviceFailedResult(reason?: string, message = ON_DEVICE_FAILED_MESSAGE): NothingSentResult {
  return { status: "on-device-failed", kind: "on-device-failed", message, ...(reason ? { reason } : {}) };
}

/** Any result where the browser stopped before sending anything (offline, or strict on-device). */
export function isNothingSentResult(r: unknown): r is NeedsConnectionResult | NothingSentResult {
  const status = (r as { status?: unknown } | null | undefined)?.status;
  return status === "needs-connection" || status === "on-device-unavailable" || status === "on-device-failed";
}

/**
 * Strict on-device gate. Call before touching the SDK. In ONLY_ON_DEVICE mode, unless Chrome's
 * LanguageModel says "available" right now, nothing may be sent: the Web SDK would otherwise pick
 * the cloud when its Chrome adapter is missing, and callers would fall back to the server.
 */
export async function strictOnDeviceBlock(mode: HybridMode): Promise<NothingSentResult | null> {
  if (mode !== "only_on_device") return null;
  const availability = await onDeviceAvailability();
  return availability === "available" ? null : onDeviceUnavailableResult(availability);
}

/** Thrown by hybridGenerate itself if a caller skipped strictOnDeviceBlock. Nothing was sent. */
export class OnDeviceUnavailableError extends Error {
  readonly availability: OnDeviceAvailability;
  constructor(availability: OnDeviceAvailability) {
    super(ON_DEVICE_UNAVAILABLE_MESSAGE);
    this.name = "OnDeviceUnavailableError";
    this.availability = availability;
  }
}

export function isNavigatorOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * True when the browser reports offline AND either on-device AI is unavailable
 * or the configured mode disallows on-device inference (`only_in_cloud`).
 */
export async function needsConnectionOffline(mode: HybridMode): Promise<boolean> {
  if (!isNavigatorOffline()) return false;
  if (mode === "only_in_cloud") return true;
  const avail = await onDeviceAvailability();
  return avail !== "available";
}

/** Error thrown when model inference completed but JSON extraction or Zod schema parsing failed. */
export class HybridSchemaError extends Error {
  readonly source: AiSource;
  readonly model: string;
  readonly ms: number;
  readonly causeError?: unknown;

  constructor(
    message: string,
    meta: { source: AiSource; model: string; ms: number; cause?: unknown },
  ) {
    super(message);
    this.name = "HybridSchemaError";
    this.source = meta.source;
    this.model = meta.model;
    this.ms = meta.ms;
    this.causeError = meta.cause;
  }
}

const MODE_MAP: Record<HybridMode, (typeof InferenceMode)[keyof typeof InferenceMode]> = {
  prefer_on_device: InferenceMode.PREFER_ON_DEVICE,
  only_on_device: InferenceMode.ONLY_ON_DEVICE,
  prefer_in_cloud: InferenceMode.PREFER_IN_CLOUD,
  only_in_cloud: InferenceMode.ONLY_IN_CLOUD,
};

/** JSON Schema for the model, without the $schema key that the APIs reject. */
export function toModelJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/**
 * On-device variant of the JSON schema. Gemini Nano tends to skip optional top-level fields, so
 * every top-level property becomes required but nullable; nulls are stripped again before zod
 * validation, so "not in the document" still means "absent". Cloud keeps the plain schema.
 */
export function toOnDeviceJsonSchema(json: Record<string, unknown>): Record<string, unknown> {
  const props = json.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return json;
  const required = new Set((json.required as string[] | undefined) ?? []);
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    properties[key] = required.has(key) || "default" in value ? value : { anyOf: [value, { type: "null" }] };
  }
  return { ...json, properties, required: Object.keys(props) };
}

/** Strip a ```json fence if a model wraps its answer in one. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export async function hybridGenerate<S extends z.ZodTypeAny>(
  req: HybridRequest<S>,
): Promise<HybridResult<z.infer<S>>> {
  const mode =
    req.mode ??
    (req.step
      ? getRemoteConfigStepMode(req.step)
      : (getRemoteConfigString("parse_mode", "prefer_on_device") as HybridMode));
  // Strict private mode: refuse before the SDK (or Remote Config) is touched, so nothing can reach the cloud.
  if (mode === "only_on_device") {
    const availability = await onDeviceAvailability();
    if (availability !== "available") throw new OnDeviceUnavailableError(availability);
    if (req.files?.some((f) => f.mimeType === "application/pdf")) {
      throw new OnDeviceUnavailableError("unsupported");
    }
  }

  const cloudModel = req.cloudModel ?? getRemoteConfigString("cloud_model", getDefaultCloudModel());
  const jsonSchema = toModelJsonSchema(req.schema);

  const ai = req.ai ?? getFirebaseAI();

  const model = getGenerativeModel(ai, {
    mode: MODE_MAP[mode] ?? InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
      model: cloudModel,
      systemInstruction: req.system,
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema,
      },
    },
    onDeviceParams: {
      createOptions: {
        expectedInputs: req.image
          ? [{ type: "image" }, { type: "text", languages: ["en"] }]
          : [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        initialPrompts: [{ role: "system", content: [{ type: "text", value: req.system }] }],
      },
      promptOptions: { responseConstraint: toOnDeviceJsonSchema(jsonSchema) },
    },
  });

  const started = now();
  const inline = [
    ...(req.image ? [req.image] : []),
    ...(req.files ?? []),
  ];
  const content: string | Part[] = inline.length
    ? [
        { type: "text", text: req.prompt },
        ...inline.map(
          (f): Part => ({ type: "inlineData", inlineData: { mimeType: f.mimeType, data: f.base64 } }) as Part,
        ),
      ]
    : req.prompt;
  const result = await model.generateContent(content);
  const ms = Math.round(now() - started);
  const response = result.response;
  const source: AiSource =
    response.inferenceSource === "on_device" || response.inferenceSource === "in_cloud"
      ? response.inferenceSource
      : mode === "only_on_device"
        ? "on_device"
        : "in_cloud";

  const modelLabel = source === "on_device" ? ON_DEVICE_MODEL_LABEL : cloudModel;
  try {
    const value = req.schema.parse(stripNulls(extractJson(response.text())));
    return { value, source, model: modelLabel, ms };
  } catch (err) {
    throw new HybridSchemaError(
      err instanceof Error ? err.message : "Model output did not match schema.",
      { source, model: modelLabel, ms, cause: err },
    );
  }
}

export type OnDeviceAvailability = "available" | "downloadable" | "downloading" | "unavailable" | "unsupported";

/** What Chrome says about the on-device model, for the UI. Never throws. */
export async function onDeviceAvailability(): Promise<OnDeviceAvailability> {
  try {
    const LM = (globalThis as unknown as { LanguageModel?: { availability: () => Promise<string> } }).LanguageModel;
    if (!LM?.availability) return "unsupported";
    const a = await LM.availability();
    return (["available", "downloadable", "downloading", "unavailable"] as const).includes(a as never)
      ? (a as OnDeviceAvailability)
      : "unavailable";
  } catch {
    return "unsupported";
  }
}

/**
 * Every place AI output can come from. The browser path (Firebase AI Logic hybrid) reports
 * on_device / in_cloud; the server path reports server (its own Gemini/Anthropic call) or
 * offline (the offline fixture rules, no model ran).
 */
export type AiSourceKind = AiSource | "server" | "offline";

export interface AiSourceDisplay {
  source: AiSourceKind;
  model: string;
  ms: number;
  parsedBy?: "gemini" | "anthropic" | "offline-fixture";
}

export const OFFLINE_RULES_LABEL = "Offline rules";

function formatLatency(ms: number): string {
  const rounded = Math.max(0, Math.round(ms));
  return rounded >= 1000 ? `${(rounded / 1000).toFixed(1)} s` : `${rounded} ms`;
}

/** "On-device · Gemini Nano · 840 ms", "Cloud · …", "Server · gemini-3.8-flash · 2.1 s", or "Offline rules". */
export function formatAiSource(r: AiSourceDisplay): string {
  if (r.source === "offline" || r.parsedBy === "offline-fixture") return OFFLINE_RULES_LABEL;
  const where = r.source === "on_device" ? "On-device" : r.source === "server" ? "Server" : "Cloud";
  return `${where} · ${r.model} · ${formatLatency(r.ms)}`;
}
