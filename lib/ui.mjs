/**
 * Tiny UI helpers — colors via raw ANSI (zero deps), step indicators, prompts.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const isTTY = output.isTTY && !process.env.NO_COLOR;
const wrap = (code, s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const fmt = {
  bold: (s) => wrap("1", s),
  dim: (s) => wrap("2", s),
  red: (s) => wrap("31", s),
  green: (s) => wrap("32", s),
  yellow: (s) => wrap("33", s),
  blue: (s) => wrap("34", s),
  cyan: (s) => wrap("36", s),
  ok: (s) => wrap("32", `✓ ${s}`),
  err: (s) => wrap("31", `✗ ${s}`),
  warn: (s) => wrap("33", `⚠ ${s}`),
  step: (n, total, label) => `${wrap("2", `[${n}/${total}]`)} ${label}`,
  error: (s) => `${wrap("31", "✗")} ${s}`,
  header: (s) => "\n" + wrap("1", `▸ ${s}`)
};

export function progress(stepNum, total, label) {
  return fmt.step(stepNum, total, label);
}

export async function prompt(message, { default: defaultValue, validate } = {}) {
  const rl = createInterface({ input, output });
  const suffix = defaultValue !== undefined ? ` ${fmt.dim(`(${defaultValue})`)}` : "";
  let answer = "";
  try {
    answer = (await rl.question(`${fmt.cyan("▸")} ${message}${suffix} `)).trim();
  } finally {
    rl.close();
  }
  if (!answer && defaultValue !== undefined) answer = String(defaultValue);
  if (validate) {
    const err = validate(answer);
    if (err) {
      console.error(fmt.error(err));
      return prompt(message, { default: defaultValue, validate });
    }
  }
  return answer;
}

export async function promptYesNo(message, { default: defaultValue = true } = {}) {
  const dflt = defaultValue ? "Y/n" : "y/N";
  const ans = (await prompt(`${message} [${dflt}]`, { default: defaultValue ? "y" : "n" })).toLowerCase();
  if (ans === "" || ans === "y" || ans === "yes") return true;
  return false;
}

export async function promptHidden(message) {
  // Best-effort silent input. Real terminals support raw mode; piped input doesn't.
  if (!input.isTTY) return prompt(message);
  return new Promise((resolve) => {
    output.write(`${fmt.cyan("▸")} ${message} `);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let buf = "";
    const onData = (ch) => {
      // Enter
      if (ch === "\r" || ch === "\n" || ch === "") {
        input.removeListener("data", onData);
        input.setRawMode(false);
        input.pause();
        output.write("\n");
        resolve(buf);
        return;
      }
      // Ctrl-C
      if (ch === "") {
        input.removeListener("data", onData);
        input.setRawMode(false);
        process.exit(130);
      }
      // Backspace
      if (ch === "" || ch === "\b") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          output.write("\b \b");
        }
        return;
      }
      buf += ch;
      output.write("•");
    };
    input.on("data", onData);
  });
}
