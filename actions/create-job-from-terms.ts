import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getService, summarize } from "../server/clause/app.js";

export default defineAction({
  description:
    "Create a DRAFT job from contract or policy terms that were already extracted in the browser by Firebase AI Logic (on-device Gemini Nano or cloud Gemini). The raw document is NOT sent or stored; the server re-validates the structured terms deterministically. Nothing is issued until owner/manager approval.",
  schema: z.object({
    kind: z.enum(["contract", "policy"]),
    terms: z.unknown().optional().describe("ContractTerms JSON when kind=contract"),
    policyTerms: z.unknown().optional().describe("PolicyTerms JSON when kind=policy"),
    aiSource: z.object({
      source: z.enum(["on_device", "in_cloud"]),
      model: z.string().min(1).max(80),
      ms: z.number().int().nonnegative(),
    }),
  }),
  run: async (input) => {
    const job = await (await getService()).createJobFromTerms(input);
    return {
      summary: summarize(job),
      kind: job.kind ?? "contract",
      terms: job.terms,
      policyTerms: job.policyTerms ?? null,
      problems: job.problems,
      parsedBy: job.parsedBy,
      aiSource: job.aiSource ?? null,
    };
  },
});
