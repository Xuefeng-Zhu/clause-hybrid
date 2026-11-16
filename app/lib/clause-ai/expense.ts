/**
 * Browser-side travel & expense policy parsing via Firebase AI Logic hybrid inference.
 * Raw policy and trip documents stay on this device unless cloud inference is selected;
 * deterministic validation runs in shared/clause-ai/validate.ts, falling back to the
 * existing server parser if hybrid inference fails or is unavailable.
 */
import type { AI } from "firebase/ai";

import { PolicyTerms } from "../../../server/clause/expense/schema.js";
import { POLICY_SYSTEM, policyPrompt } from "../../../shared/clause-ai/prompts.js";
import { validateExpenseTerms } from "../../../shared/clause-ai/validate.js";
import { getRemoteConfigThreshold, isFirebaseConfigured } from "../firebase";
import {
  type AiSource,
  hybridGenerate,
  HybridSchemaError,
  type HybridMode,
} from "../hybrid-ai";

export interface ParseExpenseAiInfo {
  source: AiSource;
  model: string;
  ms: number;
}

export interface ParseExpenseOptions<TFallback = unknown> {
  mode?: HybridMode;
  ai?: AI;
  serverFallback?: () => Promise<TFallback>;
}

export type ParseExpenseResult<TFallback = unknown> =
  | {
      status: "ok";
      kind: "policy";
      policyTerms: PolicyTerms;
      problems: string[];
      ai: ParseExpenseAiInfo;
    }
  | {
      status: "fallback";
      kind: "fallback";
      fallback: TFallback;
      reason: string;
    };

export function chooseExpenseMode(
  text: string,
  threshold = getRemoteConfigThreshold(),
): HybridMode {
  return text.length > threshold ? "prefer_in_cloud" : "prefer_on_device";
}

export async function parseExpenseInBrowser<TFallback = unknown>(
  text: string,
  opts: ParseExpenseOptions<TFallback> = {},
): Promise<ParseExpenseResult<TFallback>> {
  const mode = opts.mode ?? chooseExpenseMode(text);
  const available = Boolean(opts.ai) || isFirebaseConfigured();

  const runFallback = async (reason: string): Promise<ParseExpenseResult<TFallback>> => {
    const fallback = opts.serverFallback ? await opts.serverFallback() : (undefined as TFallback);
    return { status: "fallback", kind: "fallback", fallback, reason };
  };

  if (!available) {
    return runFallback("firebase-unavailable");
  }

  try {
    const r = await hybridGenerate({
      system: POLICY_SYSTEM,
      prompt: policyPrompt(text),
      schema: PolicyTerms,
      mode,
      ...(opts.ai ? { ai: opts.ai } : {}),
    });

    const validation = validateExpenseTerms(r.value, text);
    if (!validation.ok || !validation.policyTerms) {
      return runFallback(`expense-validation-failed: ${validation.errors.join("; ")}`);
    }

    return {
      status: "ok",
      kind: "policy",
      policyTerms: validation.policyTerms,
      problems: validation.problems,
      ai: { source: r.source, model: r.model, ms: r.ms },
    };
  } catch (err) {
    if (err instanceof HybridSchemaError) {
      return runFallback(`expense-schema-failed: ${err.message}`);
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    return runFallback(`expense-inference-failed: ${msg}`);
  }
}
