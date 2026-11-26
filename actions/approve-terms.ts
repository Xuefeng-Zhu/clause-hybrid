import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getService, summarize } from "../server/clause/app.js";
import { assertSignedInApprover, requirePolicyApprover } from "../server/clause/approvalAccess.js";

export default defineAction({
  description: "OWNER APPROVAL: the owner confirms the extracted terms. Code then issues an Airwallex virtual card to the contractor whose controls are derived from the terms: limit = milestones released on signing, merchant-category allowlist from the allowed-spend clause, valid until the deadline. Only call this when the owner explicitly approves in the UI or says so in chat.",
  schema: z.object({ jobId: z.string() }),
  authorize: assertSignedInApprover,
  needsApproval: true,
  run: async ({ jobId }) => {
    const service = await getService();
    const terms = await service.getJob(jobId);
    if (terms.kind === "policy") requirePolicyApprover();
    const job = await service.approveTerms(jobId);
    return { summary: summarize(job), rules: job.rules };
  },
});
