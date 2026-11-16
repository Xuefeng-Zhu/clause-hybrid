import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { EVIDENCE_TOOL_SYSTEM, evidencePrompt } from "../../../shared/clause-ai/prompts.js";
import {
  checkMissingEvidenceKinds,
  EvidenceVerdict,
  validateEvidenceVerdict,
} from "../../../shared/clause-ai/validate.js";
import { callTool, llmProvider, withOfflineFallback } from "../llm.js";
import type { EvidenceKind, Milestone } from "../contract/schema.js";

export { EvidenceVerdict };

export interface EvidenceFile {
  filename: string;
  mediaType: string; // image/jpeg, image/png, application/pdf
  base64: string;
  declaredKind: EvidenceKind; // what the uploader says it is
}

/**
 * Two layers:
 *  1. Code: are all required evidence KINDS present? If not, stop here; no model call.
 *  2. Vision model: does the content actually show the release condition? (photos/PDF)
 * Either way the result is only a recommendation; the owner approves the release.
 */
export async function evaluateEvidence(milestone: Milestone, files: EvidenceFile[]): Promise<EvidenceVerdict> {
  const missingKindsVerdict = checkMissingEvidenceKinds(milestone, files);
  if (missingKindsVerdict) {
    return missingKindsVerdict;
  }
  if (!llmProvider()) return offlineVerdict(milestone, files);
  // Live vision only: a placeholder/empty file would 400 at the model API, so stop in code.
  const unreadable = files.find((f) => Buffer.from(f.base64 ?? "", "base64").length < 64);
  if (unreadable) {
    return {
      verdict: "insufficient",
      reasoning: `${unreadable.filename} is empty or unreadable, so it can't show ${milestone.clause.clause_id} was met.`,
      observed: [],
      missing: [milestone.release_condition],
    };
  }

  const blocks: Anthropic.ContentBlockParam[] = files.flatMap((f): Anthropic.ContentBlockParam[] => {
    const label: Anthropic.ContentBlockParam = { type: "text", text: `File: ${f.filename} (declared: ${f.declaredKind})` };
    if (f.mediaType === "application/pdf") {
      return [label, { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.base64 } }];
    }
    return [label, { type: "image", source: { type: "base64", media_type: f.mediaType as "image/jpeg" | "image/png", data: f.base64 } }];
  });
  blocks.push({
    type: "text",
    text: evidencePrompt(milestone, files),
  });

  const { value: callInput } = await withOfflineFallback(() => callTool({
    system: EVIDENCE_TOOL_SYSTEM,
    content: blocks,
    toolName: "record_verdict",
    description: "Record the evidence verdict.",
    schema: z.toJSONSchema(EvidenceVerdict, { target: "draft-7" }) as Record<string, unknown>,
    maxTokens: 1200,
  }), () => offlineVerdict(milestone, files));
  const validated = validateEvidenceVerdict(callInput);
  if (!validated.ok || !validated.verdict) {
    throw new Error(`Invalid evidence verdict: ${validated.errors.join(" ")}`);
  }
  return validated.verdict;
}

/** Offline demo: filenames containing "stock" or "wrong" fail; everything else passes. */
function offlineVerdict(milestone: Milestone, files: EvidenceFile[]): EvidenceVerdict {
  const bad = files.find((f) => /stock|wrong|blurry/i.test(f.filename));
  if (bad) {
    return {
      verdict: "insufficient",
      reasoning: `${bad.filename} doesn't show this job site (offline rule: filename flagged).`,
      observed: [],
      missing: [milestone.release_condition],
    };
  }
  return {
    verdict: "meets",
    reasoning: `Evidence covers ${milestone.evidence_required.join(" + ")} for ${milestone.clause.clause_id} (offline evaluator).`,
    observed: files.map((f) => `${f.declaredKind}: ${f.filename}`),
    missing: [],
  };
}
