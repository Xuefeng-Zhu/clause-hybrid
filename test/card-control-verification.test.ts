import { describe, expect, it, vi } from "vitest";
import { AirwallexClient } from "../server/clause/airwallex/client.js";
import { SandboxIssuingGateway } from "../server/clause/airwallex/sandbox.js";
import type { AuthorizationControls, Card } from "../server/clause/airwallex/types.js";

const controls: AuthorizationControls = {
  allowed_currencies: ["USD"],
  allowed_merchant_categories: ["7011", "4121"],
  allowed_transaction_count: "MULTIPLE",
  transaction_limits: {
    currency: "USD",
    limits: [{ interval: "PER_TRANSACTION", amount: 300 }, { interval: "ALL_TIME", amount: 2_000 }],
  },
  active_to: "2026-12-01T00:00:00.000Z",
};

const card: Card = {
  card_id: "issuer_card",
  cardholder_id: "issuer_holder",
  card_status: "ACTIVE",
  authorization_controls: controls,
};

describe("Airwallex control readback", () => {
  it("reads all limits from the issuer before reporting a new card", async () => {
    const client = new AirwallexClient();
    const gateway = new SandboxIssuingGateway(client);
    const post = vi.spyOn(client, "post").mockResolvedValue({ ...card, authorization_controls: {} });
    const actual = {
      ...card,
      authorization_controls: {
        ...controls,
        allowed_merchant_categories: ["4121", "7011"],
        transaction_limits: {
          ...controls.transaction_limits!,
          limits: [...controls.transaction_limits!.limits].reverse(),
        },
        active_to: "2026-11-30T16:00:00-08:00",
      },
    };
    const get = vi.spyOn(client, "get").mockResolvedValue(actual);

    await expect(gateway.createCard({
      cardholder_id: card.cardholder_id,
      nick_name: "Trip card",
      authorization_controls: controls,
    })).resolves.toEqual(actual);
    expect(get).toHaveBeenCalledWith("/issuing/cards/issuer_card");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rejected two-limit request with a single limit", async () => {
    const client = new AirwallexClient();
    const gateway = new SandboxIssuingGateway(client);
    const post = vi.spyOn(client, "post").mockRejectedValue(new Error("Provider rejected the controls"));

    await expect(gateway.createCard({
      cardholder_id: card.cardholder_id,
      nick_name: "Trip card",
      authorization_controls: controls,
    })).rejects.toThrow("Provider rejected the controls");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each(["create", "update"] as const)("contains a %s whose provider readback dropped the trip cap", async (operation) => {
    const client = new AirwallexClient();
    const gateway = new SandboxIssuingGateway(client);
    const safeStatus = operation === "create" ? "CLOSED" : "INACTIVE";
    const incomplete = { ...card, authorization_controls: {
      ...controls,
      transaction_limits: { currency: "USD", limits: [{ interval: "PER_TRANSACTION", amount: 300 }] },
    } };
    const post = vi.spyOn(client, "post").mockResolvedValue(card);
    vi.spyOn(client, "get")
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce({ ...incomplete, card_status: safeStatus });

    const changed = operation === "create"
      ? gateway.createCard({ cardholder_id: card.cardholder_id, nick_name: "Trip card", authorization_controls: controls })
      : gateway.updateCard(card.card_id, { authorization_controls: controls });
    await expect(changed).rejects.toThrow(`confirmed the card is ${safeStatus.toLowerCase()}`);
    expect(post).toHaveBeenLastCalledWith("/issuing/cards/issuer_card/update", { card_status: safeStatus }, { withRequestId: false });
  });

  it("freezes an existing card if the control update response is lost", async () => {
    const client = new AirwallexClient();
    const gateway = new SandboxIssuingGateway(client);
    const inactive = { ...card, card_status: "INACTIVE" };
    const post = vi.spyOn(client, "post")
      .mockRejectedValueOnce(new Error("Update timed out"))
      .mockResolvedValueOnce(inactive);
    vi.spyOn(client, "get").mockResolvedValue(inactive);

    await expect(gateway.updateCard(card.card_id, { authorization_controls: controls }))
      .rejects.toThrow("confirmed the card is inactive");
    expect(post).toHaveBeenLastCalledWith("/issuing/cards/issuer_card/update", { card_status: "INACTIVE" }, { withRequestId: false });
  });
});
