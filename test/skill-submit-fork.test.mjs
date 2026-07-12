import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { submitSkill } from "../lib/skill-registry.mjs";

// `selat skill submit` fork-and-PR default flow (from user feedback: a
// contributor without write access hit a failed push and had to fork + PR by
// hand). These drive submitSkill with an injected shell runner that scripts
// git/gh responses, over a real on-disk fixture (manifest + receipt + index).

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "selat-submit-"));
  const skillDir = join(root, "skills", "demo-skill");
  await mkdir(join(skillDir, ".selat"), { recursive: true });
  await writeFile(join(root, "index.json"), JSON.stringify({ skills: [] }, null, 2));
  await writeFile(join(skillDir, "manifest.json"), JSON.stringify({
    schema: "selat-skill/v1",
    name: "demo-skill",
    description: "Demo skill for submit tests.",
    maxAmount: "0.10",
    steps: [{ label: "demo", rail: "routed", method: "GET", url: "https://demo.mpp.tempo.xyz/thing", maxAmount: "0.10" }]
  }, null, 2));
  await writeFile(join(skillDir, ".selat", "verify-receipt.json"), JSON.stringify({
    ok: true,
    verifiedAt: "2026-07-11T00:00:00.000Z",
    paidMode: false,
    steps: [{ index: 0, rail: "routed", mode: "routed-mpp", livePriceUsd: 0.0021, maxAmount: "0.10" }]
  }, null, 2));
  return { root, skillDir };
}

