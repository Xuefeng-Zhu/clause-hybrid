import ExpoModulesCore
import FirebaseAILogic
import FirebaseAppCheck
import FirebaseCore
import Foundation
import UIKit
#if canImport(FoundationModels)
import FoundationModels
#endif

// ============================================================================
// Clause Hybrid AI: iOS implementation.
//
// Mirrors the Android module's JS API (getStatus / downloadModel / warmUp /
// parseContract / generateText). Inference is hybrid:
//   - on-device: Apple Foundation Models (SystemLanguageModel, iOS 26+ with
//     Apple Intelligence enabled), structured output via @Generable.
//   - cloud: Firebase AI Logic (Gemini Developer API) with a JSON response
//     schema, protected by App Check.
// Firebase AI Logic 13.x removed its interim HybridModel wrapper, so the
// prefer/only routing is implemented here, the same way the Android SDK's
// InferenceMode behaves.
//
// Log lines use the CLAUSE_* markers so device syslogs (e.g. Test Lab) show
// which path ran.
// ============================================================================

// MARK: - Output model (keys mirror server/clause/contract/schema.ts)

struct ClauseRefOut: Codable {
  var clause_id: String
  var quote: String
}

struct MilestoneOut: Codable {
  var id: String
  var name: String
  var amount: Double
  var release_condition: String
  var evidence_required: [String]
  var released_on_signing: Bool
  var clause: ClauseRefOut
}

struct AllowedSpendOut: Codable {
  var categories: [String]
  var clause: ClauseRefOut
}

struct ProhibitedSpendOut: Codable {
  var description: String
  var clause: ClauseRefOut
}

struct DeadlineOut: Codable {
  var date: String
  var clause: ClauseRefOut
}

struct ContractTermsOut: Codable {
  var contract_ref: String
  var contractor_name: String
  var client_name: String
  var project: String
  var currency: String
  var total_amount: Double
  var milestones: [MilestoneOut]
  var allowed_spend: AllowedSpendOut
  var prohibited_spend: ProhibitedSpendOut?
  var start_date: String?
  var deadline: DeadlineOut
  var change_order_clause: ClauseRefOut?
  var open_questions: [String]?
}

private enum Guides {
  static let clauseId = "Clause or section identifier copied exactly as written, e.g. §2.1"
  static let quote = "Exact clause text copied verbatim from the document; never paraphrase"
  static let milestoneId = "Milestone identifier in document order: M1, M2, M3..."
  static let amount = "Milestone amount in major currency units as a positive number"
  static let evidence =
    "Evidence items required before release; each item must be from: photos, inspection_report, invoice, walkthrough_signoff"
  static let releasedOnSigning =
    "True only when the milestone is paid on signing or as an initial deposit"
  static let categories =
    "Allowed spend categories; each must be from: building_materials, lumber, hardware, plumbing_supplies, electrical_supplies, paint_glass, home_improvement_warehouse"
  static let deadlineDate = "Last day project funds may be drawn, formatted as YYYY-MM-DD"
  static let currency = "Three-letter ISO 4217 currency code, e.g. USD"
  static let total = "Contract total amount as written in major currency units"
  static let startDate = "Work start date formatted as YYYY-MM-DD if stated, otherwise omit"
  static let openQuestions =
    "Ambiguities, unmapped spend categories, or missing details requiring human review"
}

// MARK: - Cloud response schema (Firebase AI Logic)

private enum CloudSchema {
  static func clauseRef(_ description: String) -> Schema {
    .object(
      properties: [
        "clause_id": .string(description: Guides.clauseId),
        "quote": .string(description: Guides.quote),
      ],
      propertyOrdering: ["clause_id", "quote"],
      description: description
    )
  }

