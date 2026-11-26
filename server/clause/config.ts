import { fail } from "@agent-native/core/action";
import { prefetchSecrets, resolveSecretDetailed } from "@agent-native/core/server";
import { getRequestContext, type RequestContext } from "@agent-native/core/server/request-context";

import { isContestMode } from "./contest-mode.js";

export type AwxMode = "mock" | "sandbox";
export type MetalMode = "mock" | "testnet";

const envAwxClientId = process.env.AWX_CLIENT_ID || undefined; // guard:allow-env-credential — optional local/sandbox deploy fallback
const envAwxApiKey = process.env.AWX_API_KEY || undefined; // guard:allow-env-credential — optional local/sandbox deploy fallback
const envAwxCardholderId = process.env.AWX_CARDHOLDER_ID || undefined; // guard:allow-env-credential — optional local/sandbox deploy fallback
const hasEnvAwx = Boolean(envAwxClientId && envAwxApiKey);

export const config = {
  awx: {
    mode: (hasEnvAwx ? "sandbox" : "mock") as AwxMode,
    clientId: hasEnvAwx ? envAwxClientId! : "mock_client_id",
    apiKey: hasEnvAwx ? envAwxApiKey! : "mock_api_key",
    baseUrl: "https://api.sandbox.airwallex.com",
    cardholderId: envAwxCardholderId as string | undefined,
  },
  metal: {
    get mode(): MetalMode {
      return resolveMetalMode();
    },
    get dir(): string {
      return process.env.METAL_DIR || "/workspace/work/metal"; // guard:allow-env-credential — deploy-level directory outside repo
    },
    get cliPrefix(): string {
      return process.env.METAL_CLI_PREFIX || "/workspace/tools/metal"; // guard:allow-env-credential — deploy-level CLI installation prefix
    },
    get account(): string | undefined {
      return process.env.METAL_ACCOUNT || undefined; // guard:allow-env-credential — public principal account address on Metal testnet
    },
    get contractorAddress(): string | undefined {
      return process.env.METAL_CONTRACTOR_ADDRESS || undefined; // guard:allow-env-credential — public contractor address on Metal testnet
    },
    get rpcUrl(): string | undefined {
      return process.env.METAL_RPC_URL || undefined; // guard:allow-env-credential — deployment Metal testnet RPC endpoint
    },
  },
  gemini: {
    apiKey: (process.env.GEMINI_API_KEY || undefined) as string | undefined, // guard:allow-env-credential — deployment model key fallback
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash", // guard:allow-env-credential — model name
    // Used when the primary model is overloaded (429/5xx). Same key, different capacity pool.
    fallbackModels: (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.6-flash,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite") // guard:allow-env-credential — model names
      .split(",").map((m) => m.trim()).filter(Boolean),
  },
  anthropic: {
    apiKey: undefined as string | undefined,
    model: "claude-sonnet-4-5",
  },
  demo: {
    ownerEmail: "owner@example.com",
    contractorEmail: "contractor@example.com",
  },
};

export function resolveMetalMode(): MetalMode {
  const modeEnv = process.env.METAL_MODE; // guard:allow-env-credential — deployment mode toggle
  const rpcUrl = process.env.METAL_RPC_URL; // guard:allow-env-credential — deployment Metal testnet RPC endpoint
  const account = process.env.METAL_ACCOUNT; // guard:allow-env-credential — public principal account address on Metal testnet
  return modeEnv === "testnet" && Boolean(rpcUrl && account) ? "testnet" : "mock";
}

async function readScopedSecret(key: string): Promise<string | undefined> {
  const result = await resolveSecretDetailed(key).catch(() => ({ value: null, lookupFailed: true }));
  if (result.lookupFailed) {
    fail("Could not read saved provider credentials. Try again in a moment.", {
      statusCode: 503,
      errorCode: "credential_store_unavailable",
      details: { retryable: true },
    });
  }
  return result.value || undefined;
}

export type ProviderConfig = {
  readonly awx: Readonly<typeof config.awx>;
  readonly gemini: Readonly<typeof config.gemini>;
  readonly anthropic: Readonly<typeof config.anthropic>;
};

type RequestProviders = {
  loading: Promise<ProviderConfig>;
  value?: ProviderConfig;
};

const requestProviders = new WeakMap<RequestContext, RequestProviders>();

/** Resolve once for the active request. Unavailable credentials can be retried. */
export async function loadProviderConfig(): Promise<ProviderConfig> {
  const request = getRequestContext();
  if (!request?.userEmail) return config;

  const existing = requestProviders.get(request);
  if (existing) return existing.loading;

  const entry: RequestProviders = {
    loading: readProviderConfig().then(
      (value) => {
        entry.value = value;
        return value;
      },
      (error) => {
        requestProviders.delete(request);
        throw error;
      },
    ),
  };
  requestProviders.set(request, entry);
  return entry.loading;
}

/** Actions initialize the request before constructing a gateway or calling a model. */
export function getProviderConfig(): ProviderConfig {
  const request = getRequestContext();
  if (!request?.userEmail) return config;
  const configForRequest = requestProviders.get(request)?.value;
  if (!configForRequest) throw new Error("Clause provider configuration has not been resolved for this request.");
  return configForRequest;
}

async function readProviderConfig(): Promise<ProviderConfig> {
  const modelKeys = isContestMode() ? [] : ["GEMINI_API_KEY", "ANTHROPIC_API_KEY"];
  const keys = ["AWX_CLIENT_ID", "AWX_API_KEY", "AWX_CARDHOLDER_ID", ...modelKeys];
  await prefetchSecrets(keys).catch(() => undefined);
  const [clientId, apiKey, cardholderId, geminiKey, anthropicKey] =
    await Promise.all(keys.map(readScopedSecret));
  const sandbox = Boolean(clientId && apiKey);

  return {
    awx: {
      baseUrl: config.awx.baseUrl,
      mode: sandbox ? "sandbox" : "mock",
      clientId: sandbox ? clientId! : "mock_client_id",
      apiKey: sandbox ? apiKey! : "mock_api_key",
      cardholderId: sandbox ? cardholderId : undefined,
    },
    gemini: { ...config.gemini, apiKey: geminiKey },
    anthropic: { ...config.anthropic, apiKey: anthropicKey },
  };
}

export function assertSandboxCredentials({ baseUrl, clientId, apiKey }: Pick<ProviderConfig["awx"], "baseUrl" | "clientId" | "apiKey">): void {
  if (!clientId || !apiKey || clientId.startsWith("mock_") || apiKey.startsWith("mock_")) {
    throw new Error(
      "Airwallex sandbox mode needs AWX_CLIENT_ID and AWX_API_KEY configured in Settings › Secrets.",
    );
  }
  if (!baseUrl.includes("sandbox")) {
    throw new Error(`Refusing to run against non-sandbox base URL: ${baseUrl}`);
  }
}
