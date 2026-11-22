import { StatusBar } from "expo-status-bar";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  addDownloadListener,
  downloadModel,
  extractErrorDetails,
  formatAiBadge,
  getStatus,
  NANO_CHAR_THRESHOLD,
  parseQuoteOnPhone,
  warmUp,
  type DownloadProgressEvent,
  type HybridInferenceMode,
  type OnDeviceStatus,
  type PhoneParseResult,
} from "./src/ai/clauseAi";
import {
  describeSharedFields,
  shareTerms,
  type ShareTermsResponse,
} from "./src/api/clauseServer";
import { SAMPLE_QUOTE } from "./src/samples/quote";

type UiModeOption = {
  mode: HybridInferenceMode;
  label: string;
};

const MODE_OPTIONS: UiModeOption[] = [
  { mode: "prefer_on_device", label: "Prefer on-device" },
  { mode: "only_on_device", label: "On-device only" },
  { mode: "only_in_cloud", label: "Cloud only" },
];

function formatMoney(amount: number, currency: string): string {
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency.toUpperCase()} ${formatted}`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const [modelStatus, setModelStatus] = useState<OnDeviceStatus>("unavailable");
  const [downloadEvent, setDownloadEvent] = useState<DownloadProgressEvent | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  const [quoteText, setQuoteText] = useState<string>(SAMPLE_QUOTE);
  const [selectedMode, setSelectedMode] = useState<HybridInferenceMode>("prefer_on_device");

  const [isParsing, setIsParsing] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [parseResult, setParseResult] = useState<PhoneParseResult | null>(null);
  const [nativeError, setNativeError] = useState<{ code?: string; message: string } | null>(null);

  const [isSharing, setIsSharing] = useState(false);
  const [shareResponse, setShareResponse] = useState<ShareTermsResponse | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  const busySlotRef = useRef(false);

  useEffect(() => {
    let mounted = true;

    const subscription = addDownloadListener((evt) => {
      if (!mounted) return;
      setDownloadEvent(evt);
      if (evt.state === "started" || evt.state === "progress") {
        setModelStatus("downloading");
      } else if (evt.state === "completed") {
        setIsDownloading(false);
        setModelStatus("available");
        void warmUp();
      } else if (evt.state === "failed") {
        setIsDownloading(false);
        if (evt.error) {
          setNativeError({ code: "DOWNLOAD_FAILED", message: evt.error });
        }
      }
    });

    (async () => {
      try {
        const status = await getStatus();
        if (!mounted) return;
        setModelStatus(status);
        if (status === "available") {
          void warmUp();
        }
      } catch {
        if (mounted) {
          setModelStatus("unavailable");
        }
      }
    })();

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!isParsing) return;
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const id = setInterval(() => {
      setElapsedSeconds((Date.now() - startedAt) / 1000);
    }, 100);
    return () => clearInterval(id);
  }, [isParsing]);

  async function handleDownloadModel() {
    if (isDownloading || busySlotRef.current) return;
    setIsDownloading(true);
    setNativeError(null);
    setModelStatus("downloading");
    try {
      await downloadModel();
      const updated = await getStatus();
      setModelStatus(updated);
      if (updated === "available") {
        void warmUp();
      }
    } catch (err) {
      setNativeError(extractErrorDetails(err));
      try {
        setModelStatus(await getStatus());
      } catch {
        setModelStatus("unavailable");
      }
    } finally {
      setIsDownloading(false);
    }
  }

  async function handleParse() {
    if (busySlotRef.current) return;
    busySlotRef.current = true;
    setIsParsing(true);
    setNativeError(null);
    setShareResponse(null);
    setShareError(null);

    try {
      const res = await parseQuoteOnPhone(quoteText, selectedMode);
      setParseResult(res);
    } catch (err) {
      setParseResult(null);
      setNativeError(extractErrorDetails(err));
    } finally {
      setIsParsing(false);
      busySlotRef.current = false;
    }
  }

  async function handleShare() {
    if (!parseResult || parseResult.problems.length > 0 || busySlotRef.current) return;
    busySlotRef.current = true;
    setIsSharing(true);
    setShareError(null);
    setShareResponse(null);

    try {
      const created = await shareTerms(parseResult.terms, parseResult.ai);
      setShareResponse(created);
    } catch (err) {
      setShareError(extractErrorDetails(err).message);
    } finally {
      setIsSharing(false);
      busySlotRef.current = false;
    }
  }

  function handleChangeQuote(next: string) {
    setQuoteText(next);
    if (parseResult || shareResponse) {
      setShareResponse(null);
      setShareError(null);
    }
  }

  const downloadProgressText = (() => {
    if (!downloadEvent) return null;
    if (
      typeof downloadEvent.bytes === "number" &&
      typeof downloadEvent.total === "number" &&
      downloadEvent.total > 0
    ) {
      const pct = Math.min(100, Math.round((downloadEvent.bytes / downloadEvent.total) * 100));
      return `${pct}% (${formatMegabytes(downloadEvent.bytes)} / ${formatMegabytes(downloadEvent.total)})`;
    }
    if (typeof downloadEvent.bytes === "number") {
      return formatMegabytes(downloadEvent.bytes);
    }
    return null;
  })();

  const exceedsNanoWindow =
    selectedMode === "prefer_on_device" && quoteText.trim().length > NANO_CHAR_THRESHOLD;

  const hasProblems = Boolean(parseResult && parseResult.problems.length > 0);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Clause Private</Text>
            <Text style={styles.subtitle}>
              The contract stays private until you choose to share; the money stays controlled.
            </Text>
          </View>

          {/* On-device model status chip */}
          <View
            style={[
              styles.statusChip,
              modelStatus === "available"
                ? styles.statusAvailable
                : modelStatus === "downloadable" || modelStatus === "downloading"
                  ? styles.statusPending
                  : styles.statusUnavailable,
            ]}
          >
            <View style={styles.statusLeft}>
              <View
                style={[
                  styles.statusDot,
                  modelStatus === "available"
                    ? styles.dotAvailable
                    : modelStatus === "downloadable" || modelStatus === "downloading"
                      ? styles.dotPending
                      : styles.dotUnavailable,
                ]}
              />
              <View style={styles.statusTextWrap}>
                <Text style={styles.statusLabel}>
                  {modelStatus === "available" &&
                    `On-device model: Available (${Platform.OS === "ios" ? "Apple Foundation Models" : "Gemini Nano"})`}
                  {modelStatus === "downloadable" && "On-device model: Downloadable"}
                  {modelStatus === "downloading" &&
                    `Downloading Gemini Nano${downloadProgressText ? ` · ${downloadProgressText}` : "…"}`}
                  {modelStatus === "unavailable" && "On-device model: Unavailable: will use cloud"}
                </Text>
              </View>
            </View>

            {modelStatus === "downloadable" && !isDownloading && (
              <Pressable
                onPress={handleDownloadModel}
                style={({ pressed }) => [
                  styles.downloadButton,
                  pressed && styles.buttonPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Download Gemini Nano on-device model"
              >
                <Text style={styles.downloadButtonText}>Download</Text>
              </Pressable>
            )}

            {(modelStatus === "downloading" || isDownloading) && (
              <ActivityIndicator size="small" color="#92400E" />
            )}
          </View>

          {/* Quote input */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.sectionTitle}>Contractor quote</Text>
              <View style={styles.metaRow}>
                <Text style={styles.charCount}>
                  {quoteText.length.toLocaleString("en-US")} chars
                </Text>
                {quoteText !== SAMPLE_QUOTE && (
                  <Pressable
                    onPress={() => {
                      setQuoteText(SAMPLE_QUOTE);
                      setNativeError(null);
                      setShareResponse(null);
                      setShareError(null);
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.resetSampleLink}>Reset sample</Text>
                  </Pressable>
                )}
              </View>
            </View>

            <TextInput
              style={styles.quoteInput}
              multiline
              textAlignVertical="top"
              value={quoteText}
              onChangeText={handleChangeQuote}
              editable={!isParsing && !isSharing}
              placeholder="Paste contractor quote or agreement text…"
              placeholderTextColor="#94A3B8"
              autoCorrect={false}
              spellCheck={false}
            />

            {exceedsNanoWindow && (
              <Text style={styles.lengthHint}>
                Quote exceeds ~{NANO_CHAR_THRESHOLD.toLocaleString("en-US")} chars (Gemini Nano
                4,000-token context); Prefer on-device will route to cloud Gemini.
              </Text>
            )}

            {/* Segmented mode control */}
            <Text style={styles.fieldLabel}>Inference mode</Text>
            <View style={styles.segmentedControl} accessibilityRole="radiogroup">
              {MODE_OPTIONS.map((opt) => {
                const active = selectedMode === opt.mode;
                return (
                  <Pressable
                    key={opt.mode}
                    onPress={() => setSelectedMode(opt.mode)}
                    disabled={isParsing}
                    style={[styles.segmentItem, active && styles.segmentItemActive]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active, disabled: isParsing }}
                  >
                    <Text
                      style={[styles.segmentText, active && styles.segmentTextActive]}
                      numberOfLines={1}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Parse button with live elapsed timer */}
            <Pressable
              onPress={handleParse}
              disabled={isParsing || isSharing || !quoteText.trim()}
              style={({ pressed }) => [
                styles.primaryButton,
                (isParsing || isSharing || !quoteText.trim()) && styles.buttonDisabled,
                pressed && !isParsing && styles.buttonPressed,
              ]}
              accessibilityRole="button"
            >
              {isParsing ? (
                <View style={styles.buttonBusyRow}>
                  <ActivityIndicator size="small" color="#FFFFFF" />
                  <Text style={styles.primaryButtonText}>
                    Parsing quote… {elapsedSeconds.toFixed(1)} s
                  </Text>
                </View>
              ) : (
                <Text style={styles.primaryButtonText}>Parse contract terms</Text>
              )}
            </Pressable>
          </View>

          {/* Inline native / validation error */}
          {nativeError && (
            <View style={styles.errorCard}>
              <Text style={styles.errorTitle}>
                {nativeError.code ? `Inference error · ${nativeError.code}` : "Inference error"}
              </Text>
              <Text style={styles.errorBody}>{nativeError.message}</Text>
            </View>
          )}

          {/* Parsed Result */}
          {parseResult && (
            <>
              <View style={styles.card}>
                <View style={styles.resultHeader}>
                  <Text style={styles.sectionTitle}>Extracted terms</Text>
                  <View
                    style={[
                      styles.aiBadge,
                      parseResult.ai.source === "on_device"
                        ? styles.aiBadgeOnDevice
                        : styles.aiBadgeCloud,
                    ]}
                  >
                    <Text
                      style={[
                        styles.aiBadgeText,
                        parseResult.ai.source === "on_device"
                          ? styles.aiBadgeTextOnDevice
                          : styles.aiBadgeTextCloud,
                      ]}
                    >
                      {formatAiBadge(parseResult.ai)}
                    </Text>
                  </View>
                </View>

                <View style={styles.kvGrid}>
                  <View style={styles.kvRow}>
                    <Text style={styles.kvKey}>Reference</Text>
                    <Text style={styles.kvValue}>{parseResult.terms.contract_ref}</Text>
                  </View>
                  <View style={styles.kvRow}>
                    <Text style={styles.kvKey}>Contractor</Text>
                    <Text style={styles.kvValue}>{parseResult.terms.contractor_name}</Text>
                  </View>
                  <View style={styles.kvRow}>
                    <Text style={styles.kvKey}>Client</Text>
                    <Text style={styles.kvValue}>{parseResult.terms.client_name}</Text>
                  </View>
                  <View style={styles.kvRow}>
                    <Text style={styles.kvKey}>Total</Text>
                    <Text style={styles.kvValueStrong}>
                      {formatMoney(parseResult.terms.total_amount, parseResult.terms.currency)}
                    </Text>
                  </View>
                  <View style={styles.kvRow}>
                    <Text style={styles.kvKey}>Drawdown deadline</Text>
                    <Text style={styles.kvValue}>
                      {parseResult.terms.deadline.date} ({parseResult.terms.deadline.clause.clause_id})
                    </Text>
                  </View>
                </View>

                {/* Milestones */}
                <Text style={styles.subsectionTitle}>
                  Milestones ({parseResult.terms.milestones.length})
                </Text>
                <View style={styles.milestoneList}>
                  {parseResult.terms.milestones.map((m) => (
                    <View key={m.id} style={styles.milestoneRow}>
                      <View style={styles.milestoneTop}>
                        <View style={styles.milestoneTitleGroup}>
                          <Text style={styles.milestoneId}>{m.id}</Text>
                          <Text style={styles.milestoneName}>{m.name}</Text>
                        </View>
                        <Text style={styles.milestoneAmount}>
                          {formatMoney(m.amount, parseResult.terms.currency)}
                        </Text>
                      </View>
                      <View style={styles.milestoneMetaRow}>
                        <View
                          style={[
                            styles.signingPill,
                            m.released_on_signing
                              ? styles.signingPillImmediate
                              : styles.signingPillGated,
                          ]}
                        >
                          <Text
                            style={[
                              styles.signingPillText,
                              m.released_on_signing
                                ? styles.signingPillTextImmediate
                                : styles.signingPillTextGated,
                            ]}
                          >
                            {m.released_on_signing ? "Released on signing" : "Proof required"}
                          </Text>
                        </View>
                        <Text style={styles.clauseTag}>{m.clause.clause_id}</Text>
                      </View>
                    </View>
                  ))}
                </View>

                {/* Validator problems (red) */}
                {parseResult.problems.length > 0 ? (
                  <View style={styles.problemsBox}>
                    <Text style={styles.problemsTitle}>
                      Deterministic validation problems ({parseResult.problems.length})
                    </Text>
                    {parseResult.problems.map((prob, idx) => (
                      <Text key={`${idx}-${prob}`} style={styles.problemItem}>
                        • {prob}
                      </Text>
                    ))}
                  </View>
                ) : (
                  <View style={styles.validPassBox}>
                    <Text style={styles.validPassText}>
                      Deterministic checks passed: milestone sum matches contract total, deadline is
                      valid ISO YYYY-MM-DD, and signing deposit is present.
                    </Text>
                  </View>
                )}

                {/* Open questions (amber) */}
                {parseResult.terms.open_questions.length > 0 && (
                  <View style={styles.questionsBox}>
                    <Text style={styles.questionsTitle}>
                      Open questions for review ({parseResult.terms.open_questions.length})
                    </Text>
                    {parseResult.terms.open_questions.map((q, idx) => (
                      <Text key={`${idx}-${q}`} style={styles.questionItem}>
                        • {q}
                      </Text>
                    ))}
                  </View>
                )}
              </View>

              {/* What leaves this device */}
              <View style={styles.privacyCard}>
                <Text style={styles.privacyTitle}>What leaves this device</Text>
                <Text style={styles.privacyLead}>
                  Only the structured JSON fields below are sent to the Clause server when you tap
                  Share. Your raw contractor quote text is never transmitted or stored on the
                  server.
                </Text>
                <View style={styles.fieldChipWrap}>
                  {describeSharedFields(parseResult.terms).map((field) => (
                    <View key={field} style={styles.fieldChip}>
                      <Text style={styles.fieldChipText}>{field}</Text>
                    </View>
                  ))}
                </View>

                <Pressable
                  onPress={handleShare}
                  disabled={hasProblems || isSharing || isParsing}
                  style={({ pressed }) => [
                    styles.shareButton,
                    (hasProblems || isSharing || isParsing) && styles.shareButtonDisabled,
                    pressed && !hasProblems && !isSharing && styles.buttonPressed,
                  ]}
                  accessibilityRole="button"
                >
                  {isSharing ? (
                    <View style={styles.buttonBusyRow}>
                      <ActivityIndicator size="small" color="#FFFFFF" />
                      <Text style={styles.shareButtonText}>Sharing structured terms…</Text>
                    </View>
                  ) : (
                    <Text
                      style={[
                        styles.shareButtonText,
                        hasProblems && styles.shareButtonTextDisabled,
                      ]}
                    >
                      {hasProblems
                        ? "Fix problems before sharing: AI never controls money"
                        : "Share terms with Clause"}
                    </Text>
                  )}
                </Pressable>

                {shareError && (
                  <View style={styles.inlineShareError}>
                    <Text style={styles.errorBody}>{shareError}</Text>
                  </View>
                )}

                {shareResponse && (
                  <View style={styles.shareSuccessBox}>
                    <Text style={styles.shareSuccessTitle}>
                      Draft job created on Clause · {shareResponse.summary.id}
                    </Text>
                    <Text style={styles.shareSuccessDetail}>
                      Status: {shareResponse.summary.status.toUpperCase()} ·{" "}
                      {shareResponse.summary.contractRef} ·{" "}
                      {formatMoney(shareResponse.summary.total, shareResponse.summary.currency)}
                    </Text>
                    {shareResponse.parsedBy && (
                      <Text style={styles.shareSuccessMeta}>
                        Recorded provenance: {shareResponse.parsedBy} (awaiting owner approval before
                        any card is issued)
                      </Text>
                    )}
                  </View>
                )}
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F4F6F9",
    paddingTop: Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 36,
    gap: 14,
  },
  header: {
    gap: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#0F172A",
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 13.5,
    lineHeight: 19,
    color: "#475569",
  },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
  },
  statusAvailable: {
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
  },
  statusPending: {
    backgroundColor: "#FFFBEB",
    borderColor: "#FDE68A",
  },
  statusUnavailable: {
    backgroundColor: "#F1F5F9",
    borderColor: "#CBD5E1",
  },
  statusLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotAvailable: {
    backgroundColor: "#059669",
  },
  dotPending: {
    backgroundColor: "#D97706",
  },
  dotUnavailable: {
    backgroundColor: "#64748B",
  },
  statusTextWrap: {
    flex: 1,
  },
  statusLabel: {
    fontSize: 12.5,
    fontWeight: "600",
    color: "#1E293B",
  },
  downloadButton: {
    backgroundColor: "#0F4C5C",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  downloadButtonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 14,
    gap: 12,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0F172A",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  charCount: {
    fontSize: 12,
    color: "#64748B",
  },
  resetSampleLink: {
    fontSize: 12,
    fontWeight: "600",
    color: "#0F4C5C",
  },
  quoteInput: {
    minHeight: 170,
    maxHeight: 260,
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 10,
    fontSize: 12.5,
    lineHeight: 18,
    color: "#0F172A",
    fontFamily: Platform.select({ android: "monospace", ios: "Menlo", default: "monospace" }),
  },
  lengthHint: {
    fontSize: 12,
    lineHeight: 17,
    color: "#92400E",
    backgroundColor: "#FFFBEB",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#475569",
  },
  segmentedControl: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    borderRadius: 8,
    padding: 3,
    gap: 3,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentItemActive: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#CBD5E1",
  },
  segmentText: {
    fontSize: 12,
    fontWeight: "500",
    color: "#475569",
  },
  segmentTextActive: {
    fontWeight: "700",
    color: "#0F172A",
  },
  primaryButton: {
    backgroundColor: "#0F4C5C",
    borderRadius: 9,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonBusyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  errorCard: {
    backgroundColor: "#FEF2F2",
    borderColor: "#FECACA",
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  errorTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#991B1B",
  },
  errorBody: {
    fontSize: 12.5,
    lineHeight: 18,
    color: "#7F1D1D",
  },
  resultHeader: {
    gap: 8,
  },
  aiBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  aiBadgeOnDevice: {
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
  },
  aiBadgeCloud: {
    backgroundColor: "#EFF6FF",
    borderColor: "#BFDBFE",
  },
  aiBadgeText: {
    fontSize: 12,
    fontWeight: "700",
  },
  aiBadgeTextOnDevice: {
    color: "#065F46",
  },
  aiBadgeTextCloud: {
    color: "#1E40AF",
  },
  kvGrid: {
    borderTopWidth: 1,
    borderTopColor: "#F1F5F9",
    paddingTop: 10,
    gap: 7,
  },
  kvRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
  },
  kvKey: {
    fontSize: 12.5,
    color: "#64748B",
  },
  kvValue: {
    fontSize: 13,
    fontWeight: "500",
    color: "#0F172A",
    flexShrink: 1,
    textAlign: "right",
  },
  kvValueStrong: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0F172A",
  },
  subsectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#334155",
    marginTop: 4,
  },
  milestoneList: {
    gap: 8,
  },
  milestoneRow: {
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  milestoneTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  milestoneTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  milestoneId: {
    fontSize: 11.5,
    fontWeight: "700",
    color: "#0F4C5C",
    backgroundColor: "#E0F2FE",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  milestoneName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#0F172A",
    flex: 1,
  },
  milestoneAmount: {
    fontSize: 13,
    fontWeight: "700",
    color: "#0F172A",
  },
  milestoneMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  signingPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  signingPillImmediate: {
    backgroundColor: "#DCFCE7",
  },
  signingPillGated: {
    backgroundColor: "#F1F5F9",
  },
  signingPillText: {
    fontSize: 11,
    fontWeight: "600",
  },
  signingPillTextImmediate: {
    color: "#166534",
  },
  signingPillTextGated: {
    color: "#475569",
  },
  clauseTag: {
    fontSize: 11.5,
    color: "#64748B",
    fontWeight: "600",
  },
  problemsBox: {
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  problemsTitle: {
    fontSize: 12.5,
    fontWeight: "700",
    color: "#991B1B",
  },
  problemItem: {
    fontSize: 12.5,
    lineHeight: 18,
    color: "#7F1D1D",
  },
  validPassBox: {
    backgroundColor: "#F0FDF4",
    borderWidth: 1,
    borderColor: "#BBF7D0",
    borderRadius: 8,
    padding: 10,
  },
  validPassText: {
    fontSize: 12,
    lineHeight: 17,
    color: "#166534",
    fontWeight: "500",
  },
  questionsBox: {
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FDE68A",
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  questionsTitle: {
    fontSize: 12.5,
    fontWeight: "700",
    color: "#92400E",
  },
  questionItem: {
    fontSize: 12.5,
    lineHeight: 18,
    color: "#78350F",
  },
  privacyCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    padding: 14,
    gap: 11,
  },
  privacyTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0F172A",
  },
  privacyLead: {
    fontSize: 12.5,
    lineHeight: 18,
    color: "#334155",
  },
  fieldChipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  fieldChip: {
    backgroundColor: "#F1F5F9",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  fieldChipText: {
    fontSize: 11.5,
    color: "#1E293B",
    fontFamily: Platform.select({ android: "monospace", ios: "Menlo", default: "monospace" }),
  },
  shareButton: {
    backgroundColor: "#0F172A",
    borderRadius: 9,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  shareButtonDisabled: {
    backgroundColor: "#E2E8F0",
  },
  shareButtonText: {
    color: "#FFFFFF",
    fontSize: 13.5,
    fontWeight: "700",
    textAlign: "center",
  },
  shareButtonTextDisabled: {
    color: "#475569",
  },
  inlineShareError: {
    backgroundColor: "#FEF2F2",
    borderColor: "#FECACA",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  shareSuccessBox: {
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  shareSuccessTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#065F46",
  },
  shareSuccessDetail: {
    fontSize: 12.5,
    color: "#047857",
    fontWeight: "600",
  },
  shareSuccessMeta: {
    fontSize: 12,
    lineHeight: 17,
    color: "#065F46",
  },
});
