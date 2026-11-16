import { describe, expect, it } from "vitest";

import {
  deterministicDeclineText,
  validateDeclineExplanation,
  type DeclineFacts,
} from "../app/lib/clause-ai/decline";

const facts: DeclineFacts = {
  merchant_name: "Builders Supply Co.",
  amount: 6000,
  currency: "USD",
  failure_reason: "LIMIT_EXCEEDED",
  headline: "Declined USD 6,000.00 at Builders Supply Co. (Hardware): it would exceed the funds released so far.",
  clause_id: "§1.1",
  clause_quote: "Funds are released per milestone.",
};

describe("decline explanation validator", () => {
  it("accepts an explanation that only uses given numbers", () => {
    const r = validateDeclineExplanation(
      "The $6,000 charge at Builders Supply Co. was blocked because it is more than the funds released so far under §1.1.",
      facts,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects invented amounts", () => {
    const r = validateDeclineExplanation("Only $4,500 can be spent until milestone 2.", facts);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/4500/);
  });

  it("rejects promises that money will move", () => {
    const r = validateDeclineExplanation("Don't worry, the charge will be approved tomorrow.", facts);
    expect(r.ok).toBe(false);
  });

  it("deterministic text includes the clause quote", () => {
    expect(deterministicDeclineText(facts)).toContain("Funds are released per milestone.");
  });
});
