import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getService, SAMPLES, summarize } from "../server/clause/app.js";
import { RawModelChangeOrder } from "../shared/clause-ai/validate.js";

export default defineAction({
  description: "Read a contractor email against the current terms and draft a change order (new milestone amounts and/or deadline, with the verbatim source sentence). Creates a PENDING change-order approval; the card does not change until the owner approves. useSample=true loads the bundled quartz-substitution email.",
  schema: z.object({
    jobId: z.string(),
    emailText: z.string().optional(),
    useSample: z.boolean().optional(),
    draft: RawModelChangeOrder.optional(),
    aiSource: z
      .object({
        source: z.enum(["on_device", "in_cloud"]),
        model: z.string(),
        ms: z.number(),
      })
      .optional(),
  }),
  run: async ({ jobId, emailText, useSample, draft, aiSource }) => {
    const resolvedEmail = emailText ?? (useSample ? SAMPLES.changeOrderEmail : draft ? undefined : SAMPLES.changeOrderEmail);
    const job = await (await getService()).proposeChangeOrder(
      jobId,
      resolvedEmail,
      draft && aiSource ? { draft, aiSource } : undefined,
    );
    return { summary: summarize(job), pending: job.pending };
  },
});
