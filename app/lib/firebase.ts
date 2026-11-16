import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import { type AI, getAI, GoogleAIBackend } from "firebase/ai";
import {
  type AppCheck,
  CustomProvider,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";
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
  ai: AI;
  appCheck: AppCheck | null;
  remoteConfig: RemoteConfig | null;
}

declare global {
  interface WindowOrWorkerGlobalScope {
    FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
  }
}

function readEnv(key: string): string {
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
  const debugToken = readEnv("VITE_APPCHECK_DEBUG_TOKEN");

  if (debugToken && typeof self !== "undefined") {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      debugToken === "true" ? true : debugToken;
  }

  let appCheck: AppCheck | null = null;
  if (siteKey) {
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } else if (debugToken) {
    // Setting self.FIREBASE_APPCHECK_DEBUG_TOKEN activates Firebase App Check's built-in DebugProvider.
    appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          throw new Error("App Check debug token provider expected.");
        },
      }),
      isTokenAutoRefreshEnabled: true,
    });
  } else {
    console.warn(
      "[clause] Firebase App Check skipped: neither VITE_RECAPTCHA_ENTERPRISE_SITE_KEY nor VITE_APPCHECK_DEBUG_TOKEN is set.",
    );
  }

  const ai = getAI(app, {
    backend: new GoogleAIBackend(),
    useLimitedUseAppCheckTokens: Boolean(appCheck),
  });

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

export function getFirebaseAI(): AI {
  return getFirebaseServices().ai;
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

export function getRemoteConfigStepMode(
  step: AiStep,
  fallback: HybridMode = DEFAULT_STEP_MODES[step],
): HybridMode {
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
}
