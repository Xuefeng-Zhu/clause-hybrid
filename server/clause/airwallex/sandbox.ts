import { getProviderConfig } from "../config.js";
import { AirwallexClient } from "./client.js";
import type {
  AuthorizationControls,
  Card,
  CardStatus,
  Cardholder,
  IssuingGateway,
  IssuingTransaction,
  SimulatedAuthRequest,
  SimulatedDeposit,
  SimulatedDepositRequest,
} from "./types.js";

/**
 * Real Airwallex sandbox implementation.
 * Endpoints (prefix /api/v1, base https://api.sandbox.airwallex.com):
 *   POST /issuing/cardholders/create
 *   POST /issuing/cards/create
 *   GET  /issuing/cards/{id}
 *   POST /issuing/cards/{id}/update       (controls, freeze = INACTIVE, close = CLOSED)
 *   POST /simulation/issuing/create       (sandbox-only authorization)
 *   POST /simulation/issuing/card_transaction_lifecycles/{lifecycle_id}/capture
 *   GET  /issuing/transactions?card_id=
 *
 * Verified live against the sandbox on 2026-11-12:
 *  - REST DELEGATE cardholder: { type, email } only, returns READY (HTTP 202).
 *  - cards/create needs program: { purpose: "COMMERCIAL" } (no type on this account).
 *  - authorization_controls round-trip as sent; partial updates keep other fields.
 *  - simulation body: card_id, transaction_amount, transaction_currency,
 *    merchant_category_code, merchant_info (string). Response has process_result
 *    APPROVED|DECLINED, failure_reason, card_transaction_lifecycle_id.
 *  - card_status INACTIVE declines with CARD_INACTIVE; CLOSED closes.
 */
export class SandboxIssuingGateway implements IssuingGateway {
  readonly mode = "sandbox" as const;
  constructor(
    private readonly awx = new AirwallexClient(),
    private readonly cardholderId = getProviderConfig().awx.cardholderId,
  ) {}

  async createDelegateCardholder(email: string): Promise<Cardholder> {
    const preset = this.cardholderId;
    if (preset) return { cardholder_id: preset, email, type: "DELEGATE", status: "READY" };
    try {
      const res = await this.awx.post<any>("/issuing/cardholders/create", { type: "DELEGATE", email });
      return { cardholder_id: res.cardholder_id ?? res.id, email, type: "DELEGATE", status: res.status };
    } catch (err) {
      // Re-running the demo reuses the same cardholder email; Airwallex rejects duplicates,
      // so look up and reuse the existing cardholder instead of failing.
      if (!/already associated with a cardholder/i.test(String(err))) throw err;
      const existing = await this.findCardholderByEmail(email);
      if (!existing) throw err;
      return existing;
    }
  }

  private async findCardholderByEmail(email: string): Promise<Cardholder | undefined> {
    for (let page = 0; page < 20; page++) {
      const res = await this.awx.get<any>(`/issuing/cardholders?page_num=${page}&page_size=100`);
      const items: any[] = res.items ?? [];
      const hit = items.find((c) => (c.email ?? "").toLowerCase() === email.toLowerCase());
      if (hit) return { cardholder_id: hit.cardholder_id ?? hit.id, email, type: "DELEGATE", status: hit.status };
      if (!res.has_more || items.length === 0) return undefined;
    }
    return undefined;
  }

  async createCard(input: { cardholder_id: string; nick_name: string; authorization_controls: AuthorizationControls }): Promise<Card> {
    const payload = {
      cardholder_id: input.cardholder_id,
      created_by: "Contract-as-Card agent",
      form_factor: "VIRTUAL",
      is_personalized: false,
      program: { purpose: "COMMERCIAL" },
      nick_name: input.nick_name,
      authorization_controls: input.authorization_controls,
    };
    const issued = normalizeCard(await this.awx.post<any>("/issuing/cards/create", payload));
    if (!issued.card_id) throw new Error("Airwallex did not return the issued card ID. Check the sandbox before retrying.");
    return await this.verifyControls(issued.card_id, input.authorization_controls, "CLOSED");
  }

  async getCard(card_id: string): Promise<Card> {
    return normalizeCard(await this.awx.get<any>(`/issuing/cards/${card_id}`));
  }