  static var contractTerms: Schema {
    let milestone = Schema.object(
      properties: [
        "id": .string(description: Guides.milestoneId),
        "name": .string(description: "Short milestone name"),
        "amount": .double(description: Guides.amount),
        "release_condition": .string(
          description: "Condition that must be satisfied to release this milestone"
        ),
        "evidence_required": .array(items: .string(), description: Guides.evidence),
        "released_on_signing": .boolean(description: Guides.releasedOnSigning),
        "clause": clauseRef("Source clause copied verbatim for this milestone"),
      ],
      propertyOrdering: [
        "id", "name", "amount", "release_condition", "evidence_required",
        "released_on_signing", "clause",
      ]
    )
    return .object(
      properties: [
        "contract_ref": .string(description: "Quote or contract reference identifier"),
        "contractor_name": .string(description: "Contractor business or individual name"),
        "client_name": .string(description: "Client business or individual name"),
        "project": .string(description: "Brief project description"),
        "currency": .string(description: Guides.currency),
        "total_amount": .double(description: Guides.total),
        "milestones": .array(items: milestone, description: "Payment milestones in document order"),
        "allowed_spend": .object(
          properties: [
            "categories": .array(items: .string(), description: Guides.categories),
            "clause": clauseRef("Source clause copied verbatim defining allowed spend"),
          ],
          propertyOrdering: ["categories", "clause"]
        ),
        "prohibited_spend": .object(
          properties: [
            "description": .string(description: "Summary of prohibited spend items"),
            "clause": clauseRef("Source clause copied verbatim defining prohibited spend"),
          ],
          propertyOrdering: ["description", "clause"],
          description: "Prohibited spend rule if present in the document"
        ),
        "start_date": .string(description: Guides.startDate),
        "deadline": .object(
          properties: [
            "date": .string(description: Guides.deadlineDate),
            "clause": clauseRef(
              "Source clause copied verbatim stating the completion or drawdown deadline"
            ),
          ],
          propertyOrdering: ["date", "clause"]
        ),
        "change_order_clause": clauseRef(
          "Change order clause copied verbatim if present in the document"
        ),
        "open_questions": .array(items: .string(), description: Guides.openQuestions),
      ],
      optionalProperties: [
        "prohibited_spend", "start_date", "change_order_clause", "open_questions",
      ],
      propertyOrdering: [
        "contract_ref", "contractor_name", "client_name", "project", "currency",
        "total_amount", "milestones", "allowed_spend", "prohibited_spend", "start_date",
        "deadline", "change_order_clause", "open_questions",
      ]
    )
  }
}

// MARK: - On-device structured output (Apple Foundation Models)

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
struct ODClauseRef {
  @Guide(description: "Clause or section identifier copied exactly as written, e.g. §2.1")
  var clause_id: String
  @Guide(description: "Exact clause text copied verbatim from the document; never paraphrase")
  var quote: String
}

@available(iOS 26.0, *)
@Generable
struct ODMilestone {
  @Guide(description: "Milestone identifier in document order: M1, M2, M3...")
  var id: String
  @Guide(description: "Short milestone name")
  var name: String
  @Guide(description: "Milestone amount in major currency units as a positive number")
  var amount: Double
  @Guide(description: "Condition that must be satisfied to release this milestone")
  var release_condition: String
  @Guide(description: "Evidence items required before release; each item must be from: photos, inspection_report, invoice, walkthrough_signoff")
  var evidence_required: [String]
  @Guide(description: "True only when the milestone is paid on signing or as an initial deposit")
  var released_on_signing: Bool
  @Guide(description: "Source clause copied verbatim for this milestone")
  var clause: ODClauseRef
}

@available(iOS 26.0, *)
@Generable
struct ODAllowedSpend {
  @Guide(description: "Allowed spend categories; each must be from: building_materials, lumber, hardware, plumbing_supplies, electrical_supplies, paint_glass, home_improvement_warehouse")
  var categories: [String]
  @Guide(description: "Source clause copied verbatim defining allowed spend")
  var clause: ODClauseRef
}

@available(iOS 26.0, *)
@Generable
struct ODProhibitedSpend {
  @Guide(description: "Summary of prohibited spend items")
  var description: String
  @Guide(description: "Source clause copied verbatim defining prohibited spend")
  var clause: ODClauseRef
}

@available(iOS 26.0, *)
@Generable
struct ODDeadline {
  @Guide(description: "Last day project funds may be drawn, formatted as YYYY-MM-DD")
  var date: String
  @Guide(description: "Source clause copied verbatim stating the completion or drawdown deadline")
  var clause: ODClauseRef
}

