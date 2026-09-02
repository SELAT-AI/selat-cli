/**
 * `selat doctor` — diagnose setup problems. Single pass through:
 *   - Node / npm / git version
 *   - Circle CLI installed + authed
 *   - Agent wallet exists
 *   - Gateway balance
 *   - agent-payment skill installed
 *   - selat-pay installed
 *   - ~/.config/selat-pay/.env present and valid
 *   - Router URL reachable
 */

import { fmt } from "../ui.mjs";
import { sh, binVersion } from "../sh.mjs";
import {
  spendingPolicyByChain,
  describeChainPolicy, authStatus, getAgentAddress, gatewayBalancesByChain, listAgentWallets, usdcBalances, hasCircle,
  lastCircleReadError } from "../circle.mjs";
import { resolveSelatPay, selatPayVersion } from "../selat-pay.mjs";
import { readConfig, configPath } from "../config.mjs";
import { findSkill, packagedSkillPath, skillInstallLines, skillPackageVersion, skillSource } from "../skill.mjs";
import { safeHttpUrl } from "../url-safety.mjs";

export async function doctor(args = []) {
  // Per-chain Gateway rows confuse more than they inform (live onboarding
  // feedback: users read them as separate balances). Default = ONE number;
  // --by-chain opts into the routing-detail rows.
  const byChain = args.includes("--by-chain");
  console.log(fmt.bold("\nselat doctor — checking your setup"));
  console.log("");

  let failures = 0;
  const fail = (msg) => { failures++; console.log("  " + fmt.err(msg)); };
  const pass = (msg) => console.log("  " + fmt.ok(msg));
  const warn = (msg) => console.log("  " + fmt.warn(msg));

  // Binaries
  console.log(fmt.bold("Binaries:"));
  for (const bin of ["node", "npm", "git"]) {
    const v = await binVersion(bin);
    if (v) pass(`${bin} ${v}`);
    else fail(`${bin} not on PATH`);
  }

  // Agent-payment skill
  console.log(fmt.bold("\nAgent-payment skill:"));
  const skill = findSkill("rank.mjs");
  if (skill.found) {
    const source = skillSource(skill.path);
    const version = skillPackageVersion(skill.path);
    pass(`skill at ${skill.path}${version ? ` (${source}, v${version})` : ` (${source})`}`);
    const packaged = packagedSkillPath();
    if (source !== "bundled" && packaged) {
      const bundledVersion = skillPackageVersion(packaged);
      const versionText = version && bundledVersion && version !== bundledVersion
        ? `local v${version} shadows bundled v${bundledVersion}`
        : "local checkout shadows the bundled discovery dependency";
      warn(`${versionText}; unset SELAT_SKILL_PATH or move the local skill to use the packaged copy`);
    }
  } else {
    fail("agent-payment skill not found — `selat run` needs it for discovery and ranking");
    for (const line of skillInstallLines(skill.path)) console.log("  " + fmt.dim(line));
  }

  // Circle CLI
  console.log(fmt.bold("\nCircle CLI:"));
  if (await hasCircle()) {
    pass("circle binary on PATH");
    const status = await authStatus();
    if (status.authed) pass(`authenticated${status.email ? " as " + status.email : ""}`);
    else fail("not authenticated — run `selat init`");
  } else {
    fail("circle CLI not installed — install Circle CLI, then run `selat init`");
  }

  // Agent wallet
  console.log(fmt.bold("\nAgent Wallet:"));
  const address = await getAgentAddress();
  if (address) {
    pass(`wallet ${address}`);
    const gw = await gatewayBalancesByChain(address);
    const bal = gw ? gw.total : null;
    if (bal != null) {
      const fmtBal = bal.toFixed(6) + " USDC";
      if (bal >= 0.5) pass(`Gateway balance: ${fmtBal} — spendable on any supported chain`);
      else if (bal > 0) warn(`Gateway balance: ${fmtBal} (low — top up before heavy use)`);
      else warn("Gateway balance: 0 USDC (run `selat fund`)");
      // A 0/low reading right after a deposit usually means the deposit is
      // still attesting, not lost — Gateway credits take ~5–10 minutes. Say so
      // here, because doctor is where a worried user lands first.
      for (const line of pendingDepositHintLines(bal)) console.log("    " + fmt.dim(line));
      // Gateway is ONE balance; the per-chain rows are a routing detail (which
      // chain to pass as `--chain` when paying; Eco deposits settle on Polygon)
      // and live behind --by-chain — enumerating them by default made users
      // read the balance as split into per-chain buckets.
      if (byChain) {
        for (const line of gatewayPerChainLines(gw)) console.log("    " + fmt.dim(line));
      }
    } else {
      warn("Gateway balance: could not read (Circle API issue or no wallet on the queried chain)");
      for (const line of circleReadErrorLines(lastCircleReadError())) console.log("    " + fmt.dim(line));
    }
    // On-chain USDC across the deposit-source chains (distinct from Gateway).
    const oc = await usdcBalances(address);
    for (const c of oc.perChain) {
      if (c.usdc == null) warn(`on-chain USDC ${c.key}: could not read`);
      else if (c.usdc > 0) pass(`on-chain USDC ${c.key}: ${c.usdc.toFixed(2)}`);
      else warn(`on-chain USDC ${c.key}: 0.00`);
    }
    if (oc.errors.length) {
      for (const line of circleReadErrorLines(lastCircleReadError())) console.log("    " + fmt.dim(line));
    }
    if ((bal ?? 0) <= 0 && !oc.hasAny) {
      warn("No on-chain USDC and Gateway is empty — run `selat fund`");
      // Multi-wallet accounts (issue #54): the resolved wallet being empty
      // doesn't mean the ACCOUNT is unfunded — another agent wallet may hold
      // the balance. Check siblings and point at the fix instead of leaving a
      // funded user staring at "0 USDC".
      const funded = await findFundedSibling(address);
      if (funded) {
        warn(`another agent wallet on this account holds funds: ${funded.address} (Gateway: ${funded.usd.toFixed(6)} USDC)`);
        console.log("    " + fmt.dim(`To pay from it, set SELAT_AGENT_WALLET_ADDRESS=${funded.address} in ${configPath()} (or rerun \`selat init\` and pick it).`));
      }
    }
  } else {
    fail("no agent wallet found — run `selat init`");
  }

  // Spending policy — the hard ceiling, which Circle stores and enforces PER
  // CHAIN (the source chain of a transfer picks the governing row — see
  // spendingPolicy() in lib/circle.mjs). A wallet capped on one chain and on
  // Circle's DEFAULT elsewhere is exactly the gap doctor must surface: every
  // other cap (--max-amount, skill maxAmount) is advisory next to this one.
  console.log(fmt.bold("\nSpending policy (per chain):"));
  const policyRows = address ? await spendingPolicyByChain(address) : [];
  const policyUnreadable = address && !policyRows.some((r) => r?.readable);
  for (const line of policyDoctorLines(policyRows)) {
    if (line.level === "pass") pass(line.text);
    else if (line.level === "warn") warn(line.text);
    else console.log("  " + fmt.dim(line.text));
  }
  if (policyUnreadable) {
    for (const line of circleReadErrorLines(lastCircleReadError())) console.log("    " + fmt.dim(line));
  }

  console.log(fmt.bold("\nselat-pay:"));
  const selatPay = await resolveSelatPay();
  const versionLabel = await selatPayVersion(); // e.g. "installed (bundled, v0.3.1)"
  if (selatPay.source === "global") {
    pass(`selat-pay ${versionLabel ?? "installed (global)"}`);
    console.log("    " + fmt.dim("bundled selat-pay missing — install with `npm install -g @selat-ai/selat-cli` to restore"));
  } else if (selatPay.source === "bundled") {
    pass(`selat-pay ${versionLabel ?? "installed (bundled)"} — ${selatPay.bin}`);
    console.log("    " + fmt.dim("only reachable via `selat run`; for a shell-callable copy: npm i -g @selat-ai/selat-pay"));
  } else if (selatPay.source === "env-override") {
    pass(`selat-pay ${versionLabel ?? "installed (env-override)"} — ${selatPay.bin}`);
    console.log("    " + fmt.dim("override via $SELAT_PAY_BIN — unset to fall back to bundled"));
  } else {
    fail("selat-pay not found — reinstall selat-cli, or install selat-pay globally");
  }

  // Config file
  console.log(fmt.bold("\nConfig:"));
  const cfg = await readConfig();
  if (Object.keys(cfg).length === 0) {
    fail(`${configPath()} missing or empty — run \`selat init\``);
  } else {
    pass(`${configPath()} present`);
    if (cfg.SELAT_ROUTER_URL) pass(`SELAT_ROUTER_URL=${cfg.SELAT_ROUTER_URL}`);
    else warn("SELAT_ROUTER_URL not set");
    if (cfg.SELAT_AGENT_WALLET_ADDRESS) pass(`SELAT_AGENT_WALLET_ADDRESS=${cfg.SELAT_AGENT_WALLET_ADDRESS}`);
    else warn("SELAT_AGENT_WALLET_ADDRESS not set");
    if (cfg.SELAT_ROUTER_URL && !safeHttpUrl(cfg.SELAT_ROUTER_URL)) {
      fail("SELAT_ROUTER_URL must be an https:// URL (http:// is allowed only for localhost) — MITM can rewrite the payment challenge. Fix it with `selat init --router-url=<https url>`.");
    }
  }

  // Router reachable. Only probe a validated URL: an unvalidated config value
  // reaches curl as an argv element, where a leading "-" or a non-http scheme
  // would be read as an option/target rather than a URL.
  if (cfg.SELAT_ROUTER_URL && safeHttpUrl(cfg.SELAT_ROUTER_URL)) {
    console.log(fmt.bold("\nRouter reachability:"));
    // fetch(), not curl: `-o /dev/null` fails on Windows (no /dev/null; curl
    // exits 23 unable to open the output file), so doctor reported a healthy
    // router as unreachable on every Windows host. host.mjs already uses
    // fetch for the same kind of check.
    const probe = await probeRouterHealthz({ routerUrl: cfg.SELAT_ROUTER_URL });
    if (probe.ok) {
      pass(`${cfg.SELAT_ROUTER_URL}/healthz returns ${probe.status}${probe.attempt > 1 ? ` (attempt ${probe.attempt})` : ""}`);
    } else if (probe.status != null) {
      fail(`${cfg.SELAT_ROUTER_URL}/healthz returned ${probe.status} on all ${probe.attempt} attempts`);
    } else {
      fail(`${cfg.SELAT_ROUTER_URL}/healthz unreachable after ${probe.attempt} attempts (${probe.error})`);
    }
  }

  // Summary
  console.log("");
  if (failures === 0) {
    console.log(fmt.bold(fmt.green("All checks passed.")));
    return 0;
  }
  console.log(fmt.bold(fmt.red(`${failures} check(s) failed.`)));
  console.log(fmt.dim("Most fixes: install missing tools, then run `selat init` again."));
  return 1;
}

