/**
 * Browser-side milestone evidence evaluation via Firebase AI Logic hybrid inference.
 * Image inputs are downscaled in the browser to a single JPEG (max 768px) and evaluated
 * single-turn (default mode PREFER_IN_CLOUD). PDF proof is sent inline to cloud Gemini through
 * Firebase AI Logic (ONLY_IN_CLOUD); strict on-device mode refuses PDFs and sends nothing. Deterministic code checks missing evidence kinds
 * upfront before any model call and hashes the original files for release binding.
 */
import type { AI } from "firebase/ai";

import {
  EVIDENCE_SYSTEM,
  evidencePrompt,
  type PromptMilestoneContext,
} from "../../../shared/clause-ai/prompts.js";
import {
  checkMissingEvidenceKinds,
  EvidenceVerdict,
  validateEvidenceVerdict,
} from "../../../shared/clause-ai/validate.js";
import { logAiCall } from "../ai-log";
import { getRemoteConfigStepMode, isFirebaseConfigured } from "../firebase";
import {
  type AiSource,
  hybridGenerate,
  HybridSchemaError,
  type HybridMode,
  isNavigatorOffline,
  needsConnectionOffline,
  needsConnectionResult,
  type NeedsConnectionResult,
  type NothingSentResult,
  onDeviceFailedResult,
  strictOnDeviceBlock,
} from "../hybrid-ai";

export const MAX_EVIDENCE_IMAGE_DIM = 768;
export const DEFAULT_EVIDENCE_JPEG_QUALITY = 0.82;

export interface EvidenceInputFile {
  filename: string;
  mediaType: "image/jpeg" | "image/png" | "application/pdf";
  base64: string;
  declaredKind: string;
}

export interface DownscaledEvidenceJpeg {
  mimeType: "image/jpeg";
  base64: string;
  width: number;
  height: number;
}

export interface EvaluateEvidenceAiInfo {
  source: AiSource;
  model: string;
  ms: number;
}

export interface EvaluateEvidenceOptions<TFallback = unknown> {
  mode?: HybridMode;
  ai?: AI;
  downscale?: (file: EvidenceInputFile) => Promise<DownscaledEvidenceJpeg>;
  serverFallback?: () => Promise<TFallback>;
}

export type EvaluateEvidenceResult<TFallback = unknown> =
  | {
      status: "ok";
      verdict: EvidenceVerdict;
      /** The downscaled JPEG the model saw; absent for a PDF-only batch. */
      image?: DownscaledEvidenceJpeg;
      ai: EvaluateEvidenceAiInfo;
    }
  | {
      status: "fallback";
      fallback: TFallback;
      reason: string;
    }
  | NeedsConnectionResult
  | NothingSentResult;

export function chooseEvidenceMode(): HybridMode {
  return getRemoteConfigStepMode("evidence");
}

/** Pure proportional resize dimensions capped at maxDim (768px) on the longest side. */
export function computeScaledDimensions(
  width: number,
  height: number,
  maxDim = MAX_EVIDENCE_IMAGE_DIM,
): { width: number; height: number } {
  const safeW = Math.max(1, Math.round(width));
  const safeH = Math.max(1, Math.round(height));
  const longest = Math.max(safeW, safeH);
  if (longest <= maxDim) {
    return { width: safeW, height: safeH };
  }
  const scale = maxDim / longest;
  return {
    width: Math.max(1, Math.round(safeW * scale)),
    height: Math.max(1, Math.round(safeH * scale)),
  };
}

function estimateBase64Bytes(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * Downscale a browser image (JPEG or PNG) into a single JPEG capped at 768px max dimension.
 */
export async function downscaleImageToJpeg(
  file: Pick<EvidenceInputFile, "mediaType" | "base64">,
  maxDim = MAX_EVIDENCE_IMAGE_DIM,
  quality = DEFAULT_EVIDENCE_JPEG_QUALITY,
): Promise<DownscaledEvidenceJpeg> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("Browser image canvas is unavailable in this environment.");
  }
  const src = `data:${file.mediaType};base64,${file.base64}`;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not decode image for downscaling."));
    el.src = src;
  });

  const naturalW = img.naturalWidth || img.width || maxDim;
  const naturalH = img.naturalHeight || img.height || maxDim;
  const target = computeScaledDimensions(naturalW, naturalH, maxDim);

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for image downscaling.");
  }
  ctx.drawImage(img, 0, 0, target.width, target.height);

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
  if (!base64) {
    throw new Error("Canvas JPEG encoding returned empty output.");
  }

  return {
    mimeType: "image/jpeg",
    base64,
    width: target.width,
    height: target.height,
  };
}

