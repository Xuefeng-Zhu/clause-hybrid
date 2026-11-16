/**
 * Pure validation & normalization helpers shared across browser, mobile (Expo), and server.
 * Zero Node, DOM, or SDK imports.
 */
import { z } from "zod";
import type { ClauseRef, ContractTerms } from "../../server/clause/contract/schema.js";
import { addDaysIso, PolicyTerms, validatePolicyTerms } from "../../server/clause/expense/schema.js";
import {
  missingQuotes,
  policyClauses,
  type PromptContractContext,
  type PromptMilestoneContext,
} from "./prompts.js";

/**
 * Drop null values (recursively) so optional fields the model marked "not present"
 * parse as absent (`undefined`) when validated with Zod.
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== null) out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

/**
 * Milestone ids are labels, not money: if the model repeats one, renumber M1..Mn in document
 * order. Amounts are never touched; a bad sum stays a validation problem for a human.
 */
export function renumberDuplicateMilestoneIds(terms: ContractTerms): void {
  const ids = terms.milestones.map((m) => m.id);
  if (new Set(ids).size === ids.length) return;
  terms.milestones.forEach((m, i) => {
    m.id = `M${i + 1}`;
  });
}

/** Verify YYYY-MM-DD string represents an actual calendar date (rejects e.g. 2026-02-30). */
export function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/** Deterministically apply the 48-hour post-trip card expiry window when cited in the quote. */
export function normalizePolicyExpiry(terms: PolicyTerms): void {
  if (/48\s+hours\s+after/i.test(terms.card_expires.clause.quote) && isValidIsoDate(terms.trip_end)) {
    terms.card_expires.date = addDaysIso(terms.trip_end, 2);
  }
}

export interface ExpenseValidationResult {
  ok: boolean;
  policyTerms?: PolicyTerms;
  errors: string[];
  problems: string[];
}

/**
 * Deterministic validation for extracted PolicyTerms (structure, required strings & clause quotes,
 * calendar date validity, 48h expiry calculation, cap <= budget check, and verbatim quote flagging).
 */
export function validateExpenseTerms(raw: unknown, sourceText?: string): ExpenseValidationResult {
  const cleaned = stripNulls(raw);
  const parsed = PolicyTerms.safeParse(cleaned);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
      problems: [],
    };
  }

  const terms = parsed.data;
  const errors: string[] = [];

  if (!terms.policy_ref.trim()) errors.push("policy_ref is required.");
  if (!terms.company.trim()) errors.push("company is required.");
  if (!terms.traveler.trim()) errors.push("traveler is required.");
  if (!terms.approver.trim()) errors.push("approver is required.");
  if (!terms.purpose.trim()) errors.push("purpose is required.");
  if (!/^[A-Z]{3}$/.test(terms.currency.trim())) {
    errors.push(`currency "${terms.currency}" must be a 3-letter ISO code.`);
  }

  const clauses: Array<[string, ClauseRef]> = [
    ["budget", terms.budget.clause],
    ["per_charge_cap", terms.per_charge_cap.clause],
    ["allowed_spend", terms.allowed_spend.clause],
    ["card_expires", terms.card_expires.clause],
    ...terms.prohibited_spend.map((p, idx): [string, ClauseRef] => [`prohibited_spend[${idx}]`, p.clause]),
    ...(terms.lodging_clause ? ([["lodging_clause", terms.lodging_clause]] as Array<[string, ClauseRef]>) : []),
    ...(terms.exception_clause ? ([["exception_clause", terms.exception_clause.clause]] as Array<[string, ClauseRef]>) : []),
  ];
  for (const [label, clause] of clauses) {
    if (!clause.clause_id.trim()) errors.push(`${label}.clause.clause_id is required.`);
    if (!clause.quote.trim()) errors.push(`${label}.clause.quote is required.`);
  }

  if (!isValidIsoDate(terms.trip_start)) {
    errors.push(`Trip start "${terms.trip_start}" is not a valid YYYY-MM-DD date.`);
  }
  if (!isValidIsoDate(terms.trip_end)) {
    errors.push(`Trip end "${terms.trip_end}" is not a valid YYYY-MM-DD date.`);
  }

  normalizePolicyExpiry(terms);

  if (!isValidIsoDate(terms.card_expires.date)) {
    errors.push(`Card expiry "${terms.card_expires.date}" is not a valid YYYY-MM-DD date.`);
  }

  if (sourceText) {
    const quoteIssues = missingQuotes(policyClauses(terms), sourceText);
    for (const issue of quoteIssues) {
      if (!terms.open_questions.includes(issue)) {
        terms.open_questions.push(issue);
      }
    }
  }

  const problems = validatePolicyTerms(terms);
  for (const problem of problems) {
    if (!errors.includes(problem)) errors.push(problem);
  }

  if (errors.length > 0) {
    return { ok: false, errors, problems };
  }

  return { ok: true, policyTerms: terms, errors: [], problems: [] };
}

