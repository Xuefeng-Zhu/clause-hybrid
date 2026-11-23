import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

/**
 * Which job the workspace shows.
 *
 * The URL (`?job=`) is the source of truth. A job the user just created is not in
 * `list-jobs` until that query refetches, so it is held as `pendingJobId` and
 * honoured optimistically. Without this, the fallback to `jobs[0]` (and the
 * effect that rewrites the URL to match) snapped the view back to the
 * previously open job right after a new quote was read.
 */
export function resolveActiveJobId(
  urlJobId: string,
  jobIds: readonly string[],
  pendingJobId: string | null,
): string {
  if (urlJobId && (jobIds.includes(urlJobId) || urlJobId === pendingJobId)) {
    return urlJobId;
  }
  return jobIds[0] ?? "";
}

export function useJobSelection(opts: {
  jobIds: readonly string[];
  isLoading: boolean;
  refetchJobs?: () => unknown;
}) {
  const { jobIds, isLoading, refetchJobs } = opts;
  const [searchParams, setSearchParams] = useSearchParams();
  const urlJobId = searchParams.get("job")?.trim() || "";
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  const activeJobId = resolveActiveJobId(urlJobId, jobIds, pendingJobId);
  const jobIdsKey = jobIds.join("|");

  // Once the list knows the new job, it no longer needs special treatment.
  useEffect(() => {
    if (pendingJobId && jobIds.includes(pendingJobId)) setPendingJobId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJobId, jobIdsKey]);

  useEffect(() => {
    if (activeJobId && urlJobId !== activeJobId) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("job", activeJobId);
          return next;
        },
        { replace: true },
      );
    } else if (!activeJobId && urlJobId && !isLoading) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("job");
          return next;
        },
        { replace: true },
      );
    }
  }, [activeJobId, isLoading, setSearchParams, urlJobId]);

  /**
   * Select a job. `justCreated` marks it as known-to-exist even though the job
   * list may not contain it yet, and refetches the list.
   */
  const selectJob = useCallback(
    (jobId: string, selectOpts?: { justCreated?: boolean }) => {
      setPendingJobId(selectOpts?.justCreated ? jobId : null);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("job", jobId);
          return next;
        },
        { replace: true },
      );
      if (selectOpts?.justCreated) void refetchJobs?.();
    },
    [refetchJobs, setSearchParams],
  );

  const clearSelection = useCallback(() => {
    setPendingJobId(null);
    setSearchParams(new URLSearchParams(), { replace: true });
  }, [setSearchParams]);

  return { urlJobId, activeJobId, pendingJobId, selectJob, clearSelection };
}
