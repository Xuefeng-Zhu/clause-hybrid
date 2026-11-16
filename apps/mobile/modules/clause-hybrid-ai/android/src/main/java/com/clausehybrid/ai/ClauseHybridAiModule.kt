@file:OptIn(PublicPreviewAPI::class, ExperimentalSerializationApi::class)

package com.clausehybrid.ai

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.SystemClock
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.ai.GenerativeModel
import com.google.firebase.ai.ai
import com.google.firebase.ai.annotations.Generable
import com.google.firebase.ai.annotations.Guide
import com.google.firebase.ai.ondevice.DownloadStatus
import com.google.firebase.ai.ondevice.FirebaseAIOnDevice
import com.google.firebase.ai.ondevice.OnDeviceModelStatus
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.InferenceMode
import com.google.firebase.ai.InferenceSource
import com.google.firebase.ai.OnDeviceConfig
import com.google.firebase.ai.type.PublicPreviewAPI
import com.google.firebase.ai.type.QuotaExceededException
import com.google.firebase.ai.type.content
import com.google.firebase.appcheck.appCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.initialize
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

// ============================================================================
// Structured output schemas for Firebase AI Logic Hybrid inference.
// Hybrid / on-device modes require KSP @Generable data classes (manual JSON
// schemas are cloud-only). Property names and @SerialName keys mirror
// server/clause/contract/schema.ts (ContractTerms) in exact snake_case.
// ============================================================================

@Serializable
@Generable
data class ClauseRef(
  @SerialName("clause_id")
  @Guide("Clause or section identifier copied exactly as written, e.g. §2.1")
  val clause_id: String,
  @SerialName("quote")
  @Guide("Exact clause text copied verbatim from the document; never paraphrase")
  val quote: String,
) {
  companion object
}

@Serializable
@Generable
data class MilestoneOut(
  @SerialName("id")
  @Guide("Milestone identifier in document order: M1, M2, M3...")
  val id: String,
  @SerialName("name")
  @Guide("Short milestone name")
  val name: String,
  @SerialName("amount")
  @Guide("Milestone amount in major currency units as a positive number")
  val amount: Double,
  @SerialName("release_condition")
  @Guide("Condition that must be satisfied to release this milestone")
  val release_condition: String,
  @SerialName("evidence_required")
  @Guide("Evidence items required before release; each item must be from: photos, inspection_report, invoice, walkthrough_signoff")
  val evidence_required: List<String>,
  @SerialName("released_on_signing")
  @Guide("True only when the milestone is paid on signing or as an initial deposit")
  val released_on_signing: Boolean,
  @SerialName("clause")
  @Guide("Source clause copied verbatim for this milestone")
  val clause: ClauseRef,
) {
  companion object
}

@Serializable
@Generable
data class AllowedSpend(
  @SerialName("categories")
  @Guide("Allowed spend categories; each must be from: building_materials, lumber, hardware, plumbing_supplies, electrical_supplies, paint_glass, home_improvement_warehouse")
  val categories: List<String>,
  @SerialName("clause")
  @Guide("Source clause copied verbatim defining allowed spend")
  val clause: ClauseRef,
) {
  companion object
}

@Serializable
@Generable
data class ProhibitedSpend(
  @SerialName("description")
  @Guide("Summary of prohibited spend items")
  val description: String,
  @SerialName("clause")
  @Guide("Source clause copied verbatim defining prohibited spend")
  val clause: ClauseRef,
) {
  companion object
}

@Serializable
@Generable
data class Deadline(
  @SerialName("date")
  @Guide("Last day project funds may be drawn, formatted as YYYY-MM-DD")
  val date: String,
  @SerialName("clause")
  @Guide("Source clause copied verbatim stating the completion or drawdown deadline")
  val clause: ClauseRef,
) {
  companion object
}

@Serializable
@Generable
data class ContractTermsOut(
  @SerialName("contract_ref")
  @Guide("Quote or contract reference identifier")
  val contract_ref: String,
  @SerialName("contractor_name")
  @Guide("Contractor business or individual name")
  val contractor_name: String,
  @SerialName("client_name")
  @Guide("Client business or individual name")
  val client_name: String,
  @SerialName("project")
  @Guide("Brief project description")
  val project: String,
  @SerialName("currency")
  @Guide("Three-letter ISO 4217 currency code, e.g. USD")
  val currency: String,
  @SerialName("total_amount")
  @Guide("Contract total amount as written in major currency units")
  val total_amount: Double,
  @SerialName("milestones")
  @Guide("Payment milestones in document order")
  val milestones: List<MilestoneOut>,
  @SerialName("allowed_spend")
  @Guide("Allowed merchant spend categories and source clause")
  val allowed_spend: AllowedSpend,
  @SerialName("prohibited_spend")
  @Guide("Prohibited spend rule if present in the document, otherwise null")
  val prohibited_spend: ProhibitedSpend? = null,
  @SerialName("start_date")
  @Guide("Work start date formatted as YYYY-MM-DD if stated, otherwise null")
  val start_date: String? = null,
  @SerialName("deadline")
  @Guide("Drawdown or completion deadline formatted as YYYY-MM-DD and its verbatim clause")
  val deadline: Deadline,
  @SerialName("change_order_clause")
  @Guide("Change order clause copied verbatim if present in the document, otherwise null")
  val change_order_clause: ClauseRef? = null,
  @SerialName("open_questions")
  @Guide("Ambiguities, unmapped spend categories, or missing details requiring human review")
  val open_questions: List<String> = emptyList(),
) {
  companion object
}