@available(iOS 26.0, *)
@Generable
struct ODContractTerms {
  @Guide(description: "Quote or contract reference identifier")
  var contract_ref: String
  @Guide(description: "Contractor business or individual name")
  var contractor_name: String
  @Guide(description: "Client business or individual name")
  var client_name: String
  @Guide(description: "Brief project description")
  var project: String
  @Guide(description: "Three-letter ISO 4217 currency code, e.g. USD")
  var currency: String
  @Guide(description: "Contract total amount as written in major currency units")
  var total_amount: Double
  @Guide(description: "Payment milestones in document order")
  var milestones: [ODMilestone]
  @Guide(description: "Allowed merchant spend categories and source clause")
  var allowed_spend: ODAllowedSpend
  @Guide(description: "Prohibited spend rule if present in the document, otherwise null")
  var prohibited_spend: ODProhibitedSpend?
  @Guide(description: "Work start date formatted as YYYY-MM-DD if stated, otherwise null")
  var start_date: String?
  @Guide(description: "Drawdown or completion deadline formatted as YYYY-MM-DD and its verbatim clause")
  var deadline: ODDeadline
  @Guide(description: "Change order clause copied verbatim if present in the document, otherwise null")
  var change_order_clause: ODClauseRef?
  @Guide(description: "Ambiguities, unmapped spend categories, or missing details requiring human review")
  var open_questions: [String]
}

@available(iOS 26.0, *)
private extension ODClauseRef {
  var out: ClauseRefOut { ClauseRefOut(clause_id: clause_id, quote: quote) }
}

@available(iOS 26.0, *)
private extension ODContractTerms {
  var out: ContractTermsOut {
    ContractTermsOut(
      contract_ref: contract_ref,
      contractor_name: contractor_name,
      client_name: client_name,
      project: project,
      currency: currency,
      total_amount: total_amount,
      milestones: milestones.map {
        MilestoneOut(
          id: $0.id, name: $0.name, amount: $0.amount,
          release_condition: $0.release_condition,
          evidence_required: $0.evidence_required,
          released_on_signing: $0.released_on_signing,
          clause: $0.clause.out
        )
      },
      allowed_spend: AllowedSpendOut(
        categories: allowed_spend.categories, clause: allowed_spend.clause.out
      ),
      prohibited_spend: prohibited_spend.map {
        ProhibitedSpendOut(description: $0.description, clause: $0.clause.out)
      },
      start_date: start_date,
      deadline: DeadlineOut(date: deadline.date, clause: deadline.clause.out),
      change_order_clause: change_order_clause?.out,
      open_questions: open_questions
    )
  }
}
#endif

// MARK: - Errors

private func clauseError(_ code: String, _ message: String) -> Exception {
  return Exception(name: "ClauseHybridAiError", description: message, code: code)
}

private struct OnDeviceUnavailable: Error {
  let reason: String
}

// MARK: - Logging

private func clauseLog(_ marker: String, _ message: String) {
  // NSLog lands in the device syslog (Test Lab "syslog" artifact) and Xcode console.
  NSLog("%@ %@", marker, message)
}

// MARK: - Module

public class ClauseHybridAiModule: Module {
  static let defaultCloudModel = "gemini-3.5-flash-lite"
  static let onDeviceModelId = "apple-foundation-models"

  private static let initLock = NSLock()
  private static var initialized = false

  public func definition() -> ModuleDefinition {
    Name("ClauseHybridAi")

    Events("onDownload")

    AsyncFunction("getStatus") { () -> String in
      Self.ensureInitialized()
      let (status, detail) = Self.onDeviceStatus()
      clauseLog("CLAUSE_MODEL_STATUS", "status=\(status) detail=\(detail) os=\(UIDevice.current.systemVersion) model=\(Self.deviceModel())")
      return status
    }

    AsyncFunction("downloadModel") { () throws in
      // Apps cannot trigger the Apple Intelligence model download; the OS does it once
      // Apple Intelligence is enabled. Report the current state instead.
      Self.ensureInitialized()
      let (status, detail) = Self.onDeviceStatus()
      if status == "available" {
        self.sendEvent("onDownload", ["state": "completed"])
        return
      }
      let message = "On-device model can't be downloaded by the app (\(detail)). Enable Apple Intelligence in Settings; the OS downloads the model."
      self.sendEvent("onDownload", ["state": "failed", "error": message])
      throw clauseError("ONDEVICE_UNAVAILABLE", message)
    }

    AsyncFunction("warmUp") { () async in
      Self.ensureInitialized()
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        if case .available = SystemLanguageModel.default.availability {
          LanguageModelSession().prewarm()
        }
      }
      #endif
    }

