import { z } from "zod";
import { EXCEPTION_TOOL_SYSTEM, exceptionPrompt } from "../../../shared/clause-ai/prompts.js";
import { computeValidatedExceptionCap, RawModelException } from "../../../shared/clause-ai/validate.js";
import { callTool, llmProvider, withOfflineFallback } from "../llm.js";
import { ClauseRef } from "../contract/schema.js";
import type { PolicyTerms } from "./schema.js";

export { computeValidatedExceptionCap, RawModelException };

/**
 * Model-drafted exception proposal for §3.4 client entertainment, validated deterministically
 * in code so the cap can never exceed `per_attendee_cap * attendees`.
 */
export const ExceptionProposal = z.object({
  client: z.string(),
  attendees: z.number().int().positive(),
  attendee_names: z.array(z.string()).min(1),
  max_allowed: z.number().positive(),
  one_time_cap: z.number().positive(),
  requested_charge: z.number().positive().optional(),
  rationale: z.string(),
  source_note: z.string(),
  clause: ClauseRef,
});
export type ExceptionProposal = z.infer<typeof ExceptionProposal>;

export interface ActivePolicyException {
  approval_id: string;
  one_time_cap: number;
  base_per_charge_cap: number;
  client: string;
  attendees: number;
  clause: ClauseRef;
  expires_at: string; // 2 hours after manager approval
}

export async function draftPolicyException(
  terms: PolicyTerms,
  note: string,
  opts: { requestedCharge?: number; requestedCap?: number; extraction?: RawModelException } = {},
): Promise<ExceptionProposal> {
  const rule = terms.exception_clause;
  if (!rule) {
    throw new Error("This policy has no client-entertainment exception clause.");
  }
  const trimmed = note.trim();
  if (!trimmed) {
    throw new Error("Provide a note naming the client and attendees.");
  }

  const raw = opts.extraction
    ? RawModelException.parse(opts.extraction)
    : llmProvider()
      ? (await withOfflineFallback(() => extractWithClaude(terms, trimmed), () => extractOffline(trimmed))).value
      : extractOffline(trimmed);

  const effectiveRequestedCap = opts.requestedCap ?? raw.requested_cap;
  const { max_allowed, one_time_cap } = computeValidatedExceptionCap({
    client: raw.client,
    attendees: raw.attendees,
    attendee_names: raw.attendee_names,
    perAttendeeCap: rule.per_attendee_cap,
    requestedCap: effectiveRequestedCap,
  });

  return ExceptionProposal.parse({
    client: raw.client.trim(),
    attendees: raw.attendees,
    attendee_names: raw.attendee_names.map((s) => s.trim()).filter(Boolean),
    max_allowed,
    one_time_cap,
    ...(opts.requestedCharge !== undefined ? { requested_charge: opts.requestedCharge } : {}),
    rationale: raw.rationale.trim(),
    source_note: trimmed,
    clause: rule.clause,
  });
}

async function extractWithClaude(
  terms: PolicyTerms,
  note: string,
): Promise<RawModelException> {
  const callInput = await callTool({
    system: EXCEPTION_TOOL_SYSTEM,
    content: exceptionPrompt(terms, note),
    toolName: "propose_policy_exception",
    description: "Extract client entertainment exception details.",
    schema: z.toJSONSchema(RawModelException, { target: "draft-7" }) as Record<string, unknown>,
    maxTokens: 1024,
  });
  return RawModelException.parse(callInput);
}

function extractOffline(note: string): RawModelException {
  if (/Lone Star Logistics/i.test(note)) {
    return {
      client: "Lone Star Logistics",
      attendees: 4,
      attendee_names: [
        "Dana Ruiz (VP Ops)",
        "Kevin Tran (Ops lead)",
        "Priya Shah",
        "Marcus Lee",
      ],
      rationale:
        "Client dinner with Lone Star Logistics naming 4 attendees qualifies under §3.4 up to USD 500 ($125 × 4).",
    };
  }
  throw new Error(
    "Offline mode only understands the bundled Lone Star Logistics dinner note. Set ANTHROPIC_API_KEY to evaluate custom exception notes.",
  );
}
