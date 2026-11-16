import type { EventSubscription } from "expo-modules-core";

import ClauseHybridAiModule, {
  type ClauseHybridAiModuleEvents,
  type DownloadProgressEvent,
  type DownloadState,
  type GenerateTextResult,
  type HybridInferenceMode,
  type InferenceSource,
  type OnDeviceStatus,
  type ParseContractResult,
} from "./src/ClauseHybridAiModule";

export type {
  ClauseHybridAiModuleEvents,
  DownloadProgressEvent,
  DownloadState,
  GenerateTextResult,
  HybridInferenceMode,
  InferenceSource,
  OnDeviceStatus,
  ParseContractResult,
};

export async function getStatus(): Promise<OnDeviceStatus> {
  return ClauseHybridAiModule.getStatus();
}

export async function downloadModel(): Promise<void> {
  return ClauseHybridAiModule.downloadModel();
}

export function addDownloadListener(
  listener: (event: DownloadProgressEvent) => void,
): EventSubscription {
  return ClauseHybridAiModule.addListener("onDownload", listener);
}

export async function warmUp(): Promise<void> {
  return ClauseHybridAiModule.warmUp();
}

export async function parseContract(
  system: string,
  prompt: string,
  mode: HybridInferenceMode,
  cloudModel: string,
): Promise<ParseContractResult> {
  return ClauseHybridAiModule.parseContract(system, prompt, mode, cloudModel);
}

export async function generateText(
  prompt: string,
  mode: HybridInferenceMode,
  cloudModel: string,
): Promise<GenerateTextResult> {
  return ClauseHybridAiModule.generateText(prompt, mode, cloudModel);
}

export default ClauseHybridAiModule;
