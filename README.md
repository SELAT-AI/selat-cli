# juris-cli

> **Setup helper and runner for Juris Agent Payments.**

The package is `@myjuris/juris-cli`; it installs the `juris` command.

## Install

Install from the GitHub repo:

```bash
git clone https://github.com/MyJuris/juris-cli /path/to/juris-cli
cd /path/to/juris-cli
npm install
npm link
```

That exposes the `juris` command on your `PATH`.

If the package has been published to npm, install it with:

```bash
npm install -g @myjuris/juris-cli
```

Then install the agent-payment skill and run:

```bash
juris init
```

That command:

1. Checks your `node`.
2. Checks whether the agent-payment skill is installed.
3. Checks that Circle CLI is installed.
4. Walks you through Circle Agent Wallet login (one email + one OTP code).
5. Creates wallets across all Circle-supported chains.
6. Checks whether `juris-pay` is on `PATH`.
7. Writes `~/.config/juris-pay/.env` with your router URL and wallet address.
8. Optionally claims a **2 USDC welcome drip** so your first paid call works.

Then:

```bash
juris run "summarize the latest news on gold prices"
```

You get a real paid API response. No API keys, no manually-acquired USDC, no scheme branching, no Unix-streams jargon.

## Commands

| Command | What it does |
|---|---|
| `juris init` | Full bootstrap. Idempotent — safe to re-run. |
| `juris run "<intent>"` | Discover + rank + pay in one pipe. Sugar for the skill's `rank.mjs --pick` payment plan. |
| `juris fund [--chain ... --amount ... --method direct\|eco]` | Top up Gateway balance. Dry-runs first; requires explicit confirm. Use `--method eco` for gasless Eco deposits; Base is supported by default (`base` / `8453` / `eip155:8453`), no ETH/native gas deposit is needed in the wallet, and Base is currently the only Eco chain. |
| `juris setup-policy` | Set Circle spending caps on your Agent Wallet. Requires an email OTP (Circle's policy-write security). Recommended before any deposit > $20. |
| `juris doctor` | Diagnose setup problems in one pass. Run when something looks off. |
| `juris --help` | This page. |

## What this is

`juris` is a thin orchestrator that bundles three pieces:

- The **Circle CLI** (`@circle-fin/cli`) — wallet creation, MPC-backed signing, Gateway deposits.
- The **`juris-pay`** CLI ([MyJuris/juris-router/juris-pay](https://github.com/MyJuris/juris-router/tree/main/juris-pay)) — probe + sign + retry against the Juris Router, with direct/routed mode auto-detect.
- The **discovery skill** ([MyJuris/juris-agent-payments](https://github.com/MyJuris/juris-agent-payments)) — federated catalog, intent ranking, payment-plan emission.

It doesn't reimplement any of them — it just wires them together so a new user can get from `juris init` to their first paid response without hand-editing config files.

## Why bother

Without this wrapper, the setup ordeal is:

1. Install the agent-payment skill manually.
2. Install Circle CLI manually.
3. Run `circle wallet login <email> --type agent` — wait for email — paste OTP.
4. Run `node scripts/setup.mjs create` (from the skill repo).
5. Clone `juris-router`, `cd juris-pay`, `npm install`, `npm link`.
6. Write `~/.config/juris-pay/.env` by hand with router URL + wallet address.
7. Acquire mainnet USDC.
8. Deposit it through Circle Gateway.
9. *Then* try the paid request flow.

`juris init` checks the required local tools and skill, handles Circle login and wallet creation, and writes the config that `juris-pay` consumes. It does not install global dependencies or clone the skill on your behalf.

## Configuration

`juris init` writes:

```
# ~/.config/juris-pay/.env (mode 0600)
JURIS_ROUTER_URL=https://router.juris.fund      # demo router (pre-launch)
JURIS_AGENT_WALLET_ADDRESS=0xb71105c418b671cd8e6b983611c1fa142d22f51b
```

The default points at the **demo router** at `https://router.juris.fund` — a pre-launch endpoint with no SLA. Availability, pricing, and the trust-minimization story (see the [trust-minimization roadmap](https://github.com/MyJuris/juris-router/blob/main/trust-minimization-proposal.md)) are still evolving; treat it as a sandbox, not production. Override with your own router URL via `--router-url=` when one is available. If you do override to a plain `http://` URL, init prints a MITM warning at runtime — a network attacker on the path can rewrite `payTo` in the 402 and capture the signed payment.

Override the router URL at init time: `juris init --router-url=https://custom.example`

Override at runtime per call: `JURIS_ROUTER_URL=... juris run "..."`

## Status

**v0.1.0 — scaffolding.** Init flow works against existing agent-payment skill, Circle CLI, and juris-pay; welcome-drip step is stubbed (endpoint spec at [MyJuris/juris-router#6](https://github.com/MyJuris/juris-router/pull/6)). `juris init` checks for the skill and `juris-pay`, then prints guidance if either is missing.

## License

Apache-2.0 — see [LICENSE](LICENSE).
