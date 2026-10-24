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
