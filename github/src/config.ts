// Operator configuration, read from the environment at startup.
//
// Parsing is strict on purpose. Every knob here decides whether a check runs, so a
// value nobody recognizes has to stop the process: "the value was a typo" must
// never come out as "the check is off". Unset is a different thing from misspelled
// and keeps the documented default.

export class ConfigError extends Error {}

/**
 * Unset -- and empty, which is what a shell prologue exporting an unset variable
 * produces -- means false. Anything else is either `true` or `false`, in any case
 * and with surrounding whitespace ignored, or it is a startup failure.
 */
export function booleanFromEnv(name: string, raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError(`${name} is set to '${(raw ?? "").slice(0, 40)}'; it takes 'true' or 'false'.`);
}

export const DISPATCH_REFS = ["default", "current"] as const;

/** One verb that dispatches one workflow on one ref. */
export type DispatchEntry = { verb: string; file: string; ref: (typeof DISPATCH_REFS)[number] };

/** Checked again in the GitHub client, since a file name reaches a URL path. */
export const WORKFLOW_FILE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

const VERB_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ENTRY = /^([^=@]+)=([^=@]+)@([^=@]+)$/;

/** Parses `<verb>=<file>@<default|current>,...`; empty is none, and a malformed or taken entry throws. */
export function dispatchFromEnv(name: string, raw: string | undefined, reserved: ReadonlySet<string>): DispatchEntry[] {
  const value = (raw ?? "").trim();
  if (value === "") return [];
  const seen = new Set<string>();
  return value.split(",").map((part) => {
    const fail = (why: string) => new ConfigError(`${name} entry '${part.trim().slice(0, 80)}' ${why}`);
    const match = ENTRY.exec(part.trim());
    if (!match) throw fail("is not <verb>=<workflow file>@<default|current>.");
    const [, verb, file, ref] = match;
    if (!VERB_NAME.test(verb)) {
      throw fail("needs a verb name of up to 64 lowercase letters, digits, and '_', starting with a letter.");
    }
    if (reserved.has(verb) || seen.has(verb)) throw fail(`names a verb that is already taken: ${verb}.`);
    if (!WORKFLOW_FILE.test(file)) throw fail("needs a .yml or .yaml file name, with no directory.");
    if (!(DISPATCH_REFS as readonly string[]).includes(ref)) throw fail("needs the ref 'default' or 'current'.");
    seen.add(verb);
    return { verb, file, ref: ref as DispatchEntry["ref"] };
  });
}
