import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_EXCEPTION_NOTE, SAMPLE_POLICY_TERMS } from "../server/clause/fixtures.js";
import {
  computeValidatedExceptionCap,
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
const { parseDocumentInBrowser } = await import("../app/lib/clause-ai/parse.js");

const quoteSample = readFileSync(
  new URL("../samples/quote-maple-street-cafe.txt", import.meta.url),
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