// Scripted runner: matches each call against `script` rules in order
// (command + args prefix), returns the first match, and records every call.
function makeRunner(script) {
  const calls = [];
  const run = async (command, args = []) => {
    calls.push([command, ...args]);
    for (const rule of script) {
      if (rule.cmd !== command) continue;
      if (!rule.args.every((a, i) => args[i] === a)) continue;
      return { code: rule.code ?? 0, stdout: rule.stdout ?? "", stderr: rule.stderr ?? "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  run.calls = calls;
  run.find = (...prefix) => calls.find((c) => prefix.every((a, i) => c[i] === a));
  return run;
}

const BRANCH = "add-skill-demo-skill";
const GIT_OK = [
  { cmd: "git", args: ["rev-parse", "--is-inside-work-tree"] },
  { cmd: "git", args: ["checkout", "-b", BRANCH] },
  { cmd: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], stdout: `${BRANCH}\n` },
  { cmd: "git", args: ["add"] },
  { cmd: "git", args: ["commit"] }
];

test("default flow forks when gh reports no push access", async () => {
  const { skillDir } = await makeFixture();
  const run = makeRunner([
    ...GIT_OK,
    { cmd: "gh", args: ["api", "repos/SELAT-AI/selat-skills", "--jq", ".permissions.push"], stdout: "false\n" },
    { cmd: "gh", args: ["api", "user", "--jq", ".login"], stdout: "contributor\n" },
    { cmd: "gh", args: ["repo", "fork"] },
    { cmd: "git", args: ["remote", "get-url", "origin"], stdout: "https://github.com/SELAT-AI/selat-skills.git\n" },
    { cmd: "git", args: ["remote", "get-url", "fork"], code: 1 },
    { cmd: "git", args: ["remote", "add", "fork", "https://github.com/contributor/selat-skills.git"] },
    { cmd: "git", args: ["push", "-u", "fork", BRANCH] },
    { cmd: "gh", args: ["pr", "create"], stdout: "https://github.com/SELAT-AI/selat-skills/pull/99\n" }
  ]);

  const res = await submitSkill(skillDir, { run });
  assert.equal(res.via, "fork");
  assert.equal(res.forkRepo, "contributor/selat-skills");
  assert.equal(res.prUrl, "https://github.com/SELAT-AI/selat-skills/pull/99");
  assert.ok(run.find("gh", "repo", "fork", "SELAT-AI/selat-skills", "--clone=false"), "fork is created on demand");
  const pr = run.find("gh", "pr", "create");
  assert.equal(pr[pr.indexOf("--head") + 1], `contributor:${BRANCH}`, "PR head is cross-fork");
  assert.equal(run.find("git", "push", "-u", "origin"), undefined, "origin is never pushed without write access");
});

test("maintainers with push access keep the same-repo branch flow", async () => {
  const { skillDir } = await makeFixture();
  const run = makeRunner([
    ...GIT_OK,
    { cmd: "gh", args: ["api", "repos/SELAT-AI/selat-skills", "--jq", ".permissions.push"], stdout: "true\n" },
    { cmd: "git", args: ["push", "-u", "origin", BRANCH] },
    { cmd: "gh", args: ["pr", "create"], stdout: "https://github.com/SELAT-AI/selat-skills/pull/100\n" }
  ]);

  const res = await submitSkill(skillDir, { run });
  assert.equal(res.via, "origin");
  assert.equal(res.forkRepo, null);
  const pr = run.find("gh", "pr", "create");
  assert.equal(pr[pr.indexOf("--head") + 1], BRANCH);
  assert.equal(run.find("gh", "repo", "fork"), undefined, "no fork is created for maintainers");
});

test("a failed origin push falls through to the fork flow automatically", async () => {
  const { skillDir } = await makeFixture();
  const run = makeRunner([
    ...GIT_OK,
    // Permission probe wrongly says push is allowed; the push then 403s.
    { cmd: "gh", args: ["api", "repos/SELAT-AI/selat-skills", "--jq", ".permissions.push"], stdout: "true\n" },
    { cmd: "git", args: ["push", "-u", "origin", BRANCH], code: 1, stderr: "remote: Permission denied (403)" },
    { cmd: "gh", args: ["api", "user", "--jq", ".login"], stdout: "contributor\n" },
    { cmd: "gh", args: ["repo", "fork"] },
    { cmd: "git", args: ["remote", "get-url", "origin"], stdout: "git@github.com:SELAT-AI/selat-skills.git\n" },
    { cmd: "git", args: ["remote", "get-url", "fork"], code: 1 },
    { cmd: "git", args: ["remote", "add", "fork", "git@github.com:contributor/selat-skills.git"] },
    { cmd: "git", args: ["push", "-u", "fork", BRANCH] },
    { cmd: "gh", args: ["pr", "create"], stdout: "https://github.com/SELAT-AI/selat-skills/pull/101\n" }
  ]);

  const res = await submitSkill(skillDir, { run });
  assert.equal(res.via, "fork");
  assert.equal(res.prUrl, "https://github.com/SELAT-AI/selat-skills/pull/101");
  const addRemote = run.find("git", "remote", "add", "fork");
  assert.equal(addRemote[4], "git@github.com:contributor/selat-skills.git", "fork remote matches origin's ssh scheme");
});

test("--no-fork keeps the old push-to-origin behavior with hints on failure", async () => {
  const { skillDir } = await makeFixture();
  const run = makeRunner([
    ...GIT_OK,
    { cmd: "git", args: ["push", "-u", "origin", BRANCH], code: 1, stderr: "remote: Permission denied (403)" }
  ]);

  const res = await submitSkill(skillDir, { fork: false, run });
  assert.equal(res.pushed, false);
  assert.match(res.hint, /gh repo fork/);
  assert.equal(run.find("gh", "repo", "fork"), undefined, "--no-fork never forks");
  assert.equal(run.find("gh", "api", "repos/SELAT-AI/selat-skills"), undefined, "--no-fork skips the permission probe");
});

test("an unrelated existing `fork` remote is left alone; push goes to the fork URL", async () => {
  const { skillDir } = await makeFixture();
  const run = makeRunner([
    ...GIT_OK,
    { cmd: "gh", args: ["api", "repos/SELAT-AI/selat-skills", "--jq", ".permissions.push"], stdout: "false\n" },
    { cmd: "gh", args: ["api", "user", "--jq", ".login"], stdout: "contributor\n" },
    { cmd: "gh", args: ["repo", "fork"] },
    { cmd: "git", args: ["remote", "get-url", "origin"], stdout: "https://github.com/SELAT-AI/selat-skills.git\n" },
    { cmd: "git", args: ["remote", "get-url", "fork"], stdout: "https://github.com/somebody-else/other-repo.git\n" },
    { cmd: "git", args: ["push", "https://github.com/contributor/selat-skills.git", BRANCH] },
    { cmd: "gh", args: ["pr", "create"], stdout: "https://github.com/SELAT-AI/selat-skills/pull/102\n" }
  ]);

  const res = await submitSkill(skillDir, { run });
  assert.equal(res.via, "fork");
  assert.equal(run.find("git", "remote", "add"), undefined, "existing remote is not clobbered");
  assert.ok(run.find("git", "push", "https://github.com/contributor/selat-skills.git", BRANCH), "push targets the fork URL directly");
});

test("register still writes the index.json entry on submit", async () => {
  const { root, skillDir } = await makeFixture();
  const run = makeRunner([
    ...GIT_OK,
    { cmd: "gh", args: ["api", "repos/SELAT-AI/selat-skills", "--jq", ".permissions.push"], stdout: "true\n" },
    { cmd: "git", args: ["push", "-u", "origin", BRANCH] },
    { cmd: "gh", args: ["pr", "create"], stdout: "https://x/pull/1\n" }
  ]);
  await submitSkill(skillDir, { run });
  const idx = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  assert.deepEqual(idx.skills[0], { name: "demo-skill", rail: "routed", kind: "single", description: "Demo skill for submit tests." });
});

test("an unusable permission probe (gh missing) keeps the plain git-push-to-origin behavior", async () => {
  const { skillDir } = await makeFixture();
  const run = makeRunner([
    ...GIT_OK,
    // gh is not installed: every gh call fails.
    { cmd: "gh", args: ["api", "repos/SELAT-AI/selat-skills", "--jq", ".permissions.push"], code: 1, stderr: "gh: command not found" },
    { cmd: "git", args: ["push", "-u", "origin", BRANCH] },
    { cmd: "gh", args: ["pr", "create"], code: 1, stderr: "gh: command not found" }
  ]);

  const res = await submitSkill(skillDir, { run });
  assert.equal(res.via, "origin", "gh-less setups try the plain origin push first, like before the fork flow");
  assert.equal(res.pushed, true, "the branch still gets pushed with git alone");
  assert.equal(res.prUrl, null);
  assert.match(res.hint, /open the PR manually/);
  assert.equal(run.find("gh", "api", "user"), undefined, "no fork attempt without a usable gh");
});
