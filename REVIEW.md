# Code Review: selat-cli

## Purpose

**selat-cli** is a lightweight Node.js CLI orchestrator that bootstrap the SELAT agent payments ecosystem. It bundles Circle CLI integration, selat-pay CLI resolution, and agent-payment skill discovery into a single `selat init` → `selat run` workflow. Users install this CLI once, run init to set up wallets/config, then call `selat run "<intent>"` to discover, rank, and pay for x402-routed API calls. It is the user-facing entry point for the broader SELAT ecosystem, which includes:
- **selat-pay**: standalone CLI that signs and retries payments to the SELAT Router
- **selat-router**: server that proxies paid upstream requests and handles x402/MPP payment flows
- **selat-discovery**: discovery skill that ranks and plans paid service calls

selat-cli itself doesn't reimplement these pieces; it orchestrates them and hides the setup plumbing.

## Structure

```
bin/
  selat.mjs               CLI entry point; command router and help
lib/
  commands/
    init.mjs              Bootstrap (Circle auth, wallet create, config write)
    run.mjs               Discover + rank + pay in one pipe
    doctor.mjs            Diagnose setup state (versions, auth, wallet, skill, routes)
    fund.mjs              Top up Circle Gateway balance
    setup-policy.mjs      Set Circle spending policy caps
  circle.mjs              Circle CLI wrappers (auth, wallet, Gateway balance)
  config.mjs              XDG ~/.config/selat-pay/.env read/write
  selat-pay.mjs           Bundled vs. global selat-pay resolver
  skill.mjs               Agent-payment skill finder (multiple candidate paths)
  sh.mjs                  Promise-based shell spawn + bin detection
  ui.mjs                  ANSI formatting, prompts, progress (zero deps)
package.json              Declares @selat-ai/selat-pay ^0.1.0 as sole dependency
```

~1200 lines of ES2022 JavaScript; no external deps except selat-pay.

---

## Top 3-5 Issues

### 1. **Missing validation of router URL in fund.mjs** (lib/commands/fund.mjs, lines 26–32)

**What:** fund.mjs reads --chain and --amount via `arg()` helper, which has no null-safety. If the arg is present but followed by EOF or another flag, `arg()` returns null, and the code silently falls through to interactive prompt. This is unintuitive UX for scripting.

**Why:** Subtle silent-failure path; users expecting `selat fund --chain base --amount 2 --method eco --other-flag` to error will instead see a prompt.

**Fix:** Make `arg()` stricter: if `--chain` is present, require a value immediately after, else error. Or parse all args with a proper arg parser (yargs/minimist) rather than bespoke logic.

---

### 2. **Network error handling in doctor.mjs is incomplete** (lib/commands/doctor.mjs, lines 107–109)

**What:** The router healthz check uses curl with `--max-time 5`, but only checks if the HTTP status is "200". If curl errors (network unreachable, DNS failure, timeout), the code reports "unreachable or returned ...", which is ambiguous.

**Why:** Operators running `selat doctor` won't know if the failure is a genuine network outage, a DNS issue, or a timeout. The error message lumps all failures together.

**Fix:** Parse curl exit code separately; differentiate timeouts, connection errors, and HTTP 4xx/5xx. Return more granular diagnostics.

---

### 3. **Config parsing in config.mjs is naive** (lib/config.mjs, lines 44–59)

**What:** parseEnv() splits on `=` and strips quotes, but doesn't handle:
- Escaped quotes (`\"` inside quoted strings)
- Multiline values
- Comments after values (`KEY=value # comment`)
- Environment variable expansion (`$OTHER_KEY`)

**Why:** Minimal risk for current use cases (only stores router URL and wallet address), but fragile if config expands. A user might paste a wallet address with a trailing comment and have the parse silently truncate it.

**Fix:** Use a proper .env parser (dotenv already vendored by selat-pay), or document the strict format and validate against it.

---

### 4. **Unsafe shell command construction in fund.mjs and doctor.mjs** (lib/commands/fund.mjs, lines 56–59; lib/commands/doctor.mjs, line 107)

**What:** Both commands pass user-controlled chain names and router URLs directly into sh() without validation. In doctor.mjs, the router URL is embedded in a curl command string.

```javascript
const r = await sh("curl", ["-sS", "-m", "5", ..., `${cfg.SELAT_ROUTER_URL}/healthz`]);
```

