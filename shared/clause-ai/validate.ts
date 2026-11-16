/**
 * Pure validation & normalization helpers shared across browser, mobile (Expo), and server.
 * Zero Node, DOM, or SDK imports.
 */
import type { ContractTerms } from "../../server/clause/contract/schema.js";

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
