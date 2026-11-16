/**
 * Browser-side document parsing. The raw contract or policy never leaves this device unless the
 * document is too long for the on-device model, in which case we explicitly prefer the cloud.
 * Only the structured, validated terms are sent to the Clause server.
 */
import { ContractTerms, validateTerms } from "../../../server/clause/contract/schema.js";
import { addDaysIso, PolicyTerms, validatePolicyTerms } from "../../../server/clause/expense/schema.js";
import {
  CONTRACT_SYSTEM,
  contractClauses,
  looksLikePolicyText,
  missingQuotes,
  POLICY_SYSTEM,
  policyClauses,
} from "../../../shared/clause-ai/prompts.js";
import { getRemoteConfigThreshold } from "../firebase";
import { hybridGenerate, type HybridMode, type HybridResult } from "../hybrid-ai";

export type ClientParse =
  | { kind: "contract"; terms: ContractTerms; problems: string[]; ai: Omit<HybridResult<unknown>, "value"> }
  | { kind: "policy"; policyTerms: PolicyTerms; problems: string[]; ai: Omit<HybridResult<unknown>, "value"> };

export function chooseMode(text: string, threshold = getRemoteConfigThreshold()): HybridMode {
  return text.length > threshold ? "prefer_in_cloud" : "prefer_on_device";
}

export async function parseDocumentInBrowser(text: string, opts: { mode?: HybridMode } = {}): Promise<ClientParse> {
  const mode = opts.mode ?? chooseMode(text);

  if (looksLikePolicyText(text)) {
    const r = await hybridGenerate({
      system: POLICY_SYSTEM,
      prompt: `Extract the travel & expense policy rules and approved trip terms:\n\n<document>\n${text}\n</document>`,
      schema: PolicyTerms,
      mode,
    });
    const policyTerms = r.value;
    if (/48\s+hours\s+after/i.test(policyTerms.card_expires.clause.quote) && /^\d{4}-\d{2}-\d{2}$/.test(policyTerms.trip_end)) {
      policyTerms.card_expires.date = addDaysIso(policyTerms.trip_end, 2);
    }
    policyTerms.open_questions.push(...missingQuotes(policyClauses(policyTerms), text));
    return { kind: "policy", policyTerms, problems: validatePolicyTerms(policyTerms), ai: strip(r) };
  }

  const r = await hybridGenerate({
    system: CONTRACT_SYSTEM,
    prompt: `Extract the contract terms from this quote / thread:\n\n<document>\n${text}\n</document>`,
    schema: ContractTerms,
    mode,
  });
  const terms = r.value;
  terms.open_questions.push(...missingQuotes(contractClauses(terms), text));
  return { kind: "contract", terms, problems: validateTerms(terms), ai: strip(r) };
}

function strip<T>(r: HybridResult<T>) {
  return { source: r.source, model: r.model, ms: r.ms };
}