/**
 * Schema for AI-only exception extraction & explanation.
 * Note: NO dollar caps or approval fields here — deterministic code calculates all amounts.
 */
export const RawModelException = z.object({
  client: z.string(),
  attendees: z.number().int().positive(),
  attendee_names: z.array(z.string()).min(1),
  requested_cap: z.number().positive().optional(),
  rationale: z.string(),
});
export type RawModelException = z.infer<typeof RawModelException>;

export interface ExceptionProposalValidated {
  client: string;
  attendees: number;
  attendee_names: string[];
  max_allowed: number;
  one_time_cap: number;
  requested_charge?: number;
  rationale: string;
  source_note: string;
  clause: ClauseRef;
}

export interface ExceptionValidationResult {
  ok: boolean;
  extraction?: RawModelException;
  proposal?: ExceptionProposalValidated;
  errors: string[];
}

/**
 * Pure deterministic cap computation & validation:
 * - max_allowed = per_attendee_cap * attendees (e.g. 125 * 4 = 500)
 * - one_time_cap = min(requestedCap, max_allowed), never above 125 * attendees
 * - requires named client and distinct named attendees matching count
 */
export function computeValidatedExceptionCap(input: {
  client: string;
  attendees: number;
  attendee_names: string[];
  perAttendeeCap: number;
  requestedCap?: number | undefined;
}): { max_allowed: number; one_time_cap: number } {
  if (!input.client.trim()) {
    throw new Error("Exception request must name the client (§3.4).");
  }
  if (!Number.isInteger(input.attendees) || input.attendees < 1) {
    throw new Error("Attendee count must be a positive integer.");
  }
  if (!Number.isFinite(input.perAttendeeCap) || input.perAttendeeCap <= 0) {
    throw new Error("Policy per-attendee cap must be positive (§3.4).");
  }
  const cleanNames = input.attendee_names.map((n) => n.trim()).filter(Boolean);
  if (cleanNames.length < input.attendees) {
    throw new Error(
      `Exception names ${cleanNames.length} attendee(s), fewer than the ${input.attendees} claimed (§3.4).`,
    );
  }
  const uniqueNames = new Set(cleanNames.map((n) => n.toLowerCase()));
  if (uniqueNames.size < input.attendees) {
    throw new Error(
      `Exception names only ${uniqueNames.size} distinct attendee(s), fewer than ${input.attendees} (§3.4).`,
    );
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const max_allowed = round2(input.perAttendeeCap * input.attendees);
  const rawCap =
    input.requestedCap !== undefined && Number.isFinite(input.requestedCap) && input.requestedCap > 0
      ? Math.min(input.requestedCap, max_allowed)
      : max_allowed;
  const one_time_cap = round2(Math.min(rawCap, max_allowed));
  if (one_time_cap <= 0 || one_time_cap > max_allowed) {
    throw new Error(`Computed cap ${one_time_cap} exceeds policy maximum ${max_allowed}.`);
  }
  return { max_allowed, one_time_cap };
}

/**
 * Deterministic validation of model exception explanation against policy §3.4.
 * AI only explains & extracts client/attendees; deterministic code computes all caps.
 */
export function validateExceptionExtraction(
  raw: unknown,
  terms: Pick<PolicyTerms, "exception_clause">,
  opts: { sourceNote?: string; requestedCharge?: number; requestedCap?: number } = {},
): ExceptionValidationResult {
  const rule = terms.exception_clause;
  if (!rule) {
    return {
      ok: false,
      errors: ["This policy has no client-entertainment exception clause."],
    };
  }

  const parsed = RawModelException.safeParse(stripNulls(raw));
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
    };
  }

  const data = parsed.data;
  const cleanClient = data.client.trim();
  const cleanRationale = data.rationale.trim();
  const cleanNames = data.attendee_names.map((n) => n.trim()).filter(Boolean);
  const errors: string[] = [];

  if (!cleanClient) errors.push("Exception request must name the client (§3.4).");
  if (!cleanRationale) errors.push("Exception explanation rationale is required.");

  let caps: { max_allowed: number; one_time_cap: number } | undefined;
  try {
    caps = computeValidatedExceptionCap({
      client: cleanClient,
      attendees: data.attendees,
      attendee_names: cleanNames,
      perAttendeeCap: rule.per_attendee_cap,
      requestedCap: opts.requestedCap ?? data.requested_cap,
    });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "Invalid exception cap.");
  }

  if (errors.length > 0 || !caps) {
    return { ok: false, errors };
  }

  const extraction: RawModelException = {
    client: cleanClient,
    attendees: data.attendees,
    attendee_names: cleanNames,
    ...(data.requested_cap !== undefined ? { requested_cap: data.requested_cap } : {}),
    rationale: cleanRationale,
  };

  return {
    ok: true,
    extraction,
    proposal: {
      client: cleanClient,
      attendees: data.attendees,
      attendee_names: cleanNames,
      max_allowed: caps.max_allowed,
      one_time_cap: caps.one_time_cap,
      ...(opts.requestedCharge !== undefined ? { requested_charge: opts.requestedCharge } : {}),
      rationale: cleanRationale,
      source_note: (opts.sourceNote ?? "").trim(),
      clause: rule.clause,
    },
    errors: [],
  };
}

