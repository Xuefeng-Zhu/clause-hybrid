import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  getLocalPrivacyMode,
  PRIVACY_MODE_EVENT,
  type PrivacyMode,
  setLocalPrivacyMode,
} from "@/lib/firebase";
import {
  ON_DEVICE_FAILED_MESSAGE,
  ON_DEVICE_UNAVAILABLE_MESSAGE,
  onDeviceAvailability,
  type OnDeviceAvailability,
} from "@/lib/hybrid-ai";

export interface PrivacyModeState {
  mode: PrivacyMode;
  setMode: (mode: PrivacyMode) => void;
}

/**
 * The device-local privacy mode. `?ai=strict` / `?ai=hybrid` in the URL sets it (handy for a judge
 * or a test browser); the Settings menu toggles it. Strict forces ONLY_ON_DEVICE for every AI step.
 */
export function usePrivacyMode(): PrivacyModeState {
  const [mode, setModeState] = useState<PrivacyMode>("hybrid");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const param = new URLSearchParams(window.location.search).get("ai");
      if (param === "strict" || param === "hybrid") setLocalPrivacyMode(param);
    } catch {
      // Ignore malformed URLs.
    }
    setModeState(getLocalPrivacyMode());
    const onChange = () => setModeState(getLocalPrivacyMode());
    window.addEventListener(PRIVACY_MODE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(PRIVACY_MODE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const setMode = useCallback((next: PrivacyMode) => {
    setLocalPrivacyMode(next);
    setModeState(getLocalPrivacyMode());
  }, []);

  return { mode, setMode };
}

type LanguageModelApi = {
  create: (opts: Record<string, unknown>) => Promise<{ destroy?: () => void }>;
};

/** Start Chrome's on-device model download. Must run from a click (user activation). */
async function downloadOnDeviceModel(onProgress: (pct: number) => void): Promise<void> {
  const LM = (globalThis as unknown as { LanguageModel?: LanguageModelApi }).LanguageModel;
  if (!LM?.create) throw new Error("This browser has no on-device model API.");
  const session = await LM.create({
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    monitor(m: EventTarget) {
      m.addEventListener("downloadprogress", (e) => {
        const loaded = (e as Event & { loaded?: number }).loaded ?? 0;
        onProgress(Math.round(loaded * 100));
      });
    },
  });
  session.destroy?.();
}

/**
 * Buttons under the intake notice: save a draft read offline (terms only), and, after a strict
 * on-device refusal, switch back to hybrid or download Chrome's model.
 */
export function OnDeviceNoticeActions({
  notice,
  privacyMode,
  canSaveDraft,
  onSaveDraft,
  onModeChanged,
}: {
  notice: string | null;
  privacyMode: PrivacyModeState;
  canSaveDraft: boolean;
  onSaveDraft: () => void;
  onModeChanged?: () => void;
}) {
  const strictNotice = notice === ON_DEVICE_UNAVAILABLE_MESSAGE || notice === ON_DEVICE_FAILED_MESSAGE;
  const [availability, setAvailability] = useState<OnDeviceAvailability | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!strictNotice) return;
    let alive = true;
    void onDeviceAvailability().then((a) => {
      if (alive) setAvailability(a);
    });
    return () => {
      alive = false;
    };
  }, [strictNotice, progress]);

  if (!canSaveDraft && !strictNotice) return null;

  const canDownload = availability === "downloadable" || availability === "downloading";

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="on-device-notice-actions">
      {canSaveDraft ? (
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={onSaveDraft}>
          Save draft
        </Button>
      ) : null}
      {strictNotice && privacyMode.mode === "strict" ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => {
            privacyMode.setMode("hybrid");
            onModeChanged?.();
          }}
        >
          Switch to hybrid (cloud allowed)
        </Button>
      ) : null}
      {strictNotice && canDownload ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={progress !== null && progress < 100}
          onClick={() => {
            setDownloadError(null);
            setProgress(0);
            downloadOnDeviceModel(setProgress)
              .then(() => setProgress(100))
              .catch((err: unknown) => {
                setProgress(null);
                setDownloadError(err instanceof Error ? err.message : "Download failed.");
              });
          }}
        >
          {progress === null
            ? "Download on-device model"
            : progress < 100
              ? `Downloading… ${progress}%`
              : "Model ready: read again"}
        </Button>
      ) : null}
      {downloadError ? <span className="text-rose-700">{downloadError}</span> : null}
    </div>
  );
}
