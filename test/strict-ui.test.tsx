// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tabler/icons-react", () => {
  const StubIcon = () => null;
  const names = ["IconArrowRight", "IconCheck", "IconFileText", "IconLoader2", "IconSparkles", "IconCloud", "IconDeviceLaptop", "IconListCheck", "IconServer", "IconX"];
  return Object.fromEntries(names.map((n) => [n, StubIcon]));
});

import { EmptyJobState } from "../app/components/clause/NewJobDialog";
import { OnDeviceNoticeActions } from "../app/components/clause/PrivacyModeControls";
import { ON_DEVICE_UNAVAILABLE_MESSAGE } from "../app/lib/hybrid-ai";

describe("strict on-device notice", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("says nothing was sent and offers to switch to hybrid", async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const setMode = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(EmptyJobState, {
          quoteText: "",
          onQuoteTextChange: () => {},
          onParse: () => {},
          busy: false,
          dialogOpen: false,
          offlineNotice: ON_DEVICE_UNAVAILABLE_MESSAGE,
          noticeActions: createElement(OnDeviceNoticeActions, {
            notice: ON_DEVICE_UNAVAILABLE_MESSAGE,
            privacyMode: { mode: "strict", setMode },
            canSaveDraft: false,
            onSaveDraft: () => {},
          }),
        }),
      );
    });
    expect(document.querySelector("[data-testid='offline-needs-connection']")?.textContent).toBe(
      "On-device model not available. Nothing was sent.",
    );
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Switch to hybrid"));
    expect(btn).toBeTruthy();
    await act(async () => btn!.click());
    expect(setMode).toHaveBeenCalledWith("hybrid");
  });

  it("offers Save draft for a document read offline", async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const onSaveDraft = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(OnDeviceNoticeActions, {
          notice: "Read on this device, but you're offline so it isn't saved yet. Nothing was sent. Reconnect and press Save draft.",
          privacyMode: { mode: "hybrid", setMode: () => {} },
          canSaveDraft: true,
          onSaveDraft,
        }),
      );
    });
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Save draft");
    await act(async () => btn!.click());
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });
});
