/**
 * Contest mode (CLAUSE_CONTEST_MODE=true): the Clause server must make zero direct model-provider
 * calls, even with GEMINI_API_KEY and ANTHROPIC_API_KEY configured. Gen AI runs only through
 * Firebase AI Logic in the browser; the server offers its offline rules and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const anthropicCtor = vi.fn();
const anthropicCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: anthropicCreate };
    constructor(...args: unknown[]) {
      anthropicCtor(...args);
    }
  },
}));

const { MockIssuingGateway } = await import("../server/clause/airwallex/mock.js");
const { runtimeInfo, SAMPLES } = await import("../server/clause/app.js");
const { config } = await import("../server/clause/config.js");
const { assertAgentChatAllowed, CONTEST_MODE_CHAT_DISABLED, CONTEST_MODE_OFFLINE_ONLY, isContestMode } =
  await import("../server/clause/contest-mode.js");
const { callTool, llmModelLabel, llmProvider, serverAiSource } = await import("../server/clause/llm.js");
const { ContractCardService } = await import("../server/clause/milestones/service.js");
const { MemoryJobStore } = await import("../server/clause/store/jobStore.js");

const photo = (filename: string) => ({
  filename,
  mediaType: "image/jpeg" as const,
  base64: Buffer.alloc(128, 1).toString("base64"),
  declaredKind: "photos" as const,
});
const pdf = {
  filename: "inspection.pdf",
  mediaType: "application/pdf" as const,
  base64: Buffer.alloc(256, 2).toString("base64"),
  declaredKind: "photos" as const,
};

function geminiReply(args: unknown) {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "tool", args } }] } }] }),
    { status: 200 },
  );
}

const svc = (owner = "owner@example.com") =>
  new ContractCardService(new MockIssuingGateway(), new MemoryJobStore(), owner);

describe("contest mode: no direct model provider on the server", () => {
  const saved = { gemini: config.gemini.apiKey, anthropic: config.anthropic.apiKey };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("CLAUSE_CONTEST_MODE", "true");
    // Keys present on purpose: contest mode must ignore them.
    config.gemini.apiKey = "test-gemini-key";
    config.anthropic.apiKey = "test-anthropic-key";
    fetchMock = vi.fn(async () => geminiReply({}));
    vi.stubGlobal("fetch", fetchMock);
    anthropicCtor.mockClear();
    anthropicCreate.mockClear();
  });

  afterEach(() => {
    config.gemini.apiKey = saved.gemini;
    config.anthropic.apiKey = saved.anthropic;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function expectNoProviderCalls() {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(anthropicCreate).not.toHaveBeenCalled();
  }

  it("reports contest mode and no provider, whatever keys are set", () => {
    expect(isContestMode()).toBe(true);
    expect(llmProvider()).toBeUndefined();
    expect(llmModelLabel()).toContain("contest mode");
    expect(runtimeInfo().contestMode).toBe(true);
    expect(serverAiSource(false, 10)).toMatchObject({ source: "offline", parsedBy: "offline-fixture" });
  });

  it("callTool refuses before any network call", async () => {
    await expect(
      callTool({ system: "s", content: "x", toolName: "t", description: "d", schema: {}, maxTokens: 10 }),
    ).rejects.toThrow(/Contest mode/);
    expectNoProviderCalls();
  });

  it("quote, change order, PDF/photo proof and policy exception use offline rules with zero provider calls", async () => {
    const s = svc();
    let job = await s.createJob({ kind: "text", text: SAMPLES.quote });
    expect(job.aiSource).toMatchObject({ source: "offline", parsedBy: "offline-fixture" });
    job = await s.approveTerms(job.id);
    job = await s.proposeChangeOrder(job.id, SAMPLES.changeOrderEmail);
    expect(job.pending?.aiSource).toMatchObject({ source: "offline" });
    job = await s.rejectPending(job.id, "test");
    job = await s.submitProof(job.id, [photo("cabinets.jpg"), pdf]);
    expect(job.pending?.aiSource).toMatchObject({ source: "offline" });

    const p = svc("priya.shah@acme-robotics.example");
    let trip = await p.createJob({ kind: "text", text: SAMPLES.policy });
    expect(trip.aiSource).toMatchObject({ source: "offline" });
    trip = await p.approveTerms(trip.id);
    trip = await p.requestException(trip.id, SAMPLES.exceptionNote);
    expect(trip.pending?.aiSource).toMatchObject({ source: "offline" });

    expectNoProviderCalls();
  });

  it("a non-sample document gets an honest error, not a provider call", async () => {
    await expect(
      svc().createJob({ kind: "text", text: "Quote #77 from Bob's Decks: $3,000, half up front." }),
    ).rejects.toThrow(CONTEST_MODE_OFFLINE_ONLY);
    await expect(svc().createJob({ kind: "pdf", base64: pdf.base64 })).rejects.toThrow(/contest mode/i);
    expectNoProviderCalls();
  });

  it("the agent chat is refused", () => {
    expect(() => assertAgentChatAllowed()).toThrow(CONTEST_MODE_CHAT_DISABLED);
  });

  it("control: with the flag off, the same keys do reach the provider (the flag is what blocks it)", async () => {
    vi.stubEnv("CLAUSE_CONTEST_MODE", "false");
    expect(isContestMode()).toBe(false);
    expect(llmProvider()).toBe("gemini");
    expect(() => assertAgentChatAllowed()).not.toThrow();
    await callTool({ system: "s", content: "x", toolName: "t", description: "d", schema: {}, maxTokens: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
