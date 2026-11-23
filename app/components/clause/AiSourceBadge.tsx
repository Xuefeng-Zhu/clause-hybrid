import { IconCloud, IconDeviceLaptop, IconListCheck, IconServer } from "@tabler/icons-react";

import { formatAiSource, type AiSourceDisplay } from "@/lib/hybrid-ai";
import { cn } from "@/lib/utils";

import { usePrivacyMode } from "./PrivacyModeControls";

export type AiSourceInfo = AiSourceDisplay;

const STYLES = {
  on_device: {
    Icon: IconDeviceLaptop,
    title: "Extracted on this device. The document was not sent anywhere.",
    cls: "border-[#CFE3D7] bg-[#EBF4EE] text-[#0F5C3F]",
  },
  in_cloud: {
    Icon: IconCloud,
    title: "Extracted by cloud Gemini through Firebase AI Logic.",
    cls: "border-[#D6DEEA] bg-[#EEF2F8] text-[#2D4A73]",
  },
  server: {
    Icon: IconServer,
    title: "The browser AI call was unavailable, so the Clause server ran the model. The text was sent to the server.",
    cls: "border-[#E3DCCF] bg-[#F6F1E8] text-[#6B4E1F]",
  },
  offline: {
    Icon: IconListCheck,
    title: "No model ran: the server used its deterministic offline rules for the bundled sample.",
    cls: "border-stone-300 bg-stone-100 text-stone-700",
  },
} as const;

/** "On-device · Gemini Nano · 840 ms", "Cloud · gemini-3.5-flash-lite · 2.1 s", "Server · gemini-3.8-flash · 3.2 s" or "Offline rules". */
export function AiSourceBadge({ info, className }: { info: AiSourceInfo; className?: string }) {
  const kind = info.parsedBy === "offline-fixture" ? "offline" : info.source;
  const style = STYLES[kind] ?? STYLES.in_cloud;
  const Icon = style.Icon;
  return (
    <span
      data-testid="ai-source-badge"
      data-ai-source={kind}
      title={style.title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        style.cls,
        className,
      )}
    >
      <Icon className="size-3.5" />
      {formatAiSource(info)}
    </span>
  );
}

/** Plain statement of what leaves the browser in the current mode. */
export function WhatLeavesThisDevice({ className }: { className?: string }) {
  const { mode } = usePrivacyMode();
  if (mode === "strict") {
    return (
      <p className={cn("text-[11px] leading-relaxed text-stone-500", className)} data-testid="what-leaves-strict">
        <span className="font-medium text-stone-700">Strict on-device mode:</span> the document is read only by
        Gemini Nano in this browser. It is never sent to Firebase AI Logic or the Clause server for reading, even if
        something fails; if the local model isn&rsquo;t ready you&rsquo;ll see &ldquo;Nothing was sent.&rdquo; Only the
        structured terms go to Clause when the job is created. Turn it off in the account menu.
      </p>
    );
  }
  return (
    <p className={cn("text-[11px] leading-relaxed text-stone-500", className)}>
      <span className="font-medium text-stone-700">What leaves this device:</span> only the structured terms
      (amounts, dates, milestones and the quoted clauses) after you choose to create the job. The full document is
      read on-device by Gemini Nano when your browser supports it; long documents or unsupported browsers send it to
      cloud Gemini through Firebase AI Logic. If neither can run, the text goes to the Clause server: in contest mode
      it only applies offline rules (no model runs); otherwise it reads it with its own Gemini key. The badge says
      which ran: On-device, Cloud, Server, or Offline rules.
    </p>
  );
}