/**
 * The "Spending policy" doctor block as data — pure and unit-testable.
 * Takes a spendingPolicyByChain() result and returns [{ level:
 * "pass"|"warn"|"dim", text }]. Caps are per-(wallet, chain) and enforcement
 * follows the source chain (verified live 2026-08-11), so the block lists
 * each readable chain with the origin of its governing policy — a chain on
 * Circle's DEFAULT is a warn, because the user's custom caps do not govern
 * there no matter what the other chains say.
 */
export function policyDoctorLines(rows) {
  const readable = (rows ?? []).filter((r) => r?.readable && r.origin);
  if (!readable.length) {
    return [{ level: "warn", text: "could not read the wallet spending policy on any chain (circle wallet limit)" }];
  }
  const custom = readable.filter((r) => r.origin === "CUSTOM");
  if (!custom.length) {
    return [
      { level: "warn", text: "no custom spending caps on any chain — a looping agent could drain the balance" },
      { level: "dim", text: "set the hard ceiling on every chain (per-tx/daily/weekly/monthly): selat setup-policy" }
    ];
  }
  const lines = readable.map((r) => ({
    level: r.origin === "CUSTOM" ? "pass" : "warn",
    text: `${r.chain}: ${describeChainPolicy(r)}`
  }));
  if (custom.length < readable.length) {
    lines.push({
      level: "dim",
      text: "caps are enforced per chain — cover the DEFAULT chains too: selat setup-policy"
    });
  }
  return lines;
}

