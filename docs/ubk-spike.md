# Spike: Circle Unified Balance Kit (UBK) for `selat fund`

**Date:** 2026-07-14
**Question:** Can `@circle-fin/unified-balance-kit` replace (or augment) the
`selat fund` deposit path, which today wraps the selat-discovery skill's
`scripts/setup.mjs deposit` / `eco-deposit` (Circle CLI, self-custody Agent
Wallet)?

**Verdict: deferred for deposits and reads; unified-balance *model* adopted.**
UBK cannot sign deposits for Circle *Agent* Wallets without breaking
self-custody, so deposits stay on the Circle CLI. Balance reads stay on
`circle gateway balance --all` — which at spike time reports a *different*
(and for selat-pay, the operative) Gateway accounting than UBK's
`getBalances()`, see §2 — rather than adding a heavy new runtime dependency
for a read that wouldn't even observe our deposits crediting. What
`selat fund` adopts from UBK is the model and the UX: one unified balance,
spendable from any supported chain, polled until credited (`--wait`),
displayed after every deposit, plus a QR funding branch for empty wallets.

## What UBK is

- `@circle-fin/unified-balance-kit` (v1.2.2 on npm at spike time), standalone,
  no kit key needed. API: `kit.deposit()`, `kit.spend()`, `kit.getBalances()`.
- Signing is delegated to adapter packages: Viem (raw private key), EIP-1193
  (browser wallets), Solana, and `@circle-fin/adapter-circle-wallets`
  (v1.4.2).
- Source: Circle's `unify-balance` skill
  (`circlefin/skills` → `plugins/circle/skills/unify-balance/SKILL.md` and its
  `references/adapter-circle-wallets.md`, `references/check-balance.md`).

## Compatibility findings for SELAT Agent Wallets

SELAT wallets are Circle **Agent Wallets**: MPC, user-custody, created and
operated through the `circle` CLI after an OTP login
(`circle wallet login --type agent`). The wallet address lives in
`~/.config/selat-pay/.env` as `SELAT_AGENT_WALLET_ADDRESS`. No API key, no
entity secret, no private key ever touches this machine — that is the product
guarantee.

### 1. Deposits via the Circle Wallets adapter: NOT compatible (evidence)

`createCircleWalletsAdapter` is built exclusively for **developer-controlled**
wallets. From the installed package's type definitions
(`@circle-fin/adapter-circle-wallets@1.4.2`, `index.d.ts`):

```ts
interface CircleWalletsAdapterOptions {
  readonly apiKey: string;        // Circle Developer Console API key
  readonly entitySecret: string;  // developer entity custody secret
  readonly baseUrl?: string;
}

interface CircleWalletsAdapterCapabilities extends AdapterCapabilities {
  addressContext: 'developer-controlled';
}
```

The adapter wraps `CircleDeveloperControlledWalletsClient` from
`@circle-fin/developer-controlled-wallets`. Circle's own reference doc
(`references/adapter-circle-wallets.md`) says it is a "reference
implementation for unified balance deposit and spend using Circle
developer-controlled wallets" and requires `CIRCLE_API_KEY` +
`CIRCLE_ENTITY_SECRET`.

Consequences for SELAT:

- The CLI flow simply does not have these credentials: an OTP agent session is
  not an API key, and there is no entity secret for a user-custody MPC wallet.
- Even if a user pasted developer-console credentials, an entity secret is a
  **custody credential** — holding it in the SELAT flow would convert the
  model from self-custody to developer custody. Self-custody is
  non-negotiable, so this path is rejected on principle, not just mechanics.
- The other signing adapters are worse fits: Viem needs a raw private key
  (never handled here), EIP-1193 needs a browser wallet.

So UBK `deposit()` cannot be used. Deposits stay on the existing
skill-wrapped `circle` CLI path (`setup.mjs deposit` / `eco-deposit`), which
signs inside the user's own Circle agent session.

