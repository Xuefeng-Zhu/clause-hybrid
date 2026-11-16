/**
 * Fire-and-forget Firestore telemetry logger for hybrid AI inference calls (`users/{uid}/aiCalls`).
 * Uses Firebase Anonymous Auth so each browser profile writes only under its own `uid`.
 *
 * STRICT PRIVACY BOUNDARY: NEVER stores contract text, expense text, notes, or images.
 * Safe offline and never throws.
 */
import { signInAnonymously, type Auth } from "firebase/auth";
import { addDoc, collection, serverTimestamp, type Firestore } from "firebase/firestore";

import {
  type AiStep,
  getFirebaseAuth,
  getFirebaseDb,
  type HybridMode,
  isFirebaseConfigured,
} from "./firebase";
import type { AiSource } from "./hybrid-ai";

export interface AiCallLogEntry {
  step: AiStep;
  mode: HybridMode;
  inferenceSource: AiSource;
  latencyMs: number;
  validatorOk: boolean;
}

export interface AiLogDeps {
  auth?: Auth | null;
  db?: Firestore | null;
  configured?: boolean;
}

let pendingSignIn: Promise<string | null> | null = null;

async function ensureAnonymousUid(auth: Auth): Promise<string | null> {
  if (auth.currentUser?.uid) return auth.currentUser.uid;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return null;
  }
  if (!pendingSignIn) {
    pendingSignIn = signInAnonymously(auth)
      .then((cred) => cred.user?.uid ?? null)
      .catch(() => null)
      .finally(() => {
        pendingSignIn = null;
      });
  }
  return pendingSignIn;
}

/**
 * Write an immutable AI-call metadata log entry to `users/{uid}/aiCalls`.
 * Call without awaiting (`void logAiCall(...)`) for fire-and-forget telemetry.
 * Never throws; safe when Firebase is unconfigured, offline, or permissions fail.
 */
export async function logAiCall(entry: AiCallLogEntry, deps?: AiLogDeps): Promise<void> {
  try {
    const configured = deps?.configured ?? isFirebaseConfigured();
    if (!configured) return;

    const auth = deps?.auth !== undefined ? deps.auth : getFirebaseAuth();
    const db = deps?.db !== undefined ? deps.db : getFirebaseDb();
    if (!auth || !db) return;

    const uid = await ensureAnonymousUid(auth);
    if (!uid) return;

    // Strict whitelist matching firestore.rules; never store text or images.
    const payload = {
      step: entry.step,
      mode: entry.mode,
      inferenceSource: entry.inferenceSource,
      latencyMs: Number.isFinite(entry.latencyMs) ? Math.max(0, Math.round(entry.latencyMs)) : 0,
      validatorOk: Boolean(entry.validatorOk),
      createdAt: serverTimestamp(),
    };

    await addDoc(collection(db, "users", uid, "aiCalls"), payload);
  } catch {
    // Logging must never throw or disrupt the main flow, including offline.
  }
}

export function resetAiLogForTest(): void {
  pendingSignIn = null;
}