    AsyncFunction("parseContract") {
      (system: String, prompt: String, mode: String, cloudModel: String) async throws -> [String: Any] in
      Self.ensureInitialized()
      let model = cloudModel.trimmingCharacters(in: .whitespaces).isEmpty
        ? Self.defaultCloudModel : cloudModel
      let started = Date()
      do {
        let (terms, source, usedModel) = try await Self.route(mode: mode, label: "parseContract") {
          try await Self.parseOnDevice(system: system, prompt: prompt)
        } cloud: {
          try await Self.parseInCloud(system: system, prompt: prompt, modelName: model)
        }
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(terms)
        let json = String(data: data, encoding: .utf8) ?? "{}"
        let finalModel = source == "on_device" ? usedModel : model
        clauseLog("CLAUSE_RESULT", "fn=parseContract mode=\(mode) source=\(source) model=\(finalModel) ms=\(ms) ref=\(terms.contract_ref) total=\(terms.total_amount) \(terms.currency) milestones=\(terms.milestones.count)")
        return ["json": json, "source": source, "model": finalModel, "ms": ms]
      } catch {
        let mapped = Self.mapError(error)
        clauseLog("CLAUSE_ERROR", "fn=parseContract mode=\(mode) code=\(mapped.code) message=\(mapped.description)")
        throw mapped
      }
    }