/**
 * Schema for AI-only change-order drafting.
 * AI extracts deltas/replacement targets, date, and verbatim source quote;
 * deterministic code computes all resulting milestone amounts and contract totals.
 */
export const RawModelMilestoneChange = z.object({
  milestone_id: z.string(),
  delta_amount: z.number().finite().optional(),
  new_amount: z.number().positive().finite().optional(),
  reason: z.string(),
});

export const RawModelChangeOrder = z.object({
  summary: z.string(),
  milestone_amount_changes: z.array(RawModelMilestoneChange).default([]),
  new_deadline: z.string().optional(),
  requires_signed_change_order: z.boolean().default(true),
  source_quote: z.string(),
});
export type RawModelChangeOrder = z.infer<typeof RawModelChangeOrder>;

export interface CanonicalChangeOrderProposal {
  summary: string;
  milestone_amount_changes: Array<{
    milestone_id: string;
    new_amount: number;
    reason: string;
  }>;
  new_deadline?: string;
  requires_signed_change_order: boolean;
  source_quote: string;
}

export interface ChangeOrderValidationResult {
  ok: boolean;
  draft?: RawModelChangeOrder;
  proposal?: CanonicalChangeOrderProposal;
  computed?: {
    oldTotal: number;
    newTotal: number;
    totalDelta: number;
  };
  errors: string[];
}

/**
 * Deterministic validation & amount calculation for a drafted change order.
 * AI only drafts deltas/reasons/date/quote; code computes every milestone's `new_amount`
 * and the new contract total from the authoritative existing contract terms.
 */
