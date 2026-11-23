import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockIssuingGateway } from "../server/clause/airwallex/mock.js";
import { ContractTerms } from "../server/clause/contract/schema.js";
import { SAMPLE_EXCEPTION_NOTE, SAMPLE_POLICY_TERMS } from "../server/clause/fixtures.js";
import { ContractCardService } from "../server/clause/milestones/service.js";
import { MemoryJobStore } from "../server/clause/store/jobStore.js";
import {
  checkMissingEvidenceKinds,
  computeValidatedExceptionCap,
  validateChangeOrderDraft,
  validateEvidenceVerdict,
  validateExceptionExtraction,
  validateExpenseTerms,
} from "../shared/clause-ai/validate.js";

// --- Mock Firebase SDK packages so we test real firebase.ts, ai-log.ts, hybrid-ai.ts, and clause-ai wrappers ---

const generateContent = vi.fn();
const getGenerativeModel = vi.fn(() => ({ generateContent }));
const rcValues: Record<string, string | number> = {};
const authState: { currentUser: { uid: string } | null } = { currentUser: null };
const signInAnonymously = vi.fn(async () => {
  authState.currentUser = { uid: "anon-user-123" };
  return { user: authState.currentUser };
});
const addDoc = vi.fn(async () => ({ id: "doc-1" }));
const collection = vi.fn((_db: unknown, ...segments: string[]) => ({
  path: segments.join("/"),
}));
const serverTimestamp = vi.fn(() => ({ _serverTimestamp: true }));
const getAI = vi.fn(() => ({ _ai: true }));

vi.mock("firebase/app", () => ({
  getApps: () => [],
  initializeApp: vi.fn((cfg: unknown) => ({ name: "[DEFAULT]", options: cfg })),
}));

vi.mock("firebase/ai", () => ({
  getAI: (...args: unknown[]) => getAI(...(args as [])),
  GoogleAIBackend: vi.fn(),
  getGenerativeModel: (...args: unknown[]) => getGenerativeModel(...(args as [])),
  InferenceMode: {
    PREFER_ON_DEVICE: "prefer_on_device",
    ONLY_ON_DEVICE: "only_on_device",
    ONLY_IN_CLOUD: "only_in_cloud",
    PREFER_IN_CLOUD: "prefer_in_cloud",
  },
}));

vi.mock("firebase/app-check", () => ({
  CustomProvider: vi.fn(),
  ReCaptchaEnterpriseProvider: vi.fn(),
  initializeAppCheck: vi.fn(() => ({ _appCheck: true })),
}));

vi.mock("firebase/auth", () => ({
  getAuth: vi.fn(() => authState),
  signInAnonymously: (...args: unknown[]) => signInAnonymously(...(args as [])),
}));

vi.mock("firebase/firestore", () => ({
  getFirestore: vi.fn(() => ({ _firestore: true })),
  collection: (...args: unknown[]) => collection(...(args as [unknown, ...string[]])),
  addDoc: (...args: unknown[]) => addDoc(...(args as [])),
  serverTimestamp: () => serverTimestamp(),
}));

vi.mock("firebase/remote-config", () => ({
  getRemoteConfig: vi.fn(() => ({ settings: {}, defaultConfig: {} })),
  fetchAndActivate: vi.fn(async () => true),
  getNumber: vi.fn((_rc: unknown, key: string) => {
    const val = rcValues[key];
    return typeof val === "number" ? val : 6000;
  }),
  getString: vi.fn((_rc: unknown, key: string) => {
    const val = rcValues[key];
    return typeof val === "string" ? val : "";
  }),
}));

const {
  DEFAULT_CLOUD_MODEL,
  DEFAULT_STEP_MODES,
  STEP_MODE_KEYS,
  getRemoteConfigStepMode,
  isFirebaseConfigured,
  resetFirebaseServicesForTest,
} = await import("../app/lib/firebase.js");
const { logAiCall, resetAiLogForTest } = await import("../app/lib/ai-log.js");
const { NEEDS_CONNECTION_MESSAGE } = await import("../app/lib/hybrid-ai.js");
const { parseExpenseInBrowser } = await import("../app/lib/clause-ai/expense.js");
const { explainExceptionInBrowser } = await import("../app/lib/clause-ai/exception.js");
const { draftChangeOrderInBrowser } = await import("../app/lib/clause-ai/changeOrder.js");
const {
  chooseEvidenceMode,
  computeScaledDimensions,
  evaluateEvidenceInBrowser,
} = await import("../app/lib/clause-ai/evidence.js");
const { parseDocumentInBrowser } = await import("../app/lib/clause-ai/parse.js");