**Why:** While sh() uses spawn (not shell=true), if SELAT_ROUTER_URL is ever read from an untrusted source (unlikely now, but config file could be manipulated), the URL is not escaped. Fund.mjs passes `chainArg` directly to Circle CLI, which should be safe but is not validated first.

**Fix:** Validate router URL against a whitelist or strict URL parser before use. Validate chain names against Circle's known list (BASE, ETH, ARB, OP, POLY, AVAX, UNI, MONAD). Consider URL.parse() for the router URL.

---

### 5. **Incomplete welcome-drip stub** (lib/commands/init.mjs, lines 213–227)

**What:** claimWelcomeDrip() is a stub that always returns `ok: false` with a message pointing to a PR. The EIP-712 signing logic and welcome-drip endpoint call are documented but not implemented. This is fine for v0.1, but the code path still runs if the user selects yes.

**Why:** UX hiccup: init will appear to fail the welcome drip step even though the overall init succeeds. Users unfamiliar with the stub will think something broke. The code also references the Circle CLI's `circle wallet sign typed-data` command, which is not validated to exist.

**Fix:** When the endpoint lands, implement the EIP-712 signing. For now, improve the prompt messaging: "Claim 2 USDC (requires endpoint deployment; skipping for now)?" or skip the step entirely in v0.

---

## Cross-Repo Notes

- **Version mismatch risk:** selat-cli bundles `@selat-ai/selat-pay@^0.1.0` but selat-pay is currently at 0.2.2 (package.json shows 0.2.2). The caret allows npm to install 0.2.2, which should be compatible, but the version constraint is stale. Consider updating to `^0.2.2` or pinning to the exact version you're tested against.

- **Config schema consistency:** selat-cli writes SELAT_ROUTER_URL and SELAT_AGENT_WALLET_ADDRESS to ~/.config/selat-pay/.env. selat-pay reads these vars. Both repos should document the schema (types, required fields) in a shared file or in the main README. Currently, config is documented only in selat-cli/README.md; selat-pay README doesn't mention it.

- **Circle CLI binary name assumption:** selat-cli respects CIRCLE_BIN env var (defaults to "circle") and checks it with `hasBin("circle")`. selat-pay likely calls circle as well. If the binary is renamed or namespaced, both repos need updates. No shared Circle CLI wrapper library. Consider extracting Circle helpers into a shared package if the ecosystem grows.

- **No dependency on selat-discovery for skill location:** selat-cli hard-codes skill candidate paths (~/.codex/skills/selat-discovery and ~/.claude/skills/selat-discovery). If the skill repo changes its install directory or the agent framework updates, selat-cli is blind. Document the contract in the skill repo's README or via an env var.

---

## Quick Wins

### 1. **Replace ad-hoc arg parsing with a real arg parser** (lib/commands/fund.mjs, lines 89–102)

Current logic with `arg()` is fragile. A ~10-line swap to [yargs](https://www.npmjs.com/package/yargs) or [minimist](https://www.npmjs.com/package/minimist) would add clarity and handle edge cases (missing values, unknown flags). **Effort: 30 min.**

### 2. **Extract Circle CLI wrappers into a shared utility** (lib/circle.mjs)

Selat-pay likely duplicates some of this logic. Move circle.mjs + selat-pay's equiv into a separate @selat-ai/circle-cli-helpers package, published to npm. Future repos benefit and avoid duplication. **Effort: 1–2 hours.**

### 3. **Document config schema formally** (README.md + a new docs/CONFIG.md)

Add a table listing each env var (SELAT_ROUTER_URL, SELAT_AGENT_WALLET_ADDRESS), type, default, and whether it's required. Both selat-cli and selat-pay should reference it. **Effort: 30 min.**

### Bonus: Update selat-pay dependency version constraint from ^0.1.0 to ^0.2.2 (or pin exact if you've tested thoroughly). **Effort: 2 min.**

---

## Summary

selat-cli is well-structured, idempotent, and handles the core setup workflow cleanly. The UI/UX is thoughtful (progress steps, color output, helpful errors). Main gaps are:

1. Stricter input validation (args, URLs, env vars).
2. Better error narratives (network diagnostics, stub messaging).
3. Fragile config parsing (works for v0, but risky if config schema expands).
4. Version + schema drift between sibling repos (document and sync contracts).

No critical bugs or security issues; these are ergonomic and maintainability improvements for a pre-1.0 CLI at an early stage.

