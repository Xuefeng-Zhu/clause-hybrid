/**
 * Browser-side card-decline explanation via Firebase AI Logic hybrid inference.
 * The decline itself is decided by deterministic card rules (server/clause/policy/declineExplainer.ts).
 * The AI only rewrites those facts in plain words. A validator rejects any explanation that
 * invents an amount or suggests the money will move; the deterministic headline is shown instead.
 */
import type { AI } from "firebase/ai";
import { z } from "zod";

import { logAiCall } from "../ai-log";
import { getRemoteConfigStepMode, isFirebaseConfigured } from "../firebase";
import {
  type AiSource,
  hybridGenerate,
  HybridSchemaError,
  type HybridMode,
  isNavigatorOffline,
  needsConnectionOffline,
} from "../hybrid-ai";

export interface DeclineFacts {
  merchant_name: string;
  amount: number;
  currency: string;
  failure_reason?: string;
  headline: string;
  clause_id?: string;
  clause_quote?: string;
  can_request_exception?: boolean;
}

export const RawModelDeclineExplanation = z.object({
  explanation: z.string().min(1).max(600),
});

export const DECLINE_SYSTEM =
  "You explain why a contractor's company card charge was declined. Use only the facts given. " +
  "Write one or two short, plain sentences. Name the clause when one is given. " +
  "Never invent amounts or dates. Never say the charge was, will be, or can be approved, paid, or released.";

export function declinePrompt(f: DeclineFacts): string {
  const lines = [
    `Merchant: ${f.merchant_name}`,
    `Amount: ${f.currency} ${f.amount}`,
    `Decline code: ${f.failure_reason ?? "unknown"}`,
    `Rule result: ${f.headline}`,
  ];
  if (f.clause_id) lines.push(`Clause: ${f.clause_id}`);
  if (f.clause_quote) lines.push(`Clause text: "${f.clause_quote}"`);
  if (f.can_request_exception) lines.push("The holder may ask a manager for a one-time exception.");
  lines.push('Return JSON: {"explanation": string}');
  return lines.join("\n");
}

const PROMISE_WORDS = /\b(will be (approved|paid|released)|has been (approved|paid|released)|was (approved|paid|released)|can be (approved|paid|released)|is approved)\b/i;

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Deterministic check: every number in the explanation must come from the facts, and no promise of payment. */
export function validateDeclineExplanation(
  explanation: string,
  facts: DeclineFacts,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const text = explanation.trim();
  if (!text) errors.push("empty explanation");
  if (PROMISE_WORDS.test(text)) errors.push("explanation suggests money will move");
  const allowed = new Set<number>([
    facts.amount,
    ...numbersIn(facts.headline),
    ...numbersIn(facts.clause_quote ?? ""),
    ...numbersIn(facts.clause_id ?? ""),
  ]);
  for (const n of numbersIn(text)) {
    if (!allowed.has(n)) errors.push(`number ${n} is not in the facts`);
  }
  return { ok: errors.length === 0, errors };
}

/** What the card shows when AI can't run or its answer fails validation. */
export function deterministicDeclineText(f: DeclineFacts): string {
  return f.clause_quote ? `${f.headline} The clause says: "${f.clause_quote}"` : f.headline;
}

export type ExplainDeclineResult =
  | { status: "ok"; explanation: string; ai: { source: AiSource; model: string; ms: number } }
  | { status: "fallback"; explanation: string; reason: string };

export async function explainDeclineInBrowser(
  facts: DeclineFacts,
  opts: { mode?: HybridMode; ai?: AI } = {},
): Promise<ExplainDeclineResult> {
  const mode = opts.mode ?? getRemoteConfigStepMode("exception");
  const fallback = (reason: string): ExplainDeclineResult => ({
    status: "fallback",
    explanation: deterministicDeclineText(facts),
    reason,
  });

  // The rule result is already on the device, so offline we just show it. Nothing is sent.
  if (await needsConnectionOffline(mode)) return fallback("needs-connection");
  if (!opts.ai && !isFirebaseConfigured()) return fallback("firebase-unavailable");

  const effectiveMode: HybridMode = isNavigatorOffline() && !opts.ai ? "only_on_device" : mode;
  try {
    const r = await hybridGenerate({
      system: DECLINE_SYSTEM,
      prompt: declinePrompt(facts),
      schema: RawModelDeclineExplanation,
      step: "exception",
      mode: effectiveMode,
      ...(opts.ai ? { ai: opts.ai } : {}),
    });
    const v = validateDeclineExplanation(r.value.explanation, facts);
    void logAiCall({
      step: "exception",
      mode: effectiveMode,
      inferenceSource: r.source,
      latencyMs: r.ms,
      validatorOk: v.ok,
    });
    if (!v.ok) return fallback(`decline-validation-failed: ${v.errors.join("; ")}`);
    return {
      status: "ok",
      explanation: r.value.explanation.trim(),
      ai: { source: r.source, model: r.model, ms: r.ms },
    };
  } catch (err) {
    if (err instanceof HybridSchemaError) {
      void logAiCall({
        step: "exception",
        mode: effectiveMode,
        inferenceSource: err.source,
        latencyMs: err.ms,
        validatorOk: false,
      });
      return fallback(`decline-schema-failed: ${err.message}`);
    }
    return fallback(`decline-inference-failed: ${err instanceof Error ? err.message : "unknown"}`);
  }
}
