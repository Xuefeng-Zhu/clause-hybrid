# Clause Private (mobile)

React Native (Expo SDK 58) app that reads a contractor quote **on the phone** with Firebase AI Logic hybrid inference: Gemini Nano on-device when the phone supports it, cloud Gemini otherwise. Only the structured, validated terms are shared with the Clause server. The raw quote never leaves the device.

## Architecture
- **UI and policy in TypeScript.** `App.tsx`, `src/ai/clauseAi.ts`. It reuses the repo's shared prompt (`shared/clause-ai/prompts.ts`), zod schema, and deterministic validators (`server/clause/contract/schema.ts`, `shared/clause-ai/validate.ts`) through Metro `watchFolders`.
- **Native module** `modules/clause-hybrid-ai`: Kotlin calls the native Firebase AI Logic SDK (`firebase-ai` + `firebase-ai-ondevice`, ML Kit Prompt API) with `OnDeviceConfig(InferenceMode.*)` and `generateObject` on KSP `@Generable` classes. It reports `inferenceSource` (on-device or cloud), the model, and latency.
- **Why not `@react-native-firebase/ai`?** It doesn't support hybrid or on-device inference.
- **iOS:** the module is a stub that reports `unavailable`. Apple Foundation Models support comes later.
- The model only proposes terms. Validators and a human decide, and sharing stays disabled while problems remain: "AI never controls money."

## Build (Android)
1. Download `google-services.json` for the Android app `com.clausehybrid.app` from the Firebase console and place it in `apps/mobile/`. The file is gitignored.
2. Copy `.env.example` to `.env` and set `EXPO_PUBLIC_CLAUSE_SERVER_URL`.
3. `npm install`, then `npx expo prebuild -p android`, then `npx expo run:android` (or `cd android && ./gradlew assembleRelease`).
4. Run the debug build once and copy the token from logcat (`DebugAppCheckProvider`). Register it in Firebase console > App Check > Apps > Manage debug tokens.

## App Check in release builds (Play Integrity)
Firebase AI Logic enforces App Check, so the cloud fallback only works from an attested app. Debug builds (`BuildConfig.DEBUG` or a debuggable app) install the debug provider. Release builds install `PlayIntegrityAppCheckProviderFactory` (`firebase-appcheck-playintegrity`); see `ensureInitialized()` in `ClauseHybridAiModule.kt`. The Play Integrity API is enabled on the Firebase project. What is still needed, and not in this repo:

1. **Make a release keystore** (never commit it; `*.jks`, `*.keystore` and `keystore.properties` are gitignored):
   `keytool -genkeypair -v -storetype PKCS12 -keystore ~/keys/clause-release.jks -alias clause -keyalg RSA -keysize 4096 -validity 10000`
   Wire it into `android/app/build.gradle` `signingConfigs.release` through `~/.gradle/gradle.properties` (`CLAUSE_UPLOAD_STORE_FILE`, `..._PASSWORD`, `..._KEY_ALIAS`, `..._KEY_PASSWORD`), not through files in the repo. The Expo template signs release builds with the debug keystore by default, and that build will not pass Play Integrity.
2. **Get the SHA-256** of the certificate Play will see: `keytool -list -v -keystore ~/keys/clause-release.jks -alias clause`. With Play App Signing (the default for new apps), use the **app signing key** SHA-256 from Play Console > Test and release > App integrity, not the upload key.
3. **Register it**: Firebase console > Project settings > Android app `com.clausehybrid.app` > Add fingerprint (SHA-256). Then App Check > Apps > `com.clausehybrid.app` > Play Integrity > Register.
4. **Link Play Console**: upload the signed AAB to an internal testing track, then in Play Console > App integrity > Play Integrity API, link Google Cloud project `fbailogic26vrt-3071`.
5. **Verify on a real device** installed from the internal track: a cloud parse should show `Cloud · <model>` with no App Check 403 in logcat. A sideloaded release APK gets no Play Integrity verdict, so it fails attestation by design.

## Devices
On-device inference needs a phone on the ML Kit Prompt API list, such as Pixel 9 and newer. Emulators have no Gemini Nano, so they use the cloud fallback.
