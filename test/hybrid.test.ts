import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { MockIssuingGateway } from "../server/clause/airwallex/mock.js";
import { ContractTerms } from "../server/clause/contract/schema.js";
import { SAMPLE_POLICY_TERMS } from "../server/clause/fixtures.js";
import { ContractCardService } from "../server/clause/milestones/service.js";
import { MemoryJobStore } from "../server/clause/store/jobStore.js";
import { contractClauses, looksLikePolicyText, missingQuotes } from "../shared/clause-ai/prompts.js";

const generateContent = vi.fn();
const getGenerativeModel = vi.fn(() => ({ generateContent }));
vi.mock("firebase/ai", () => ({
  getGenerativeModel: (...args: unknown[]) => getGenerativeModel(...(args as [])),
  InferenceMode: {
    PREFER_ON_DEVICE: "prefer_on_device",
    ONLY_ON_DEVICE: "only_on_device",
    ONLY_IN_CLOUD: "only_in_cloud",
    PREFER_IN_CLOUD: "prefer_in_cloud",
  },
}));
vi.mock("../app/lib/firebase", () => ({
  getFirebaseAI: () => ({}),
  getDefaultCloudModel: () => "gemini-3.5-flash-lite",
  getRemoteConfigString: (_k: string, fallback: string) => fallback,
  getRemoteConfigThreshold: () => 6000,
}));

const { hybridGenerate, extractJson, formatAiSource } = await import("../app/lib/hybrid-ai.js");
const { chooseMode, parseDocumentInBrowser } = await import("../app/lib/clause-ai/parse.js");

const quote = readFileSync(new URL("../samples/quote-maple-street-cafe.txt", import.meta.url), "utf8");
const termsJson = readFileSync(new URL("../samples/quote-maple-street-cafe.terms.json", import.meta.url), "utf8");
const terms = ContractTerms.parse(JSON.parse(termsJson));

function reply(text: string, inferenceSource?: "on_device" | "in_cloud") {
  generateContent.mockResolvedValueOnce({ response: { text: () => text, inferenceSource } });
}

describe("hybridGenerate", () => {
  it("reports on-device source and Gemini Nano when the SDK ran locally", async () => {
    reply(termsJson, "on_device");
    const r = await hybridGenerate({ system: "s", prompt: "p", schema: ContractTerms, ai: {} as never });
    expect(r.source).toBe("on_device");
    expect(r.model).toBe("Gemini Nano");
    expect(r.value.contract_ref).toBe(terms.contract_ref);
    const params = getGenerativeModel.mock.calls.at(-1)![1] as Record<string, any>;
    expect(params.mode).toBe("prefer_on_device");
    expect(params.inCloudParams.model).toBe("gemini-3.5-flash-lite");
    expect(params.inCloudParams.generationConfig.responseMimeType).toBe("application/json");
    expect(params.onDeviceParams.promptOptions.responseConstraint).toBeTypeOf("object");
    expect(params.inCloudParams.generationConfig.responseJsonSchema.$schema).toBeUndefined();
  });

  it("reports the cloud model when the SDK fell back to the cloud", async () => {
    reply("```json\n" + termsJson + "\n```", "in_cloud");
    const r = await hybridGenerate({ system: "s", prompt: "p", schema: ContractTerms, mode: "prefer_in_cloud", ai: {} as never });
    expect(r.source).toBe("in_cloud");
    expect(r.model).toBe("gemini-3.5-flash-lite");
  });

  it("rejects output that does not match the schema", async () => {
    reply(JSON.stringify({ contract_ref: "x" }), "on_device");
    await expect(hybridGenerate({ system: "s", prompt: "p", schema: ContractTerms, ai: {} as never })).rejects.toThrow();
  });

  it("formats badges and strips code fences", () => {
    expect(formatAiSource({ source: "on_device", model: "Gemini Nano", ms: 840 })).toBe("On-device · Gemini Nano · 840 ms");
    expect(formatAiSource({ source: "in_cloud", model: "gemini-3.5-flash-lite", ms: 2100 })).toBe("Cloud · gemini-3.5-flash-lite · 2.1 s");
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});

describe("browser parse", () => {
  it("long documents prefer the cloud, short ones stay on-device", () => {
    expect(chooseMode("x".repeat(100), 6000)).toBe("prefer_on_device");
    expect(chooseMode("x".repeat(7000), 6000)).toBe("prefer_in_cloud");
  });

  it("parses the sample quote and runs the verbatim-quote guardrail locally", async () => {
    reply(termsJson, "on_device");
    const r = await parseDocumentInBrowser(quote);
    expect(r.kind).toBe("contract");
    if (r.kind !== "contract") return;
    expect(r.problems).toEqual([]);
    expect(r.terms.open_questions).toEqual([]);
    expect(r.ai.source).toBe("on_device");
  });

  it("flags a hallucinated clause quote", () => {
    const t = structuredClone(terms);
    t.milestones[0]!.clause.quote = "The contractor may spend on anything at all whenever they like.";
    expect(missingQuotes(contractClauses(t), quote)).toHaveLength(1);
  });

  it("routes travel policies to the policy schema", () => {
    expect(looksLikePolicyText("ACME TRAVEL & EXPENSE POLICY TR-2611")).toBe(true);
    expect(looksLikePolicyText(quote)).toBe(false);
  });
});

describe("createJobFromTerms", () => {
  const svc = () => new ContractCardService(new MockIssuingGateway(), new MemoryJobStore(), "c@example.com");

  it("creates a draft job from browser-parsed terms without the raw document", async () => {
    const job = await svc().createJobFromTerms({
      kind: "contract",
      terms,
      aiSource: { source: "on_device", model: "Gemini Nano", ms: 812 },
    });
    expect(job.status).toBe("draft");
    expect(job.problems).toEqual([]);
    expect(job.parsedBy).toBe("Gemini Nano (on-device)");
    expect(job.aiSource?.source).toBe("on_device");
    expect(JSON.stringify(job)).not.toContain(quote.slice(0, 200));
  });

  it("re-validates on the server: bad sums become problems, bad shapes are rejected", async () => {
    const bad = { ...structuredClone(terms), total_amount: 13000 };
    const job = await svc().createJobFromTerms({ kind: "contract", terms: bad, aiSource: { source: "in_cloud", model: "gemini-3.5-flash-lite", ms: 1500 } });
    expect(job.problems.join()).toMatch(/sum to 12000/);
    await expect(
      svc().createJobFromTerms({ kind: "contract", terms: { contract_ref: "x" }, aiSource: { source: "in_cloud", model: "m", ms: 1 } }),
    ).rejects.toThrow();
  });

  it("accepts policy terms", async () => {
    const job = await svc().createJobFromTerms({
      kind: "policy",
      policyTerms: structuredClone(SAMPLE_POLICY_TERMS),
      aiSource: { source: "in_cloud", model: "gemini-3.5-flash-lite", ms: 2000 },
    });
    expect(job.kind).toBe("policy");
    expect(job.policyTerms?.policy_ref).toBeTruthy();
  });
});
