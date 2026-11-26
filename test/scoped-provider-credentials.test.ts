import { prefetchSecrets, resolveSecretDetailed } from "@agent-native/core/server";
import { getRequestUserEmail, runWithRequestContext } from "@agent-native/core/server/request-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AirwallexClient } from "../server/clause/airwallex/client.js";
import { loadProviderConfig } from "../server/clause/config.js";
import { callTool, llmProvider } from "../server/clause/llm.js";

vi.mock("@agent-native/core/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agent-native/core/server")>()),
  prefetchSecrets: vi.fn(),
  resolveSecretDetailed: vi.fn(),
}));

const seller = "seller@example.test";
const buyer = "buyer@example.test";
const missing = { value: null, lookupFailed: false } as const;
const tool = {
  system: "Use the test tool.",
  content: "fixture",
  toolName: "fixture",
  description: "Extract a fixture.",
  schema: { type: "object" },
  maxTokens: 100,
};

beforeEach(() => {
  vi.stubEnv("CLAUSE_CONTEST_MODE", "false");
  vi.mocked(prefetchSecrets).mockResolvedValue(undefined);
  vi.mocked(resolveSecretDetailed).mockResolvedValue(missing);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("request-scoped provider credentials", () => {
  it("keeps model retries and Airwallex requests within each overlapping identity", async () => {
    vi.mocked(resolveSecretDetailed).mockImplementation(async (key) => {
      const email = getRequestUserEmail();
      if (email !== seller && email !== buyer) return missing;
      return { value: `${email}/${key}`, lookupFailed: false, source: "user", scopeId: email };
    });

    const modelKeys: (string | null)[] = [];
    const sandboxKeys: { client: string | null; key: string | null }[] = [];
    let markSellerStarted!: () => void;
    const sellerStarted = new Promise<void>((resolve) => { markSellerStarted = resolve; });
    let finishSellerRequest!: (response: Response) => void;
    const firstSellerResponse = new Promise<Response>((resolve) => { finishSellerRequest = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const modelKey = headers.get("x-goog-api-key");
      if (modelKey) {
        modelKeys.push(modelKey);
        if (modelKeys.length === 1) {
          markSellerStarted();
          return firstSellerResponse;
        }
        return Response.json({ candidates: [{ content: { parts: [{ functionCall: { args: { ok: true } } }] } }] });
      }
      sandboxKeys.push({ client: headers.get("x-client-id"), key: headers.get("x-api-key") });
      return Response.json({ token: "fixture-token" });
    }));

    const sellerRequest = runWithRequestContext({ userEmail: seller }, async () => {
      await loadProviderConfig();
      const airwallex = new AirwallexClient();
      const result = await callTool(tool);
      await airwallex.login();
      return result;
    });
    await sellerStarted;

    const buyerResult = await runWithRequestContext({ userEmail: buyer }, async () => {
      await loadProviderConfig();
      await new AirwallexClient().login();
      return callTool(tool);
    });
    await runWithRequestContext({ userEmail: "no-keys@example.test" }, async () => {
      expect((await loadProviderConfig()).awx.mode).toBe("mock");
      expect(llmProvider()).toBeUndefined();
    });
    finishSellerRequest(Response.json({ error: { message: "busy" } }, { status: 503 }));

    expect(buyerResult).toEqual({ ok: true });
    expect(await sellerRequest).toEqual({ ok: true });
    expect(modelKeys).toEqual([`${seller}/GEMINI_API_KEY`, `${buyer}/GEMINI_API_KEY`, `${seller}/GEMINI_API_KEY`]);
    expect(sandboxKeys).toEqual([
      { client: `${buyer}/AWX_CLIENT_ID`, key: `${buyer}/AWX_API_KEY` },
      { client: `${seller}/AWX_CLIENT_ID`, key: `${seller}/AWX_API_KEY` },
    ]);
  });

  it("keeps an unreadable vault retryable and uses a permitted deployment fallback after recovery", async () => {
    vi.mocked(resolveSecretDetailed).mockImplementation(async (key) => key === "GEMINI_API_KEY"
      ? { value: "deployment-model-key", lookupFailed: true, source: "env" }
      : missing);

    await runWithRequestContext({ userEmail: seller }, async () => {
      await expect(loadProviderConfig()).rejects.toMatchObject({
        statusCode: 503,
        errorCode: "credential_store_unavailable",
        details: { retryable: true },
      });
      vi.mocked(resolveSecretDetailed).mockImplementation(async (key) => key === "GEMINI_API_KEY"
        ? { value: "deployment-model-key", lookupFailed: false, source: "env" }
        : missing);

      const [first, second] = await Promise.all([loadProviderConfig(), loadProviderConfig()]);
      expect(second).toBe(first);
      expect(first.gemini.apiKey).toBe("deployment-model-key");
      expect(vi.mocked(resolveSecretDetailed).mock.calls.filter(([key]) => key === "GEMINI_API_KEY")).toHaveLength(2);
    });
  });

  it("skips direct model credential reads in contest mode", async () => {
    vi.stubEnv("CLAUSE_CONTEST_MODE", "true");

    await runWithRequestContext({ userEmail: seller }, async () => {
      await loadProviderConfig();
      expect(llmProvider()).toBeUndefined();
      expect(vi.mocked(resolveSecretDetailed).mock.calls.map(([key]) => key)).toEqual([
        "AWX_CLIENT_ID", "AWX_API_KEY", "AWX_CARDHOLDER_ID",
      ]);
    });
  });
});
