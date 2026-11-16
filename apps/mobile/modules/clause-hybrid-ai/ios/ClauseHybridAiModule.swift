import ExpoModulesCore

internal final class NotImplementedIosException: Exception {
  override var code: String {
    "NOT_IMPLEMENTED_IOS"
  }

  override var reason: String {
    "Hybrid inference is not yet implemented on iOS (Apple Foundation Models support planned)."
  }
}

public class ClauseHybridAiModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ClauseHybridAi")

    Events("onDownload")

    AsyncFunction("getStatus") { () -> String in
      return "unavailable"
    }

    AsyncFunction("downloadModel") { () throws -> Void in
      throw NotImplementedIosException()
    }

    AsyncFunction("warmUp") { () -> Void in
      // No-op stub on iOS
    }

    AsyncFunction("parseContract") { (_: String, _: String, _: String, _: String) throws -> [String: Any] in
      throw NotImplementedIosException()
    }

    AsyncFunction("generateText") { (_: String, _: String, _: String) throws -> [String: Any] in
      throw NotImplementedIosException()
    }
  }
}
