# selat-cli

> **Setup helper and runner for SELAT Agent Payments.**

The package is `@selat-ai/selat-cli`; it installs the `selat` command.

## Install

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
| `selat run "<intent>"` | Discover + rank + pay in one pipe. Sugar for the discovery skill's `rank.mjs --pick` payment plan. For **Apify** picks, `selat run` uses the prepaid-token model (buy a token via the Router, then call the Actor with a Bearer token) — pass Actor input with `--input '<json>'` or `--input-file <path>`. |
| `selat skill list [--available]` | List installed skills, or the catalog of skills available to install — each with a live **reliability** badge (● ok / ● degraded / ● down / ○ unknown) from the selat-skills auto-verify registry. |
| `selat skill install <name\|path> [--force]` | Install an **agent skill** by name (from the public [selat-skills](https://github.com/SELAT-AI/selat-skills) registry) or from a local path. |
| `selat skill run <name> [--param value ...]` | Run an installed agent skill, passing its params as `--flags`. |
| `selat fund [--chain ... --amount ... --method direct\|eco]` | Top up Gateway balance. Dry-runs first; requires explicit confirm. **Both methods are gasless** — the deposit runs through your Circle Agent Wallet (a smart-contract account) and Circle sponsors the gas, so you never need to hold native ETH. The difference is **destination**: **`--method direct`** keeps the balance on the chain you deposited from; **`--method eco`** sources from Base, Optimism, or Arbitrum but settles the resulting Gateway balance on **Polygon** regardless of source chain. After an Eco deposit, pay and check balance with `--chain polygon` (not the source chain), or the call fails with `insufficient_balance`. |
| `selat spend [--json\|--wallet 0x..]` | Unified spend report (read-only): settled spend from the `selat-pay` ledger (per-call payments + Apify token buys, with a charged-but-failed/disputable total) plus Apify token utilization (consumed vs remaining, flagging prepaid-balance waste). |
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

- **Where skills live:** skill content is maintained in the separate, public repo
  [SELAT-AI/selat-skills](https://github.com/SELAT-AI/selat-skills). The CLI ships
  no skills itself — `selat skill install` fetches the manifest **on demand and
  anonymously** over `raw.githubusercontent.com` (no GitHub auth required) into
  `~/.config/selat/skills/<name>/`.
- **Rails:** a skill step is paid **direct** (Circle nanopayment / Gateway-batched,
  straight to the upstream) or **routed** (erc-3009 or tempo-native MPP, translated
  by the SELAT Router). A run prints a per-rail summary, so a skill that mixes
  rails reports each separately.
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

## What this is

`selat` is a thin orchestrator that wires together:

- The **Circle CLI** (`@circle-fin/cli`) — wallet creation, MPC-backed signing, Gateway deposits.
- The **`selat-pay`** CLI ([SELAT-AI/selat-pay](https://github.com/SELAT-AI/selat-pay)) — probe + sign + retry against the SELAT Router, with direct/routed mode auto-detect.
- The **discovery skill** ([SELAT-AI/selat-discovery](https://github.com/SELAT-AI/selat-discovery)) — federated catalog, intent ranking, payment-plan emission (powers `selat run`).
- **Agent skills** ([SELAT-AI/selat-skills](https://github.com/SELAT-AI/selat-skills)) — installable catalogue-endpoint recipes (powers `selat skill`).

It doesn't reimplement any of them — it just wires them together so a new user can get from `selat init` to their first paid response without hand-editing config files.

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

## License

Apache-2.0 — see [LICENSE](LICENSE).