const quoteSample = readFileSync(
  new URL("../samples/quote-maple-street-cafe.txt", import.meta.url),
  "utf8",
);
const quoteTerms = ContractTerms.parse(
  JSON.parse(
    readFileSync(
      new URL("../samples/quote-maple-street-cafe.terms.json", import.meta.url),
      "utf8",
    ),
  ),
);
const coEmailSample = readFileSync(
  new URL("../samples/change-order-email.txt", import.meta.url),
  "utf8",
);
const policySample = readFileSync(
  new URL("../samples/policy-acme-trip.txt", import.meta.url),
  "utf8",
);
const exceptionNoteSample = SAMPLE_EXCEPTION_NOTE;

function mockReply(text: string, inferenceSource: "on_device" | "in_cloud" = "on_device") {
  generateContent.mockResolvedValueOnce({
    response: { text: () => text, inferenceSource },
  });
}

function stubBrowserEnv(opts: { configured?: boolean; online?: boolean; lmAvailability?: string | null } = {}) {
  const configured = opts.configured ?? true;
  const metaEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  if (configured) {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "test-project");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "1:123:web:abc");
    if (metaEnv) {
      metaEnv.VITE_FIREBASE_API_KEY = "test-api-key";
      metaEnv.VITE_FIREBASE_PROJECT_ID = "test-project";
      metaEnv.VITE_FIREBASE_APP_ID = "1:123:web:abc";
    }
  } else {
    vi.unstubAllEnvs();
    vi.stubEnv("VITE_FIREBASE_API_KEY", "");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "");
    if (metaEnv) {
      metaEnv.VITE_FIREBASE_API_KEY = "";
      metaEnv.VITE_FIREBASE_PROJECT_ID = "";
      metaEnv.VITE_FIREBASE_APP_ID = "";
    }
  }
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { onLine: opts.online ?? true });
  if (opts.lmAvailability === null) {
    vi.stubGlobal("LanguageModel", undefined);
  } else if (opts.lmAvailability !== undefined) {
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn(async () => opts.lmAvailability),
    });
  } else {
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn(async () => "available"),
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(rcValues)) delete rcValues[k];
  authState.currentUser = null;
  resetFirebaseServicesForTest();
  resetAiLogForTest();
  stubBrowserEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("validateExpenseTerms", () => {
  it("accepts a valid policy extracted from sample text and recomputes 48h card expiry", () => {
    const raw = structuredClone(SAMPLE_POLICY_TERMS) as Record<string, any>;
    // Model returns a slightly off expiry date + nullable fields
    raw.card_expires.date = "2026-11-25";
    raw.lodging_clause = null;

    const res = validateExpenseTerms(raw, policySample);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.policyTerms?.card_expires.date).toBe("2026-11-23");
    expect(res.policyTerms?.lodging_clause).toBeUndefined();
  });

  it("rejects impossible calendar dates, inverted trip dates, and cap > budget", () => {
    const badDate = structuredClone(SAMPLE_POLICY_TERMS);
    badDate.trip_end = "2026-02-30";
    expect(validateExpenseTerms(badDate).ok).toBe(false);

    const inverted = structuredClone(SAMPLE_POLICY_TERMS);
    inverted.trip_start = "2026-11-20";
    inverted.trip_end = "2026-11-16";
    const invRes = validateExpenseTerms(inverted);
    expect(invRes.ok).toBe(false);
    expect(invRes.errors.join()).toMatch(/after the return date/i);

    const badCap = structuredClone(SAMPLE_POLICY_TERMS);
    badCap.per_charge_cap.amount = 3000;
    const capRes = validateExpenseTerms(badCap);
    expect(capRes.ok).toBe(false);
    expect(capRes.errors.join()).toMatch(/single-charge cap/i);
  });

  it("rejects blank required strings/quotes and flags non-verbatim clause quotes in open_questions", () => {
    const blankCompany = structuredClone(SAMPLE_POLICY_TERMS);
    blankCompany.company = "   ";
    expect(validateExpenseTerms(blankCompany).ok).toBe(false);

    const blankQuote = structuredClone(SAMPLE_POLICY_TERMS);
    blankQuote.budget.clause.quote = "   ";
    expect(validateExpenseTerms(blankQuote).ok).toBe(false);

    const hallucinated = structuredClone(SAMPLE_POLICY_TERMS);
    hallucinated.budget.clause.quote = "Unlimited executive budget is automatically pre-approved.";
    const res = validateExpenseTerms(hallucinated, policySample);
    expect(res.ok).toBe(true);
    expect(res.policyTerms?.open_questions.some((q) => q.includes("§2.2"))).toBe(true);
  });
});

