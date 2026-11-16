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
import { getRemoteConfigStepMode, getRemoteConfigThreshold, isFirebaseConfigured } from "../firebase";
import {
  hybridGenerate,
  HybridSchemaError,
  type HybridMode,
  type HybridResult,
  isNavigatorOffline,
  needsConnectionOffline,
  needsConnectionResult,
  type NeedsConnectionResult,
} from "../hybrid-ai";
import { parseExpenseInBrowser } from "./expense";

export { renumberDuplicateMilestoneIds };

export type ClientParse =
  | { status?: "ok"; kind: "contract"; terms: ContractTerms; problems: string[]; ai: Omit<HybridResult<unknown>, "value"> }
  | { status?: "ok"; kind: "policy"; policyTerms: PolicyTerms; problems: string[]; ai: Omit<HybridResult<unknown>, "value"> }
  | NeedsConnectionResult;

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
    if (res.status === "needs-connection") {
      return res;
    }
    if (res.status !== "ok") {
      throw new Error(res.reason);
    }
    return {
      status: "ok",
      kind: "policy",
      policyTerms: res.policyTerms,
      problems: res.problems,
      ai: res.ai,
    };
  }

  const mode = opts.mode ?? chooseMode(text);
  const offline = isNavigatorOffline();

  if (await needsConnectionOffline(mode)) {
    return needsConnectionResult();
  }

  if (offline && !isFirebaseConfigured()) {
    return needsConnectionResult();
  }

  const effectiveMode: HybridMode = offline ? "only_on_device" : mode;

  let r: HybridResult<ContractTerms>;
  try {
    r = await hybridGenerate({
      system: CONTRACT_SYSTEM,
      prompt: `Extract the contract terms from this quote / thread:\n\n<document>\n${text}\n</document>`,
      schema: ContractTerms,
      step: "contract",
      mode: effectiveMode,
    });
  } catch (err) {
    if (err instanceof HybridSchemaError) {
      void logAiCall({
        step: "contract",
        mode: effectiveMode,
        inferenceSource: err.source,
        latencyMs: err.ms,
        validatorOk: false,
      });
    }
    if (isNavigatorOffline()) {
      return needsConnectionResult();
    }
    throw err;
  }
  const terms = r.value;
  renumberDuplicateMilestoneIds(terms);
  terms.open_questions.push(...missingQuotes(contractClauses(terms), text));
  const problems = validateTerms(terms);
  void logAiCall({
    step: "contract",
    mode: effectiveMode,
    inferenceSource: r.source,
    latencyMs: r.ms,
    validatorOk: problems.length === 0,
  });
  return { status: "ok", kind: "contract", terms, problems, ai: strip(r) };
}

function strip<T>(r: HybridResult<T>) {
  return { source: r.source, model: r.model, ms: r.ms };
}
