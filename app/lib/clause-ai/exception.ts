/**
 * Browser-side §3.4 client-entertainment exception explanation via Firebase AI Logic hybrid.
 * The AI ONLY extracts structured details (client, attendees, rationale) and explains;
 * deterministic policy code computes and enforces `max_allowed` and `one_time_cap`,
 * and manager approval on the server is still required before any card limit changes.
 */
import type { AI } from "firebase/ai";

import type { PolicyTerms } from "../../../server/clause/expense/schema.js";
import { EXCEPTION_SYSTEM, exceptionPrompt } from "../../../shared/clause-ai/prompts.js";
import {
  type ExceptionProposalValidated,
  RawModelException,
  validateExceptionExtraction,
} from "../../../shared/clause-ai/validate.js";
import { getRemoteConfigStepMode, isFirebaseConfigured } from "../firebase";
import {
  type AiSource,
  hybridGenerate,
  HybridSchemaError,
  type HybridMode,
} from "../hybrid-ai";

export interface ExplainExceptionAiInfo {
  source: AiSource;
  model: string;
  ms: number;
}

export interface ExplainExceptionOptions<TFallback = unknown> {
  requestedCharge?: number;
  requestedCap?: number;
  mode?: HybridMode;
  ai?: AI;
  serverFallback?: () => Promise<TFallback>;
}

export type ExplainExceptionResult<TFallback = unknown> =
  | {
      status: "ok";
      extraction: RawModelException;
      proposal: ExceptionProposalValidated;
      explanation: string;
      ai: ExplainExceptionAiInfo;
    }
  | {
      status: "fallback";
      fallback: TFallback;
      reason: string;
    };

export type ExceptionPolicyContext = Pick<PolicyTerms, "traveler" | "exception_clause">;

export function chooseExceptionMode(): HybridMode {
  return getRemoteConfigStepMode("exception");
}

export async function explainExceptionInBrowser<TFallback = unknown>(
  terms: ExceptionPolicyContext,
  note: string,
  opts: ExplainExceptionOptions<TFallback> = {},
): Promise<ExplainExceptionResult<TFallback>> {
  const mode = opts.mode ?? chooseExceptionMode();
  const trimmed = note.trim();

  const runFallback = async (reason: string): Promise<ExplainExceptionResult<TFallback>> => {
    const fallback = opts.serverFallback ? await opts.serverFallback() : (undefined as TFallback);
    return { status: "fallback", fallback, reason };
  };

  if (!terms.exception_clause) {
    return runFallback("no-exception-clause");
  }
  if (!trimmed) {
    return runFallback("empty-exception-note");
  }

  const available = Boolean(opts.ai) || isFirebaseConfigured();
  if (!available) {
    return runFallback("firebase-unavailable");
  }

  try {
    const r = await hybridGenerate({
      system: EXCEPTION_SYSTEM,
      prompt: exceptionPrompt(terms, trimmed),
      schema: RawModelException,
      step: "exception",
      mode,
      ...(opts.ai ? { ai: opts.ai } : {}),
    });

    const validation = validateExceptionExtraction(r.value, terms, {
      sourceNote: trimmed,
      ...(opts.requestedCharge !== undefined ? { requestedCharge: opts.requestedCharge } : {}),
      ...(opts.requestedCap !== undefined ? { requestedCap: opts.requestedCap } : {}),
    });
    if (!validation.ok || !validation.extraction || !validation.proposal) {
      return runFallback(`exception-validation-failed: ${validation.errors.join("; ")}`);
    }

    return {
      status: "ok",
      extraction: validation.extraction,
      proposal: validation.proposal,
      explanation: validation.proposal.rationale,
      ai: { source: r.source, model: r.model, ms: r.ms },
    };
  } catch (err) {
    if (err instanceof HybridSchemaError) {
      return runFallback(`exception-schema-failed: ${err.message}`);
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    return runFallback(`exception-inference-failed: ${msg}`);
  }
}