### 2. Balance reads via `getBalances()`: compatible (address-only, no credentials)

Circle's `references/check-balance.md` documents an **address-only** query
mode: "Query balances for a known address without needing a private key or
adapter." Verified live at spike time against the real SELAT agent wallet:

```js
const { UnifiedBalanceKit } = await import("@circle-fin/unified-balance-kit");
const kit = new UnifiedBalanceKit();
await kit.getBalances({ sources: { address: "0xb291…e4da" } });
// 253 ms →
// { token: "USDC", totalConfirmedBalance: "0.010000",
//   breakdown: [{ depositor: "0xB291…e4Da", totalConfirmed: "0.010000",
//     breakdown: [{ chain: "Base", confirmedBalance: "0.010000" }, …11 chains] } ] }
```

This works and is fast — but it is **not the number selat-pay spends
against**. Read back-to-back at spike time for the same wallet:

| Source | Total | Per-chain |
| --- | --- | --- |
| UBK `getBalances()` (address-only) | $0.010000 | Base $0.01 |
| `circle gateway balance --all` (`gatewayBalancesByChain()`) | $1.603601 | Base $0.321122 · Polygon $1.282479 |

The two APIs report different Gateway accountings (UBK reads the
App-Kit/unified-balance deployment; the Circle CLI reads the Gateway wallet
balance that x402/agent payments draw from). Polling UBK's number for `--wait`
could therefore *never* observe a Circle-CLI deposit crediting. So reads stay
on `gatewayBalancesByChain()` — the same source `selat doctor`, `selat run`
and selat-pay use — which also avoids adding a 204-package runtime dependency
(Solana web3, Anchor, ethers subpackages, …) to a CLI whose entire dependency
list is two SELAT packages. If SELAT ever needs credential-free reads
*without* the Circle CLI installed (e.g. a status web page), the address-only
`getBalances()` call shape above is proven — against UBK's own accounting.

### 3. `circle wallet fund --method crypto`: available for the empty-wallet branch

`circle wallet fund --help` (Circle CLI 0.0.5, confirmed locally): on mainnet,
`--method crypto` "prints an EIP-681 QR for an existing mobile wallet", and
`--open` opens the QR HTML page in the browser. No transaction is signed by
the CLI — the user scans and pays from an external wallet, so it is a safe
offer when the agent wallet holds no on-chain USDC.

## What was adopted into `selat fund` (this branch)

Tester-verified problems → fixes, all on the Circle CLI rails:

1. **Success reported 5–10 min before funds are spendable** →
   `selat fund --wait [--timeout <s>]` records the unified balance before the
   deposit, then polls `gateway balance --all` with progress lines until the
   total reflects the deposit (0.9 credit ratio tolerance for Eco fees),
   default 15-minute timeout, non-zero exit if it never credits.
2. **Post-deposit on-chain balance drop reads as "funds lost"** → after every
   deposit the unified balance is printed with the explicit line that the
   on-chain balance dropping is by design (funds moved into Gateway).
3. **Eco settles on Polygon, confusing Base depositors** → the unified-balance
   display dissolves this: one total, "spendable from any supported chain",
   per-chain rows demoted to a routing detail.
4. **Empty wallet used to error downstream** → `selat fund` now checks the
   wallet's on-chain USDC on the deposit chain first and offers
   `circle wallet fund --address … --chain … --amount <shortfall> --method
   crypto --open` (browser QR, EIP-681); in non-interactive shells it prints
   the exact command instead of failing inscrutably later.

## Revisit triggers

- Circle ships a UBK adapter that signs through the **agent** wallet session
  (OTP/MPC) instead of `apiKey` + `entitySecret`.
- SELAT needs Gateway reads where the Circle CLI is not installed —
  address-only `getBalances()` is the proven drop-in.
- UBK's `spend()`/forwarder becomes relevant for selat-pay routing (out of
  scope here; selat-pay signs its own burn intents).
