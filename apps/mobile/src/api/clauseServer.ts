/**
 * Shares ONLY the structured, validated ContractTerms and AI provenance metadata
 * with the Clause server (`POST /_agent-native/actions/create-job-from-terms`).
 * The raw quote text never leaves this phone.
 */
import type { ContractTerms } from "../../../../server/clause/contract/schema";
import type { AiRunMetadata } from "../ai/clauseAi";

export interface CreatedJobSummary {
  id: string;
  kind: "contract" | "policy";
  status: string;
  contractRef: string;
  contractor: string;
  client: string;
  project: string;
  currency: string;
  total: number;
  released: number;
  spent: number;
  available: number;
  deadline: string;
  parsedBy?: string;
}

export interface ShareTermsResponse {
  summary: CreatedJobSummary;
  kind: "contract" | "policy";
  terms: ContractTerms;
  problems: string[];
  parsedBy?: string;
  aiSource: AiRunMetadata | null;
}

export function getClauseServerUrl(): string {
  const raw = process.env.EXPO_PUBLIC_CLAUSE_SERVER_URL; // guard:allow-env-credential — public Expo build-time server URL
  return typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
}

/**
 * Returns the exact list of structured field paths that `shareTerms` will transmit
 * for a given ContractTerms value, so the UI can show a transparent disclosure.
 */
export function describeSharedFields(terms: ContractTerms): string[] {
  const fields = [
    "kind (\"contract\")",
    "terms.contract_ref",
    "terms.contractor_name",
    "terms.client_name",
    "terms.project",
    "terms.currency",
    "terms.total_amount",
    `terms.milestones (${terms.milestones.length} structured milestone${terms.milestones.length === 1 ? "" : "s"} + clause quotes)`,
    "terms.allowed_spend (categories + clause)",
  ];
  if (terms.prohibited_spend) {
    fields.push("terms.prohibited_spend (description + clause)");
  }
  if (terms.start_date) {
    fields.push("terms.start_date");
  }
  fields.push("terms.deadline (YYYY-MM-DD + clause)");
  if (terms.change_order_clause) {
    fields.push("terms.change_order_clause");
  }
  fields.push(`terms.open_questions (${terms.open_questions.length})`);
  fields.push("aiSource ({ source, model, ms })");
  return fields;
}

export async function shareTerms(
  terms: ContractTerms,
  ai: AiRunMetadata,
): Promise<ShareTermsResponse> {
  const baseUrl = getClauseServerUrl();
  if (!baseUrl) {
    throw new Error(
      "EXPO_PUBLIC_CLAUSE_SERVER_URL is not configured. Set it in apps/mobile/.env.local (for example http://10.0.2.2:8080 for an Android emulator or your LAN/server URL).",
    );
  }

  const endpoint = `${baseUrl}/_agent-native/actions/create-job-from-terms`;
  const payload = {
    kind: "contract" as const,
    terms,
    aiSource: {
      source: ai.source,
      model: ai.model,
      ms: Math.max(0, Math.round(ai.ms)),
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const serverMessage =
      json && typeof json === "object"
        ? ((json as { message?: string; error?: string }).message ??
          (json as { error?: string }).error)
        : null;
    throw new Error(
      serverMessage
        ? `Server rejected terms (${response.status}): ${serverMessage}`
        : `Failed to reach create-job-from-terms (${response.status}).`,
    );
  }

  if (!json || typeof json !== "object" || !("summary" in json)) {
    throw new Error("Unexpected response from Clause server create-job-from-terms action.");
  }

  return json as ShareTermsResponse;
}
