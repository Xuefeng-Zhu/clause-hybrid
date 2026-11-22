# iOS device testing without an Apple developer account

`.github/workflows/ios-build.yml` builds the app for real iPhones (Release, JS bundled,
`CODE_SIGNING_ALLOWED=NO`, then ad-hoc signed) and uploads `ios-xctest.zip` (app + XCUITest
runner + `.xctestrun`) and an `.ipa`. Firebase Test Lab re-signs apps, so no Apple account is needed.

The build carries no Firebase config or App Check token. Before uploading to Test Lab:

```sh
RCODESIGN=/path/to/rcodesign python3 ios-testing/prepare_testlab.py \
  ios-xctest.zip GoogleService-Info.plist <app-check-debug-token> out/
gcloud firebase test ios run --type xctest --test out/ios-xctest-testlab.zip \
  --device model=iphone16pro,version=18.3 --device model=iphonese3,version=26.3
```

The script copies `GoogleService-Info.plist` into the app, sets `ClauseAppCheckDebug` /
`ClauseAppCheckDebugToken` in its Info.plist, puts the token in the `.xctestrun` environment
(the UI test forwards `FIRAAppCheckDebugToken` to the app), and re-signs the app ad-hoc.
Register the token for the iOS app under App Check > Manage debug tokens first.

- `add_uitest_target.rb`: adds the `ClausePrivateUITests` target after `expo prebuild`.
- `ClausePrivateUITests/`: launches the app, taps "Parse contract terms", waits up to 90 s for
  "Extracted terms", and attaches screenshots. The app logs `CLAUSE_*` lines to the device syslog.