  async updateCard(card_id: string, patch: { card_status?: CardStatus; authorization_controls?: AuthorizationControls }): Promise<Card> {
    let updated: Card;
    try {
      updated = normalizeCard(
        await this.awx.post<any>(`/issuing/cards/${card_id}/update`, patch, { withRequestId: false }),
      );
    } catch (error) {
      if (patch.authorization_controls) await this.containUnverifiedCard(card_id, "INACTIVE");
      throw error;
    }
    return patch.authorization_controls
      ? await this.verifyControls(card_id, patch.authorization_controls, "INACTIVE")
      : updated;
  }

  private async verifyControls(
    cardId: string,
    requested: AuthorizationControls,
    safeStatus: "CLOSED" | "INACTIVE",
  ): Promise<Card> {
    try {
      const actual = await this.getCard(cardId);
      if (cardControlsMatch(requested, actual.authorization_controls)) return actual;
    } catch {
      // An unavailable readback also leaves the provider's enforcement unverified.
    }
    return await this.containUnverifiedCard(cardId, safeStatus);
  }

  private async containUnverifiedCard(cardId: string, safeStatus: "CLOSED" | "INACTIVE"): Promise<never> {
    let confirmedStatus: CardStatus | undefined;
    try {
      await this.awx.post(
        `/issuing/cards/${cardId}/update`,
        { card_status: safeStatus },
        { withRequestId: false },
      );
      const { card_status } = await this.getCard(cardId);
      if (card_status === safeStatus || card_status === "CLOSED") {
        confirmedStatus = card_status;
      }
    } catch {
      // Report that the containment attempt itself was unverified.
    }
    const outcome = confirmedStatus
      ? `Airwallex confirmed the card is ${confirmedStatus.toLowerCase()}.`
      : "The card status is unverified. Check Airwallex before retrying.";
    throw new Error(`Airwallex controls could not be verified for card ${cardId}. ${outcome}`);
  }

  async simulateAuthorization(req: SimulatedAuthRequest): Promise<IssuingTransaction> {
    // The sandbox authorizes against its own clock and ignores a simulated time.
    // To demo a swipe "after the deadline" for real, briefly move the card's active_to
    // into the past (so Airwallex itself returns OUT_OF_ALLOWED_TIME_RANGE), then restore it.
    const at = req.at ? Date.parse(req.at) : NaN;
    if (!Number.isNaN(at) && at > Date.now()) {
      const card = await this.getCard(req.card_id);
      const original = card.authorization_controls;
      if (original.active_to && at > Date.parse(original.active_to)) {
        const past = new Date(Date.now() - 60_000).toISOString();
        const pastFrom = new Date(Date.now() - 120_000).toISOString();
        await this.updateCard(req.card_id, {
          authorization_controls: { ...original, active_from: pastFrom, active_to: past },
        });
        try {
          const { at: _ignored, ...rest } = req;
          return await this.simulateNow(rest);
        } finally {
          await this.updateCard(req.card_id, { authorization_controls: original });
        }
      }
    }
    return this.simulateNow(req);
  }

  private async simulateNow(req: SimulatedAuthRequest): Promise<IssuingTransaction> {
    const res = await this.awx.post<any>("/simulation/issuing/create", {
      card_id: req.card_id,
      transaction_amount: req.amount,
      transaction_currency: req.currency,
      merchant_category_code: req.merchant_category_code,
      merchant_info: req.merchant_name,
    });
    const txn = normalizeTxn(res, req);
    if (!txn.failure_reason && res.process_result !== "DECLINED" && res.card_transaction_lifecycle_id) {
      await this.awx
        .post(`/simulation/issuing/card_transaction_lifecycles/${res.card_transaction_lifecycle_id}/capture`, {})
        .then(() => { txn.transaction_type = "CLEARING"; })
        .catch(() => undefined);
    }
    return txn;
  }