/**
 * Probe `${routerUrl}/healthz` with retries. A single probe flip-flops the
 * doctor verdict on transient DNS/TLS/timeout blips even when the router is
 * healthy, so one failed attempt is not a finding — only all of them failing
 * is. Any 2xx passes immediately; everything else (network error or non-2xx
 * status, which can be a transient LB 502/503) retries after a short growing
 * backoff. Pure and unit-testable via injectable fetch/sleep, matching
 * waitForGatewayCredit in fund.mjs.
 *
 * Returns { ok: true, status, attempt } on 2xx;
 *         { ok: false, status, attempt } when the last attempt got a non-2xx;
 *         { ok: false, status: null, error, attempt } when it got a network
 *         error — `error` names the distinguishing cause (timeout vs DNS vs
 *         connection refused), because "(network error)" gives the user
 *         nothing to act on.
 */
export async function probeRouterHealthz({
  routerUrl,
  attempts = 3,
  timeoutMs = 5000,
  backoffMs = 500,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  let last = { status: null, error: "network error" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(`${routerUrl}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, attempt };
      last = { status: res.status, error: null };
    } catch (err) {
      last = { status: null, error: describeProbeError(err) };
    }
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }
  return { ok: false, attempt: attempts, ...last };
}

/**
 * Name the failure class of a fetch() rejection. Node's fetch wraps the real
 * cause: AbortSignal.timeout rejects with TimeoutError, while network errors
 * surface as TypeError("fetch failed") whose `.cause` carries the syscall
 * code — sometimes one level deeper inside an AggregateError when a host
 * resolves to multiple addresses.
 */
export function describeProbeError(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  const cause = err?.cause ?? err;
  const code = cause?.code ?? cause?.errors?.find((e) => e?.code)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `DNS lookup failed (${code})`;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ECONNRESET") return "connection reset";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `host unreachable (${code})`;
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (typeof code === "string" && (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")
    || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code))) return `TLS error (${code})`;
  return code ? `network error (${code})` : `network error (${err?.message ?? "unknown"})`;
}

/**
 * Hint lines for a 0/low Gateway balance reading. A deposit takes ~5–10
 * minutes to become spendable, so a fresh reading of 0 right after funding
 * looks like lost money when it's just settling. Pure and unit-testable;
 * returns [] when the balance is healthy (>= 0.5 USDC) or unreadable.
 * `selat fund --wait` ships with the deposit-visibility work (PR #69) — the
 * hint mentions it but nothing here depends on that flag existing.
 */
/**
 * Detail lines under a "could not read" warning: what the Circle CLI actually
 * said, so a transient API blip, a rate limit, or an expired login is
 * distinguishable from an empty wallet. `[]` when nothing was recorded.
 * Exported for tests.
 */
export function circleReadErrorLines(reason) {
  if (!reason) return [];
  return [
    `circle said: ${reason}`,
    "Circle reads fail in short bursts — rerun `selat doctor` in a minute before treating this as a setup problem."
  ];
}

export function pendingDepositHintLines(bal) {
  if (bal == null || bal >= 0.5) return [];
  return [
    "Deposited recently? Gateway deposits take ~5–10 min to settle — the money isn't lost.",
    "Watch it land: `selat fund --wait`, or check `circle gateway balance --all`."
  ];
}

/**
 * Routing-detail rows for a `gatewayBalancesByChain()` result — only rendered
 * behind `selat doctor --by-chain`. Pure and unit-testable; returns [] when
 * nothing is funded. Framed as a routing detail so the rows never read as
 * separate per-chain balances (Gateway is one balance).
 */
export function gatewayPerChainLines(gw) {
  const funded = (gw?.perChain ?? []).filter((c) => (c.usdc ?? 0) > 0);
  return funded.map((c) => {
    const chainKey = c.network ? c.network.toLowerCase() : `domain-${c.domain}`;
    return `${c.network} (domain ${c.domain}): ${c.usdc.toFixed(6)} USDC — routing detail; pay with --chain ${chainKey}`;
  });
}

/**
 * Pick the best-funded wallet other than `currentAddress` from a list of
 * { address, usd } entries. Pure and unit-testable; returns { address, usd }
 * or null when no sibling holds a positive balance.
 */
export function pickFundedSibling(entries, currentAddress) {
  const cur = String(currentAddress ?? "").toLowerCase();
  const funded = (entries ?? [])
    .filter((e) => e?.address && e.address.toLowerCase() !== cur && (e.usd ?? 0) > 0)
    .sort((a, b) => b.usd - a.usd);
  return funded[0] ?? null;
}

/**
 * When the resolved wallet is empty, look for a funded sibling wallet on the
 * same Circle account. Advisory only: balance lookups run in parallel and any
 * failure degrades to "no finding" rather than failing doctor.
 */
async function findFundedSibling(currentAddress) {
  try {
    const wallets = await listAgentWallets();
    if (wallets.length <= 1) return null;
    const entries = await Promise.all(
      wallets
        .filter((w) => w.address.toLowerCase() !== String(currentAddress).toLowerCase())
        .map(async (w) => ({
          address: w.address,
          usd: (await gatewayBalancesByChain(w.address).catch(() => null))?.total ?? 0
        }))
    );
    return pickFundedSibling(entries, currentAddress);
  } catch {
    return null;
  }
}
