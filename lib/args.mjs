/**
 * Argv helpers shared by the commands' bespoke parsers.
 *
 * Every command hand-rolls its own parsing (zero deps, and the money-moving
 * flags need per-command wording), but the primitives — "value of --flag",
 * "positional words minus the values of value-taking flags" — were copied per
 * command. They live here once so a fix reaches every caller.
 */

/**
 * Value that follows `name` in argv, or null when the flag is absent or last.
 * Does NOT validate that the value isn't itself a flag — callers that care
 * check, because the right error wording is command-specific.
 */
export function flagValue(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

/**
 * Positional words, skipping `--flags` and the values of value-taking ones.
 * `args.filter(a => !a.startsWith("--"))` is wrong: in `search foo --top 3` it
 * would fold the cap value "3" into the intent.
 *
 * @param {string[]} args
 * @param {{ valueFlags?: Iterable<string> }} opts flags that consume the next token
 */
export function positionalWords(args, { valueFlags = [] } = {}) {
  const takesValue = new Set(valueFlags);
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (takesValue.has(a)) i++; // skip its value
      continue;
    }
    words.push(a);
  }
  return words;
}