  async simulateDeposit(req: SimulatedDepositRequest): Promise<SimulatedDeposit> {
    const accountsRes = await this.awx.get<any>("/global_accounts");
    const items: any[] = accountsRes.items ?? [];
    const usdAccount =
      items.find(
        (a) =>
          String(a.status ?? "").toUpperCase() === "ACTIVE" &&
          (a.currency === "USD" ||
            (Array.isArray(a.supported_features) &&
              a.supported_features.some((f: any) => f.currency === "USD"))),
      ) ??
      items.find(
        (a) =>
          a.currency === "USD" ||
          (Array.isArray(a.supported_features) &&
            a.supported_features.some((f: any) => f.currency === "USD")),
      ) ??
      items[0];

    const globalAccountId = usdAccount?.id ?? usdAccount?.global_account_id;
    if (!globalAccountId) {
      throw new Error("No USD global account available in Airwallex sandbox for deposit simulation.");
    }

    const payerName = `Metal payout ${req.reference.slice(0, 10)}`;
    const res = await this.awx.post<any>("/simulation/deposit/create", {
      global_account_id: globalAccountId,
      amount: req.amount,
      payer_name: payerName,
    });

    return {
      deposit_id: String(res.id ?? res.deposit_id ?? `dep_${Date.now()}`),
      amount: Number(res.amount ?? req.amount),
      currency: String(res.currency ?? req.currency ?? "USD"),
      payer_name: payerName,
      reference: req.reference,
      global_account_id: String(globalAccountId),
      status: String(res.status ?? "SETTLED"),
      created_at: String(res.created_at ?? new Date().toISOString()),
    };
  }

  async listTransactions(card_id: string): Promise<IssuingTransaction[]> {
    const res = await this.awx.get<any>("/issuing/transactions", { card_id });
    return (res.items ?? []).map((t: any) => normalizeTxn(t));
  }
}

/** Compare the requested fields with the issuer readback, independent of list order. */
export function cardControlsMatch(
  requested: AuthorizationControls,
  actual: AuthorizationControls,
): boolean {
  const sameList = (expected: string[] | undefined, observed: string[] | undefined) =>
    !expected || (Array.isArray(observed) && expected.length === observed.length
      && [...new Set(observed)].length === expected.length
      && expected.every((value) => observed.includes(value)));
  const sameDate = (expected: string | undefined, observed: string | undefined) =>
    !expected || (!!observed && Date.parse(expected) === Date.parse(observed));
  const limits = requested.transaction_limits;
  const applied = actual.transaction_limits;
  return sameList(requested.allowed_currencies, actual.allowed_currencies)
    && sameList(requested.allowed_merchant_categories, actual.allowed_merchant_categories)
    && (!requested.allowed_transaction_count
      || requested.allowed_transaction_count === actual.allowed_transaction_count)
    && sameDate(requested.active_from, actual.active_from)
    && sameDate(requested.active_to, actual.active_to)
    && (!limits || (!!applied && limits.currency === applied.currency
      && Array.isArray(applied.limits) && limits.limits.length === applied.limits.length
      && limits.limits.every((expected) => applied.limits.some((cardLimit) =>
        cardLimit.interval === expected.interval && cardLimit.amount === expected.amount))));
}

function normalizeCard(r: any): Card {
  return {
    card_id: r.card_id ?? r.id,
    cardholder_id: r.cardholder_id,
    card_status: r.card_status,
    nick_name: r.nick_name,
    authorization_controls: r.authorization_controls ?? {},
  };
}

function normalizeTxn(r: any, req?: SimulatedAuthRequest): IssuingTransaction {
  const failureReason = r.failure_reason;
  return {
    transaction_id: r.transaction_id ?? r.card_transaction_id ?? r.card_transaction_data?.card_transaction_id ?? r.id,
    card_id: r.card_id ?? req?.card_id,
    amount: Math.abs(Number(r.transaction_amount ?? r.amount ?? req?.amount)),
    currency: r.transaction_currency ?? r.currency ?? req?.currency,
    merchant_name: (r.merchant?.name ? String(r.merchant.name).replace(/_+$/, "") : undefined) ?? r.merchant_info?.name ?? req?.merchant_name ?? "",
    merchant_category_code: r.merchant?.category_code ?? r.merchant_info?.category_code ?? req?.merchant_category_code ?? "",
    transaction_type: r.transaction_type ?? "AUTHORIZATION",
    status: r.status ?? (r.process_result === "DECLINED" ? "FAILED" : r.process_result === "APPROVED" ? "APPROVED" : undefined),
    ...(failureReason ? { failure_reason: failureReason } : {}),
    created_at: r.transaction_date ?? r.created_at ?? new Date().toISOString(),
  };
}
