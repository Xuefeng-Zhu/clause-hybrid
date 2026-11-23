/**
 * Contest mode (CLAUSE_CONTEST_MODE=true).
 *
 * The Firebase AI Logic hackathon requires every generative-AI call to go through the Firebase AI
 * Logic hybrid SDK. That SDK runs in the browser (and the native apps); it has no server-side
 * hybrid API. So in contest mode the Clause server calls no model provider at all: no Gemini REST,
 * no Anthropic, and the agent chat is switched off. When the browser's Firebase AI Logic call can't
 * run, the server only offers its deterministic offline rules (badged "Offline rules").
 *
 * Off by default so the original app (server Gemini/Anthropic) still works outside the contest build.
 */
const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);

export function isContestMode(): boolean {
  const raw = process.env.CLAUSE_CONTEST_MODE; // guard:allow-no-env-credentials — deployment mode toggle, not a credential
  return TRUE_VALUES.has((raw ?? "").trim().toLowerCase());
}

export const CONTEST_MODE_NO_PROVIDER =
  "Contest mode: the Clause server calls no model provider. Generative AI runs only through Firebase AI Logic in the browser.";

export const CONTEST_MODE_OFFLINE_ONLY =
  "Firebase AI Logic couldn't run in this browser, and in contest mode the server uses no other model. Its offline rules only read the bundled sample quote.";

export const CONTEST_MODE_CHAT_DISABLED =
  "Clause chat is off in contest mode: it would call a model provider outside Firebase AI Logic.";

/** Throws when the server is about to reach a non-Firebase model provider in contest mode. */
export function assertServerModelAllowed(what = "server model call"): void {
  if (isContestMode()) throw new Error(`${CONTEST_MODE_NO_PROVIDER} (blocked: ${what})`);
}

/** Called by the agent chat before every model turn. */
export function assertAgentChatAllowed(): void {
  if (isContestMode()) throw new Error(CONTEST_MODE_CHAT_DISABLED);
}
