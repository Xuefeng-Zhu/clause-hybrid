// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tabler/icons-react", () => {
  const StubIcon = () => null;
  const names = [
    "IconAlertTriangle",
    "IconArrowRight",
    "IconCamera",
    "IconCheck",
    "IconCircleCheck",
    "IconCircleX",
    "IconClock",
    "IconCloud",
    "IconCreditCard",
    "IconDeviceLaptop",
    "IconFileDiff",
    "IconFileCheck",
    "IconFileText",
    "IconLoader2",
    "IconLock",
    "IconReceipt2",
    "IconShieldCheck",
    "IconSparkles",
    "IconUpload",
    "IconX",
  ];
  return Object.fromEntries(names.map((n) => [n, StubIcon]));
});

import { ActionBar } from "../app/components/clause/ActionBar";
import { ContractorPhone } from "../app/components/clause/ContractorPhone";
import { EmptyJobState } from "../app/components/clause/NewJobDialog";
import type { ClauseJob, JobSummary } from "../app/components/clause/clause-types";
import { NEEDS_CONNECTION_MESSAGE } from "../app/lib/hybrid-ai";
import { MockIssuingGateway } from "../server/clause/airwallex/mock";
import { POLICY_DEMO_CHARGES, SAMPLES, summarize } from "../server/clause/app";
import { config } from "../server/clause/config";
import { ContractCardService } from "../server/clause/milestones/service";
import { MemoryJobStore } from "../server/clause/store/jobStore";

describe("offline needs-connection UI notices", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders 'Needs a connection. Nothing was sent.' on intake and exception panels when offlineNotice is set", async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    config.anthropic.apiKey = undefined;
    const store = new MemoryJobStore();
    const svc = new ContractCardService(
      new MockIssuingGateway(),
      store,
      "priya.shah@acme-robotics.example",
    );
    let job = await svc.createJob({ kind: "text", text: SAMPLES.policy });
    job = await svc.approveTerms(job.id);
    const dinner = POLICY_DEMO_CHARGES.find((c) => c.key === "dinner")!;
    await svc.simulateCharge(job.id, {
      amount: dinner.amount,
      merchant_name: dinner.merchant_name,
      mcc: dinner.mcc,
    });
    job = (await store.get(job.id))!;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        createElement(
          "div",
          null,
          createElement(EmptyJobState, {
            quoteText: SAMPLES.policy,
            onQuoteTextChange: () => {},
            onParse: () => {},
            busy: false,
            dialogOpen: false,
            offlineNotice: NEEDS_CONNECTION_MESSAGE,
          }),
          createElement(ContractorPhone, {
            job: job as unknown as ClauseJob,
            summary: summarize(job) as unknown as JobSummary,
            charges: [],
            onSimulate: () => {},
            isFrozen: false,
            onClose: () => {},
            exceptionNote: "Dinner with Lone Star Logistics",
            onExceptionNoteChange: () => {},
            onRequestException: () => {},
            offlineNotice: NEEDS_CONNECTION_MESSAGE,
          }),
        ),
      );
    });

    const intakeAlert = document.querySelector("[data-testid='offline-needs-connection']");
    expect(intakeAlert?.textContent).toBe("Needs a connection. Nothing was sent.");

    const exceptionAlert = document.querySelector("[data-testid='exception-offline-needs-connection']");
    expect(exceptionAlert?.textContent).toBe("Needs a connection. Nothing was sent.");
  });

  it("renders AiSourceBadge on pending change order banner in ActionBar", async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    config.anthropic.apiKey = undefined;
    const svc = new ContractCardService(
      new MockIssuingGateway(),
      new MemoryJobStore(),
      "owner@example.com",
    );
    let contractJob = await svc.createJob({ kind: "text", text: SAMPLES.quote });
    contractJob = await svc.approveTerms(contractJob.id);
    contractJob = await svc.proposeChangeOrder(contractJob.id, undefined, {
      draft: {
        summary: "In-stock quartz adds $800 to M2.",
        milestone_amount_changes: [
          { milestone_id: "M2", delta_amount: 800, reason: "In-stock quartz" },
        ],
        new_deadline: "2026-12-23",
        requires_signed_change_order: true,
        source_quote: "We can do the in-stock quartz at +$800 for Milestone 2",
      },
      aiSource: { source: "in_cloud", model: "gemini-3.5-flash-lite", ms: 950 },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        createElement(ActionBar, {
          job: contractJob as unknown as ClauseJob,
          summary: summarize(contractJob) as unknown as JobSummary,
          busyLabel: null,
          onCancelBusy: () => {},
          onApproveTerms: () => {},
          proofSheetOpen: false,
          onProofSheetOpenChange: () => {},
          proofKind: "photos",
          onProofKindChange: () => {},
          proofInputRef: createRef<HTMLInputElement>(),
          stagedProofFiles: [],
          onStageSelectedFiles: () => {},
          onRemoveStagedFile: () => {},
          onSubmitProof: () => {},
          onApproveRelease: () => {},
          coSheetOpen: false,
          onCoSheetOpenChange: () => {},
          coEmailText: "",
          onCoEmailTextChange: () => {},
          onDraftChangeOrder: () => {},
          onApproveChangeOrder: () => {},
          onRejectPending: () => {},
        }),
      );
    });

    const badge = document.querySelector("[data-testid='ai-source-badge']");
    expect(badge?.textContent).toContain("Cloud · gemini-3.5-flash-lite · 950 ms");
  });
});
