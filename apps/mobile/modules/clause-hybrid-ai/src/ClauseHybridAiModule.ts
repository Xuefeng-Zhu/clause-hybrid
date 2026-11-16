import { NativeModule, requireNativeModule } from "expo-modules-core";

export type OnDeviceStatus = "unavailable" | "downloadable" | "downloading" | "available";

export type HybridInferenceMode =
  | "prefer_on_device"
  | "only_on_device"
  | "prefer_in_cloud"
  | "only_in_cloud";

export type InferenceSource = "on_device" | "in_cloud";

export type DownloadState = "started" | "progress" | "completed" | "failed";

export interface DownloadProgressEvent {
  state: DownloadState;
  bytes?: number;
  total?: number;
  error?: string;
}

export interface ParseContractResult {
  json: string;
  source: InferenceSource;
  model: string;
  ms: number;
}

export interface GenerateTextResult {
  text: string;
  source: InferenceSource;
  model: string;
  ms: number;
}

export type ClauseHybridAiModuleEvents = {
  onDownload: (event: DownloadProgressEvent) => void;
};

declare class ClauseHybridAiNativeModule extends NativeModule<ClauseHybridAiModuleEvents> {
  getStatus(): Promise<OnDeviceStatus>;
  downloadModel(): Promise<void>;
  warmUp(): Promise<void>;
  parseContract(
    system: string,
    prompt: string,
    mode: HybridInferenceMode,
    cloudModel: string,
  ): Promise<ParseContractResult>;
  generateText(
    prompt: string,
    mode: HybridInferenceMode,
    cloudModel: string,
  ): Promise<GenerateTextResult>;
}

export default requireNativeModule<ClauseHybridAiNativeModule>("ClauseHybridAi");
