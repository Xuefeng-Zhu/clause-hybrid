/**
 * Prompts and pure guardrails shared by the browser (Firebase AI Logic hybrid) and the server.
 * No Node or SDK imports here: this module must stay importable from the browser.
 */
import type { ContractTerms } from "../../server/clause/contract/schema.js";
import type { PolicyTerms } from "../../server/clause/expense/schema.js";

export const CONTRACT_SYSTEM = `You extract payment terms from a contractor quote or email thread for a small business.
Rules:
- Copy each clause_id exactly as written (e.g. "§2.1") and quote the clause text verbatim. Never paraphrase a quote.
- Milestone ids are "M1", "M2", "M3"... in document order.
- Amounts in major units as numbers (4,000.00 -> 4000).
- Dates as YYYY-MM-DD. "deadline.date" is the last day funds may be drawn.
- allowed_spend.categories: choose only from the enum. If the contract allows something not in the enum, add an open_question instead of guessing.
- Mark released_on_signing=true only when the text says the milestone is paid at signing / as a deposit.
- If anything is ambiguous (missing deadline, milestones that don't sum to the total, conflicting dates), record it in open_questions.
Return only JSON that matches the provided schema.`;

export const POLICY_SYSTEM = `You extract corporate travel & expense policy rules and an approved trip request into structured PolicyTerms.
Rules:
- Copy each clause_id exactly as written (e.g. "§2.1", "§3.3", "§4.2") and quote the clause text verbatim. Never paraphrase a quote.
- Amounts in major units as numbers (2,000.00 -> 2000).
- Dates as YYYY-MM-DD. Compute card_expires.date deterministically from trip_end + the policy's expiry window (e.g. 48 hours after Nov 21, 2026 -> 2026-11-23).
- allowed_spend.categories: choose only from ["lodging", "airfare", "ground_transport", "meals"].
- Record every prohibited spend clause (§4.1, §4.2, etc.) separately in prohibited_spend with its verbatim quote.
- If anything is ambiguous, add it to open_questions.
Return only JSON that matches the provided schema.`;

export function looksLikePolicyText(t: string): boolean {
  if (t.includes("TR-2611") || /TRAVEL\s*&\s*EXPENSE\s*POLICY/i.test(t)) return true;
  if (/TRIP\s+REQUEST/i.test(t) && /Traveler:/i.test(t)) return true;
  if (/not\s+reimbursable/i.test(t) && /approved\s+budget/i.test(t)) return true;
  return false;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

type Quoted = { clause_id: string; quote: string };

/** Returns open questions for every clause quote that does not appear verbatim in the source. */
export function missingQuotes(clauses: Quoted[], sourceText: string): string[] {
  const hay = norm(sourceText);
  return clauses
    .filter((c) => !hay.includes(norm(c.quote).slice(0, 40)))
    .map((c) => `Quote for ${c.clause_id} not found verbatim in source; please review.`);
}

export function contractClauses(terms: ContractTerms): Quoted[] {
  return [
    ...terms.milestones.map((m) => m.clause),
    terms.allowed_spend.clause,
    terms.deadline.clause,
    ...(terms.prohibited_spend ? [terms.prohibited_spend.clause] : []),
  ];
}

export function policyClauses(terms: PolicyTerms): Quoted[] {
  return [
    terms.budget.clause,
    terms.per_charge_cap.clause,
    ...(terms.lodging_clause ? [terms.lodging_clause] : []),
    terms.allowed_spend.clause,
    terms.card_expires.clause,
    ...terms.prohibited_spend.map((p) => p.clause),
    ...(terms.exception_clause ? [terms.exception_clause.clause] : []),
  ];
}
