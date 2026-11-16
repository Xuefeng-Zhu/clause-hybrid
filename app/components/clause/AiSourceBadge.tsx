import { IconCloud, IconDeviceLaptop } from "@tabler/icons-react";

import { formatAiSource, type AiSource } from "@/lib/hybrid-ai";
import { cn } from "@/lib/utils";

export interface AiSourceInfo {
  source: AiSource;
  model: string;
  ms: number;
}

/** "On-device · Gemini Nano · 840 ms" or "Cloud · gemini-3.5-flash-lite · 2.1 s". */
export function AiSourceBadge({ info, className }: { info: AiSourceInfo; className?: string }) {
  const onDevice = info.source === "on_device";
  const Icon = onDevice ? IconDeviceLaptop : IconCloud;
  return (
    <span
      data-testid="ai-source-badge"
      title={onDevice ? "Extracted on this device. The document was not sent anywhere." : "Extracted by cloud Gemini through Firebase AI Logic."}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        onDevice ? "border-[#CFE3D7] bg-[#EBF4EE] text-[#0F5C3F]" : "border-[#D6DEEA] bg-[#EEF2F8] text-[#2D4A73]",
        className,
      )}
    >
      <Icon className="size-3.5" />
      {formatAiSource(info)}
    </span>
  );
}

/** Plain statement of what the server receives when the browser parses a document. */
export function WhatLeavesThisDevice({ className }: { className?: string }) {
  return (
    <p className={cn("text-[11px] leading-relaxed text-stone-500", className)}>
      <span className="font-medium text-stone-700">What leaves this device:</span> only the structured terms
      (amounts, dates, milestones and the quoted clauses) after you choose to create the job. The full document is
      read on-device by Gemini Nano when your browser supports it; long documents or unsupported browsers use cloud
      Gemini through Firebase AI Logic, and the badge says which ran.
    </p>
  );
}