class ClauseHybridAiModule : Module() {
  private val initLock = Any()

  @Volatile
  private var initialized = false

  private val jsonEncoder = Json {
    encodeDefaults = true
    explicitNulls = false
    ignoreUnknownKeys = true
  }

  override fun definition() = ModuleDefinition {
    Name("ClauseHybridAi")

    Events("onDownload")

    AsyncFunction("getStatus") Coroutine { ->
      ensureInitialized()
      try {
        when (FirebaseAIOnDevice.checkStatus()) {
          OnDeviceModelStatus.AVAILABLE -> "available"
          OnDeviceModelStatus.DOWNLOADABLE -> "downloadable"
          OnDeviceModelStatus.DOWNLOADING -> "downloading"
          OnDeviceModelStatus.UNAVAILABLE -> "unavailable"
          else -> "unavailable"
        }
      } catch (_: Throwable) {
        "unavailable"
      }
    }

    AsyncFunction("downloadModel") Coroutine { ->
      ensureInitialized()
      var totalBytes: Long? = null
      var emittedFailure = false
      try {
        FirebaseAIOnDevice.download().collect { status ->
          when (status) {
            is DownloadStatus.DownloadStarted -> {
              totalBytes = status.bytesToDownload
              sendEvent(
                "onDownload",
                mapOf(
                  "state" to "started",
                  "total" to status.bytesToDownload,
                ),
              )
            }
            is DownloadStatus.DownloadInProgress -> {
              val payload = mutableMapOf<String, Any>(
                "state" to "progress",
                "bytes" to status.totalBytesDownloaded,
              )
              totalBytes?.let { payload["total"] = it }
              sendEvent("onDownload", payload)
            }
            is DownloadStatus.DownloadCompleted -> {
              sendEvent("onDownload", mapOf("state" to "completed"))
            }
            is DownloadStatus.DownloadFailed -> {
              emittedFailure = true
              val errMsg = status.exception.message ?: "On-device model download failed."
              sendEvent(
                "onDownload",
                mapOf(
                  "state" to "failed",
                  "error" to errMsg,
                ),
              )
              throw mapException(status.exception)
            }
          }
        }
      } catch (t: Throwable) {
        if (!emittedFailure) {
          sendEvent(
            "onDownload",
            mapOf(
              "state" to "failed",
              "error" to (t.message ?: "On-device model download failed."),
            ),
          )
        }
        throw mapException(t)
      }
    }

    AsyncFunction("warmUp") Coroutine { ->
      ensureInitialized()
      try {
        val model = buildModel(
          cloudModel = DEFAULT_CLOUD_MODEL,
          mode = InferenceMode.PREFER_ON_DEVICE,
          systemInstructionText = null,
        )
        model.onDeviceExtension?.warmUp()
      } catch (_: Throwable) {
        // Swallow unsupported or unavailable warm-up errors on devices without AICore.
      }
    }

    AsyncFunction("parseContract") Coroutine { system: String, prompt: String, mode: String, cloudModel: String ->
      ensureInitialized()
      try {
        val inferenceMode = parseInferenceMode(mode)
        val effectiveCloudModel = cloudModel.ifBlank { DEFAULT_CLOUD_MODEL }
        val model = buildModel(
          cloudModel = effectiveCloudModel,
          mode = inferenceMode,
          systemInstructionText = system,
        )
        // Cloud-only passes systemInstruction natively; hybrid/on-device modes prepend
        // system rules to the prompt so ML Kit Prompt API (Gemini Nano) always receives them.
        val effectivePrompt = if (inferenceMode != InferenceMode.ONLY_IN_CLOUD && system.isNotBlank()) {
          "$system\n\n$prompt"
        } else {
          prompt
        }

        val startedMs = SystemClock.elapsedRealtime()
        val response = model.generateObject(ContractTermsOut.firebaseAISchema(), effectivePrompt)
        val elapsedMs = SystemClock.elapsedRealtime() - startedMs

        val parsed = response.getObject(0)
          ?: throw CodedException("ERR_EMPTY", "Model returned no structured object.", null)
        val encodedJson = jsonEncoder.encodeToString(ContractTermsOut.serializer(), parsed)
        val source = mapInferenceSource(response.response.inferenceSource, inferenceMode)
        val usedModel = if (source == "on_device") ON_DEVICE_MODEL_ID else effectiveCloudModel

        mapOf(
          "json" to encodedJson,
          "source" to source,
          "model" to usedModel,
          "ms" to elapsedMs,
        )
      } catch (t: Throwable) {
        throw mapException(t)
      }
    }

    AsyncFunction("generateText") Coroutine { prompt: String, mode: String, cloudModel: String ->
      ensureInitialized()
      try {
        val inferenceMode = parseInferenceMode(mode)
        val effectiveCloudModel = cloudModel.ifBlank { DEFAULT_CLOUD_MODEL }
        val model = buildModel(
          cloudModel = effectiveCloudModel,
          mode = inferenceMode,
          systemInstructionText = null,
        )

        val startedMs = SystemClock.elapsedRealtime()
        val response = model.generateContent(prompt)
        val elapsedMs = SystemClock.elapsedRealtime() - startedMs

        val source = mapInferenceSource(response.inferenceSource, inferenceMode)
        val usedModel = if (source == "on_device") ON_DEVICE_MODEL_ID else effectiveCloudModel

        mapOf(
          "text" to (response.text ?: ""),
          "source" to source,
          "model" to usedModel,
          "ms" to elapsedMs,
        )
      } catch (t: Throwable) {
        throw mapException(t)
      }
    }
  }

