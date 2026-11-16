/**
 * On-phone contractor quote parsing via Firebase AI Logic Hybrid (Gemini Nano on-device
 * through ML Kit Prompt API, cloud Gemini fallback) followed by deterministic TypeScript
 * Zod + rule validation.
 */
import { ZodError } from "zod";

import { ContractTerms, validateTerms } from "../../../../server/clause/contract/schema";
import {
  CONTRACT_SYSTEM,
  contractClauses,
  missingQuotes,
} from "../../../../shared/clause-ai/prompts";
import {
  renumberDuplicateMilestoneIds,
  stripNulls,
} from "../../../../shared/clause-ai/validate";
import {
  addDownloadListener,
  downloadModel,
  getStatus,
  parseContract,
  warmUp,
  type DownloadProgressEvent,
  type HybridInferenceMode,
  type InferenceSource,
  type OnDeviceStatus,
} from "../../modules/clause-hybrid-ai";

export {
  addDownloadListener,
  downloadModel,
  getStatus,
  warmUp,
  type DownloadProgressEvent,
  type HybridInferenceMode,
  type InferenceSource,
  type OnDeviceStatus,
};

/** Gemini Nano Prompt API limit is ~4,000 tokens (~9,000 chars including system rules). */
export const NANO_CHAR_THRESHOLD = 9000;

export const DEFAULT_CLOUD_MODEL = "gemini-3.5-flash-lite";

export interface AiRunMetadata {
  source: InferenceSource;
  model: string;
  ms: number;
}

export interface PhoneParseResult {
  terms: ContractTerms;
  problems: string[];
  ai: AiRunMetadata;
}

export function getConfiguredCloudModel(): string {
  const fromEnv = process.env.EXPO_PUBLIC_CLOUD_MODEL;
  return typeof fromEnv === "string" && fromEnv.trim().length > 0
    ? fromEnv.trim()
    : DEFAULT_CLOUD_MODEL;
}

export function resolveEffectiveMode(
  text: string,
  requestedMode?: HybridInferenceMode,
): HybridInferenceMode {
  if (!requestedMode) {
    return text.length > NANO_CHAR_THRESHOLD ? "prefer_in_cloud" : "prefer_on_device";
  }
  // When "Prefer on-device" is chosen on a long document that exceeds Nano's 4,000-token
  // budget, prefer cloud automatically; keep explicit "only_*" modes strict.
  if (requestedMode === "prefer_on_device" && text.length > NANO_CHAR_THRESHOLD) {
    return "prefer_in_cloud";
  }
  return requestedMode;
}

function parseJsonPayload(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export async function parseQuoteOnPhone(
  text: string,
  mode?: HybridInferenceMode,
): Promise<PhoneParseResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Paste a contractor quote before parsing.");
  }

  const effectiveMode = resolveEffectiveMode(trimmed, mode);
  const cloudModel = getConfiguredCloudModel();
  const prompt = `Extract the contract terms from this quote / thread:\n\n<document>\n${trimmed}\n</document>`;

  const raw = await parseContract(CONTRACT_SYSTEM, prompt, effectiveMode, cloudModel);
  const decoded = stripNulls(parseJsonPayload(raw.json));
  const terms = ContractTerms.parse(decoded);

  renumberDuplicateMilestoneIds(terms);
  terms.open_questions.push(...missingQuotes(contractClauses(terms), trimmed));

  const problems = validateTerms(terms);

  return {
    terms,
    problems,
    ai: {
      source: raw.source,
      model: raw.model,
      ms: Math.max(0, Math.round(raw.ms)),
    },
  };
}

export function formatAiBadge(ai: AiRunMetadata): string {
  const duration =
    ai.ms >= 1000 ? `${(ai.ms / 1000).toFixed(1)} s` : `${Math.round(ai.ms)} ms`;
  if (ai.source === "on_device") {
    const label = ai.model === "gemini-nano" ? "Gemini Nano" : ai.model;
    return `On-device · ${label} · ${duration}`;
  }
  return `Cloud · ${ai.model} · ${duration}`;
}

export function extractErrorDetails(err: unknown): { code?: string; message: string } {
  if (err instanceof ZodError) {
    const summary = err.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    return {
      code: "SCHEMA_INVALID",
      message: `Structured output failed deterministic Zod validation (${summary}).`,
    };
  }
  if (err && typeof err === "object") {
    const maybeCode = (err as { code?: unknown }).code;
    const maybeMsg = (err as { message?: unknown }).message;
    return {
      code: typeof maybeCode === "string" ? maybeCode : undefined,
      message:
        typeof maybeMsg === "string" && maybeMsg.trim().length > 0
          ? maybeMsg
          : "Unexpected native inference error.",
    };
  }
  return { message: String(err) };
}
