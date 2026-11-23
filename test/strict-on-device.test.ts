/**
 * Strict on-device mode (ONLY_ON_DEVICE): when Chrome's local model is not "available", no AI step
 * may touch the Firebase AI Logic SDK, the network, or the Clause server fallback, including after
 * errors. When the local model runs and fails, the server fallback is still never called.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContractTerms } from "../server/clause/contract/schema.js";
import { SAMPLE_EXCEPTION_NOTE, SAMPLE_POLICY_TERMS } from "../server/clause/fixtures.js";

const generateContent = vi.fn();
const getGenerativeModel = vi.fn(() => ({ generateContent }));
const getAI = vi.fn(() => ({ _ai: true }));
const addDoc = vi.fn(async () => ({ id: "doc-1" }));

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
  getAuth: vi.fn(() => ({ currentUser: null })),
  signInAnonymously: vi.fn(async () => ({ user: { uid: "u" } })),
}));
vi.mock("firebase/firestore", () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn(() => ({})),
  addDoc: (...args: unknown[]) => addDoc(...(args as [])),
  serverTimestamp: () => ({}),
}));
vi.mock("firebase/remote-config", () => ({
  getRemoteConfig: vi.fn(() => ({ settings: {}, defaultConfig: {} })),
  fetchAndActivate: vi.fn(async () => true),
  getNumber: vi.fn(() => 6000),
  getString: vi.fn(() => ""),
}));

const firebase = await import("../app/lib/firebase.js");
const { resetAiLogForTest } = await import("../app/lib/ai-log.js");
const hybrid = await import("../app/lib/hybrid-ai.js");
const { parseDocumentInBrowser } = await import("../app/lib/clause-ai/parse.js");
const { parseExpenseInBrowser } = await import("../app/lib/clause-ai/expense.js");
const { explainExceptionInBrowser } = await import("../app/lib/clause-ai/exception.js");
const { draftChangeOrderInBrowser } = await import("../app/lib/clause-ai/changeOrder.js");
const { evaluateEvidenceInBrowser } = await import("../app/lib/clause-ai/evidence.js");
const { explainDeclineInBrowser, deterministicDeclineText } = await import("../app/lib/clause-ai/decline.js");

const quote = readFileSync(new URL("../samples/quote-maple-street-cafe.txt", import.meta.url), "utf8");
const policy = readFileSync(new URL("../samples/policy-acme-trip.txt", import.meta.url), "utf8");
const coEmail = readFileSync(new URL("../samples/change-order-email.txt", import.meta.url), "utf8");
const quoteTerms = ContractTerms.parse(
  JSON.parse(readFileSync(new URL("../samples/quote-maple-street-cafe.terms.json", import.meta.url), "utf8")),
);
const m2 = quoteTerms.milestones.find((m) => m.id === "M2")!;
const validBase64 = Buffer.alloc(512, 7).toString("base64");
const photo = { filename: "site.png", mediaType: "image/png" as const, base64: validBase64, declaredKind: "photos" as const };
const pdf = { filename: "report.pdf", mediaType: "application/pdf" as const, base64: validBase64, declaredKind: "photos" as const };
const downscale = vi.fn(async () => ({ mimeType: "image/jpeg" as const, base64: "JPEG", width: 10, height: 10 }));
const declineFacts = {
  merchant_name: "Builders Supply Co.",
  amount: 6000,
  currency: "USD",
  failure_reason: "LIMIT_EXCEEDED",
  headline: "Declined USD 6,000.00 at Builders Supply Co.: it would exceed the funds released so far.",
};

let fetchSpy: ReturnType<typeof vi.fn>;
let serverFallback: ReturnType<typeof vi.fn>;

function stubEnv(lm: string | null, storage?: Record<string, string>) {
  vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "test-project");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "1:123:web:abc");
  const store = storage ?? {};
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
    dispatchEvent: () => true,
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal(
    "LanguageModel",
    lm === null ? undefined : { availability: vi.fn(async () => lm) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  firebase.resetFirebaseServicesForTest();
  resetAiLogForTest();
  fetchSpy = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchSpy);
  serverFallback = vi.fn(async () => ({ server: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectNothingSent() {
  expect(getAI).not.toHaveBeenCalled();
  expect(getGenerativeModel).not.toHaveBeenCalled();
  expect(generateContent).not.toHaveBeenCalled();
  expect(serverFallback).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
}

async function runAllSteps(mode?: "only_on_device") {
  const opts = mode ? { mode } : {};
  return {
    contract: await parseDocumentInBrowser(quote, opts),
    policy: await parseExpenseInBrowser(policy, { ...opts, serverFallback }),
    exception: await explainExceptionInBrowser(SAMPLE_POLICY_TERMS, SAMPLE_EXCEPTION_NOTE, { ...opts, serverFallback }),
    changeOrder: await draftChangeOrderInBrowser(quoteTerms, coEmail, { ...opts, serverFallback }),
    evidence: await evaluateEvidenceInBrowser(m2, [photo], { ...opts, downscale, serverFallback }),
  };
}

describe("strict on-device: local model not available", () => {
  for (const lm of [null, "unavailable", "downloadable", "downloading"]) {
    it(`sends nothing anywhere when LanguageModel is ${lm ?? "missing"} (browser online)`, async () => {
      stubEnv(lm);
      const r = await runAllSteps("only_on_device");
      for (const res of Object.values(r)) {
        expect(res).toMatchObject({
          status: "on-device-unavailable",
          message: hybrid.ON_DEVICE_UNAVAILABLE_MESSAGE,
        });
      }
      expect(hybrid.ON_DEVICE_UNAVAILABLE_MESSAGE).toBe("On-device model not available. Nothing was sent.");
      const decline = await explainDeclineInBrowser(declineFacts, { mode: "only_on_device" });
      expect(decline).toEqual({
        status: "fallback",
        explanation: deterministicDeclineText(declineFacts),
        reason: "on-device-unavailable",
      });
      expectNothingSent();
    });
  }

  it("the device-local strict switch forces ONLY_ON_DEVICE for every step with no mode passed", async () => {
    stubEnv("downloadable", { [firebase.PRIVACY_MODE_STORAGE_KEY]: "strict" });
    expect(firebase.getLocalPrivacyMode()).toBe("strict");
    for (const step of ["contract", "expense", "exception", "changeOrder", "evidence"] as const) {
      expect(firebase.getRemoteConfigStepMode(step)).toBe("only_on_device");
      expect(firebase.isStrictOnDevice(step)).toBe(true);
    }
    const r = await runAllSteps();
    for (const res of Object.values(r)) expect(res.status).toBe("on-device-unavailable");
    expect((await explainDeclineInBrowser(declineFacts)).status).toBe("fallback");
    expectNothingSent();

    firebase.setLocalPrivacyMode("hybrid");
    expect(firebase.getRemoteConfigStepMode("evidence")).toBe("prefer_in_cloud");
  });

  it("hybridGenerate itself refuses ONLY_ON_DEVICE before building a model (defence in depth)", async () => {
    stubEnv(null);
    await expect(
      hybrid.hybridGenerate({ system: "s", prompt: quote, schema: ContractTerms, mode: "only_on_device" }),
    ).rejects.toBeInstanceOf(hybrid.OnDeviceUnavailableError);
    expectNothingSent();
  });
});

describe("strict on-device: local model available but the call fails", () => {
  it("runtime errors never fall back to the server or throw for a resend", async () => {
    stubEnv("available");
    generateContent.mockRejectedValue(new Error("local runtime error"));
    const r = await runAllSteps("only_on_device");
    for (const res of Object.values(r)) expect(res.status).toBe("on-device-failed");
    expect(serverFallback).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const call of getGenerativeModel.mock.calls as unknown as [unknown, { mode: string }][]) {
      expect(call[1].mode).toBe("only_on_device");
    }
  });

  it("schema and validation failures never fall back to the server", async () => {
    stubEnv("available");
    generateContent.mockResolvedValue({ response: { text: () => "not json", inferenceSource: "on_device" } });
    const r = await runAllSteps("only_on_device");
    for (const res of Object.values(r)) expect(res.status).toBe("on-device-failed");
    expect(serverFallback).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("PDF proof and missing-evidence batches stop with nothing sent", async () => {
    stubEnv("available");
    const pdfRes = await evaluateEvidenceInBrowser(m2, [pdf], { mode: "only_on_device", downscale, serverFallback });
    expect(pdfRes).toMatchObject({ status: "on-device-failed", message: expect.stringContaining("Nothing was sent") });
    const missing = await evaluateEvidenceInBrowser(m2, [{ ...photo, declaredKind: "invoice" as never }], {
      mode: "only_on_device",
      downscale,
      serverFallback,
    });
    expect(missing).toMatchObject({ status: "on-device-failed", message: expect.stringContaining("Nothing was sent") });
    expectNothingSent();
  });

  it("isNothingSentResult covers offline and both strict outcomes", () => {
    expect(hybrid.isNothingSentResult(hybrid.needsConnectionResult())).toBe(true);
    expect(hybrid.isNothingSentResult(hybrid.onDeviceUnavailableResult("unavailable"))).toBe(true);
    expect(hybrid.isNothingSentResult(hybrid.onDeviceFailedResult("x"))).toBe(true);
    expect(hybrid.isNothingSentResult({ status: "fallback" })).toBe(false);
  });
});
