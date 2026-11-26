import type { IssuingTransaction, SimulatedDeposit } from "../airwallex/types.js";
import type { ChangeOrderProposal } from "../contract/changeOrder.js";
import type { ContractTerms } from "../contract/schema.js";
import type { ActivePolicyException, ExceptionProposal } from "../expense/exception.js";
import type { PolicyTerms } from "../expense/schema.js";
import type { JobMandateState } from "../metal/types.js";
import type { EvidenceVerdict } from "../milestones/evidence.js";
import type { CardRule } from "../policy/cardRules.js";
import type { DeclineExplanation } from "../policy/declineExplainer.js";

export type JobKind = "contract" | "policy";
export type JobStatus = "draft" | "active" | "closed";

/** An approval is bound to exactly what the owner saw. Changing any field invalidates it. */
export interface PendingApproval {
  approval_id: string;
  kind: "release_milestone" | "change_order" | "policy_exception";
  milestone_id?: string;
  amount?: number;
  currency: string;
  evidence_sha256?: string;
  verdict?: EvidenceVerdict;
  change_order?: ChangeOrderProposal;
  exception?: ExceptionProposal;
  /** Where the pending proposal/explanation was generated (Firebase AI Logic hybrid). */
  aiSource?: AiSourceInfo;
  created_at: string;
}

export interface ReleaseApproval {
  approval_id: string;
  milestone_id: string;
  amount: number;
  currency?: string;
  evidence_sha256?: string;
}

export interface ReleaseAttempt {
  approval: ReleaseApproval;
  payment_id: string;
  state: "running" | "needs_review";
  stage: "card_controls" | "mandate" | "payout";
  started_at: string;
}

/**
 * Where AI output came from. on_device / in_cloud: the browser (Firebase AI Logic hybrid).
 * server: the server's own model call (parsedBy names gemini or anthropic). offline: the offline
 * fixture / rules path (no model ran).
 */
export interface AiSourceInfo {
  source: "on_device" | "in_cloud" | "server" | "offline";
  model: string;
  ms: number;
  parsedBy?: "gemini" | "anthropic" | "offline-fixture";
}

export interface JobEvent {
  at: string;
  type:
    | "terms_parsed"
    | "terms_approved"
    | "card_issued"
    | "charge_approved"
    | "charge_declined"
    | "proof_submitted"
    | "release_approved"
    | "release_rejected"
    | "change_order_drafted"
    | "change_order_approved"
    | "exception_requested"
    | "exception_approved"
    | "exception_used"
    | "card_frozen"
    | "card_closed"
    | "mandate_issued"
    | "metal_payout"
    | "metal_refused"
    | "mandate_replaced"
    | "mandate_verified"
    | "treasury_deposit";
  detail: string;
  data?: unknown;
}

export interface Job {
  id: string;
  kind?: JobKind;
  status: JobStatus;
  terms: ContractTerms;
  policyTerms?: PolicyTerms;
  activeException?: ActivePolicyException;
  problems: string[];
  parsedBy: string;
  /** Where the terms were extracted when the browser parsed them (Firebase AI Logic hybrid). The raw document is not stored. */
  aiSource?: AiSourceInfo;
  cardholder_id?: string;
  card_id?: string;
  /** Last time a sandbox card's applied controls matched the plan. */
  card_controls_verified_at?: string;
  releasedMilestoneIds: string[];
  rules: CardRule[];
  mandate?: JobMandateState;
  deposits?: SimulatedDeposit[];
  pending?: PendingApproval;
  releaseAttempt?: ReleaseAttempt;
  completedReleases?: ReleaseApproval[];
  transactions: (IssuingTransaction & { explanation?: DeclineExplanation })[];
  events: JobEvent[];
  created_at?: string;
}

/** Where jobs live. The app uses SqlJobStore (drizzle); tests can use MemoryJobStore. */
export interface JobStore {
  get(id: string): Promise<Job>;
  list(): Promise<Job[]>;
  save(job: Job): Promise<Job>;
  reset(): Promise<void>;
}

export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, string>();
  private revisions = new WeakMap<Job, string>();

  private read(doc: string): Job {
    const job = JSON.parse(doc) as Job;
    this.revisions.set(job, doc);
    return job;
  }

  async get(id: string): Promise<Job> {
    const doc = this.jobs.get(id);
    if (!doc) throw new Error(`Job ${id} not found`);
    return this.read(doc);
  }
  async list(): Promise<Job[]> {
    return [...this.jobs.values()].map((doc) => this.read(doc));
  }
  async save(job: Job): Promise<Job> {
    if (this.jobs.get(job.id) !== this.revisions.get(job)) {
      throw new Error("The job changed. Refresh before retrying.");
    }
    const doc = JSON.stringify(job);
    this.jobs.set(job.id, doc);
    this.revisions.set(job, doc);
    return job;
  }
  async reset(): Promise<void> {
    if ([...this.jobs.values()].some((doc) => (JSON.parse(doc) as Job).releaseAttempt)) {
      throw new Error("Reconcile the outstanding release before resetting these jobs.");
    }
    this.jobs.clear();
  }
}
