import { GID } from "./asana.js";

export class ConfigError extends Error {}

export type Config = { token: string; workspaceGid: string };

/** So the token cannot smuggle a header line. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

export function configFromEnv(env: { ASANA_TOKEN?: string; ASANA_WORKSPACE_ID?: string }): Config {
  const token = (env.ASANA_TOKEN ?? "").trim();
  if (!token) throw new ConfigError("ASANA_TOKEN is unset or blank; set it to a ${secret:...} Asana personal access token.");
  if (!PRINTABLE_ASCII.test(token)) throw new ConfigError("ASANA_TOKEN has whitespace, control, or non-ASCII characters in it.");

  const workspaceGid = (env.ASANA_WORKSPACE_ID ?? "").trim();
  // Not echoed: a swapped pair of values would print the token.
  if (!GID.test(workspaceGid)) throw new ConfigError("ASANA_WORKSPACE_ID is unset or not a gid; set it to the workspace's gid, digits only.");
  return { token, workspaceGid };
}