describe("validateExceptionExtraction & computeValidatedExceptionCap", () => {
  it("computes max_allowed = 125 * attendees deterministically and clamps excess requested_cap", () => {
    const res = validateExceptionExtraction(
      {
        client: "Lone Star Logistics",
        attendees: 4,
        attendee_names: [
          "Marcus Lee",
          "Dana Reyes (Lone Star Logistics)",
          "Raj Patel (Lone Star Logistics)",
          "Claire Wu (Acme)",
        ],
        requested_cap: 9999,
        rationale: "4 attendees x $125 = $500 max allowed for the client dinner.",
      },
      SAMPLE_POLICY_TERMS,
      { sourceNote: exceptionNoteSample, requestedCharge: 420 },
    );

    expect(res.ok).toBe(true);
    expect(res.proposal?.max_allowed).toBe(500);
    expect(res.proposal?.one_time_cap).toBe(500);
    expect(res.proposal?.requested_charge).toBe(420);
    expect(res.proposal?.clause.clause_id).toBe("§3.4");
  });

  it("honors a lower requested_cap when strictly within the policy ceiling", () => {
    const caps = computeValidatedExceptionCap({
      client: "Lone Star Logistics",
      attendees: 4,
      attendee_names: ["A", "B", "C", "D"],
      perAttendeeCap: 125,
      requestedCap: 420,
    });
    expect(caps).toEqual({ max_allowed: 500, one_time_cap: 420 });
  });

  it("rejects missing client, duplicate attendees, fewer names than count, and missing §3.4 clause", () => {
    const dupes = validateExceptionExtraction(
      {
        client: "Lone Star Logistics",
        attendees: 3,
        attendee_names: ["Marcus Lee", "marcus lee", "Dana Reyes"],
        rationale: "Dinner",
      },
      SAMPLE_POLICY_TERMS,
    );
    expect(dupes.ok).toBe(false);
    expect(dupes.errors.join()).toMatch(/distinct/i);

    const noClause = validateExceptionExtraction(
      {
        client: "Lone Star Logistics",
        attendees: 2,
        attendee_names: ["Marcus Lee", "Dana Reyes"],
        rationale: "Dinner",
      },
      { exception_clause: undefined },
    );
    expect(noClause.ok).toBe(false);
  });
});

describe("Remote Config per-step modes and explicit cloud model", () => {
  it("keeps in-code defaults for all 5 steps and reads overrides from Remote Config", () => {
    expect(DEFAULT_CLOUD_MODEL).toBe("gemini-3.5-flash-lite");
    expect(STEP_MODE_KEYS).toEqual({
      contract: "contract_mode",
      expense: "expense_mode",
      exception: "exception_mode",
      changeOrder: "changeOrder_mode",
      evidence: "evidence_mode",
    });
    expect(DEFAULT_STEP_MODES).toEqual({
      contract: "prefer_on_device",
      expense: "prefer_on_device",
      exception: "prefer_on_device",
      changeOrder: "prefer_in_cloud",
      evidence: "prefer_in_cloud",
    });

    expect(getRemoteConfigStepMode("expense")).toBe("prefer_on_device");
    expect(getRemoteConfigStepMode("evidence")).toBe("prefer_in_cloud");

    rcValues.expense_mode = "prefer_in_cloud";
    rcValues.evidence_mode = "only_in_cloud";
    expect(getRemoteConfigStepMode("expense")).toBe("prefer_in_cloud");
    expect(getRemoteConfigStepMode("evidence")).toBe("only_in_cloud");

    rcValues.expense_mode = "bogus_invalid_value";
    expect(getRemoteConfigStepMode("expense")).toBe("prefer_on_device");
  });
});

