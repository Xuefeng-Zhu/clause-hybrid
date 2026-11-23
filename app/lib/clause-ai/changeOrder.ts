/**
 * Browser-side change-order drafting via Firebase AI Logic hybrid inference.
 * AI ONLY drafts structured milestone deltas/reasons, deadline, and verbatim source quote;
 * deterministic code in shared/clause-ai/validate.ts computes every resulting milestone amount
 * and total, and the server still requires owner approval before card controls or mandates change.
 */
import type { AI } from "firebase/ai";

import {
  CHANGE_ORDER_SYSTEM,
  changeOrderPrompt,
  type PromptContractContext,
} from "../../../shared/clause-ai/prompts.js";
import {
  type CanonicalChangeOrderProposal,
  RawModelChangeOrder,
  validateChangeOrderDraft,
} from "../../../shared/clause-ai/validate.js";
import { logAiCall } from "../ai-log";
import { getRemoteConfigStepMode, isFirebaseConfigured } from "../firebase";
import {
  type AiSource,
  hybridGenerate,
  HybridSchemaError,
  type HybridMode,
  isNavigatorOffline,
  needsConnectionOffline,
  needsConnectionResult,
  type NeedsConnectionResult,
  type NothingSentResult,
  onDeviceFailedResult,
  strictOnDeviceBlock,
} from "../hybrid-ai";

export interface DraftChangeOrderAiInfo {
  source: AiSource;
  model: string;
  ms: number;
}

export interface DraftChangeOrderOptions<TFallback = unknown> {
  mode?: HybridMode;
  ai?: AI;
  serverFallback?: () => Promise<TFallback>;
}

export type DraftChangeOrderResult<TFallback = unknown> =
  | {
      status: "ok";
      draft: RawModelChangeOrder;
      proposal: CanonicalChangeOrderProposal;
      computed: {
        oldTotal: number;
        newTotal: number;
        totalDelta: number;
      };
      ai: DraftChangeOrderAiInfo;
    }
  | {
      status: "fallback";
      fallback: TFallback;
      reason: string;
    }
  | NeedsConnectionResult
  | NothingSentResult;

export function chooseChangeOrderMode(): HybridMode {
  return getRemoteConfigStepMode("changeOrder");
}

export async function draftChangeOrderInBrowser<TFallback = unknown>(
  terms: PromptContractContext,
  emailText: string,
  opts: DraftChangeOrderOptions<TFallback> = {},
): Promise<DraftChangeOrderResult<TFallback>> {
  const mode = opts.mode ?? chooseChangeOrderMode();
  const offline = isNavigatorOffline();
  const trimmed = emailText.trim();

  // Never guess or contact server/cloud when offline and on-device is unavailable.
  if (await needsConnectionOffline(mode)) {
    return needsConnectionResult();
  }

  // Strict private mode: unless the on-device model is ready, stop here. No SDK call, no server.
  const strictBlock = await strictOnDeviceBlock(mode);
  if (strictBlock) return strictBlock;
  const strict = mode === "only_on_device";

  const runFallback = async (reason: string): Promise<DraftChangeOrderResult<TFallback>> => {
    if (isNavigatorOffline()) {
      return needsConnectionResult();
    }
    // Strict mode never hands the document to the server (or any other model) after a failure.
    if (strict) return onDeviceFailedResult(reason);
    const fallback = opts.serverFallback ? await opts.serverFallback() : (undefined as TFallback);
    return { status: "fallback", fallback, reason };
  };

  if (!trimmed) {
    return runFallback("empty-change-order-email");
  }

  const available = Boolean(opts.ai) || isFirebaseConfigured();
  if (!available) {
    return runFallback("firebase-unavailable");
  }

  const effectiveMode: HybridMode = offline && !opts.ai ? "only_on_device" : mode;

  try {
    const r = await hybridGenerate({
      system: CHANGE_ORDER_SYSTEM,
      prompt: changeOrderPrompt(terms, trimmed),
      schema: RawModelChangeOrder,
      step: "changeOrder",
      mode: effectiveMode,
      ...(opts.ai ? { ai: opts.ai } : {}),
    });

    const validation = validateChangeOrderDraft(r.value, terms, trimmed);
    void logAiCall({
      step: "changeOrder",
      mode: effectiveMode,
      inferenceSource: r.source,
      latencyMs: r.ms,
      validatorOk: validation.ok,
    });
    if (!validation.ok || !validation.draft || !validation.proposal || !validation.computed) {
      return runFallback(`change-order-validation-failed: ${validation.errors.join("; ")}`);
    }

    return {
      status: "ok",
      draft: validation.draft,
      proposal: validation.proposal,
      computed: validation.computed,
      ai: { source: r.source, model: r.model, ms: r.ms },
    };
  } catch (err) {
    if (err instanceof HybridSchemaError) {
      void logAiCall({
        step: "changeOrder",
        mode: effectiveMode,
        inferenceSource: err.source,
        latencyMs: err.ms,
        validatorOk: false,
      });
      return runFallback(`change-order-schema-failed: ${err.message}`);
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    return runFallback(`change-order-inference-failed: ${msg}`);
  }
}
