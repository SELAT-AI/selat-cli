/**
 * `selat spend` — unified spend report: settled spend (the selat-pay ledger) +
 * Apify token utilization (the token store). Thin, read-only wrapper over the
 * discovery skill's `spend_report.mjs`. Flags pass straight through:
 *   --json  --wallet <0x..>  --ledger <path>  --store <path>
 */

import { join } from "node:path";
import { sh } from "../sh.mjs";
import { fmt } from "../ui.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";

export async function spend(args = []) {
  const skill = findSkill("spend_report.mjs");
  if (!skill.found) {
    console.error(fmt.error("spend report not found — update the agent-payment skill (@selat-ai/selat-discovery)."));
    console.error("");
    for (const line of skillInstallLines()) console.error(fmt.cyan(line));
    return 1;
  }
  const res = await sh(
    "node",
    [join(skill.path, "scripts", "spend_report.mjs"), ...args],
    { inherit: true },
  );
  return res.code;
}
