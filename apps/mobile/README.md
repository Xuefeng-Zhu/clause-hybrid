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

## Devices
On-device inference needs a phone on the ML Kit Prompt API list, such as Pixel 9 and newer. Emulators have no Gemini Nano, so they use the cloud fallback.
