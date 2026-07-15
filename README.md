# selat-cli

> **Setup helper and runner for SELAT Agent Payments.**

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
3. Checks that Circle CLI is installed.
4. Walks you through Circle Agent Wallet login (one email + one OTP code).
5. Prompts to **reuse your existing agent wallet or create a new one**. If your Circle account holds several agent wallets, it lists them all with their Gateway balances and defaults to the configured or best-funded one — so a fresh host doesn't silently adopt an empty wallet. (`--force` re-creates non-interactively.)
6. Checks whether `selat-pay` is on `PATH`.
7. Writes `~/.config/selat-pay/.env` with your router URL and wallet address.
8. Checks for spendable USDC — **on-chain balance across Base / Optimism / Arbitrum / Polygon** and your Gateway balance (broken down per chain, so you can see which chain holds it) — and, if there's none, points you to `selat fund` (a gasless top-up — Circle sponsors the gas, so no native ETH required).

Then either describe an intent and let the CLI discover + pay:

```bash
selat run "summarize the latest news on gold prices"
```

…or install and run a packaged **agent skill**:

```bash
selat skill install twitter-profile-lookup
selat skill run twitter-profile-lookup --handle openai
```

Either way you get a real paid API response. No API keys, no native ETH to hold, no manually-acquired USDC, no scheme branching, no Unix-streams jargon.

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
| `selat fund [--chain ... --amount ... --method direct\|eco]` | Top up Gateway balance. Dry-runs first; requires explicit confirm. **Both methods are gasless** — the deposit runs through your Circle Agent Wallet (a smart-contract account) and Circle sponsors the gas, so you never need to hold native ETH. The difference is **destination**: **`--method direct`** keeps the balance on the chain you deposited from; **`--method eco`** sources from Base, Optimism, or Arbitrum but settles the resulting Gateway balance on **Polygon** regardless of source chain. After an Eco deposit, pay and check balance with `--chain polygon` (not the source chain), or the call fails with `insufficient_balance`. |
| `selat spend [--json\|--wallet 0x..]` | Unified spend report (read-only): settled spend from the `selat-pay` ledger (per-call payments + Apify token buys, with a charged-but-failed/disputable total) plus Apify token utilization (consumed vs remaining, flagging prepaid-balance waste). |
| `selat budget [--chain BASE] [--json]` | Show the wallet's spending caps and remaining per-window budget (read-only). The caps are Circle wallet policy — the hard ceiling a runaway agent cannot bypass; set them with `setup-policy`. |
| `selat setup-policy` | Set Circle spending caps on your Agent Wallet. Requires an email OTP (Circle's policy-write security). Recommended before any deposit > $20. |
| `selat doctor` | Diagnose setup problems in one pass. Run when something looks off. |
| `selat --help` | This page. |

## Agent skills

Beyond ad-hoc `selat run`, the CLI can install and run **agent skills** — named,
reusable recipes composed of one or more catalogue API endpoints, paid via
`selat-pay` and the SELAT Router. Each skill is a declarative manifest (no
executable code), so installing one only ever writes data.

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

## What this is

`selat` is a thin orchestrator that wires together:

- The **Circle CLI** (`@circle-fin/cli`) — wallet creation, MPC-backed signing, Gateway deposits.
- The **`selat-pay`** CLI ([SELAT-AI/selat-pay](https://github.com/SELAT-AI/selat-pay)) — probe + sign + retry against the SELAT Router, auto-detecting the upstream's protocol (Gateway-batched x402 / MPP) to pick the routed outbound leg.
- The **discovery skill** ([SELAT-AI/selat-discovery](https://github.com/SELAT-AI/selat-discovery)) — federated catalog, intent ranking, payment-plan emission (powers `selat run`).
- **Agent skills** ([SELAT-AI/selat-skills](https://github.com/SELAT-AI/selat-skills)) — installable catalogue-endpoint recipes (powers `selat skill`).

It doesn't reimplement any of them — it just wires them together so a new user can get from `selat init` to their first paid response without hand-editing config files.

## Trust model — what "self-custody" actually means here

"Self-custody" gets used loosely, so here is the mechanism. Your wallet is a
**Circle Agent Wallet**, built on Circle's user-controlled wallet architecture
with **2-of-2 MPC key management**: the private key never exists in one piece —
it exists only as two key shares, and **both** are required to sign. Per
[Circle's docs](https://developers.circle.com/agent-stack/agent-wallets), the
key shares are **never exposed to the agent** (or to SELAT), and the user
retains custody — **Circle cannot unilaterally move funds** without your
involvement. Signing is authorized by your email-OTP login (CLI sessions expire
after 7 days, so you'll re-enter an OTP periodically), and policy writes —
spending caps, allowlists — require a **fresh human OTP** every time. Circle's
public docs don't enumerate where each of the two shares physically lives, and
we won't invent that detail; what they do state is: two shares, both required
to sign, neither exposed to the agent, no unilateral movement by Circle.

Where SELAT sits: below all of that. `selat` and `selat-pay` request signatures
**through the Circle CLI only** — SELAT never sees or holds a private key or
key share, never holds your funds or Gateway balance, and never holds your
Circle login credentials. So this is not seed-phrase custody (there is no
mnemonic to hold) — but it is not classic custodial either: Circle alone cannot
move your money, and neither can SELAT.

## Why bother

Without this wrapper, the setup ordeal is:

1. Install the agent-payment skill manually.
2. Install Circle CLI manually.
3. Run `circle wallet login <email> --type agent` — wait for email — paste OTP.
4. Run `node scripts/setup.mjs create` (from the skill repo).
5. Clone `selat-router`, `cd selat-pay`, `npm install`, `npm link`.
6. Write `~/.config/selat-pay/.env` by hand with router URL + wallet address.
7. Acquire mainnet USDC.
8. Deposit it through Circle Gateway.
9. *Then* try the paid request flow.

`selat init` checks the required local tools and skill, handles Circle login and wallet creation, and writes the config that `selat-pay` consumes. It does not install global dependencies or clone the skill on your behalf.

## Configuration

`selat init` writes:

```
# ~/.config/selat-pay/.env (mode 0600)
SELAT_ROUTER_URL=https://router.selat.ai      # default SELAT Router
SELAT_AGENT_WALLET_ADDRESS=0xYourAgentWalletAddress   # written by `selat init` from your Circle wallet
```

The default points at the SELAT Router at `https://router.selat.ai`.

## Status

**Working beta.** `selat init` bootstraps a Circle Agent Wallet and writes the `selat-pay` config; it skips wallet creation when an agent wallet already exists (use `--force` to re-run). `selat run "<intent>"` discovers, ranks, and pays an x402 / MPP service end to end.

The `selat-discovery` discovery skill and `selat-pay` ship as npm dependencies, so `npm install -g @selat-ai/selat-cli` pulls everything `selat run` needs — no separate skill install or repo clone. (`SELAT_SKILL_PATH`, or a local `~/.codex/skills` / `~/.claude/skills` checkout, still takes precedence if you're developing the discovery skill.)

**Agent skills** (`selat skill`) are not bundled — they're installed on demand from the public [SELAT-AI/selat-skills](https://github.com/SELAT-AI/selat-skills) repo, so the catalog can grow without a CLI release.

## FAQ

**Does my wallet expire?**
No — never. The 14-day expiry some testers hit belongs to **Apify prepaid
tokens** (the ~$1 Bearer tokens `selat run` buys for Apify Actor picks), not to
the wallet. Your Circle Agent Wallet and its Gateway balance have no expiry.
What does recur is **login**: Circle CLI sessions expire after 7 days, so
you'll periodically re-enter an email OTP — that re-authenticates you; it does
not touch the wallet or the funds.

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
3. **Per day / week / month** — the Circle Agent Wallet that SELAT onboards you into has built-in policy: `selat setup-policy` sets per-transaction, daily, weekly, and monthly caps enforced at the money layer, across every service the agent pays — including ones discovered tomorrow. Policy writes require an email OTP, so an agent can't raise its own limits.
4. **Freeze** — a `selat freeze` / `unfreeze` kill switch (pause all signing instantly) is in flight ([#73](https://github.com/SELAT-AI/selat-cli/pull/73)).

Keys slice spend by vendor. Wallets slice it by time. A capped API key and a
capped wallet are the same safety model — a bounded pool with an enforced
ceiling — sliced differently. The honest trade: wallet caps can't cap
per-vendor, but the per-transaction ceiling is one no vendor billing dashboard
offers.

## License

Apache-2.0 — see [LICENSE](LICENSE).