describe("expense and exception wrappers: fallback logic & telemetry", () => {
  it("parses expense policy on-device without calling serverFallback and logs sanitized telemetry", async () => {
    mockReply(JSON.stringify(SAMPLE_POLICY_TERMS), "on_device");
    const serverFallback = vi.fn(async () => ({ server: true }));

    const res = await parseExpenseInBrowser(policySample, { serverFallback });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.policyTerms.policy_ref).toBe("TR-2611");
    expect(res.ai).toMatchObject({ source: "on_device", model: "Gemini Nano" });
    expect(serverFallback).not.toHaveBeenCalled();

    const params = getGenerativeModel.mock.calls.at(-1)![1] as Record<string, any>;
    expect(params.inCloudParams.model).toBe("gemini-3.5-flash-lite");

    await vi.waitFor(() => expect(addDoc).toHaveBeenCalledTimes(1));
    const logged = addDoc.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(logged).sort()).toEqual([
      "createdAt",
      "inferenceSource",
      "latencyMs",
      "mode",
      "step",
      "validatorOk",
    ]);
    expect(logged.step).toBe("expense");
    expect(logged.validatorOk).toBe(true);
    expect(JSON.stringify(logged)).not.toContain("ACME");
  });

  it("falls back to server when Firebase is unconfigured, when hybridGenerate throws, or when validation fails", async () => {
    // 1. Firebase unconfigured
    stubBrowserEnv({ configured: false });
    expect(isFirebaseConfigured()).toBe(false);
    const fb1 = vi.fn(async () => ({ via: "server-unconfigured" }));
    const r1 = await parseExpenseInBrowser(policySample, { serverFallback: fb1 });
    expect(r1).toEqual({
      status: "fallback",
      kind: "fallback",
      fallback: { via: "server-unconfigured" },
      reason: "firebase-unavailable",
    });
    expect(fb1).toHaveBeenCalledTimes(1);

    // 2. Model call throws
    stubBrowserEnv({ configured: true });
    generateContent.mockRejectedValueOnce(new Error("AI quota exceeded"));
    const fb2 = vi.fn(async () => ({ via: "server-error" }));
    const r2 = await parseExpenseInBrowser(policySample, { serverFallback: fb2 });
    expect(r2.status).toBe("fallback");
    if (r2.status === "fallback") {
      expect(r2.reason).toContain("AI quota exceeded");
      expect(r2.fallback).toEqual({ via: "server-error" });
    }

    // 3. Bad JSON -> HybridSchemaError -> logged with validatorOk: false -> server fallback
    mockReply("{ not valid json", "in_cloud");
    const fb3 = vi.fn(async () => ({ via: "server-schema" }));
    const r3 = await parseExpenseInBrowser(policySample, { serverFallback: fb3 });
    expect(r3.status).toBe("fallback");
    await vi.waitFor(() => expect(addDoc).toHaveBeenCalledTimes(1));
    expect((addDoc.mock.calls[0]![1] as Record<string, unknown>).validatorOk).toBe(false);

    // 4. Deterministic validation fails (per_charge_cap > budget) -> logged validatorOk: false -> fallback
    const badTerms = structuredClone(SAMPLE_POLICY_TERMS);
    badTerms.per_charge_cap.amount = 9999;
    mockReply(JSON.stringify(badTerms), "on_device");
    const fb4 = vi.fn(async () => ({ via: "server-validation" }));
    const r4 = await parseExpenseInBrowser(policySample, { serverFallback: fb4 });
    expect(r4.status).toBe("fallback");
    if (r4.status === "fallback") {
      expect(r4.reason).toContain("expense-validation-failed");
    }
    await vi.waitFor(() => expect(addDoc).toHaveBeenCalledTimes(2));
    expect((addDoc.mock.calls[1]![1] as Record<string, unknown>).validatorOk).toBe(false);
  });

  it("explains exception on-device with deterministic cap clamping and falls back on invalid extraction", async () => {
    mockReply(
      JSON.stringify({
        client: "Lone Star Logistics",
        attendees: 4,
        attendee_names: ["Marcus Lee", "Dana Reyes", "Raj Patel", "Claire Wu"],
        requested_cap: 1500, // deliberately excessive model suggestion
        rationale: "Four named attendees authorize up to $500 under §3.4.",
      }),
      "on_device",
    );
    const fbOk = vi.fn(async () => ({ server: true }));
    const ok = await explainExceptionInBrowser(SAMPLE_POLICY_TERMS, exceptionNoteSample, {
      serverFallback: fbOk,
    });
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") {
      // AI suggestion of 1500 was clamped deterministically to 500
      expect(ok.proposal.one_time_cap).toBe(500);
      expect(ok.explanation).toContain("Four named attendees");
    }
    expect(fbOk).not.toHaveBeenCalled();

    // Missing attendees vs count -> fallback
    mockReply(
      JSON.stringify({
        client: "Lone Star Logistics",
        attendees: 4,
        attendee_names: ["Marcus Lee"],
        rationale: "Dinner",
      }),
      "in_cloud",
    );
    const fbBad = vi.fn(async () => ({ fallback: "server" }));
    const bad = await explainExceptionInBrowser(SAMPLE_POLICY_TERMS, exceptionNoteSample, {
      serverFallback: fbBad,
    });
    expect(bad.status).toBe("fallback");
    if (bad.status === "fallback") {
      expect(bad.reason).toContain("exception-validation-failed");
    }
    expect(fbBad).toHaveBeenCalledTimes(1);
  });
});

