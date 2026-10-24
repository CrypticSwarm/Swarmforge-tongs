// Strict on purpose: each knob decides whether a check runs, so a typo must stop startup, not turn the check off.

export class ConfigError extends Error {}

/** Unset or empty means false; otherwise `true` or `false`, case- and whitespace-insensitive, or a ConfigError. */
export function booleanFromEnv(name: string, raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError(`${name} is set to '${(raw ?? "").slice(0, 40)}'; it takes 'true' or 'false'.`);
}
