import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockIssuingGateway } from "../server/clause/airwallex/mock.js";
import { requirePolicyApprover } from "../server/clause/approvalAccess.js";
import { SAMPLE_QUOTE } from "../server/clause/fixtures.js";
import { MockMetalRail } from "../server/clause/metal/mock.js";
import type { MandatePayoutResult } from "../server/clause/metal/types.js";
import { ContractCardService } from "../server/clause/milestones/service.js";
import { MemoryJobStore } from "../server/clause/store/jobStore.js";

beforeEach(() => {
  vi.stubEnv("CLAUSE_CONTEST_MODE", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function pendingRelease() {
  const gateway = new MockIssuingGateway();
  const store = new MemoryJobStore();
  const metal = new MockMetalRail();
  const service = new ContractCardService(gateway, store, "contractor@example.com", metal);
  const draft = await service.createJob({ kind: "text", text: SAMPLE_QUOTE });
  await service.approveTerms(draft.id);
  const job = await service.submitProof(draft.id, [
    { filename: "cabinets.jpg", mediaType: "image/jpeg", base64: "AA==", declaredKind: "photos" },
  ]);
  const pending = job.pending!;
  const approval = {
    approval_id: pending.approval_id,
    milestone_id: pending.milestone_id!,
    amount: pending.amount!,
    currency: pending.currency,
    evidence_sha256: pending.evidence_sha256,
  };
  return { service, gateway, metal, store, job, approval };
}

describe("payout approval execution", () => {
  it("claims an approval once and returns the saved release on a repeat", async () => {
    const { service, gateway, store, metal, job, approval } = await pendingRelease();
    const updateCard = vi.spyOn(gateway, "updateCard");
    const deposit = vi.spyOn(gateway, "simulateDeposit");
    let notifyPayout!: () => void;
    const payoutStarted = new Promise<void>((resolve) => { notifyPayout = resolve; });
    let settlePayout!: (outcome: MandatePayoutResult) => void;
    const providerResponse = new Promise<MandatePayoutResult>((resolve) => { settlePayout = resolve; });
    const payout = vi.spyOn(metal, "payout").mockImplementation(async () => {
      notifyPayout();
      return providerResponse;
    });

    const concurrent = new ContractCardService(gateway, store, "contractor@example.com", metal);
    const releasing = service.approveRelease(job.id, approval);
    await payoutStarted;
    await expect(concurrent.approveRelease(job.id, approval)).rejects.toThrow(/in progress/);
    settlePayout({ outcome: "paid" });
    const released = await releasing;
    const sameApproval = await concurrent.approveRelease(job.id, approval);

    expect(sameApproval.completedReleases).toEqual([approval]);
    expect(sameApproval.releasedMilestoneIds).toEqual(released.releasedMilestoneIds);
    expect(payout).toHaveBeenCalledTimes(1);
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(deposit).toHaveBeenCalledTimes(1);
    await expect(concurrent.approveRelease(job.id, { ...approval, amount: 10 })).rejects.toThrow(/does not match/);
  });

  it("retains the payment reference and refuses to redispatch an ambiguous provider result", async () => {
    const { service, gateway, store, metal, job, approval } = await pendingRelease();
    const payout = vi.spyOn(metal, "payout").mockRejectedValue(new Error("Provider response was lost"));
    await expect(service.approveRelease(job.id, approval)).rejects.toThrow(/may have changed provider state/);

    const freshService = new ContractCardService(gateway, store, "contractor@example.com", metal);
    expect((await freshService.getJob(job.id)).releaseAttempt).toMatchObject({
      approval,
      stage: "payout",
      state: "needs_review",
      payment_id: `${job.id}-${approval.milestone_id}`,
    });
    await expect(freshService.approveRelease(job.id, approval)).rejects.toThrow(/requires provider reconciliation/);
    expect(payout).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale job save that could erase a saved approval claim", async () => {
    const { store, job, approval } = await pendingRelease();
    const stale = await store.get(job.id);
    const claimed = await store.get(job.id);
    claimed.releaseAttempt = {
      approval,
      payment_id: `${job.id}-${approval.milestone_id}`,
      started_at: new Date().toISOString(),
      stage: "card_controls",
      state: "running",
    };
    await store.save(claimed);
    await expect(store.save(stale)).rejects.toThrow(/job changed/);
    expect((await store.get(job.id)).releaseAttempt).toEqual(claimed.releaseAttempt);
  });
});

it("checks the authenticated identity against the configured policy managers", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("AUTH_DISABLED", "false");
  vi.stubEnv("CLAUSE_POLICY_APPROVER_EMAILS", " Owner@Example.test , other@example.test ");
  expect(() => runWithRequestContext({ userEmail: "employee@example.test" }, requirePolicyApprover)).toThrow(/requires a configured policy manager/);
  expect(runWithRequestContext({ userEmail: "owner@example.test" }, requirePolicyApprover)).toBe("owner@example.test");
});
