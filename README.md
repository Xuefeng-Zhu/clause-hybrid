# Clause

[Live demo](https://8080-agrbns4donht7p3tyd2gpj43qe.instabox.tech/home) · [Kane CLI showcase](https://www.kaneclihack.sh/o/p/xuefeng-zhu) · [Local setup](#run-locally)

Clause turns contractor quotes and approved business trips into virtual cards with spending rules tied to the source document. For contractors, the card cap tracks released milestones and a Metal mandate governs payouts. For travel, the card has a trip budget, a per-charge limit, and manager-approved exceptions. When a charge breaks a rule, you can see the clause behind the decline.

## Try the live demo

1. Open **New job → Use sample quote** and select **Read quote**. Review the highlighted terms, then choose **Approve & issue card**. The signing milestone releases **$4,000**.
2. Open **Sandbox → Custom authorization**. Keep **Builders Supply Co.** and MCC **5211**, enter **6000**, and select **Send authorization**.
3. Close the drawer. Hover over the declined charge and choose **Explain**. The inline explanation cites **§1.1** and shows why the charge exceeded the released cap.

The public preview uses simulated cards and payouts in a shared workspace. Use the bundled samples. The InstaBox machine auto-pauses after 30 idle minutes. [Preview access and deployment](./deploy/README-instabox-preview.md)

## Run locally

Use Node.js 22.22.0 or later and pnpm 10.29.1. Corepack selects the version pinned in [package.json](./package.json).

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Open the URL printed by the dev server and choose **Continue as local dev** if prompted. A clean setup runs both walkthroughs with local mocks and bundled parsing fixtures, without provider keys. Open **Sandbox → Environment & parser** to check the active card gateway and parser. See the [development guide](./DEVELOPING.md) for checks, provider setup, and the separate Expo app.

## Walk through both workflows

Start each walkthrough with a fresh **New job**. The examples below use the mocked card and payout providers.

### Contractor quote · Maple Street Café

1. Read the [sample quote](./samples/quote-maple-street-cafe.txt) and issue the card. In **Sandbox**, run **Dunn Lumber ($1,840.50)**, **Kirkland Taphouse ($86.40)**, and **Home Depot ($2,500)** in order. Lumber passes. Lunch breaks the meals rule (§2.2), and Home Depot exceeds the remaining released funds (§1.1).
2. In **Metal payout mandate**, try **Pay contractor over the cap** and **Pay a different wallet**. The mandate refuses both attempts. Close the drawer.
3. Choose **Submit proof for Milestone 2**. Leave **Photos** selected and the attachment field empty to use the [bundled cabinet photo](./public/samples/cabinets-installed.jpg). Choose **Evaluate proof**, then **Approve release**. The cap rises to **$9,000**. The mocks record a **50 USDZ** payout and a **$5,000** simulated deposit. Retry Home Depot to see it pass.
4. Choose **Propose change order** and use the [prefilled email](./samples/change-order-email.txt). Approve the proposal. The cap rises to **$9,800**, the deadline moves to **December 23, 2026**, and the replacement mandate carries forward prior spend.
5. In **Sandbox**, run the **McLendon Hardware** preset dated December 24. The decline cites the change order. **Verify mandate on chain** shows the mock's two refusals and one payout.

### Travel and expense policy · Acme Robotics

1. Choose **Travel policy + trip request**, then **Read policy & trip**. Review [trip TR-2611](./samples/policy-acme-trip.txt) and choose **Approve & issue trip card**. The mock card has a **$2,000** budget and a **$300** per-charge cap.
2. In **Sandbox**, try **Hyatt Regency Austin ($289)** and **Uber Trip ($34.60)**. Both pass. The cocktail bar and Best Buy presets decline under §§4.2 and 4.1. The November 26 Uber preset declines under the expiry clause (§2.1).
3. Turn on **Employee phone view** in the Sandbox drawer and try **Uchi Austin ($480)**. The charge declines under §3.3. Close the drawer and use the prefilled note to **Request an exception (§3.4)** in the phone view.
4. Under **Live enforcement**, choose **Approve exception**. Four named attendees at $125 each allow a **$500** cap. In **Sandbox**, retry Uchi Austin twice. The first retry passes and restores the **$300** cap. The second declines under §3.3.
5. Close the drawer. Open **Expense report — auto-generated** and select **Export CSV**. With the hotel, rideshare, and one dinner approved, the report shows **$803.60** in company card spend and **$0.00** owed to the traveler.

**Reset demo** deletes the signed-in user's jobs and clears the process-wide mocks. On the public preview, all visitors share that identity. Use **New job** to start another sample.

## How Clause makes decisions

- **AI reads.** Firebase AI Logic runs supported tasks in Chrome with Gemini Nano on-device or Gemini in the cloud. The source badge identifies what ran. Contest mode disables the server's model providers and agent chat. [Inference and data flow](./docs/INFERENCE.md)
- **Code computes.** Schemas validate the extracted terms. Deterministic rules compute card caps, merchant categories, deadlines, and payout limits. When a decline maps to a rule, Clause cites its source. [Card rules](./server/clause/policy/cardRules.ts)
- **People approve.** The job owner approves changes. Outside the mock demo, the owner must be on the configured policy-manager list to issue a trip card or approve an exception. The service records a stable payment ID to prevent duplicate milestone payouts on retry. Uncertain outcomes go to manual review. [Approval and release recovery](./DEVELOPING.md#approval-and-release-recovery)

## Browser testing with Kane CLI

Kane caught a real bug in the first walkthrough. The card correctly declined the **$6,000** charge, but **Explain** opened an empty chat. The fix moved the answer into the transaction row and validates it against the card rules. Kane passed on rerun. [Fix commit](https://github.com/Xuefeng-Zhu/clause-hybrid/commit/22daf676)

Kane flows 01–04 cover quote extraction, the decline explanation, change orders, and rejected proof. The offline check ran manually. The travel exception and CSV flow passed in desktop Chrome against a local build with mocks. It still awaits a hosted Kane run. [Commands and run history](./docs/KANE.md)

## More docs

- [Development guide](./DEVELOPING.md) for app structure, local checks, mock and sandbox providers, and production setup.
- [InstaBox preview](./deploy/README-instabox-preview.md) for the public demo and redeployment.
- [Mobile app](./apps/mobile/README.md) for Expo setup and device testing.
- [Agent guide](./AGENTS.md) for the action reference.
- [Apache 2.0 license](./LICENSE).
