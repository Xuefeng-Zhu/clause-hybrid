import { fail } from "@agent-native/core/action";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/index.js";
import { jobs } from "../../db/schema.js";
import type { Job, JobStore } from "./jobStore.js";

function requireOwnerEmail(): string {
  const ownerEmail = getRequestUserEmail();
  if (!ownerEmail) fail("Not authenticated", { statusCode: 401 });
  return ownerEmail;
}

export class SqlJobStore implements JobStore {
  private revisions = new WeakMap<Job, string>();

  private read(doc: string): Job {
    const job = JSON.parse(doc) as Job;
    this.revisions.set(job, doc);
    return job;
  }

  async get(id: string): Promise<Job> {
    const ownerEmail = requireOwnerEmail();
    const [row] = await getDb()
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.ownerEmail, ownerEmail)));
    if (!row) throw new Error(`Job ${id} not found`);
    return this.read(row.doc);
  }

  async list(): Promise<Job[]> {
    const ownerEmail = requireOwnerEmail();
    const rows = await getDb()
      .select()
      .from(jobs)
      .where(eq(jobs.ownerEmail, ownerEmail))
      .orderBy(desc(jobs.createdAt))
      .limit(100);
    return rows.map((r) => this.read(r.doc));
  }

  async save(job: Job): Promise<Job> {
    const ownerEmail = requireOwnerEmail();
    const now = new Date().toISOString();
    job.created_at ??= now;
    const values = {
      id: job.id,
      ownerEmail,
      status: job.status,
      contractRef:
        (job.kind === "policy" ? job.policyTerms?.policy_ref : job.terms.contract_ref) ??
        job.terms.contract_ref,
      cardId: job.card_id ?? "",
      doc: JSON.stringify(job),
      createdAt: job.created_at,
      updatedAt: now,
    };
    const revision = this.revisions.get(job);
    const updated = revision === undefined
      ? await getDb().insert(jobs).values(values).onConflictDoNothing().returning({ id: jobs.id })
      : await getDb().update(jobs).set({
          status: values.status,
          contractRef: values.contractRef,
          cardId: values.cardId,
          doc: values.doc,
          updatedAt: now,
        })
        .where(and(eq(jobs.id, job.id), eq(jobs.ownerEmail, ownerEmail), eq(jobs.doc, revision)))
        .returning({ id: jobs.id });
    if (updated.length !== 1) fail("The job changed. Refresh before retrying.", { statusCode: 409 });
    this.revisions.set(job, values.doc);
    return job;
  }

  async reset(): Promise<void> {
    const ownerEmail = requireOwnerEmail();
    await getDb().transaction(async (tx) => {
      const ownedJobs = await tx.select({ id: jobs.id, doc: jobs.doc }).from(jobs)
        .where(eq(jobs.ownerEmail, ownerEmail)).for("update");
      if (ownedJobs.some(({ doc }) => (JSON.parse(doc) as Job).releaseAttempt)) {
        fail("Reconcile the outstanding release before resetting these jobs.", { statusCode: 409 });
      }
      if (ownedJobs.length) {
        await tx.delete(jobs).where(and(
          eq(jobs.ownerEmail, ownerEmail),
          inArray(jobs.id, ownedJobs.map(({ id }) => id)),
        ));
      }
    });
  }
}
