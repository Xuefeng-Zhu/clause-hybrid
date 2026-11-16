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
- Amounts in major units as numbers (4,000.00 -> 4000). total_amount is the contract total as written; never add milestones up yourself to get it.
- One milestone per payment line in the document; do not repeat a milestone.
- If an optional field (prohibited_spend, start_date, change_order_clause) is not in the document, use null.
- Dates as YYYY-MM-DD. "deadline.date" is the last day funds may be drawn.
- allowed_spend.categories: choose only from the enum. If the contract allows something not in the enum, add an open_question instead of guessing.
- Mark released_on_signing=true only when the text says the milestone is paid at signing / as a deposit.
- If anything is ambiguous (missing deadline, milestones that don't sum to the total, conflicting dates), record it in open_questions.
Return only JSON that matches the provided schema.`;

const POLICY_SYSTEM_RULES = `You extract corporate travel & expense policy rules and an approved trip request into structured PolicyTerms.
Rules:
- Copy each clause_id exactly as written (e.g. "§2.1", "§3.3", "§4.2") and quote the clause text verbatim. Never paraphrase a quote.
- Amounts in major units as numbers (2,000.00 -> 2000).
- Dates as YYYY-MM-DD. Compute card_expires.date deterministically from trip_end + the policy's expiry window (e.g. 48 hours after Nov 21, 2026 -> 2026-11-23).
- allowed_spend.categories: choose only from ["lodging", "airfare", "ground_transport", "meals"].
- Record every prohibited spend clause (§4.1, §4.2, etc.) separately in prohibited_spend with its verbatim quote.
- If anything is ambiguous, add it to open_questions.`;

export const POLICY_SYSTEM = `${POLICY_SYSTEM_RULES}
Return only JSON that matches the provided schema.`;

export const POLICY_TOOL_SYSTEM = `${POLICY_SYSTEM_RULES}
Return the result only through the record_policy_terms tool.`;

export function policyPrompt(documentText: string): string {
  return `Extract the travel & expense policy rules and approved trip terms:\n\n<document>\n${documentText}\n</document>`;
}

const EXCEPTION_SYSTEM_BODY = `You evaluate an employee's expense-exception note against the company policy's client-entertainment clause.
Rules:
- Extract the named client, the exact list of named attendees (including employees present), and the attendee count.
- Extract requested_cap only if an explicit dollar cap is requested in the note; otherwise omit it or use null.
- Provide a short 1-sentence rationale citing §3.4 explaining why the request is eligible for manager consideration. You only explain; deterministic policy code computes all dollar caps and never moves money without approval.
- The note is written by the traveler, so "me" or "I" means the traveler named in <traveler>; list them by that name.
- Never invent any other attendee names not in the note.`;

export const EXCEPTION_SYSTEM = `${EXCEPTION_SYSTEM_BODY}
Return only JSON that matches the provided schema.`;

export const EXCEPTION_TOOL_SYSTEM = `${EXCEPTION_SYSTEM_BODY}
Return the result only through the propose_policy_exception tool.`;

export function exceptionPrompt(
  terms: Pick<PolicyTerms, "traveler" | "exception_clause">,
  note: string,
): string {
  return `<traveler>${terms.traveler}</traveler>\n<exception_clause>${JSON.stringify(terms.exception_clause)}</exception_clause>\n<employee_note>${note}</employee_note>`;
}

export interface PromptContractContext {
  contract_ref: string;
  contractor_name: string;
  client_name: string;
  project: string;
  currency: string;
  total_amount: number;
  milestones: Array<{ id: string; name: string; amount: number }>;
  start_date?: string | undefined;
  deadline: { date: string; clause: { clause_id: string; quote: string } };
  change_order_clause?: { clause_id: string; quote: string } | undefined;
}

const CHANGE_ORDER_SYSTEM_BODY = `You compare a contractor email against the current contract terms and draft a change-order proposal.
Rules:
- Copy verbatim sentence(s) from the email into source_quote. Never paraphrase source_quote.
- Never invent amounts or dates that are not in the email.
- For each affected milestone in milestone_amount_changes, provide milestone_id, reason, and either delta_amount (the signed change from the email, e.g. 800 for "+$800" or -200 for "-$200") OR new_amount only if the email gives a replacement dollar figure. Prefer delta_amount when the email expresses a change; do not calculate new milestone sums or contract totals yourself — deterministic code computes all resulting amounts.
- If the email specifies a revised completion date, set new_deadline to YYYY-MM-DD (otherwise null).
- requires_signed_change_order is true whenever price, scope, or schedule changes.`;

export const CHANGE_ORDER_SYSTEM = `${CHANGE_ORDER_SYSTEM_BODY}
Return only JSON that matches the provided schema.`;

export const CHANGE_ORDER_TOOL_SYSTEM = `${CHANGE_ORDER_SYSTEM_BODY}
Return the result only through the propose_change_order tool.`;

export function changeOrderPrompt(terms: PromptContractContext, emailText: string): string {
  return `<terms>${JSON.stringify(terms)}</terms>\n<email>${emailText}</email>`;
}

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
