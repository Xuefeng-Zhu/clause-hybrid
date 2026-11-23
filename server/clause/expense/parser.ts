import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  looksLikePolicyText,
  missingQuotes,
  POLICY_TOOL_SYSTEM,
  policyClauses,
  policyPrompt,
} from "../../../shared/clause-ai/prompts.js";
import { normalizePolicyExpiry } from "../../../shared/clause-ai/validate.js";
import { callTool, llmProvider, serverAiSource, withOfflineFallback, type ServerAiSource } from "../llm.js";
import type { ContractSource } from "../contract/parser.js";
import { SAMPLE_POLICY_TERMS } from "../fixtures.js";
import { PolicyTerms, validatePolicyTerms } from "./schema.js";

export interface PolicyParseResult {
  policyTerms: PolicyTerms;
  problems: string[];
  parsedBy: "gemini" | "claude" | "offline-fixture";
  /** Server provenance for the UI badge: live model + latency, or offline fixture. */
  aiSource: ServerAiSource;
}

const POLICY_TOOL_SCHEMA = z.toJSONSchema(PolicyTerms, { target: "draft-7" }) as Record<string, unknown>;

export function looksLikePolicyDocument(src: ContractSource): boolean {
  if (src.kind !== "text") return false;
  return looksLikePolicyText(src.text);
}

export async function parsePolicy(src: ContractSource): Promise<PolicyParseResult> {
  const started = Date.now();
  const { value: policyTerms, usedFallback } = llmProvider()
    ? await withOfflineFallback(() => parsePolicyWithClaude(src), () => parsePolicyOffline(src))
    : { value: await parsePolicyOffline(src), usedFallback: true };
  return {
    policyTerms,
    problems: validatePolicyTerms(policyTerms),
    parsedBy: usedFallback ? "offline-fixture" : llmProvider()!,
    aiSource: serverAiSource(usedFallback, Date.now() - started),
  };
}

async function parsePolicyWithClaude(src: ContractSource): Promise<PolicyTerms> {
  const content: Anthropic.MessageParam["content"] =
    src.kind === "pdf"
      ? [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: src.base64 } },
          { type: "text", text: "Extract the travel & expense policy rules and approved trip terms." },
        ]
      : [
          {
            type: "text",
            text: policyPrompt(src.text),
          },
        ];

  const callInput = await callTool({
    system: POLICY_TOOL_SYSTEM,
    content: content,
    toolName: "record_policy_terms",
    description: "Record the extracted travel & expense policy and trip terms.",
    schema: POLICY_TOOL_SCHEMA as Record<string, unknown>,
    maxTokens: 4096,
  });
  const terms = PolicyTerms.parse(callInput);
  normalizePolicyExpiry(terms);
  assertPolicyQuotesAreVerbatim(terms, src);
  return terms;
}

/** Guardrail: every quoted policy clause must appear verbatim in the source text (whitespace-normalised). */
export function assertPolicyQuotesAreVerbatim(terms: PolicyTerms, src: ContractSource): void {
  if (src.kind !== "text") return;
  const missing = missingQuotes(policyClauses(terms), src.text);
  if (missing.length) {
    terms.open_questions.push(...missing);
  }
}

async function parsePolicyOffline(src: ContractSource): Promise<PolicyTerms> {
  const text = src.kind === "text" ? src.text : "";
  if (!text.includes("TR-2611") && !/ACME ROBOTICS/i.test(text)) {
    throw new Error(
      "Offline mode only understands bundled samples (Q-2026-0412 or TR-2611). Set ANTHROPIC_API_KEY to parse other documents.",
    );
  }
  const parsed = PolicyTerms.parse(structuredClone(SAMPLE_POLICY_TERMS));
  assertPolicyQuotesAreVerbatim(parsed, src);
  return parsed;
}
