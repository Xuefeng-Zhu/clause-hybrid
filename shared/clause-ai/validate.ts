/**
 * Pure validation & normalization helpers shared across browser, mobile (Expo), and server.
 * Zero Node, DOM, or SDK imports.
 */
import type { ClauseRef, ContractTerms } from "../../server/clause/contract/schema.js";
import { addDaysIso, PolicyTerms, validatePolicyTerms } from "../../server/clause/expense/schema.js";
import { missingQuotes, policyClauses } from "./prompts.js";

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