describe("offline needs-connection behavior", () => {
  it("returns needs-connection without calling model or server when offline and on-device is unavailable", async () => {
    stubBrowserEnv({ online: false, lmAvailability: "unavailable" });
    const fbExpense = vi.fn(async () => ({ server: true }));
    const fbException = vi.fn(async () => ({ server: true }));

    const resExpense = await parseExpenseInBrowser(policySample, { serverFallback: fbExpense });
    const resException = await explainExceptionInBrowser(SAMPLE_POLICY_TERMS, exceptionNoteSample, {
      serverFallback: fbException,
    });
    const resContract = await parseDocumentInBrowser(quoteSample);

    for (const r of [resExpense, resException, resContract]) {
      expect(r.status).toBe("needs-connection");
      expect(r.kind).toBe("needs-connection");
      if (r.kind === "needs-connection") {
        expect(r.message).toBe(NEEDS_CONNECTION_MESSAGE);
      }
    }
    expect(generateContent).not.toHaveBeenCalled();
    expect(fbExpense).not.toHaveBeenCalled();
    expect(fbException).not.toHaveBeenCalled();
  });

  it("returns needs-connection offline even if on-device is available when mode is only_in_cloud", async () => {
    stubBrowserEnv({ online: false, lmAvailability: "available" });
    rcValues.expense_mode = "only_in_cloud";
    const fb = vi.fn(async () => ({ server: true }));

    const res = await parseExpenseInBrowser(policySample, { serverFallback: fb });
    expect(res).toEqual({
      status: "needs-connection",
      kind: "needs-connection",
      message: NEEDS_CONNECTION_MESSAGE,
    });
    expect(generateContent).not.toHaveBeenCalled();
    expect(fb).not.toHaveBeenCalled();
  });

  it("never falls back to server when offline even if an on-device call fails", async () => {
    stubBrowserEnv({ online: false, lmAvailability: "available" });
    generateContent.mockRejectedValueOnce(new Error("local runtime error"));
    const fb = vi.fn(async () => ({ server: true }));

    const res = await parseExpenseInBrowser(policySample, { serverFallback: fb });
    expect(res.status).toBe("needs-connection");
    expect(getGenerativeModel.mock.calls.at(-1)![1]).toMatchObject({ mode: "only_on_device" });
    expect(fb).not.toHaveBeenCalled();
  });
});

