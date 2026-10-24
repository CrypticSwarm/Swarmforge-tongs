
import { isMap, isScalar } from "yaml";
import { strictYaml } from "./yaml.js";

export const ALLOWLIST = ".github/swarmforge-dispatch.yml";

export const DISPATCH_REFS = ["default", "current"] as const;

export type DispatchEntry = { verb: string; file: string; ref: (typeof DISPATCH_REFS)[number] };

export type Dropped = { verb: string; why: string };

/** Checked again in the GitHub client, since a file name reaches a URL path. */
export const WORKFLOW_FILE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

export const MAX_VERBS = 20;

export const MAX_ALLOWLIST_BYTES = 16 * 1024;

const VERB_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Drops a malformed entry; throws only on a malformed file. */
export function parseAllowlist(
  text: string,
  reserved: ReadonlySet<string>,
): { entries: DispatchEntry[]; dropped: Dropped[] } {
  const size = Buffer.byteLength(text, "utf8");
  if (size > MAX_ALLOWLIST_BYTES) throw new Error(`it is ${size} bytes; the tong reads at most ${MAX_ALLOWLIST_BYTES}`);
  const doc = strictYaml(text, "it");
  const entries: DispatchEntry[] = [];
  const dropped: Dropped[] = [];
  const top = doc.contents;
  if (top === null || (isScalar(top) && top.value === null)) return { entries, dropped };
  if (!isMap(top)) throw new Error("it is not a map of verb names to entries");
  if (top.items.length > MAX_VERBS) throw new Error(`it lists ${top.items.length} verbs; the tong takes at most ${MAX_VERBS}`);

  // Read off the nodes, never expanded, so an alias is refused rather than resolved.
  for (const [index, { key, value }] of top.items.entries()) {
    const name = isScalar(key) && typeof key.value === "string" ? key.value : undefined;
    // Only a name that passed the pattern is repeated back.
    const valid = name !== undefined && VERB_NAME.test(name);
    const drop = (why: string) =>
      dropped.push({ verb: valid ? name : `at entry ${index + 1}`, why: `${ALLOWLIST}: ${why}` });
    if (name === undefined) {
      drop("a verb name is a string starting with a letter");
      continue;
    }
    if (!valid) {
      drop("a verb name takes up to 64 lowercase letters, digits, and '_', starting with a letter");
      continue;
    }
    // `constructor` too: the SDK keeps tools in a plain object.
    if (reserved.has(name) || name in Object.prototype) {
      drop("that verb name is already taken");
      continue;
    }
    const fields = new Map<string, unknown>();
    if (isMap(value)) {
      for (const item of value.items) {
        if (isScalar(item.key) && isScalar(item.value)) fields.set(String(item.key.value), item.value.value);
      }
    }
    if (!isMap(value) || value.items.length !== 2 || !fields.has("workflow") || !fields.has("ref")) {
      drop("an entry takes exactly 'workflow' and 'ref', each a plain string");
      continue;
    }
    const file = fields.get("workflow");
    const ref = fields.get("ref");
    if (typeof file !== "string" || !WORKFLOW_FILE.test(file)) {
      drop("'workflow' takes a .yml or .yaml file name, with no directory");
      continue;
    }
    if (typeof ref !== "string" || !(DISPATCH_REFS as readonly string[]).includes(ref)) {
      drop("'ref' takes 'default' or 'current'");
      continue;
    }
    entries.push({ verb: name, file, ref: ref as DispatchEntry["ref"] });
  }
  return { entries, dropped };
}
