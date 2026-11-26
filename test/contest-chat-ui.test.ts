import { afterEach, describe, expect, it, vi } from "vitest";

import { loadChatAvailability } from "../app/lib/chat-availability.server";
import { loader as loadChatEntry } from "../app/routes/chat._index";
import { loader as loadChatThread } from "../app/routes/chat.$threadId";

vi.mock("@/components/chat/ChatHomeRedirect", () => ({ default: () => null }));
vi.mock("@/components/chat/ChatRouteContent", () => ({ default: () => null }));
vi.mock("../app/routes/home", () => ({ meta: () => [] }));

describe("contest mode chat availability", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("hides chat from the shell and redirects both direct chat routes to jobs", () => {
    vi.stubEnv("CLAUSE_CONTEST_MODE", "true");

    expect(loadChatAvailability()).toEqual({ chatEnabled: false });
    for (const load of [loadChatEntry, loadChatThread]) {
      const response = load();
      expect(response?.status).toBe(302);
      expect(response?.headers.get("location")).toBe("/home");
    }
  });

  it("allows the existing chat entry and thread routes outside contest mode", () => {
    vi.stubEnv("CLAUSE_CONTEST_MODE", "false");

    expect(loadChatAvailability()).toEqual({ chatEnabled: true });
    expect(loadChatEntry()).toBeNull();
    expect(loadChatThread()).toBeNull();
  });
});
