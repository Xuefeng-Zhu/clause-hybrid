import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAiSource, OFFLINE_RULES_LABEL } from "../app/lib/hybrid-ai.js";
import { MockIssuingGateway } from "../server/clause/airwallex/mock.js";
import { summarize } from "../server/clause/app.js";
import { config } from "../server/clause/config.js";
import { serverAiSource } from "../server/clause/llm.js";
import { aiSourceLabel, ContractCardService } from "../server/clause/milestones/service.js";
import { MemoryJobStore } from "../server/clause/store/jobStore.js";

const quote = readFileSync(new URL("../samples/quote-maple-street-cafe.txt", import.meta.url), "utf8");
const email = readFileSync(new URL("../samples/change-order-email.txt", import.meta.url), "utf8");
const photo = (filename: string) => ({
  filename,
  mediaType: "image/jpeg" as const,
  base64: Buffer.alloc(128, 1).toString("base64"),
  declaredKind: "photos" as const,
});

function geminiReply(args: unknown) {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "tool", args } }] } }] }),
    { status: 200 },
  );
}

const svc = () => new ContractCardService(new MockIssuingGateway(), new MemoryJobStore(), "owner@example.com");

describe("formatAiSource for server-side AI", () => {
  it("labels the server's own model call as Server, never Cloud or On-device", () => {
    expect(formatAiSource({ source: "server", model: "gemini-3.8-flash", ms: 3240, parsedBy: "gemini" })).toBe(
      "Server · gemini-3.8-flash · 3.2 s",
    );
    expect(formatAiSource({ source: "server", model: "claude-x", ms: 640, parsedBy: "anthropic" })).toBe(
      "Server · claude-x · 640 ms",
    );
  });
  it("labels the offline fixture path as Offline rules", () => {
    expect(formatAiSource({ source: "offline", model: "offline-fixture", ms: 3, parsedBy: "offline-fixture" })).toBe(
      OFFLINE_RULES_LABEL,
    );
    expect(OFFLINE_RULES_LABEL).toBe("Offline rules");
  });
  it("keeps the browser labels unchanged", () => {
    expect(formatAiSource({ source: "in_cloud", model: "gemini-3.5-flash-lite", ms: 4800 })).toBe(
      "Cloud · gemini-3.5-flash-lite · 4.8 s",
    );
  });
});

describe("server AI provenance", () => {
  const savedGemini = config.gemini.apiKey;
  const savedAnthropic = config.anthropic.apiKey;
  beforeEach(() => {
    config.gemini.apiKey = undefined;
    config.anthropic.apiKey = undefined;
  });
  afterEach(() => {
    config.gemini.apiKey = savedGemini;
    config.anthropic.apiKey = savedAnthropic;
    vi.unstubAllGlobals();
  });

  it("serverAiSource reports model, latency and parsedBy", () => {
    expect(serverAiSource(false, 12.4)).toEqual({ source: "offline", model: "offline-fixture", ms: 12, parsedBy: "offline-fixture" });
    config.gemini.apiKey = "test-key";
    expect(serverAiSource(false, 2100)).toEqual({ source: "server", model: config.gemini.model, ms: 2100, parsedBy: "gemini" });
    expect(serverAiSource(true, 50).source).toBe("offline");
    config.gemini.apiKey = undefined;
    config.anthropic.apiKey = "test-key";
    expect(serverAiSource(false, 10)).toMatchObject({ source: "server", model: config.anthropic.model, parsedBy: "anthropic" });
  });

  it("offline server path: quote parse, change order and proof all carry an Offline rules source", async () => {
    const s = svc();
    let job = await s.createJob({ kind: "text", text: quote });
    expect(job.aiSource).toMatchObject({ source: "offline", parsedBy: "offline-fixture" });
    expect(summarize(job).aiSource).toMatchObject({ source: "offline" });
    job = await s.approveTerms(job.id);
    job = await s.proposeChangeOrder(job.id, email);
    expect(job.pending?.aiSource).toMatchObject({ source: "offline", parsedBy: "offline-fixture" });
    expect(formatAiSource(job.pending!.aiSource!)).toBe("Offline rules");
    job = await s.rejectPending(job.id, "test");
    job = await s.submitProof(job.id, [photo("cabinets.jpg")]);
    expect(job.pending?.aiSource).toMatchObject({ source: "offline" });
    expect(job.events.at(-1)?.detail).toContain("(offline rules)");
  });

  it("live Gemini on the server: parse, change order and proof are badged Server · <model>", async () => {
    const s = svc();
    let job = await s.createJob({ kind: "text", text: quote }); // offline: no key yet
    job = await s.approveTerms(job.id);
    config.gemini.apiKey = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        geminiReply({
          summary: "In-stock quartz adds $800 to Milestone 2; completion moves to Dec 23, 2026.",
          milestone_amount_changes: [{ milestone_id: "M2", delta_amount: 800, reason: "In-stock quartz" }],
          new_deadline: "2026-12-23",
          requires_signed_change_order: true,
          source_quote: "The quartz you picked is backordered.",
        }),
      ),
    );
    job = await s.proposeChangeOrder(job.id, email);
    const co = job.pending!.aiSource!;
    expect(co).toMatchObject({ source: "server", model: config.gemini.model, parsedBy: "gemini" });
    expect(co.ms).toBeGreaterThanOrEqual(0);
    expect(formatAiSource(co)).toMatch(new RegExp(`^Server · ${config.gemini.model} · \\d`));
    expect(job.events.at(-1)?.detail).toContain(`drafted by ${config.gemini.model}, server`);
    job = await s.rejectPending(job.id, "test");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        geminiReply({
          verdict: "insufficient",
          reasoning: "Looks like a catalog photo, not this job site.",
          observed: [],
          missing: ["Photos of installed cabinets"],
        }),
      ),
    );
    job = await s.submitProof(job.id, [photo("cabinets.jpg")]);
    expect(job.pending?.verdict?.verdict).toBe("insufficient");
    expect(job.pending?.aiSource).toMatchObject({ source: "server", parsedBy: "gemini" });
  });

  it("a browser-supplied source is kept as-is", async () => {
    const s = svc();
    let job = await s.createJob({ kind: "text", text: quote });
    job = await s.approveTerms(job.id);
    job = await s.proposeChangeOrder(job.id, undefined, {
      draft: {
        summary: "In-stock quartz adds $800 to M2.",
        milestone_amount_changes: [{ milestone_id: "M2", delta_amount: 800, reason: "In-stock quartz" }],
        new_deadline: "2026-12-23",
        requires_signed_change_order: true,
        source_quote: "We can do the in-stock quartz at +$800 for Milestone 2",
      },
      aiSource: { source: "in_cloud", model: "gemini-3.5-flash-lite", ms: 950 },
    });
    expect(job.pending?.aiSource).toEqual({ source: "in_cloud", model: "gemini-3.5-flash-lite", ms: 950 });
  });

  it("code-only proof decisions carry no AI source", async () => {
    config.gemini.apiKey = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const s = svc();
    config.gemini.apiKey = undefined;
    let job = await s.createJob({ kind: "text", text: quote });
    job = await s.approveTerms(job.id);
    config.gemini.apiKey = "test-key";
    // M2 needs photos; an invoice alone is stopped by code before any model call.
    job = await s.submitProof(job.id, [{ ...photo("receipt.jpg"), declaredKind: "invoice" as const }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(job.pending?.verdict?.verdict).toBe("insufficient");
    expect(job.pending?.aiSource).toBeUndefined();
    expect(aiSourceLabel(undefined)).toBeUndefined();
  });
});