export function validateChangeOrderDraft(
  raw: unknown,
  terms: Pick<PromptContractContext, "milestones" | "total_amount" | "start_date" | "deadline">,
  sourceEmail?: string,
): ChangeOrderValidationResult {
  const parsed = RawModelChangeOrder.safeParse(stripNulls(raw));
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
    };
  }

  const data = parsed.data;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const cleanSummary = data.summary.trim();
  const cleanQuote = data.source_quote.trim();
  const cleanDeadline = data.new_deadline?.trim();
  const errors: string[] = [];

  if (!cleanSummary) errors.push("Change order summary is required.");
  if (!cleanQuote) errors.push("Change order source_quote is required.");

  if (cleanQuote && sourceEmail) {
    const quoteProblems = missingQuotes([{ clause_id: "Change order", quote: cleanQuote }], sourceEmail);
    if (quoteProblems.length > 0) {
      errors.push("source_quote was not found verbatim in the contractor email.");
    }
  }

  if (cleanDeadline) {
    if (!isValidIsoDate(cleanDeadline)) {
      errors.push(`New deadline "${cleanDeadline}" is not a valid YYYY-MM-DD date.`);
    } else if (terms.start_date && isValidIsoDate(terms.start_date) && cleanDeadline < terms.start_date) {
      errors.push(`New deadline "${cleanDeadline}" precedes contract start date "${terms.start_date}".`);
    }
  }

  const seenMilestones = new Set<string>();
  const computedChanges: CanonicalChangeOrderProposal["milestone_amount_changes"] = [];
  const normalizedDraftChanges: RawModelChangeOrder["milestone_amount_changes"] = [];
  const updatedAmounts = new Map<string, number>(
    terms.milestones.map((m) => [m.id, m.amount]),
  );

  for (const ch of data.milestone_amount_changes) {
    const milestoneId = ch.milestone_id.trim();
    const reason = ch.reason.trim();
    if (!milestoneId) {
      errors.push("Milestone change must include milestone_id.");
      continue;
    }
    if (seenMilestones.has(milestoneId)) {
      errors.push(`Duplicate change entry for milestone ${milestoneId}.`);
      continue;
    }
    seenMilestones.add(milestoneId);

    const existing = terms.milestones.find((m) => m.id === milestoneId);
    if (!existing) {
      errors.push(`Change order references unknown milestone ${milestoneId}.`);
      continue;
    }
    if (!reason) {
      errors.push(`Milestone change ${milestoneId} must include a reason.`);
    }

    let computedNew: number | undefined;
    if (ch.delta_amount !== undefined) {
      // Deterministic arithmetic always computes resulting milestone amount from existing + delta.
      computedNew = round2(existing.amount + ch.delta_amount);
    } else if (ch.new_amount !== undefined) {
      computedNew = round2(ch.new_amount);
    } else {
      errors.push(`Milestone change ${milestoneId} must include delta_amount or new_amount.`);
      continue;
    }

    if (!Number.isFinite(computedNew) || computedNew <= 0) {
      errors.push(`Computed amount for ${milestoneId} (${computedNew}) must be positive.`);
      continue;
    }

    updatedAmounts.set(milestoneId, computedNew);
    computedChanges.push({
      milestone_id: milestoneId,
      new_amount: computedNew,
      reason: reason || `Updated ${milestoneId}`,
    });
    normalizedDraftChanges.push({
      milestone_id: milestoneId,
      ...(ch.delta_amount !== undefined
        ? { delta_amount: round2(ch.delta_amount) }
        : { new_amount: computedNew }),
      reason: reason || `Updated ${milestoneId}`,
    });
  }

  const oldTotal = round2(terms.milestones.reduce((sum, m) => sum + m.amount, 0));
  const newTotal = round2([...updatedAmounts.values()].reduce((sum, amt) => sum + amt, 0));
  const totalDelta = round2(newTotal - oldTotal);

  if (computedChanges.length === 0 && !cleanDeadline) {
    errors.push("Change order proposes neither a milestone amount change nor a new deadline.");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const requiresSigned = Boolean(
    data.requires_signed_change_order || computedChanges.length > 0 || Boolean(cleanDeadline),
  );

  return {
    ok: true,
    draft: {
      summary: cleanSummary,
      milestone_amount_changes: normalizedDraftChanges,
      ...(cleanDeadline ? { new_deadline: cleanDeadline } : {}),
      requires_signed_change_order: requiresSigned,
      source_quote: cleanQuote,
    },
    proposal: {
      summary: cleanSummary,
      milestone_amount_changes: computedChanges,
      ...(cleanDeadline ? { new_deadline: cleanDeadline } : {}),
      requires_signed_change_order: requiresSigned,
      source_quote: cleanQuote,
    },
    computed: {
      oldTotal,
      newTotal,
      totalDelta,
    },
    errors: [],
  };
}

export const EvidenceVerdict = z.object({
  verdict: z.enum(["meets", "insufficient", "unclear"]),
  reasoning: z.string(),
  observed: z.array(z.string()),
  missing: z.array(z.string()),
});
export type EvidenceVerdict = z.infer<typeof EvidenceVerdict>;

export interface EvidenceValidationResult {
  ok: boolean;
  verdict?: EvidenceVerdict;
  errors: string[];
}

/** Deterministic pre-check: reject missing declared evidence kinds in code before any model call. */
export function checkMissingEvidenceKinds(
  milestone: Pick<PromptMilestoneContext, "evidence_required" | "clause">,
  files: Array<{ declaredKind: string }>,
): EvidenceVerdict | null {
  const have = new Set(files.map((f) => f.declaredKind));
  const missingKinds = milestone.evidence_required.filter((k) => !have.has(k));
  if (missingKinds.length === 0) return null;
  return {
    verdict: "insufficient",
    reasoning: `${milestone.clause.clause_id} requires ${milestone.evidence_required.join(" + ")}; missing ${missingKinds.join(", ")}.`,
    observed: [],
    missing: missingKinds,
  };
}

/** Deterministic validation of an AI evidence verdict (shape, non-empty reasoning, consistent missing list). */
export function validateEvidenceVerdict(raw: unknown): EvidenceValidationResult {
  const parsed = EvidenceVerdict.safeParse(stripNulls(raw));
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
    };
  }
  const cleanReasoning = parsed.data.reasoning.trim();
  const observed = parsed.data.observed.map((s) => s.trim()).filter(Boolean);
  const missing = parsed.data.missing.map((s) => s.trim()).filter(Boolean);
  const errors: string[] = [];

  if (!cleanReasoning) errors.push("Evidence verdict reasoning is required.");
  if (parsed.data.verdict === "meets" && missing.length > 0) {
    errors.push('Evidence verdict "meets" cannot report non-empty missing items.');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    verdict: {
      verdict: parsed.data.verdict,
      reasoning: cleanReasoning,
      observed,
      missing,
    },
    errors: [],
  };
}