  private fun requireContext(): Context {
    return appContext.reactContext?.applicationContext
      ?: appContext.reactContext
      ?: throw CodedException("PARSE_FAILED", "Android application context is not available.", null)
  }

  private fun ensureInitialized() {
    if (initialized) return
    synchronized(initLock) {
      if (initialized) return
      val context = requireContext()
      if (FirebaseApp.getApps(context).isEmpty()) {
        Firebase.initialize(context)
      }
      val isDebuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
      if (BuildConfig.DEBUG || isDebuggable) {
        Firebase.appCheck.installAppCheckProviderFactory(
          DebugAppCheckProviderFactory.getInstance(),
        )
      } else {
        // TODO(release): Configure Play Integrity attestation for release builds:
        // Firebase.appCheck.installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance())
      }
      initialized = true
    }
  }

  private fun buildModel(
    cloudModel: String,
    mode: InferenceMode,
    systemInstructionText: String?,
  ): GenerativeModel {
    val ai = Firebase.ai(
      backend = GenerativeBackend.googleAI(),
      useLimitedUseAppCheckTokens = true,
    )
    val sysInstruction = if (mode == InferenceMode.ONLY_IN_CLOUD && !systemInstructionText.isNullOrBlank()) {
      content { text(systemInstructionText) }
    } else {
      null
    }
    return ai.generativeModel(
      modelName = cloudModel,
      systemInstruction = sysInstruction,
      onDeviceConfig = OnDeviceConfig(
        mode = mode,
        maxOutputTokens = 1024,
      ),
    )
  }

  private fun parseInferenceMode(mode: String): InferenceMode {
    return when (mode) {
      "prefer_on_device" -> InferenceMode.PREFER_ON_DEVICE
      "only_on_device" -> InferenceMode.ONLY_ON_DEVICE
      "prefer_in_cloud" -> InferenceMode.PREFER_IN_CLOUD
      "only_in_cloud" -> InferenceMode.ONLY_IN_CLOUD
      else -> InferenceMode.PREFER_ON_DEVICE
    }
  }

  private fun mapInferenceSource(source: InferenceSource?, requestedMode: InferenceMode): String {
    return when (source) {
      InferenceSource.ON_DEVICE -> "on_device"
      InferenceSource.IN_CLOUD -> "in_cloud"
      else -> if (requestedMode == InferenceMode.ONLY_ON_DEVICE) "on_device" else "in_cloud"
    }
  }

  private fun mapException(t: Throwable): CodedException {
    if (t is CodedException) return t
    val className = t::class.java.simpleName.lowercase()
    val fullMsg = "${t::class.java.name}: ${t.message ?: ""}".lowercase()

    return when {
      t is QuotaExceededException ||
        "quota" in fullMsg ||
        "resource_exhausted" in fullMsg ||
        "rate limit" in fullMsg ||
        "429" in fullMsg -> {
        CodedException("QUOTA", t.message ?: "Model quota or rate limit exceeded.", t)
      }
      "busy" in className ||
        "busy" in fullMsg ||
        "concurrent" in fullMsg -> {
        CodedException("BUSY", t.message ?: "On-device Gemini Nano is currently busy. Try again shortly.", t)
      }
      "ondevice" in className ||
        "aicore" in fullMsg ||
        "not available" in fullMsg ||
        "unavailable" in fullMsg ||
        "not supported" in fullMsg ||
        "feature_not_found" in fullMsg -> {
        CodedException(
          "ONDEVICE_UNAVAILABLE",
          t.message ?: "On-device Gemini Nano is unavailable on this device.",
          t,
        )
      }
      t is SerializationException -> {
        CodedException("PARSE_FAILED", "Model output could not be decoded into ContractTerms: ${t.message}", t)
      }
      else -> {
        CodedException("PARSE_FAILED", t.message ?: "Contract parsing failed.", t)
      }
    }
  }

  companion object {
    private const val DEFAULT_CLOUD_MODEL = "gemini-3.5-flash-lite"
    private const val ON_DEVICE_MODEL_ID = "gemini-nano"
  }
}
