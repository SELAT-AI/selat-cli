# selat-cli

> **Setup helper and runner for SELAT Agent Payments.**

The package is `@selat-ai/selat-cli`; it installs the `selat` command.

## Install

Install from the GitHub repo:

```bash
git clone https://github.com/SELAT-AI/selat-cli /path/to/selat-cli
cd /path/to/selat-cli
npm install
npm link
```

That exposes the `selat` command on your `PATH`.

If the package has been published to npm, install it with:

```bash
npm install -g @selat-ai/selat-cli
```

Then install the agent-payment skill and run:

```bash
selat init
```

That command:

1. Checks your `node`.
2. Checks whether the agent-payment skill is installed.
3. Checks that Circle CLI is installed.
4. Walks you through Circle Agent Wallet login (one email + one OTP code).
5. Prompts to **reuse your existing agent wallet or create a new one**, then ensures wallets exist across all Circle-supported chains. (`--force` re-creates non-interactively.)
6. Checks whether `selat-pay` is on `PATH`.
7. Writes `~/.config/selat-pay/.env` with your router URL and wallet address.
8. Checks for spendable USDC — **on-chain balance across Base / Optimism / Arbitrum** and your Gateway balance — and, if there's none, optionally claims a **2 USDC welcome drip** or points you to `selat fund`.

Then either describe an intent and let the CLI discover + pay:

```bash
selat run "summarize the latest news on gold prices"
```

…or install and run a packaged **agent skill**:

```bash
selat skill install market-snapshot
selat skill run market-snapshot
```

Either way you get a real paid API response. No API keys, no manually-acquired USDC, no scheme branching, no Unix-streams jargon.

## Commands

| Command | What it does |
|---|---|
| `selat init` | Full bootstrap. Idempotent — safe to re-run. |
| `selat run "<intent>"` | Discover + rank + pay in one pipe. Sugar for the discovery skill's `rank.mjs --pick` payment plan. |
| `selat skill list [--available]` | List installed skills, or the catalog of skills available to install — each with a live **reliability** badge (● ok / ● degraded / ● down / ○ unknown) from the selat-skills auto-verify registry. |
| `selat skill install <name\|path> [--force]` | Install an **agent skill** by name (from the public [selat-skills](https://github.com/SELAT-AI/selat-skills) registry) or from a local path. |
| `selat skill run <name> [--param value ...]` | Run an installed agent skill, passing its params as `--flags`. |
| `selat fund [--chain ... --amount ... --method direct\|eco]` | Top up Gateway balance. Dry-runs first; requires explicit confirm. Use `--method eco` for gasless Eco deposits; Base is supported by default (`base` / `8453` / `eip155:8453`), no ETH/native gas deposit is needed in the wallet, and Base is currently the only Eco chain. |
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
selat skill install market-snapshot          # install a skill
selat skill run market-snapshot              # run it
selat skill run token-price --symbols ETH,USDC
```

- **Where skills live:** skill content is maintained in the separate, public repo
  [SELAT-AI/selat-skills](https://github.com/SELAT-AI/selat-skills). The CLI ships
  no skills itself — `selat skill install` fetches the manifest **on demand and
  anonymously** over `raw.githubusercontent.com` (no GitHub auth required) into
  `~/.config/selat/skills/<name>/`.
- **Rails:** a skill step is paid **direct** (Circle nanopayment / Gateway-batched,
  straight to the upstream) or **routed** (erc-3009 or tempo-native MPP, translated
  by the SELAT Router). Multi-rail skills (e.g. `market-snapshot`,
  `crypto-sentiment-snapshot`) exercise both in one run and print a per-rail summary.
- **Params:** pass a skill's inputs as `--flags` (e.g. `--symbols ETH,USDC`).
  `--chain` and `--max-amount` are reserved per-run overrides applied to every step.
- **Overrides:** `SELAT_SKILLS_DIR` points at a local checkout of the skills repo
  (dev); `SELAT_SKILLS_REPO` / `SELAT_SKILLS_REF` / `SELAT_SKILLS_RAW_BASE` retarget
  the registry. You can also `selat skill install ./path/to/skill` from disk.

Skills are authored to the [Agent Skill SOP](https://github.com/SELAT-AI/selat-agent-payments/blob/main/references/agent-skill-authoring-sop.md):
each is a folder with `SKILL.md`, `manifest.json`, `references/endpoints.md`, and `evals/`.

## What this is

`selat` is a thin orchestrator that wires together:

- The **Circle CLI** (`@circle-fin/cli`) — wallet creation, MPC-backed signing, Gateway deposits.
- The **`selat-pay`** CLI ([SELAT-AI/selat-pay](https://github.com/SELAT-AI/selat-pay)) — probe + sign + retry against the SELAT Router, with direct/routed mode auto-detect.
- The **discovery skill** ([SELAT-AI/selat-agent-payments](https://github.com/SELAT-AI/selat-agent-payments)) — federated catalog, intent ranking, payment-plan emission (powers `selat run`).
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
SELAT_AGENT_WALLET_ADDRESS=0xb71105c418b671cd8e6b983611c1fa142d22f51b
```

The default points at the SELAT Router at `https://router.selat.ai`. You can override it with your own router URL via `--router-url=`. If you override to a plain `http://` URL, init prints a MITM warning at runtime — a network attacker on the path can rewrite `payTo` in the 402 and capture the signed payment.

Override the router URL at init time: `selat init --router-url=https://custom.example`

Override at runtime per call: `SELAT_ROUTER_URL=... selat run "..."`

## Status

**Working beta.** `selat init` bootstraps a Circle Agent Wallet and writes the `selat-pay` config; it skips wallet creation when an agent wallet already exists (use `--force` to re-run). `selat run "<intent>"` discovers, ranks, and pays an x402 / MPP service end to end.

The `selat-agent-payments` discovery skill and `selat-pay` ship as npm dependencies, so `npm install -g @selat-ai/selat-cli` pulls everything `selat run` needs — no separate skill install or repo clone. (`SELAT_SKILL_PATH`, or a local `~/.codex/skills` / `~/.claude/skills` checkout, still takes precedence if you're developing the discovery skill.)

**Agent skills** (`selat skill`) are not bundled — they're installed on demand from the public [SELAT-AI/selat-skills](https://github.com/SELAT-AI/selat-skills) repo, so the catalog can grow without a CLI release.

The optional welcome-drip step is still stubbed pending the router endpoint (spec at [SELAT-AI/selat-router#6](https://github.com/SELAT-AI/selat-router/pull/6)).

## License

Apache-2.0 — see [LICENSE](LICENSE).