    AsyncFunction("generateText") {
      (prompt: String, mode: String, cloudModel: String) async throws -> [String: Any] in
      Self.ensureInitialized()
      let model = cloudModel.trimmingCharacters(in: .whitespaces).isEmpty
        ? Self.defaultCloudModel : cloudModel
      let started = Date()
      do {
        let (text, source, usedModel) = try await Self.route(mode: mode, label: "generateText") {
          try await Self.textOnDevice(prompt: prompt)
        } cloud: {
          try await Self.textInCloud(prompt: prompt, modelName: model)
        }
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        let finalModel = source == "on_device" ? usedModel : model
        clauseLog("CLAUSE_RESULT", "fn=generateText mode=\(mode) source=\(source) model=\(finalModel) ms=\(ms) chars=\(text.count)")
        return ["text": text, "source": source, "model": finalModel, "ms": ms]
      } catch {
        let mapped = Self.mapError(error)
        clauseLog("CLAUSE_ERROR", "fn=generateText mode=\(mode) code=\(mapped.code) message=\(mapped.description)")
        throw mapped
      }
    }
  }

  // MARK: Initialization (App Check before FirebaseApp.configure)

  static func ensureInitialized() {
    initLock.lock()
    defer { initLock.unlock() }
    if initialized { return }

    let info = Bundle.main.infoDictionary ?? [:]
    var useDebugProvider = false
    #if DEBUG
    useDebugProvider = true
    #endif
    if (info["ClauseAppCheckDebug"] as? Bool) == true {
      useDebugProvider = true
    }
    let envToken = ProcessInfo.processInfo.environment["FIRAAppCheckDebugToken"] ?? ""
    if !envToken.isEmpty {
      // Set by a test harness (e.g. the XCUITest launch environment); AppCheckCore reads it.
      useDebugProvider = true
    }

    if useDebugProvider {
      // A token preset for test builds (injected into the built app's Info.plist, never committed) lets a
      // fresh install on a test device pass App Check without registering a new random token.
      // AppCheckCore reads FIRAAppCheckDebugToken from the process environment first, then
      // its stored local token (UserDefaults key GACAppCheckDebugToken).
      if !envToken.isEmpty {
        clauseLog("CLAUSE_APPCHECK", "provider=debug token=environment")
      } else if let token = info["ClauseAppCheckDebugToken"] as? String,
         !token.trimmingCharacters(in: .whitespaces).isEmpty {
        setenv("FIRAAppCheckDebugToken", token, 1)
        UserDefaults.standard.set(token, forKey: "GACAppCheckDebugToken")
        clauseLog("CLAUSE_APPCHECK", "provider=debug token=preset")
      } else {
        clauseLog("CLAUSE_APPCHECK", "provider=debug token=generated(see AppCheckCore log)")
      }
      AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
    } else {
      // Production builds: App Attest (DeviceCheck before iOS 14).
      AppCheck.setAppCheckProviderFactory(AppAttestProviderFactoryForClause())
      clauseLog("CLAUSE_APPCHECK", "provider=app_attest")
    }

    if FirebaseApp.app() == nil {
      if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
        FirebaseApp.configure()
        clauseLog("CLAUSE_INIT", "firebase=configured app=\(FirebaseApp.app()?.options.googleAppID ?? "?")")
      } else {
        clauseLog("CLAUSE_INIT", "firebase=missing GoogleService-Info.plist")
      }
    }
    initialized = true
  }

  // MARK: Routing (mirrors Android InferenceMode)

  static func route<T>(
    mode: String,
    label: String,
    onDevice: () async throws -> (T, String),
    cloud: () async throws -> T
  ) async throws -> (T, String, String) {
    switch mode {
    case "only_on_device":
      let (value, model) = try await onDevice()
      return (value, "on_device", model)
    case "only_in_cloud":
      return (try await cloud(), "in_cloud", defaultCloudModel)
    case "prefer_in_cloud":
      do {
        return (try await cloud(), "in_cloud", defaultCloudModel)
      } catch {
        guard isNetworkError(error) else { throw error }
        clauseLog("CLAUSE_FALLBACK", "fn=\(label) from=cloud to=on_device reason=\(error.localizedDescription)")
        let (value, model) = try await onDevice()
        return (value, "on_device", model)
      }
    default: // prefer_on_device
      do {
        let (value, model) = try await onDevice()
        return (value, "on_device", model)
      } catch {
        clauseLog("CLAUSE_FALLBACK", "fn=\(label) from=on_device to=cloud reason=\(describe(error))")
        return (try await cloud(), "in_cloud", defaultCloudModel)
      }
    }
  }

  // MARK: On-device

  static func onDeviceStatus() -> (String, String) {
    #if canImport(FoundationModels)
    if #available(iOS 26.0, *) {
      switch SystemLanguageModel.default.availability {
      case .available:
        return ("available", "available")
      case .unavailable(.modelNotReady):
        return ("downloading", "modelNotReady")
      case .unavailable(.appleIntelligenceNotEnabled):
        return ("unavailable", "appleIntelligenceNotEnabled")
      case .unavailable(.deviceNotEligible):
        return ("unavailable", "deviceNotEligible")
      case .unavailable(let other):
        return ("unavailable", "\(other)")
      }
    }
    return ("unavailable", "requires iOS 26 (Foundation Models)")
    #else
    return ("unavailable", "built without FoundationModels SDK")
    #endif
  }

  static func requireOnDevice() throws {
    let (status, detail) = onDeviceStatus()
    if status != "available" {
      throw OnDeviceUnavailable(reason: detail)
    }
  }

  static func parseOnDevice(system: String, prompt: String) async throws -> (ContractTermsOut, String) {
    try requireOnDevice()
    #if canImport(FoundationModels)
    if #available(iOS 26.0, *) {
      let session = LanguageModelSession(instructions: system)
      let response = try await session.respond(
        to: prompt,
        generating: ODContractTerms.self,
        includeSchemaInPrompt: true,
        options: GenerationOptions(temperature: 0.0)
      )
      return (response.content.out, onDeviceModelId)
    }
    #endif
    throw OnDeviceUnavailable(reason: "requires iOS 26")
  }

  static func textOnDevice(prompt: String) async throws -> (String, String) {
    try requireOnDevice()
    #if canImport(FoundationModels)
    if #available(iOS 26.0, *) {
      let session = LanguageModelSession()
      let response = try await session.respond(to: prompt)
      return (response.content, onDeviceModelId)
    }
    #endif
    throw OnDeviceUnavailable(reason: "requires iOS 26")
  }

  // MARK: Cloud (Firebase AI Logic)

  static func cloudModel(name: String, system: String?, json: Bool) -> GenerativeModel {
    let ai = FirebaseAI.firebaseAI(backend: .googleAI(), useLimitedUseAppCheckTokens: true)
    let config = json
      ? GenerationConfig(
        temperature: 0.0,
        responseMIMEType: "application/json",
        responseSchema: CloudSchema.contractTerms
      )
      : nil
    let instruction = (system?.isEmpty == false) ? ModelContent(role: "system", parts: system!) : nil
    return ai.generativeModel(
      modelName: name,
      generationConfig: config,
      systemInstruction: instruction
    )
  }

  static func parseInCloud(system: String, prompt: String, modelName: String) async throws -> ContractTermsOut {
    guard FirebaseApp.app() != nil else {
      throw clauseError("PARSE_FAILED", "Firebase is not configured (GoogleService-Info.plist missing).")
    }
    let model = cloudModel(name: modelName, system: system, json: true)
    let response = try await model.generateContent(prompt)
    guard let text = response.text, !text.isEmpty else {
      throw clauseError("ERR_EMPTY", "Model returned no structured object.")
    }
    var body = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if body.hasPrefix("```") {
      body = body.replacingOccurrences(of: "```json", with: "")
        .replacingOccurrences(of: "```", with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    do {
      return try JSONDecoder().decode(ContractTermsOut.self, from: Data(body.utf8))
    } catch {
      throw clauseError("PARSE_FAILED", "Model output could not be decoded into ContractTerms: \(error)")
    }
  }

  static func textInCloud(prompt: String, modelName: String) async throws -> String {
    guard FirebaseApp.app() != nil else {
      throw clauseError("PARSE_FAILED", "Firebase is not configured (GoogleService-Info.plist missing).")
    }
    let model = cloudModel(name: modelName, system: nil, json: false)
    let response = try await model.generateContent(prompt)
    return response.text ?? ""
  }

  // MARK: Error mapping (same codes as Android)

  static func describe(_ error: Error) -> String {
    if let od = error as? OnDeviceUnavailable { return "on-device unavailable: \(od.reason)" }
    return "\(type(of: error)): \(error)"
  }

  static func isNetworkError(_ error: Error) -> Bool {
    let ns = error as NSError
    if ns.domain == NSURLErrorDomain { return true }
    let text = "\(error)".lowercased()
    return text.contains("nsurlerrordomain") || text.contains("offline")
      || text.contains("network connection")
  }

  static func mapError(_ error: Error) -> Exception {
    if let ex = error as? Exception { return ex }
    if let od = error as? OnDeviceUnavailable {
      return clauseError(
        "ONDEVICE_UNAVAILABLE",
        "On-device Apple Foundation Model is unavailable on this device (\(od.reason))."
      )
    }
    let full = "\(type(of: error)): \(error)".lowercased()
    #if canImport(FoundationModels)
    if #available(iOS 26.0, *) {
      if let gen = error as? LanguageModelSession.GenerationError {
        switch gen {
        case .rateLimited:
          return clauseError("QUOTA", "On-device model rate limited: \(gen.localizedDescription)")
        case .concurrentRequests:
          return clauseError("BUSY", "On-device model is busy: \(gen.localizedDescription)")
        case .assetsUnavailable:
          return clauseError("ONDEVICE_UNAVAILABLE", "On-device model assets unavailable: \(gen.localizedDescription)")
        default:
          return clauseError("PARSE_FAILED", "On-device generation failed: \(gen)")
        }
      }
    }
    #endif
    if full.contains("quota") || full.contains("resource_exhausted") || full.contains("rate limit")
      || full.contains("429") {
      return clauseError("QUOTA", "Model quota or rate limit exceeded: \(error)")
    }
    if full.contains("busy") || full.contains("concurrent") {
      return clauseError("BUSY", "Model is busy: \(error)")
    }
    return clauseError("PARSE_FAILED", "Contract parsing failed: \(error)")
  }

  static func deviceModel() -> String {
    var systemInfo = utsname()
    uname(&systemInfo)
    return withUnsafePointer(to: &systemInfo.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
    }
  }
}

/// App Attest for release builds (iOS 14+); falls back to DeviceCheck where App Attest is missing.
private final class AppAttestProviderFactoryForClause: NSObject, AppCheckProviderFactory {
  func createProvider(with app: FirebaseApp) -> AppCheckProvider? {
    if #available(iOS 14.0, *) {
      return AppAttestProvider(app: app)
    }
    return DeviceCheckProvider(app: app)
  }
}