export async function evaluateEvidenceInBrowser<TFallback = unknown>(
  milestone: PromptMilestoneContext,
  files: EvidenceInputFile[],
  opts: EvaluateEvidenceOptions<TFallback> = {},
): Promise<EvaluateEvidenceResult<TFallback>> {
  const mode = opts.mode ?? chooseEvidenceMode();
  const offline = isNavigatorOffline();

  // Never guess or contact server/cloud when offline and on-device is unavailable.
  if (await needsConnectionOffline(mode)) {
    return needsConnectionResult();
  }

  // Strict private mode: unless the on-device model is ready, stop here. No SDK call, no server.
  const strictBlock = await strictOnDeviceBlock(mode);
  if (strictBlock) return strictBlock;
  const strict = mode === "only_on_device";

  const runFallback = async (reason: string): Promise<EvaluateEvidenceResult<TFallback>> => {
    if (isNavigatorOffline()) {
      return needsConnectionResult();
    }
    // Strict mode never hands the document to the server (or any other model) after a failure.
    if (strict) {
      return reason === "missing-evidence-kinds"
        ? onDeviceFailedResult(reason, "This proof is missing a required file for the milestone. Nothing was sent.")
        : onDeviceFailedResult(reason);
    }
    const fallback = opts.serverFallback ? await opts.serverFallback() : (undefined as TFallback);
    return { status: "fallback", fallback, reason };
  };

  // Code pre-check: missing required evidence kinds stop before any model call.
  const missingKindsVerdict = checkMissingEvidenceKinds(milestone, files);
  if (missingKindsVerdict) {
    return runFallback("missing-evidence-kinds");
  }

  const unreadable = files.find((f) => estimateBase64Bytes(f.base64) < 64);
  if (unreadable) {
    return runFallback(`unreadable-evidence-file: ${unreadable.filename}`);
  }

  // Images are downscaled to one JPEG in the browser. PDFs go inline to cloud Gemini through
  // Firebase AI Logic (the on-device model can't read PDFs); never to a server model.
  const pdfs = files.filter((f) => f.mediaType === "application/pdf");
  const primaryImage = files.find(
    (f) => f.mediaType === "image/jpeg" || f.mediaType === "image/png",
  );
  if (pdfs.length && strict) {
    return onDeviceFailedResult(
      "pdf-needs-cloud",
      "The on-device model can't read PDF proof. Nothing was sent.",
    );
  }
  if (pdfs.length && offline) {
    return needsConnectionResult();
  }
  if (!pdfs.length && !primaryImage) {
    return runFallback("non-image-evidence");
  }

  const available = Boolean(opts.ai) || isFirebaseConfigured();
  if (!available) {
    return runFallback("firebase-unavailable");
  }

  let downscaled: DownscaledEvidenceJpeg | undefined;
  if (primaryImage) {
    try {
      downscaled = opts.downscale
        ? await opts.downscale(primaryImage)
        : await downscaleImageToJpeg(primaryImage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "image-downscale-failed";
      return runFallback(`image-downscale-failed: ${msg}`);
    }
  }

  const effectiveMode: HybridMode = pdfs.length
    ? "only_in_cloud"
    : offline && !opts.ai
      ? "only_on_device"
      : mode;

  try {
    const r = await hybridGenerate({
      system: EVIDENCE_SYSTEM,
      prompt: evidencePrompt(milestone, files),
      ...(downscaled ? { image: { mimeType: "image/jpeg" as const, base64: downscaled.base64 } } : {}),
      ...(pdfs.length
        ? { files: pdfs.map((f) => ({ mimeType: "application/pdf" as const, base64: f.base64 })) }
        : {}),
      schema: EvidenceVerdict,
      step: "evidence",
      mode: effectiveMode,
      ...(opts.ai ? { ai: opts.ai } : {}),
    });

    const validation = validateEvidenceVerdict(r.value);
    void logAiCall({
      step: "evidence",
      mode: effectiveMode,
      inferenceSource: r.source,
      latencyMs: r.ms,
      validatorOk: validation.ok,
    });
    if (!validation.ok || !validation.verdict) {
      return runFallback(`evidence-validation-failed: ${validation.errors.join("; ")}`);
    }

    return {
      status: "ok",
      verdict: validation.verdict,
      ...(downscaled ? { image: downscaled } : {}),
      ai: { source: r.source, model: r.model, ms: r.ms },
    };
  } catch (err) {
    if (err instanceof HybridSchemaError) {
      void logAiCall({
        step: "evidence",
        mode: effectiveMode,
        inferenceSource: err.source,
        latencyMs: err.ms,
        validatorOk: false,
      });
      return runFallback(`evidence-schema-failed: ${err.message}`);
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    return runFallback(`evidence-inference-failed: ${msg}`);
  }
}
