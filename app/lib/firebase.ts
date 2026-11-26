import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import { type AI, getAI, GoogleAIBackend } from "firebase/ai";
import {
  type AppCheck,
  CustomProvider,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";
import { type Auth, getAuth } from "firebase/auth";
import { type Firestore, getFirestore } from "firebase/firestore";
import {
  fetchAndActivate,
  getNumber,
  getRemoteConfig,
  getString,
  type RemoteConfig,
} from "firebase/remote-config";

export const DEFAULT_CLOUD_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_CLOUD_CHAR_THRESHOLD = 6000;

export type HybridMode = "prefer_on_device" | "only_on_device" | "prefer_in_cloud" | "only_in_cloud";
export type AiStep = "contract" | "expense" | "exception" | "changeOrder" | "evidence";

export const STEP_MODE_KEYS: Record<AiStep, string> = {
  contract: "contract_mode",
  expense: "expense_mode",
  exception: "exception_mode",
  changeOrder: "changeOrder_mode",
  evidence: "evidence_mode",
};

/** In-code per-step default inference modes kept active offline or before Remote Config loads. */
export const DEFAULT_STEP_MODES: Record<AiStep, HybridMode> = {
  contract: "prefer_on_device",
  expense: "prefer_on_device",
  exception: "prefer_on_device",
  changeOrder: "prefer_in_cloud",
  evidence: "prefer_in_cloud",
};

const VALID_HYBRID_MODES = new Set<HybridMode>([
  "prefer_on_device",
  "only_on_device",
  "prefer_in_cloud",
  "only_in_cloud",
]);

export interface FirebaseClientServices {
  app: FirebaseApp;
  /** null when cloud AI is disabled (production build without App Check). */
  ai: AI | null;
  appCheck: AppCheck | null;
  remoteConfig: RemoteConfig | null;
}

export const APP_CHECK_NOT_CONFIGURED_MESSAGE =
  "App Check not configured: cloud AI disabled. On-device and offline rules still work.";

/**
 * Thrown instead of creating a Firebase AI Logic client when this build can't attest itself with
 * App Check (production build without VITE_RECAPTCHA_ENTERPRISE_SITE_KEY). Nothing was sent.
 */
export class CloudAiDisabledError extends Error {
  readonly reason = "appcheck-not-configured" as const;
  constructor() {
    super(APP_CHECK_NOT_CONFIGURED_MESSAGE);
    this.name = "CloudAiDisabledError";
  }
}

export function isCloudAiDisabledError(err: unknown): err is CloudAiDisabledError {
  return err instanceof CloudAiDisabledError || (err as { name?: unknown } | null)?.name === "CloudAiDisabledError";
}

declare global {
  interface WindowOrWorkerGlobalScope {
    FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
  }
}

function readEnv(key: string): string {
  if (
    typeof process !== "undefined" &&
    process.env?.VITEST &&
    key.startsWith("VITE_") &&
    Object.prototype.hasOwnProperty.call(process.env, key)
  ) {
    const p = process.env[key]; // guard:allow-env-credential — Vitest stubs for public Vite settings
    return typeof p === "string" ? p.trim() : "";
  }
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const val = env?.[key];
  return typeof val === "string" ? val.trim() : "";
}

export function getFirebaseConfig() {
  return {
    apiKey: readEnv("VITE_FIREBASE_API_KEY"),
    authDomain: readEnv("VITE_FIREBASE_AUTH_DOMAIN"),
    projectId: readEnv("VITE_FIREBASE_PROJECT_ID"),
    storageBucket: readEnv("VITE_FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: readEnv("VITE_FIREBASE_MESSAGING_SENDER_ID"),
    appId: readEnv("VITE_FIREBASE_APP_ID"),
  };
}

export function getDefaultCloudModel(): string {
  return readEnv("VITE_CLOUD_MODEL") || DEFAULT_CLOUD_MODEL;
}

/**
 * Client-only check: returns true in the browser when the required Firebase Web SDK
 * configuration variables are present so hybrid inference can run on the client.
 */
export function isFirebaseConfigured(): boolean {
  if (typeof window === "undefined") return false;
  const cfg = getFirebaseConfig();
  return Boolean(cfg.apiKey && cfg.projectId && cfg.appId);
}

let cachedServices: FirebaseClientServices | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;

export function getFirebaseServices(): FirebaseClientServices {
  if (typeof window === "undefined") {
    throw new Error("Firebase client SDK cannot be initialized on the server.");
  }
  if (cachedServices) return cachedServices;

  const firebaseConfig = getFirebaseConfig();
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId || !firebaseConfig.appId) {
    throw new Error(
      "Firebase is not configured. Set VITE_FIREBASE_API_KEY, VITE_FIREBASE_PROJECT_ID, and VITE_FIREBASE_APP_ID.",
    );
  }

  const existing = getApps()[0];
  const app = existing ?? initializeApp(firebaseConfig);

  const siteKey = readEnv("VITE_RECAPTCHA_ENTERPRISE_SITE_KEY");

  let appCheck: AppCheck | null = null;
  // Dev builds only: `import.meta.env.DEV` is the literal `false` in production builds, so this
  // branch and the debug-token helper are dropped from the production bundle.
  if (import.meta.env.DEV) {
    appCheck = initDevAppCheckDebugProvider(app, siteKey);
  }
  if (!appCheck && siteKey) {
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }

  // Production builds fail closed: without App Check there is no Firebase AI Logic client at all.
  // Dev builds without any App Check config keep the client (the backend rejects it when enforced).
  const ai = appCheck || !import.meta.env.PROD
    ? getAI(app, {
        backend: new GoogleAIBackend(),
        useLimitedUseAppCheckTokens: Boolean(appCheck),
      })
    : null;
  if (!ai) {
    console.warn(`[clause] ${APP_CHECK_NOT_CONFIGURED_MESSAGE} (VITE_RECAPTCHA_ENTERPRISE_SITE_KEY is not set.)`);
  }

  let remoteConfig: RemoteConfig | null = null;
  try {
    remoteConfig = getRemoteConfig(app);
    remoteConfig.settings.minimumFetchIntervalMillis = 5 * 60 * 1000;
    remoteConfig.defaultConfig = {
      parse_cloud_char_threshold: DEFAULT_CLOUD_CHAR_THRESHOLD,
      cloud_model: getDefaultCloudModel(),
      parse_mode: DEFAULT_STEP_MODES.contract,
      [STEP_MODE_KEYS.contract]: DEFAULT_STEP_MODES.contract,
      [STEP_MODE_KEYS.expense]: DEFAULT_STEP_MODES.expense,
      [STEP_MODE_KEYS.exception]: DEFAULT_STEP_MODES.exception,
      [STEP_MODE_KEYS.changeOrder]: DEFAULT_STEP_MODES.changeOrder,
      [STEP_MODE_KEYS.evidence]: DEFAULT_STEP_MODES.evidence,
    };
    void fetchAndActivate(remoteConfig).catch(() => {
      // Offline or unconfigured Remote Config falls back to defaultConfig seamlessly.
    });
  } catch {
    remoteConfig = null;
  }

  cachedServices = { app, ai, appCheck, remoteConfig };
  return cachedServices;
}

/** True when this build has no App Check provider, so the Firebase AI Logic client is never created. */
export function isCloudAiDisabled(): boolean {
  if (!isFirebaseConfigured()) return false;
  if (!import.meta.env.PROD) return false;
  return !readEnv("VITE_RECAPTCHA_ENTERPRISE_SITE_KEY");
}

/** The Firebase AI Logic client. Throws CloudAiDisabledError (nothing sent) when App Check is missing. */
export function getFirebaseAI(): AI {
  const { ai } = getFirebaseServices();
  if (!ai) throw new CloudAiDisabledError();
  return ai;
}

let cachedOnDeviceAI: AI | null = null;

/**
 * A client for ONLY_ON_DEVICE inference (Gemini Nano in Chrome) when cloud AI is disabled. On-device
 * inference never calls the backend, so it needs no App Check. Callers must only use it with
 * InferenceMode.ONLY_ON_DEVICE after Chrome reports the local model "available".
 */
export function getOnDeviceOnlyAI(): AI {
  if (cachedOnDeviceAI) return cachedOnDeviceAI;
  const { app, ai } = getFirebaseServices();
  cachedOnDeviceAI = ai ?? getAI(app, { backend: new GoogleAIBackend() });
  return cachedOnDeviceAI;
}

/**
 * Dev-only App Check debug provider. Never reached in production builds (see the
 * `import.meta.env.DEV` guard at the call site). Reads VITE_APPCHECK_DEBUG_TOKEN from .env.local.
 */
function initDevAppCheckDebugProvider(app: FirebaseApp, siteKey: string): AppCheck | null {
  if (!import.meta.env.DEV) return null;
  const debugToken = readEnv("VITE_APPCHECK_DEBUG_TOKEN");
  if (!debugToken || typeof self === "undefined") {
    if (!siteKey) {
      console.warn(
        "[clause] Firebase App Check skipped (dev): neither VITE_RECAPTCHA_ENTERPRISE_SITE_KEY nor VITE_APPCHECK_DEBUG_TOKEN is set.",
      );
    }
    return null;
  }
  (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
    debugToken === "true" ? true : debugToken;
  // Setting self.FIREBASE_APPCHECK_DEBUG_TOKEN activates Firebase App Check's built-in DebugProvider,
  // whichever provider is passed here.
  return initializeAppCheck(app, {
    provider: siteKey
      ? new ReCaptchaEnterpriseProvider(siteKey)
      : new CustomProvider({
          getToken: async () => {
            throw new Error("App Check debug token provider expected.");
          },
        }),
    isTokenAutoRefreshEnabled: true,
  });
}

export function getFirebaseAuth(): Auth | null {
  if (!isFirebaseConfigured()) return null;
  if (cachedAuth) return cachedAuth;
  try {
    cachedAuth = getAuth(getFirebaseServices().app);
    return cachedAuth;
  } catch {
    return null;
  }
}

export function getFirebaseDb(): Firestore | null {
  if (!isFirebaseConfigured()) return null;
  if (cachedDb) return cachedDb;
  try {
    cachedDb = getFirestore(getFirebaseServices().app);
    return cachedDb;
  } catch {
    return null;
  }
}

export function getRemoteConfigThreshold(
  key = "parse_cloud_char_threshold",
  fallback = DEFAULT_CLOUD_CHAR_THRESHOLD,
): number {
  const envOverride = Number(readEnv("VITE_PARSE_CLOUD_CHAR_THRESHOLD"));
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;
  if (!isFirebaseConfigured()) return fallback;
  try {
    const rc = getFirebaseServices().remoteConfig;
    if (!rc) return fallback;
    const n = getNumber(rc, key);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function getRemoteConfigString(key: string, fallback: string): string {
  if (!isFirebaseConfigured()) return fallback;
  try {
    const rc = getFirebaseServices().remoteConfig;
    if (!rc) return fallback;
    const val = getString(rc, key).trim();
    return val || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Strict private mode, chosen by the user on this device (Settings menu or `?ai=strict`). It forces
 * ONLY_ON_DEVICE for every AI step: nothing is sent to Firebase AI Logic or the Clause server for
 * inference, and if Chrome's on-device model isn't ready the step stops with "Nothing was sent."
 */
export const PRIVACY_MODE_STORAGE_KEY = "clause.privacyMode";
export const PRIVACY_MODE_EVENT = "clause:privacy-mode";
export type PrivacyMode = "hybrid" | "strict";

function localStore(): Storage | undefined {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function getLocalPrivacyMode(): PrivacyMode {
  try {
    return localStore()?.getItem(PRIVACY_MODE_STORAGE_KEY) === "strict" ? "strict" : "hybrid";
  } catch {
    return "hybrid";
  }
}

export function setLocalPrivacyMode(mode: PrivacyMode): void {
  const ls = localStore();
  if (!ls) return;
  try {
    if (mode === "strict") ls.setItem(PRIVACY_MODE_STORAGE_KEY, "strict");
    else ls.removeItem(PRIVACY_MODE_STORAGE_KEY);
    window.dispatchEvent?.(new Event(PRIVACY_MODE_EVENT));
  } catch {
    // Storage blocked: the mode simply doesn't persist.
  }
}

/** True when this step runs ONLY_ON_DEVICE (local strict mode or Remote Config). */
export function isStrictOnDevice(step: AiStep): boolean {
  return getRemoteConfigStepMode(step) === "only_on_device";
}

export function getRemoteConfigStepMode(
  step: AiStep,
  fallback: HybridMode = DEFAULT_STEP_MODES[step],
): HybridMode {
  if (getLocalPrivacyMode() === "strict") return "only_on_device";
  const raw = getRemoteConfigString(STEP_MODE_KEYS[step], fallback);
  if (VALID_HYBRID_MODES.has(raw as HybridMode)) {
    return raw as HybridMode;
  }
  if (step === "contract") {
    const legacy = getRemoteConfigString("parse_mode", fallback);
    if (VALID_HYBRID_MODES.has(legacy as HybridMode)) {
      return legacy as HybridMode;
    }
  }
  return fallback;
}

/** Reset cached client singletons (for unit tests). */
export function resetFirebaseServicesForTest(): void {
  cachedServices = null;
  cachedOnDeviceAI = null;
  cachedAuth = null;
  cachedDb = null;
}
