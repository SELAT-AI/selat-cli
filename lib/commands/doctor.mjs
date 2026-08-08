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
import { shSafe, binVersion } from "../sh.mjs";
import { debugError, errorChain } from "../debug.mjs";
import {
  spendingPolicy,
  describePolicy, authStatus, getAgentAddress, gatewayBalancesByChain, listAgentWallets, usdcBalances, hasCircle } from "../circle.mjs";
import { resolveSelatPay, selatPayVersion } from "../selat-pay.mjs";
import { readConfig, configPath } from "../config.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";

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
    pass(`skill at ${skill.path}`);
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
  // doctor is the command a broken setup runs, so a throwing check must become
  // a reported failure here rather than a fatal that hides every check below it.
  let walletError = null;
  const address = await getAgentAddress().catch((err) => {
    walletError = err;
    return null;
  });
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
    }
    // On-chain USDC across the deposit-source chains (distinct from Gateway).
    const oc = await usdcBalances(address);
    for (const c of oc.perChain) {
      if (c.usdc == null) warn(`on-chain USDC ${c.key}: could not read`);
      else if (c.usdc > 0) pass(`on-chain USDC ${c.key}: ${c.usdc.toFixed(2)}`);
      else warn(`on-chain USDC ${c.key}: 0.00`);
    }
    if ((bal ?? 0) <= 0 && !oc.hasAny) {
      warn("No on-chain USDC and Gateway is empty — run `selat fund`");
      // Multi-wallet accounts (issue #54): the resolved wallet being empty
      // doesn't mean the ACCOUNT is unfunded — another agent wallet may hold
      // the balance. Check siblings and point at the fix instead of leaving a
      // funded user staring at "0 USDC".
      const sibling = await findFundedSibling(address);
      if (sibling.funded) {
        warn(`another agent wallet on this account holds funds: ${sibling.funded.address} (Gateway: ${sibling.funded.usd.toFixed(6)} USDC)`);
        console.log("    " + fmt.dim(`To pay from it, set SELAT_AGENT_WALLET_ADDRESS=${sibling.funded.address} in ${configPath()} (or rerun \`selat init\` and pick it).`));
      } else if (sibling.error) {
        // "Didn't find a funded sibling" and "couldn't look" are different
        // answers for a user whose money is on another wallet.
        warn(`could not check the account's other agent wallets: ${errorChain(sibling.error)}`);
      }
    }
  } else if (walletError) {
    debugError("resolving the agent wallet address", walletError);
    fail(`could not resolve the agent wallet: ${errorChain(walletError)}`);
  } else {
    fail("no agent wallet found — run `selat init`");
  }

  // selat-pay
  // Spending policy — the hard, wallet-level ceiling. An uncapped wallet is a
  // setup gap: every other cap (--max-amount, skill maxAmount) is advisory
  // next to this one.
  console.log(fmt.bold("\nSpending policy:"));
  const policy = await spendingPolicy(address);
  for (const line of policyDoctorLines(policy)) {
    if (line.level === "pass") pass(line.text);
    else if (line.level === "warn") warn(line.text);
    else console.log("  " + fmt.dim(line.text));
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
  let cfg = {};
  let cfgError = null;
  try {
    cfg = await readConfig();
  } catch (err) {
    cfgError = err;
  }
  if (cfgError) {
    debugError("reading the selat-pay config", cfgError);
    fail(errorChain(cfgError));
  } else if (Object.keys(cfg).length === 0) {
    fail(`${configPath()} missing or empty — run \`selat init\``);
  } else {
    pass(`${configPath()} present`);
    if (cfg.SELAT_ROUTER_URL) pass(`SELAT_ROUTER_URL=${cfg.SELAT_ROUTER_URL}`);
    else warn("SELAT_ROUTER_URL not set");
    if (cfg.SELAT_AGENT_WALLET_ADDRESS) pass(`SELAT_AGENT_WALLET_ADDRESS=${cfg.SELAT_AGENT_WALLET_ADDRESS}`);
    else warn("SELAT_AGENT_WALLET_ADDRESS not set");
    if (cfg.SELAT_ROUTER_URL && !cfg.SELAT_ROUTER_URL.startsWith("https://")) {
      warn("Router URL is not https:// — MITM possible. Replace when production router is available.");
    }
  }

  // Router reachable
  if (cfg.SELAT_ROUTER_URL) {
    console.log(fmt.bold("\nRouter reachability:"));
    const r = await shSafe("curl", ["-sS", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", `${cfg.SELAT_ROUTER_URL}/healthz`]);
    const status = r.stdout.trim();
    if (status === "200") {
      pass(`${cfg.SELAT_ROUTER_URL}/healthz returns 200`);
    } else if (r.code === null) {
      // curl itself never ran — reporting that as "router unreachable" sends
      // the user to debug a router that was never contacted.
      fail(`could not run curl to reach ${cfg.SELAT_ROUTER_URL}: ${r.stderr.trim()}`);
    } else if (status) {
      fail(`${cfg.SELAT_ROUTER_URL}/healthz returned HTTP ${status}`);
    } else {
      fail(`${cfg.SELAT_ROUTER_URL} unreachable (curl exited ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""})`);
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
 * Returns [{ level: "pass"|"warn"|"dim", text }]. The policy is part of the
 * user's money model, and the money model is chain-free: these lines must
 * never name a chain (chains are internal query routing only — see
 * spendingPolicy() in lib/circle.mjs).
 */
export function policyDoctorLines(policy) {
  if (!policy?.readable) {
    return [{ level: "warn", text: "could not read the wallet spending policy (circle wallet limit budget)" }];
  }
  if (policy.custom) {
    return [{ level: "pass", text: describePolicy(policy) }];
  }
  return [
    { level: "warn", text: "no custom spending caps on this wallet — a looping agent could drain the balance" },
    { level: "dim", text: "set the hard ceiling (per-tx/daily/weekly/monthly): selat setup-policy" }
  ];
}

/**
 * Hint lines for a 0/low Gateway balance reading. A deposit takes ~5–10
 * minutes to become spendable, so a fresh reading of 0 right after funding
 * looks like lost money when it's just settling. Pure and unit-testable;
 * returns [] when the balance is healthy (>= 0.5 USDC) or unreadable.
 * `selat fund --wait` ships with the deposit-visibility work (PR #69) — the
 * hint mentions it but nothing here depends on that flag existing.
 */
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
 * same Circle account. Advisory only — a failure never fails doctor — but the
 * failure is returned rather than dropped: { funded, error }, where a null
 * `funded` with a null `error` genuinely means "no sibling holds funds".
 */
async function findFundedSibling(currentAddress) {
  try {
    const wallets = await listAgentWallets();
    if (wallets.length <= 1) return { funded: null, error: null };
    const entries = await Promise.all(
      wallets
        .filter((w) => w.address.toLowerCase() !== String(currentAddress).toLowerCase())
        .map(async (w) => ({
          address: w.address,
          usd: (await gatewayBalancesByChain(w.address))?.total ?? 0
        }))
    );
    return { funded: pickFundedSibling(entries, currentAddress), error: null };
  } catch (err) {
    debugError("checking sibling agent wallets", err);
    return { funded: null, error: err };
  }
}
