import XCTest

/// Smoke test for device farms (Firebase Test Lab): launch, parse the sample quote,
/// wait for the extracted terms, and keep screenshots of each step.
final class ClausePrivateUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = true
  }

  func testParseSampleContract() throws {
    let app = XCUIApplication()
    // Forward harness-provided settings (e.g. an App Check debug token set in the
    // .xctestrun EnvironmentVariables) to the app under test.
    let env = ProcessInfo.processInfo.environment
    for key in ["FIRAAppCheckDebugToken"] {
      if let value = env[key], !value.isEmpty {
        app.launchEnvironment[key] = value
      }
    }
    app.launch()

    let title = app.staticTexts["Clause Private"]
    XCTAssertTrue(title.waitForExistence(timeout: 60), "App UI did not appear")
    sleep(3)
    snap(app, "01-launch")

    let parse = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS[c] %@", "Parse contract terms")).firstMatch
    XCTAssertTrue(parse.waitForExistence(timeout: 30), "Parse button not found")
    var swipes = 0
    while !parse.isHittable && swipes < 6 {
      app.swipeUp()
      swipes += 1
    }
    snap(app, "02-before-parse")
    parse.tap()
    sleep(2)
    snap(app, "03-parsing")

    let extracted = app.staticTexts
      .matching(NSPredicate(format: "label CONTAINS[c] %@", "Extracted terms")).firstMatch
    let parsed = extracted.waitForExistence(timeout: 90)
    NSLog("CLAUSE_UI parsed=%@", parsed ? "true" : "false")
    snap(app, "04-result")

    logBadges(app)
    for i in 0..<3 {
      app.swipeUp()
      sleep(1)
      snap(app, "05-scroll-\(i)")
    }
    logBadges(app)
    XCTAssertTrue(parsed, "Extracted terms did not appear within 90 s")
  }

  private func logBadges(_ app: XCUIApplication) {
    let texts = app.staticTexts.allElementsBoundByIndex
    for t in texts {
      let label = t.label
      if label.contains("Cloud ·") || label.contains("On-device") || label.contains("Error")
        || label.contains("error") || label.contains("Q-20") {
        NSLog("CLAUSE_UI_TEXT %@", label)
      }
    }
  }

  private func snap(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    NSLog("CLAUSE_UI_SCREENSHOT %@", name)
  }
}