describe("ai-log Firestore telemetry", () => {
  it("writes only whitelisted fields under users/{uid}/aiCalls and never throws on errors or offline", async () => {
    const extraDirtyEntry = {
      step: "contract" as const,
      mode: "prefer_on_device" as const,
      inferenceSource: "on_device" as const,
      latencyMs: 312.7,
      validatorOk: true,
      contractText: "SECRET RAW CONTRACT",
      expenseText: "SECRET EXPENSE",
      imageBase64: "data:image/jpeg;base64,AAAA",
    };

    await logAiCall(extraDirtyEntry as never);
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
    expect(collection).toHaveBeenCalledWith(expect.anything(), "users", "anon-user-123", "aiCalls");
    expect(addDoc).toHaveBeenCalledWith(
      { path: "users/anon-user-123/aiCalls" },
      {
        step: "contract",
        mode: "prefer_on_device",
        inferenceSource: "on_device",
        latencyMs: 313,
        validatorOk: true,
        createdAt: { _serverTimestamp: true },
      },
    );

    // Offline without signed-in user skips network sign-in safely and resolves
    authState.currentUser = null;
    stubBrowserEnv({ online: false });
    await expect(
      logAiCall({
        step: "expense",
        mode: "prefer_on_device",
        inferenceSource: "on_device",
        latencyMs: 100,
        validatorOk: true,
      }),
    ).resolves.toBeUndefined();
    expect(signInAnonymously).toHaveBeenCalledTimes(1);

    // Rejection in addDoc must never throw
    stubBrowserEnv({ online: true });
    authState.currentUser = { uid: "anon-user-123" };
    addDoc.mockRejectedValueOnce(new Error("firestore permission denied"));
    await expect(
      logAiCall({
        step: "exception",
        mode: "prefer_on_device",
        inferenceSource: "in_cloud",
        latencyMs: 500,
        validatorOk: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("validateChangeOrderDraft & draftChangeOrderInBrowser", () => {
  it("computes milestone new_amount and contract totals deterministically from delta_amount", () => {
    const res = validateChangeOrderDraft(
      {
        summary: "In-stock quartz adds $800 to M2 and pushes deadline to Dec 23.",
        milestone_amount_changes: [
          {
            milestone_id: "M2",
            delta_amount: 800,
            new_amount: 1234, // deliberately wrong AI arithmetic; code ignores when delta_amount present
            reason: "In-stock quartz upgrade (+$800).",
          },
        ],
        new_deadline: "2026-12-23",
        requires_signed_change_order: false, // code enforces true on price/date change
        source_quote:
          "We can do the in-stock quartz at +$800 for Milestone 2, but installation slips a week, so we'd need until December 23 to finish.",
      },
      quoteTerms,
      coEmailSample,
    );

    expect(res.ok).toBe(true);
    expect(res.proposal?.milestone_amount_changes[0]?.new_amount).toBe(5800);
    expect(res.computed).toEqual({ oldTotal: 12000, newTotal: 12800, totalDelta: 800 });
    expect(res.proposal?.requires_signed_change_order).toBe(true);
  });

  it("rejects unknown milestones, bad dates, non-positive totals, and fabricated source quotes", () => {
    const unknownMs = validateChangeOrderDraft(
      {
        summary: "Update M9",
        milestone_amount_changes: [{ milestone_id: "M9", delta_amount: 100, reason: "extra" }],
        requires_signed_change_order: true,
        source_quote: "We can do the in-stock quartz at +$800 for Milestone 2",
      },
      quoteTerms,
      coEmailSample,
    );
    expect(unknownMs.ok).toBe(false);
    expect(unknownMs.errors.join()).toMatch(/unknown milestone/i);

    const badQuote = validateChangeOrderDraft(
      {
        summary: "Free change",
        milestone_amount_changes: [{ milestone_id: "M2", delta_amount: 800, reason: "quartz" }],
        requires_signed_change_order: true,
        source_quote: "Totally invented sentence not in the contractor email.",
      },
      quoteTerms,
      coEmailSample,
    );
    expect(badQuote.ok).toBe(false);
    expect(badQuote.errors.join()).toMatch(/verbatim/i);

    const badDate = validateChangeOrderDraft(
      {
        summary: "Bad date",
        milestone_amount_changes: [],
        new_deadline: "2026-02-30",
        requires_signed_change_order: true,
        source_quote: "We can do the in-stock quartz at +$800 for Milestone 2",
      },
      quoteTerms,
      coEmailSample,
    );
    expect(badDate.ok).toBe(false);
  });

  it("drafts in browser using Remote Config step mode, validates deterministically, falls back on failure, and blocks offline", async () => {
    mockReply(
      JSON.stringify({
        summary: "Add $800 to M2 and extend deadline to Dec 23.",
        milestone_amount_changes: [
          { milestone_id: "M2", delta_amount: 800, reason: "In-stock quartz substitution." },
        ],
        new_deadline: "2026-12-23",
        requires_signed_change_order: true,
        source_quote:
          "We can do the in-stock quartz at +$800 for Milestone 2, but installation slips a week, so we'd need until December 23 to finish.",
      }),
      "in_cloud",
    );
    const serverFallback = vi.fn(async () => ({ server: true }));
    const res = await draftChangeOrderInBrowser(quoteTerms, coEmailSample, { serverFallback });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.proposal.milestone_amount_changes[0]?.new_amount).toBe(5800);
    expect(res.computed).toEqual({ oldTotal: 12000, newTotal: 12800, totalDelta: 800 });
    expect(res.ai).toMatchObject({ source: "in_cloud", model: "gemini-3.5-flash-lite" });
    expect(getGenerativeModel.mock.calls.at(-1)![1]).toMatchObject({ mode: "prefer_in_cloud" });
    expect(serverFallback).not.toHaveBeenCalled();

    // Server proposeChangeOrder accepts the browser draft and recomputes against stored terms
    const svc = new ContractCardService(new MockIssuingGateway(), new MemoryJobStore(), "owner@example.com");
    let job = await svc.createJob({ kind: "text", text: quoteSample });
    job = await svc.approveTerms(job.id);
    job = await svc.proposeChangeOrder(job.id, undefined, { draft: res.draft, aiSource: res.ai });
    expect(job.pending?.kind).toBe("change_order");
    expect(job.pending?.aiSource).toEqual(res.ai);
    expect(job.pending?.change_order?.milestone_amount_changes[0]?.new_amount).toBe(5800);

    // Offline without on-device returns needs-connection and never touches cloud or server
    stubBrowserEnv({ online: false, lmAvailability: "unavailable" });
    const offline = await draftChangeOrderInBrowser(quoteTerms, coEmailSample, { serverFallback });
    expect(offline.status).toBe("needs-connection");
    expect(serverFallback).not.toHaveBeenCalled();
  });
});

describe("evidence downscaling, validator, and evaluateEvidenceInBrowser", () => {
  const m2 = quoteTerms.milestones[1]!; // M2 requires photos
  const m3 = quoteTerms.milestones[2]!; // M3 requires inspection_report + walkthrough_signoff
  const validBase64 = Buffer.alloc(128, 7).toString("base64");

  it("caps resized dimensions at 768px while preserving aspect ratio and validates verdicts", () => {
    expect(computeScaledDimensions(1600, 1200)).toEqual({ width: 768, height: 576 });
    expect(computeScaledDimensions(600, 1200)).toEqual({ width: 384, height: 768 });
    expect(computeScaledDimensions(640, 480)).toEqual({ width: 640, height: 480 });

    const missing = checkMissingEvidenceKinds(m3, [
      { declaredKind: "photos" },
    ]);
    expect(missing?.verdict).toBe("insufficient");
    expect(missing?.missing).toEqual(["inspection_report", "walkthrough_signoff"]);

    expect(
      validateEvidenceVerdict({
        verdict: "meets",
        reasoning: "Installed maple cabinets match contract scope.",
        observed: ["Base and upper cabinets installed"],
        missing: [],
      }).ok,
    ).toBe(true);

    // Contradictory "meets" verdict with missing items must be rejected
    expect(
      validateEvidenceVerdict({
        verdict: "meets",
        reasoning: "Mostly done",
        observed: ["Cabinets"],
        missing: ["walkthrough_signoff"],
      }).ok,
    ).toBe(false);
  });

  it("evaluates single-turn downscaled JPEG in browser with PREFER_IN_CLOUD default sends PDFs to cloud via AI Logic, and falls back on missing kinds/failure", async () => {
    expect(chooseEvidenceMode()).toBe("prefer_in_cloud");
    const downscale = vi.fn(async () => ({
      mimeType: "image/jpeg" as const,
      base64: "DOWNSCALED_JPEG_DATA",
      width: 768,
      height: 576,
    }));
    const serverFallback = vi.fn(async () => ({ server: true }));

    mockReply(
      JSON.stringify({
        verdict: "meets",
        reasoning: "Photo shows completed cabinet framing and counters for M2.",
        observed: ["Upper and lower maple cabinetry installed"],
        missing: [],
      }),
      "in_cloud",
    );

    const photoFile = {
      filename: "cabinets-installed.png",
      mediaType: "image/png" as const,
      base64: validBase64,
      declaredKind: "photos" as const,
    };

    const res = await evaluateEvidenceInBrowser(m2, [photoFile], {
      downscale,
      serverFallback,
    });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.verdict.verdict).toBe("meets");
    expect(res.image).toEqual({
      mimeType: "image/jpeg",
      base64: "DOWNSCALED_JPEG_DATA",
      width: 768,
      height: 576,
    });
    expect(res.ai).toMatchObject({ source: "in_cloud", model: "gemini-3.5-flash-lite" });
    expect(downscale).toHaveBeenCalledTimes(1);
    expect(serverFallback).not.toHaveBeenCalled();

    const params = getGenerativeModel.mock.calls.at(-1)![1] as Record<string, any>;
    expect(params.mode).toBe("prefer_in_cloud");
    expect(params.inCloudParams.model).toBe("gemini-3.5-flash-lite");

    // Verify single-turn multimodal call received ONE JPEG InlineDataPart
    const callArg = generateContent.mock.calls.at(-1)![0] as Array<Record<string, any>>;
    expect(Array.isArray(callArg)).toBe(true);
    expect(callArg).toHaveLength(2);
    expect(callArg[1]).toEqual({
      type: "inlineData",
      inlineData: { mimeType: "image/jpeg", data: "DOWNSCALED_JPEG_DATA" },
    });

    // Telemetry never stores image bytes or filenames
    await vi.waitFor(() => expect(addDoc).toHaveBeenCalledTimes(1));
    const logged = JSON.stringify(addDoc.mock.calls[0]![1]);
    expect(logged).toContain('"step":"evidence"');
    expect(logged).not.toContain("DOWNSCALED_JPEG_DATA");
    expect(logged).not.toContain("cabinets-installed");

    // Server submitProof keeps missing-kinds deterministic guard and attaches aiSource
    const svc = new ContractCardService(new MockIssuingGateway(), new MemoryJobStore(), "owner@example.com");
    let job = await svc.createJob({ kind: "text", text: quoteSample });
    job = await svc.approveTerms(job.id);
    job = await svc.submitProof(job.id, [photoFile], {
      verdict: res.verdict,
      aiSource: res.ai,
    });
    expect(job.pending?.kind).toBe("release_milestone");
    expect(job.pending?.aiSource).toEqual(res.ai);

    // PDF proof goes inline to cloud Gemini through Firebase AI Logic (ONLY_IN_CLOUD), never the server
    mockReply(
      JSON.stringify({
        verdict: "meets",
        reasoning: "Inspection report covers M2.",
        observed: ["Signed inspection report"],
        missing: [],
      }),
      "in_cloud",
    );
    const pdfRes = await evaluateEvidenceInBrowser(
      m2,
      [{ filename: "report.pdf", mediaType: "application/pdf", base64: validBase64, declaredKind: "photos" }],
      { downscale, serverFallback },
    );
    expect(pdfRes.status).toBe("ok");
    expect(getGenerativeModel.mock.calls.at(-1)![1]).toMatchObject({ mode: "only_in_cloud" });
    const pdfContent = generateContent.mock.calls.at(-1)![0] as Array<Record<string, any>>;
    expect(pdfContent.some((p) => p.inlineData?.mimeType === "application/pdf")).toBe(true);
    expect(serverFallback).not.toHaveBeenCalled();

    // Offline without on-device returns needs-connection and never sends image or hits server
    stubBrowserEnv({ online: false, lmAvailability: "unavailable" });
    const offline = await evaluateEvidenceInBrowser(m2, [photoFile], { downscale, serverFallback });
    expect(offline.status).toBe("needs-connection");
    expect(serverFallback).not.toHaveBeenCalled();
  });
});
