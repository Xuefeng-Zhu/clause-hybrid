// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveActiveJobId,
  useJobSelection,
} from "../app/components/clause/use-job-selection";

describe("resolveActiveJobId", () => {
  it("uses the URL job when the list has it", () => {
    expect(resolveActiveJobId("job_b", ["job_a", "job_b"], null)).toBe("job_b");
  });
  it("falls back to the first job for an unknown URL job", () => {
    expect(resolveActiveJobId("job_x", ["job_a", "job_b"], null)).toBe("job_a");
  });
  it("honours a just-created job that the stale list does not contain yet", () => {
    expect(resolveActiveJobId("job_new", ["job_a"], "job_new")).toBe("job_new");
  });
  it("returns empty with no jobs and no URL job", () => {
    expect(resolveActiveJobId("", [], null)).toBe("");
  });
});

type Api = ReturnType<typeof useJobSelection> & { search: string };

describe("useJobSelection: new job stays selected while list-jobs is stale", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
  });

  function mount(initialJobIds: string[], initialUrl: string) {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const api: { current: Api | null } = { current: null };
    const refetchJobs = vi.fn();
    let jobIds = initialJobIds;

    function Harness() {
      const sel = useJobSelection({ jobIds, isLoading: false, refetchJobs });
      const loc = useLocation();
      api.current = { ...sel, search: loc.search };
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = () =>
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: [initialUrl] },
          createElement(Harness),
        ),
      );
    act(render);
    return {
      api,
      refetchJobs,
      setJobs(next: string[]) {
        jobIds = next;
        act(render);
      },
    };
  }

  it("selects the new job at once and does not snap back to the open job", () => {
    const h = mount(["job_first", "job_old"], "/?job=job_old");
    expect(h.api.current!.activeJobId).toBe("job_old");

    // Read quote created job_new; list-jobs has not refetched yet.
    act(() => h.api.current!.selectJob("job_new", { justCreated: true }));
    expect(h.api.current!.activeJobId).toBe("job_new");
    expect(h.api.current!.search).toBe("?job=job_new");
    expect(h.refetchJobs).toHaveBeenCalledTimes(1);

    // A re-render with the same stale list must not rewrite the URL.
    h.setJobs(["job_first", "job_old"]);
    expect(h.api.current!.activeJobId).toBe("job_new");
    expect(h.api.current!.search).toBe("?job=job_new");

    // The list catches up: still on the new job, pending cleared.
    h.setJobs(["job_new", "job_first", "job_old"]);
    expect(h.api.current!.activeJobId).toBe("job_new");
    expect(h.api.current!.search).toBe("?job=job_new");
    expect(h.api.current!.pendingJobId).toBeNull();
  });

  it("works from the empty state (no jobs yet)", () => {
    const h = mount([], "/");
    act(() => h.api.current!.selectJob("job_new", { justCreated: true }));
    expect(h.api.current!.activeJobId).toBe("job_new");
    expect(h.api.current!.search).toBe("?job=job_new");
  });

  it("a plain selection of an unknown job still falls back to the list", () => {
    const h = mount(["job_first", "job_old"], "/?job=job_old");
    act(() => h.api.current!.selectJob("job_gone"));
    expect(h.api.current!.activeJobId).toBe("job_first");
    expect(h.api.current!.search).toBe("?job=job_first");
  });

  it("switching jobs from the menu clears a pending new job", () => {
    const h = mount(["job_first", "job_old"], "/?job=job_old");
    act(() => h.api.current!.selectJob("job_new", { justCreated: true }));
    act(() => h.api.current!.selectJob("job_first"));
    expect(h.api.current!.pendingJobId).toBeNull();
    expect(h.api.current!.search).toBe("?job=job_first");
  });

  it("clearSelection empties the URL", () => {
    const h = mount(["job_first"], "/?job=job_first");
    act(() => h.api.current!.selectJob("job_new", { justCreated: true }));
    act(() => h.api.current!.clearSelection());
    // Fallback then re-selects the first listed job, as before.
    expect(h.api.current!.pendingJobId).toBeNull();
    expect(h.api.current!.activeJobId).toBe("job_first");
  });
});
