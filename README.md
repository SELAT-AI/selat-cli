# selat-cli

> **`selat` is the command-line runner for SELAT Agent Payments: an AI agent discovers, vets, and pays x402 / MPP APIs in USDC — per call, with no API keys, no gas token, and no seed phrase — from the user's own self-custodied agent wallet.**

SELAT is a discovery and payment layer for AI agents. The agent states an intent ("search the web", "look up a Twitter profile"); SELAT finds matching paid endpoints across a federated x402 / MPP catalog, ranks them by price, rail, and reliability, and settles the call in USDC. SELAT never holds your keys or your funds.

The package is `@selat-ai/selat-cli`; it installs the `selat` command.

## Install

**Prerequisites:** Node.js ≥ 18 (ships with npm). No Python needed.

Install from npm:

```bash
npm install -g @selat-ai/selat-cli
```

That exposes the `selat` command on your `PATH`.

Then run:

```bash
selat init
```

That command:

1. Checks your `node`.
2. Checks whether the agent-payment skill is installed.
3. Checks for its signing dependency (the Circle CLI).
4. Signs you into your agent wallet (one email + one OTP code).
5. Prompts to **reuse your existing agent wallet or create a new one**. If you hold several agent wallets, it lists them all with their Gateway balances and defaults to the configured or best-funded one — so a fresh host doesn't silently adopt an empty wallet. (`--force` re-creates non-interactively.)
6. Checks whether `selat-pay` is on `PATH`.
7. Writes `~/.config/selat-pay/.env` with your router URL and wallet address.
8. Checks for spendable USDC — **on-chain balance across Base / Optimism / Arbitrum / Polygon** and your Gateway balance (broken down per chain, so you can see which chain holds it) — and, if there's none, points you to `selat fund` (a gasless top-up with sponsored gas — no native ETH required).

Then either describe an intent and let the CLI discover + pay:

```bash
selat run "summarize the latest news on gold prices"
```

…or install and run a packaged **agent skill**:

```bash
selat skill install twitter-profile-lookup
selat skill run twitter-profile-lookup --handle openai
```

Either way you get a real paid API response. No API keys. No native ETH. No bridging, no chain-picking. No payment-scheme guesswork.

## Commands

