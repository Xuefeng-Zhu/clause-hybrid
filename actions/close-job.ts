import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getService, summarize } from "../server/clause/app.js";
import { assertSignedInApprover } from "../server/clause/approvalAccess.js";

export default defineAction({
  description: "OWNER DECISION: close the job and permanently close its card on Airwallex.",
  schema: z.object({ jobId: z.string() }),
  authorize: assertSignedInApprover,
  needsApproval: true,
  run: async ({ jobId }) => ({ summary: summarize(await (await getService()).closeJob(jobId)) }),
});
