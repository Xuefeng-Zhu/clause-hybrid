/**
 * Browser-side document parsing. The raw contract or policy never leaves this device unless the
 * document is too long for the on-device model, in which case we explicitly prefer the cloud.
 * Only the structured, validated terms are sent to the Clause server.
 */
import { ContractTerms, validateTerms } from "../../../server/clause/contract/schema.js";
import type { PolicyTerms } from "../../../server/clause/expense/schema.js";
import {
  CONTRACT_SYSTEM,
  contractClauses,
  looksLikePolicyText,
  missingQuotes,
} from "../../../shared/clause-ai/prompts.js";
import { renumberDuplicateMilestoneIds } from "../../../shared/clause-ai/validate.js";
import { logAiCall } from "../ai-log";
import { getRemoteConfigStepMode, getRemoteConfigThreshold } from "../firebase";
import { hybridGenerate, HybridSchemaError, type HybridMode, type HybridResult } from "../hybrid-ai";
import { parseExpenseInBrowser } from "./expense";

export { renumberDuplicateMilestoneIds };

export type ClientParse =
  | { kind: "contract"; terms: ContractTerms; problems: string[]; ai: Omit<HybridResult<unknown>, "value"> }
  | { kind: "policy"; policyTerms: PolicyTerms; problems: string[]; ai: Omit<HybridResult<unknown>, "value"> };

export function chooseMode(
  text: string,
  threshold = getRemoteConfigThreshold(),
  configuredMode = getRemoteConfigStepMode("contract"),
): HybridMode {
  if (configuredMode !== "prefer_on_device") return configuredMode;
  return text.length > threshold ? "prefer_in_cloud" : configuredMode;
}

export async function parseDocumentInBrowser(text: string, opts: { mode?: HybridMode } = {}): Promise<ClientParse> {
  if (looksLikePolicyText(text)) {
    const res = await parseExpenseInBrowser(text, opts.mode ? { mode: opts.mode } : {});
    if (res.status !== "ok") {
      throw new Error(res.reason);
    }
    return {
      kind: "policy",
      policyTerms: res.policyTerms,
      problems: res.problems,
      ai: res.ai,
    };
  }

  const mode = opts.mode ?? chooseMode(text);

  let r: HybridResult<ContractTerms>;
  try {
    r = await hybridGenerate({
      system: CONTRACT_SYSTEM,
      prompt: `Extract the contract terms from this quote / thread:\n\n<document>\n${text}\n</document>`,
      schema: ContractTerms,
      step: "contract",
      mode,
    });
  } catch (err) {
    if (err instanceof HybridSchemaError) {
      void logAiCall({
        step: "contract",
        mode,
        inferenceSource: err.source,
        latencyMs: err.ms,
        validatorOk: false,
      });
    }
    throw err;
  }
  const terms = r.value;
  renumberDuplicateMilestoneIds(terms);
  terms.open_questions.push(...missingQuotes(contractClauses(terms), text));
  const problems = validateTerms(terms);
  void logAiCall({
    step: "contract",
    mode,
    inferenceSource: r.source,
    latencyMs: r.ms,
    validatorOk: problems.length === 0,
  });
  return { kind: "contract", terms, problems, ai: strip(r) };
}

function strip<T>(r: HybridResult<T>) {
  return { source: r.source, model: r.model, ms: r.ms };
}
