/**
 * Review #4: Web App Check must fail closed in production builds. With no reCAPTCHA Enterprise site
 * key, a production build creates no Firebase AI Logic client (no getAI / getGenerativeModel), never
 * sets the App Check debug token, and AI steps fall back without sending anything to Firebase.
 * Dev builds keep the debug-token path. `import.meta.env.DEV/PROD` are stubbed per test.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
const getGenerativeModel = vi.fn(() => ({ generateContent }));
const getAI = vi.fn(() => ({ _ai: true }));
const initializeAppCheck = vi.fn(() => ({ _appCheck: true }));
const ReCaptchaEnterpriseProvider = vi.fn();

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
  ReCaptchaEnterpriseProvider: function (this: unknown, ...a: unknown[]) {
    ReCaptchaEnterpriseProvider(...(a as []));
  },
  initializeAppCheck: (...args: unknown[]) => initializeAppCheck(...(args as [])),
}));
vi.mock("firebase/auth", () => ({
  getAuth: vi.fn(() => ({ currentUser: null })),
  signInAnonymously: vi.fn(async () => ({ user: { uid: "u" } })),
}));
vi.mock("firebase/firestore", () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn(() => ({})),
  addDoc: vi.fn(async () => ({ id: "doc-1" })),
  serverTimestamp: () => ({}),
}));
vi.mock("firebase/remote-config", () => ({
  getRemoteConfig: vi.fn(() => ({ settings: {}, defaultConfig: {} })),
  fetchAndActivate: vi.fn(async () => true),
  getNumber: vi.fn(() => 6000),
  getString: vi.fn(() => ""),
}));

const firebase = await import("../app/lib/firebase.js");
const hybrid = await import("../app/lib/hybrid-ai.js");
const { parseDocumentInBrowser } = await import("../app/lib/clause-ai/parse.js");
const { parseExpenseInBrowser } = await import("../app/lib/clause-ai/expense.js");
const { z } = await import("zod");

const quote = readFileSync(new URL("../samples/quote-maple-street-cafe.txt", import.meta.url), "utf8");
const policy = readFileSync(new URL("../samples/policy-acme-trip.txt", import.meta.url), "utf8");
const DEBUG = "00000000-test-debug-token";

let fetchSpy: ReturnType<typeof vi.fn>;
let selfObj: Record<string, unknown>;

function stubBuild(build: "production" | "development", opts: { siteKey?: string; debugToken?: string; lm?: string | null } = {}) {
  vi.stubEnv("DEV", build === "development");
  vi.stubEnv("PROD", build === "production");
  vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "test-project");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "1:123:web:abc");
  vi.stubEnv("VITE_RECAPTCHA_ENTERPRISE_SITE_KEY", opts.siteKey ?? "");
  vi.stubEnv("VITE_APPCHECK_DEBUG_TOKEN", opts.debugToken ?? "");
  selfObj = {};
  vi.stubGlobal("self", selfObj);
  vi.stubGlobal("window", { dispatchEvent: () => true });
  vi.stubGlobal("navigator", { onLine: true });
  const lm = opts.lm === undefined ? "unavailable" : opts.lm;
  vi.stubGlobal("LanguageModel", lm === null ? undefined : { availability: vi.fn(async () => lm) });
}

beforeEach(() => {
  vi.clearAllMocks();
  firebase.resetFirebaseServicesForTest();
  fetchSpy = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("production build without a reCAPTCHA Enterprise site key", () => {
  it("creates no AI client and reports cloud AI disabled", () => {
    stubBuild("production", { debugToken: DEBUG });
    expect(import.meta.env.PROD).toBe(true);
    expect(firebase.isCloudAiDisabled()).toBe(true);
    const services = firebase.getFirebaseServices();
    expect(services.ai).toBeNull();
    expect(services.appCheck).toBeNull();
    expect(() => firebase.getFirebaseAI()).toThrow(firebase.APP_CHECK_NOT_CONFIGURED_MESSAGE);
    expect(getAI).not.toHaveBeenCalled();
    expect(initializeAppCheck).not.toHaveBeenCalled();
  });

  it("never sets the App Check debug token, even when VITE_APPCHECK_DEBUG_TOKEN is present", () => {
    stubBuild("production", { debugToken: DEBUG });
    firebase.getFirebaseServices();
    expect(selfObj.FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();
    firebase.resetFirebaseServicesForTest();
    stubBuild("production", { siteKey: "site-key", debugToken: DEBUG });
    firebase.getFirebaseServices();
    expect(selfObj.FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();
  });

  it("hybridGenerate throws CloudAiDisabledError before getAI/getGenerativeModel (no local model)", async () => {
    stubBuild("production", { lm: "unavailable" });
    for (const mode of ["prefer_on_device", "prefer_in_cloud", "only_in_cloud"] as const) {
      await expect(
        hybrid.hybridGenerate({ system: "s", prompt: "p", schema: z.object({ a: z.string() }), mode }),
      ).rejects.toBeInstanceOf(firebase.CloudAiDisabledError);
    }
    expect(getAI).not.toHaveBeenCalled();
    expect(getGenerativeModel).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("contract parse sends nothing to Firebase and lets the caller fall back", async () => {
    stubBuild("production", { lm: null });
    await expect(parseDocumentInBrowser(quote)).rejects.toBeInstanceOf(firebase.CloudAiDisabledError);
    const serverFallback = vi.fn(async () => ({ server: true }));
    const r = await parseExpenseInBrowser(policy, { serverFallback });
    expect(r.status).toBe("fallback");
    expect(serverFallback).toHaveBeenCalledTimes(1);
    expect(getAI).not.toHaveBeenCalled();
    expect(getGenerativeModel).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still runs on-device only when Chrome's local model is available", async () => {
    stubBuild("production", { lm: "available" });
    generateContent.mockResolvedValueOnce({ response: { text: () => '{"a":"x"}', inferenceSource: "on_device" } });
    const r = await hybrid.hybridGenerate({
      system: "s",
      prompt: "p",
      schema: z.object({ a: z.string() }),
      mode: "prefer_on_device",
    });
    expect(r.source).toBe("on_device");
    expect(getGenerativeModel).toHaveBeenCalledTimes(1);
    expect((getGenerativeModel.mock.calls[0] as unknown[])[1]).toMatchObject({ mode: "only_on_device" });
    // only_in_cloud is still refused.
    await expect(
      hybrid.hybridGenerate({ system: "s", prompt: "p", schema: z.object({ a: z.string() }), mode: "only_in_cloud" }),
    ).rejects.toBeInstanceOf(firebase.CloudAiDisabledError);
    expect(getGenerativeModel).toHaveBeenCalledTimes(1);
  });
});

describe("production build with a site key", () => {
  it("uses reCAPTCHA Enterprise and creates the AI client with limited-use tokens", () => {
    stubBuild("production", { siteKey: "site-key" });
    expect(firebase.isCloudAiDisabled()).toBe(false);
    const services = firebase.getFirebaseServices();
    expect(services.ai).not.toBeNull();
    expect(ReCaptchaEnterpriseProvider).toHaveBeenCalledWith("site-key");
    expect(getAI).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ useLimitedUseAppCheckTokens: true }));
  });
});

describe("development build", () => {
  it("keeps the debug-token path", () => {
    stubBuild("development", { debugToken: DEBUG });
    expect(firebase.isCloudAiDisabled()).toBe(false);
    const services = firebase.getFirebaseServices();
    expect(selfObj.FIREBASE_APPCHECK_DEBUG_TOKEN).toBe(DEBUG);
    expect(services.appCheck).not.toBeNull();
    expect(services.ai).not.toBeNull();
  });
});

describe("production bundle source guard", () => {
  it("only touches the debug token inside import.meta.env.DEV-guarded code", () => {
    const src = readFileSync(new URL("../app/lib/firebase.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("function initDevAppCheckDebugProvider"));
    expect(fn.split("\n")[1]).toContain("if (!import.meta.env.DEV) return null;");
    const outside = src.slice(0, src.indexOf("function initDevAppCheckDebugProvider"));
    expect(outside).not.toMatch(/VITE_APPCHECK_DEBUG_TOKEN"\)|FIREBASE_APPCHECK_DEBUG_TOKEN =/);
    expect(outside).toContain("if (import.meta.env.DEV) {\n    appCheck = initDevAppCheckDebugProvider(app, siteKey);");
  });
});