| Command | What it does |
|---|---|
| `selat init` | Full bootstrap. Idempotent — safe to re-run. |
| `selat run "<intent>"` | Discover + rank + pay in one pipe. Sugar for the discovery skill's `rank.mjs --pick` payment plan. `--param key=value` (repeatable) fills endpoint parameters: path placeholders are substituted, query params appended/replaced, and body params merged for POST hints — when a pick is refused because required params are missing, `selat run` prints which ones and the exact `--param` retry line (nothing is charged). For **Apify** picks, `selat run` uses the prepaid-token model (buy a token via the Router, then call the Actor with a Bearer token) — pass Actor input with `--input '<json>'` or `--input-file <path>`. `--auto-rebuy` (**Apify picks only**) buys a replacement token (~$1, a new spend) and retries once if the token drains mid-run; without it, a depleted token surfaces an error and re-running buys the replacement. On any non-Apify (per-call x402) pick the flag is ignored with a warning. |
| `selat skill list [--available]` | List installed skills, or the catalog of skills available to install — each with a live **reliability** badge (● ok / ● degraded / ● down / ○ unknown) from the selat-skills auto-verify registry. |
| `selat skill install <name\|path> [--force]` | Install an **agent skill** by name (from the public [selat-skills](https://github.com/SELAT-AI/selat-skills) registry) or from a local path. |
| `selat skill run <name> [--param value ...]` | Run an installed agent skill, passing its params as `--flags`. |
| `selat skill compare "<intent>" [--limit N] [--json] [--pay]` | Vet catalog candidates for an intent **side-by-side, without accounts or keys**: shortlists the top N (default 5) via the same federated discovery as `selat search`, free-probes each candidate's live 402 at its **catalog serviceUrl** (never settles), and prints one aligned table — live price, rail (direct x402 / routed MPP), probe latency, reachability, and the selat-skills registry reliability badge — sorted reachable-first, then price. `--json` for machine consumption. `--pay` adds one **capped settled test call** per candidate (asks for confirmation first; `--yes` to authorize non-interactively; `--max-amount` overrides the per-call cap, which otherwise defaults to live price + 25 % clamped to $1) and saves each response body as an output sample. Apify prepaid-token candidates are probed but skipped by `--pay` — test those with `selat run`. |
| `selat skill new/validate/verify/register/submit` | Author and contribute a skill: scaffold → static SOP check → live-402 verify (writes the receipt that gates submission) → index entry → PR to [selat-skills](https://github.com/SELAT-AI/selat-skills). `submit` opens the PR **from your fork by default** unless you have write access to the skills repo; `--fork` / `--no-fork` force either flow. |
| `selat fund [--chain ... --amount ... --method direct\|eco]` | Top up Gateway balance. Dry-runs first; requires explicit confirm. **Both methods are gasless** — the deposit runs through your agent wallet (a smart-contract account) with sponsored gas, so you never need to hold native ETH. The difference is **destination**: **`--method direct`** keeps the balance on the chain you deposited from; **`--method eco`** sources from Base, Optimism, or Arbitrum but settles the resulting Gateway balance on **Polygon** regardless of source chain. After an Eco deposit, pay and check balance with `--chain polygon` (not the source chain), or the call fails with `insufficient_balance`. |
| `selat spend [--json\|--wallet 0x..]` | Unified spend report (read-only): settled spend from the `selat-pay` ledger (per-call payments + Apify token buys, with a charged-but-failed/disputable total) plus Apify token utilization (consumed vs remaining, flagging prepaid-balance waste). |
| `selat budget [--json]` | Show the wallet's spending caps and remaining per-window budget (read-only). The caps are enforced at the wallet layer — the hard ceiling a runaway agent cannot bypass; `selat setup-policy` sets them. |
| `selat setup-policy` | Set hard spending caps on your agent wallet, enforced at the money layer. Requires an email OTP — every policy write demands fresh human authorization. Recommended before any deposit > $20. |
| `selat doctor` | Diagnose setup problems in one pass. Run when something looks off. |
| `selat --help` | This page. |

## What are agent skills?

An **agent skill** is a named, reusable recipe composed of one or more
catalogue API endpoints, paid via `selat-pay` and the SELAT Router. Each skill
is a declarative manifest — no executable code — so installing one only ever
writes data, never runs it.

```bash
selat skill list --available                 # browse the catalog (with reliability badges)
selat skill install twitter-profile-lookup   # install a skill
selat skill run twitter-profile-lookup --handle openai   # run it
selat skill run person-lookup --query "Patrick Collison Stripe"
```

Composing a skill and choosing between competing endpoints? Benchmark them
first — free:

```bash
selat skill compare "search the web for recent news" --limit 3   # price/rail/latency/reliability, no spend
selat skill compare "token prices" --pay --max-amount 0.05       # + one capped settled test call each (confirmed)
```

- **Where skills live:** skill content is maintained in the separate, public repo
  [SELAT-AI/selat-skills](https://github.com/SELAT-AI/selat-skills). The CLI ships
  no skills itself — `selat skill install` fetches the manifest **on demand and
  anonymously** over `raw.githubusercontent.com` (no GitHub auth required) into
  `~/.config/selat/skills/<name>/`.
- **Rails:** every skill step is paid **through the SELAT Router**. The step's
  rail describes the router's outbound leg to the upstream: Gateway-batched
  (same-rail passthrough, for upstreams that take Circle Gateway themselves) or
  erc-3009 / tempo-native MPP (cross-protocol translation). A run prints a
  per-rail summary, so a skill that mixes rails reports each separately.
- **Params:** pass a skill's inputs as `--flags` (e.g. `--handle openai`).
  `--chain` and `--max-amount` are reserved per-run overrides applied to every step.
  The `--chain` you pay on must match the chain your Gateway balance lives on: if
  you funded with `selat fund --method eco` (source Base/Optimism/Arbitrum), that
  balance settles on **Polygon**, so use `--chain polygon`. Run
  `circle gateway balance --address <wallet> --chain polygon --all` to see which
  chain holds your USDC — `--all` lists every chain, so the `--chain` you pass only
  resolves the wallet address.
- **Overrides:** `SELAT_SKILLS_DIR` points at a local checkout of the skills repo
  (dev); `SELAT_SKILLS_REPO` / `SELAT_SKILLS_REF` / `SELAT_SKILLS_RAW_BASE` retarget
  the registry. You can also `selat skill install ./path/to/skill` from disk.

Skills are authored to the [Agent Skill SOP](https://github.com/SELAT-AI/selat-discovery/blob/main/references/agent-skill-authoring-sop.md):
each is a folder with `SKILL.md`, `manifest.json`, `references/endpoints.md`, and `evals/`.

To contribute one, the CLI walks the whole loop inside a checkout of the skills repo:

```bash
selat skill new my-skill --dir skills      # scaffold (SOP layout)
selat skill validate ./skills/my-skill     # static SOP check
selat skill verify   ./skills/my-skill     # live 402 probe per step (free, no spend) — writes the receipt that gates submit
selat skill submit   ./skills/my-skill     # branch + commit + push + PR to SELAT-AI/selat-skills
```

`submit` is fork-aware. With write access to the skills repo it pushes the
branch there (the maintainer flow); otherwise it **forks on demand** via `gh`,
pushes the branch to your fork as a separate `fork` remote — `origin` is never
rewired — and opens the PR cross-fork. No `gh` at all? The branch is still
pushed with plain git and you get the manual `gh pr create` command. `--fork` /
`--no-fork` force either flow, and `--dry-run` previews the branch, files, and
PR body without touching git.

## What is selat-cli?

`selat` is a thin orchestrator. It wires together four components and reimplements none of them:

- The **`selat-pay`** CLI ([SELAT-AI/selat-pay](https://github.com/SELAT-AI/selat-pay)) — probe + sign + retry against the SELAT Router, auto-detecting the upstream's protocol (Gateway-batched x402 / MPP) to pick the routed outbound leg.
- The **discovery skill** ([SELAT-AI/selat-discovery](https://github.com/SELAT-AI/selat-discovery)) — federated catalog, intent ranking, payment-plan emission (powers `selat run`).
- **Agent skills** ([SELAT-AI/selat-skills](https://github.com/SELAT-AI/selat-skills)) — installable catalogue-endpoint recipes (powers `selat skill`).
- The **Circle CLI** (`@circle-fin/cli`) — the custody layer `selat` delegates to: wallet creation, MPC-backed signing, Gateway deposits. `selat` never signs anything itself.

One command — `selat init` — takes a new user to their first paid response with no hand-edited config files.

## How does self-custody work?

**Your wallet is yours. SELAT never holds your keys, your funds, or your credentials.** Here is the exact mechanism.

`selat init` provisions you a dedicated **agent wallet** with **2-of-2 MPC key
management**, built on [Circle's user-controlled wallet architecture](https://developers.circle.com/agent-stack/agent-wallets).
The private key never exists in one piece: it exists only as two key shares,
and **both are required to sign**. The key shares are **never exposed to the
agent — or to SELAT** — and the user retains custody: **Circle, the custody
provider, cannot unilaterally move your funds.**

`selat` authorizes every signature through your email-OTP login (sessions
expire after a few weeks — `circle wallet status` shows the exact time
remaining — so you re-enter an OTP periodically). Policy writes —
spending caps, allowlists — require a **fresh human OTP every time**, so an
agent can never raise its own limits.

SELAT's own code never touches key material. `selat` and `selat-pay` request
signatures **through the Circle CLI only**:

- SELAT **never** sees or holds a private key or key share.
- SELAT **never** holds your funds or your Gateway balance.
- SELAT **never** holds your login credentials.

This is self-custody without a seed phrase: there is no mnemonic to lose, and
no counterparty that can spend your money without you — not the custody
provider alone, and not SELAT. Stop using SELAT tomorrow and your wallet and
balance remain yours, accessible through Circle's own tooling with no SELAT
software in the path.

## Why use selat-cli?

Without it, the setup ordeal is:

1. Install the agent-payment skill manually.
2. Install Circle CLI manually.
3. Run `circle wallet login <email> --type agent` — wait for email — paste OTP.
4. Run `node scripts/setup.mjs create` (from the skill repo).
5. Clone `selat-router`, `cd selat-pay`, `npm install`, `npm link`.
6. Write `~/.config/selat-pay/.env` by hand with router URL + wallet address.
7. Acquire mainnet USDC.
8. Deposit it through Circle Gateway.
9. *Then* try the paid request flow.

`selat init` checks the required local tools and skill, handles wallet login and creation, and writes the config that `selat-pay` consumes. It does not install global dependencies or clone the skill on your behalf.

## Configuration

`selat init` writes:

```
# ~/.config/selat-pay/.env (mode 0600)
SELAT_ROUTER_URL=https://router.selat.ai      # default SELAT Router
SELAT_AGENT_WALLET_ADDRESS=0xYourAgentWalletAddress   # written by `selat init` from your agent wallet
```

The default points at the SELAT Router at `https://router.selat.ai`.

## Status

`selat init` bootstraps your agent wallet and writes the `selat-pay` config; it skips wallet creation when an agent wallet already exists (use `--force` to re-run). `selat run "<intent>"` discovers, ranks, and pays an x402 / MPP service end to end.

The `selat-discovery` discovery skill and `selat-pay` ship as npm dependencies, so `npm install -g @selat-ai/selat-cli` pulls everything `selat run` needs — no separate skill install or repo clone. (`SELAT_SKILL_PATH`, or a local `~/.codex/skills` / `~/.claude/skills` checkout, still takes precedence if you're developing the discovery skill.)

**Agent skills** (`selat skill`) are not bundled — they're installed on demand from the public [SELAT-AI/selat-skills](https://github.com/SELAT-AI/selat-skills) repo, so the catalog can grow without a CLI release.

## FAQ

**Does my wallet expire?**
No. Never. Your agent wallet and its Gateway balance have no expiry.
Only **Apify prepaid tokens** expire — the ~$1 Bearer tokens `selat run`
buys for Apify Actor picks lapse after 14 days. That's the token, not
your wallet or your balance.
What does recur is **login**: signing sessions expire after a few weeks
(`circle wallet status` shows the time remaining), so you'll periodically
re-enter an email OTP — that re-authenticates you; it does not touch the
wallet or the funds.

**I deposited on one chain — where did my money go?**
Into **one unified Gateway balance**: one balance, spendable from any supported
chain. The per-chain breakdown you see in `selat doctor` is where the balance
is held — a routing detail, not a separate account per chain (today the
`--chain` you pass at pay time points at the chain that holds it — see the
`selat fund` row above). And your on-chain wallet balance dropping after a
deposit is by design: the funds moved into Gateway, they are not lost.

**What stops a runaway agent from draining the wallet?**
A ladder of caps, each at a different scope:

1. **Per call** — `--max-amount` on `selat run` / `selat skill run` / `selat skill compare --pay`: a hard ceiling on any single payment.
2. **Per session** — `selat budget start --amount <usd>`: a spending tripwire for the current work session (`selat budget stop` disarms; `selat budget` shows state).
3. **Per day / week / month** — `selat setup-policy` sets per-transaction, daily, weekly, and monthly caps on your agent wallet, enforced at the money layer across every service the agent pays — including ones discovered tomorrow. Policy writes require an email OTP, so an agent can't raise its own limits.
4. **Freeze** — a `selat freeze` / `unfreeze` kill switch (pause all signing instantly) is in flight ([#73](https://github.com/SELAT-AI/selat-cli/pull/73)).

Keys slice spend by vendor. Wallets slice it by time. A capped API key and a
capped wallet are the same safety model — a bounded pool with an enforced
ceiling — sliced differently. The honest trade: wallet caps can't cap
per-vendor, but the per-transaction ceiling is one no vendor billing dashboard
offers.

## License

Apache-2.0 — see [LICENSE](LICENSE).
