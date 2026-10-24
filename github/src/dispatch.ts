// Dispatch verbs: run an allowlisted workflow, inputs checked against its file first.

import { isNode } from "yaml";
import { clean } from "./ci.js";
import { ALLOWLIST, parseAllowlist, type DispatchEntry, type Dropped } from "./allowlist.js";
import { GitHubError, NoAnswer, type GitHub } from "./github.js";
import { strictYaml } from "./yaml.js";
import type { Context } from "./server.js";

/** GitHub's own cap on inputs per dispatch. */
export const MAX_INPUTS = 25;
/** The tong's own cap per value; GitHub caps only the whole payload. */
export const MAX_INPUT_CHARS = 1024;

/** What GitHub accepts as an input name. */
export const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const INPUT_TYPES = ["string", "boolean", "choice", "number", "environment"] as const;

export type InputSpec = {
  name: string;
  type: (typeof INPUT_TYPES)[number];
  required: boolean;
  hasDefault: boolean;
  options: string[];
};

export type InputValue = string | number | boolean;

/** The workflow's `workflow_dispatch` inputs, or null without that trigger. Throws on a file it cannot read. */
export function dispatchInputs(text: string): InputSpec[] | null {
  const doc = strictYaml(text, "the workflow file");
  // Only `on` is expanded, so anchors used elsewhere in the file count against nothing.
  let on: unknown;
  try {
    const node = doc.get("on", true);
    on = isNode(node) ? node.toJS(doc, { maxAliasCount: 100 }) : node;
  } catch (err) {
    throw new Error(`the workflow file's 'on' cannot be read: ${clean((err as Error).message).slice(0, 200)}`);
  }
  let trigger: unknown;
  if (on === "workflow_dispatch") trigger = null;
  else if (Array.isArray(on)) {
    if (!on.includes("workflow_dispatch")) return null;
    trigger = null;
  } else if (isMap(on) && Object.hasOwn(on, "workflow_dispatch")) trigger = on.workflow_dispatch;
  else return null;

  const inputs = isMap(trigger) ? trigger.inputs : undefined;
  if (inputs === undefined || inputs === null) return [];
  if (!isMap(inputs)) throw new Error("workflow_dispatch.inputs is not a map.");
  return Object.entries(inputs).map(([name, raw]) => {
    const spec = isMap(raw) ? raw : {};
    const type = spec.type ?? "string";
    if (!INPUT_NAME.test(name)) {
      throw new Error(`input '${clean(name).slice(0, 80)}' has a name GitHub does not accept.`);
    }
    if (!(INPUT_TYPES as readonly unknown[]).includes(type)) {
      throw new Error(`input ${name} has type '${clean(String(type)).slice(0, 40)}', which this tong does not know.`);
    }
    const options = Array.isArray(spec.options) ? spec.options.map(String) : [];
    if (type === "choice" && options.length === 0) throw new Error(`choice input ${name} lists no options.`);
    return {
      name,
      type: type as InputSpec["type"],
      required: spec.required === true,
      hasDefault: spec.default !== undefined && spec.default !== null,
      options,
    };
  });
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every value as the string GitHub takes, or why the call is refused. */
export function checkInputs(
  specs: readonly InputSpec[],
  given: Readonly<Record<string, InputValue>>,
): Record<string, string> {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  // A Map, so an input named `__proto__` or `constructor` is only a name.
  const out = new Map<string, string>();

  for (const [name, value] of Object.entries(given)) {
    const spec = byName.get(name);
    if (!spec) throw new Error(`the workflow has no input ${clean(name)}; it takes ${describeInputs(specs)}.`);
    out.set(name, checkValue(spec, value));
  }
  const unsettable = unsetEnvironment(specs);
  if (unsettable) throw new Error(`the workflow requires environment input ${unsettable}, which this tong never sets.`);
  const missing = specs.filter((spec) => mustPass(spec) && !out.has(spec.name)).map((spec) => spec.name);
  if (missing.length) {
    throw new Error(`the workflow requires ${missing.join(", ")}; pass ${missing.length === 1 ? "it" : "them"}.`);
  }
  return Object.fromEntries(out);
}

/** GitHub sends '' for an omitted boolean with no default, and then refuses it. */
function mustPass(spec: InputSpec): boolean {
  return spec.type !== "environment" && !spec.hasDefault && (spec.required || spec.type === "boolean");
}

/** A required environment input with no default, which no call can satisfy. */
function unsetEnvironment(specs: readonly InputSpec[]): string | undefined {
  return specs.find((spec) => spec.type === "environment" && spec.required && !spec.hasDefault)?.name;
}

/** `a (required), b`, or `none`, leaving out environment inputs. */
function describeInputs(specs: readonly InputSpec[]): string {
  const settable = specs.filter((spec) => spec.type !== "environment");
  if (!settable.length) return "none";
  return settable.map((spec) => (mustPass(spec) ? `${spec.name} (required)` : spec.name)).join(", ");
}

function checkValue(spec: InputSpec, value: InputValue): string {
  const name = spec.name;
  switch (spec.type) {
    case "environment":
      throw new Error(`${name} is an environment input, which this tong never sets.`);
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${name} is a boolean input; pass true or false.`);
      return String(value);
    case "number":
      if (typeof value !== "number") throw new Error(`${name} is a number input; pass a number.`);
      return String(value);
    case "choice":
      if (typeof value !== "string" || !spec.options.includes(value)) {
        throw new Error(`${name} takes one of these strings: ${spec.options.map(clean).join(", ")}.`);
      }
      return value;
    case "string":
      if (typeof value !== "string") throw new Error(`${name} is a string input; pass a string.`);
      return value;
  }
}

/** The branch, and its tip as GitHub has it (not the agent-writable origin/ ref), where the file is read. */
async function resolveRef(context: Context, entry: DispatchEntry, defaultBranch: string, defaultTip: string) {
  let branch = defaultBranch;
  if (entry.ref === "current") {
    const current = await context.repo.currentBranch();
    if (!current) throw new Error("HEAD is detached; check out the branch to dispatch on.");
    branch = current;
    if (branch === defaultBranch) {
      throw new Error(`${clean(branch)} is the default branch; this verb runs only on other branches.`);
    }
  }
  // The default branch's tip is the one its allowlist was just read at.
  const tip = entry.ref === "default" ? defaultTip : await context.github.branchTip(branch);
  if (!tip) throw new Error(`GitHub has no branch ${clean(branch)}; push it first.`);
  if (entry.ref === "current") {
    const head = await context.repo.headSha();
    if (head !== tip) {
      const at = `HEAD is at ${head.slice(0, 12)}, but GitHub's ${clean(branch)} is at ${tip.slice(0, 12)}`;
      throw new Error(`${at}; push or pull first.`);
    }
  }
  return { branch, tip };
}

/** The default branch's tip, if its allowlist still binds the verb as at startup, so removing an entry revokes it at once. */
async function stillListed(context: Context, entry: DispatchEntry, defaultBranch: string): Promise<string> {
  let now: string;
  let tip: string | null;
  let text: string | null;
  try {
    ({ defaultBranch: now } = await context.github.repository());
    tip = await context.github.branchTip(defaultBranch);
    text = tip && (await context.github.allowlistFile(tip));
  } catch (err) {
    throw new Error(`checking ${ALLOWLIST} failed, so nothing was dispatched: ${clause(err)}.`);
  }
  if (now !== defaultBranch) {
    throw new Error(`the default branch is now ${clean(now)}, not ${clean(defaultBranch)}; restart the session.`);
  }
  if (!tip) throw new Error(`GitHub has no branch ${clean(defaultBranch)}.`);
  let listed: DispatchEntry[];
  try {
    // The names passed the reserved check at startup; this only compares bindings.
    listed = text === null ? [] : parseAllowlist(text, new Set()).entries;
  } catch (err) {
    throw new Error(`${ALLOWLIST} on ${clean(defaultBranch)} is unusable now: ${clause(err)}.`);
  }
  const current = listed.find((listedEntry) => listedEntry.verb === entry.verb);
  if (current?.file !== entry.file || current.ref !== entry.ref) {
    throw new Error(`${ALLOWLIST} on ${clean(defaultBranch)} no longer lists ${entry.verb} as it did at startup.`);
  }
  return tip;
}

export async function dispatch(
  context: Context,
  entry: DispatchEntry,
  input: { inputs?: Record<string, InputValue> },
): Promise<string> {
  const defaultBranch = context.dispatch?.defaultBranch;
  if (!defaultBranch) throw new Error("this tong has no dispatch verbs.");
  const defaultTip = await stillListed(context, entry, defaultBranch);
  const { branch, tip } = await resolveRef(context, entry, defaultBranch, defaultTip);
  const specs = dispatchInputs(await context.github.workflowFile(entry.file, tip));
  if (!specs) throw new Error(`${entry.file} on ${clean(branch)} has no workflow_dispatch trigger.`);
  const inputs = checkInputs(specs, input.inputs ?? {});

  let result: { runId: number | null; url: string };
  try {
    // Qualified, so neither a tag nor a branch named like a ref can stand in for it.
    result = await context.github.dispatchWorkflow(entry.file, `refs/heads/${branch}`, inputs);
  } catch (err) {
    if (!(err instanceof GitHubError && (err instanceof NoAnswer || err.status >= 500))) throw err;
    throw new Error(`${err.message}\n\nThe run may have started anyway; check ci_status before dispatching again.`);
  }

  const what = `Dispatched ${entry.file} on ${clean(branch)}, checked at ${tip.slice(0, 12)},`;
  if (result.runId === null) return `${what} but GitHub reported no run id; find the run with ci_status sha=${tip}.`;
  return `${what} as run ${result.runId}.\n${result.url}\nFollow it with ci_status run=${result.runId}.`;
}

/** The allowlist's verbs dispatchable from the default branch, those dropped, and why the file was unusable, if it was. */
export type DispatchSetup = { entries: DispatchEntry[]; dropped: Dropped[]; unusable?: string };

/** An error's message as one clause. */
function clause(err: unknown): string {
  return clean((err as Error).message).replace(/[.?]$/, "");
}

/** As `clause`, saying when GitHub, not the file, failed. */
function reason(err: unknown): string {
  const message = clause(err);
  const transient = err instanceof GitHubError && (err instanceof NoAnswer || err.status >= 500);
  return transient ? `${message}; a new session tries again` : message;
}

/** Reads the allowlist and the workflows it names at one tip of the default branch. Never throws. */
export async function loadDispatch(
  github: GitHub,
  defaultBranch: string,
  reserved: ReadonlySet<string>,
): Promise<DispatchSetup> {
  const none = (unusable: string): DispatchSetup => ({ entries: [], dropped: [], unusable });
  const branch = clean(defaultBranch);
  let tip: string | null;
  let text: string | null;
  try {
    tip = await github.branchTip(defaultBranch);
    text = tip && (await github.allowlistFile(tip));
  } catch (err) {
    return none(`${ALLOWLIST} on ${branch} cannot be read: ${reason(err)}`);
  }
  if (!tip) return none(`GitHub has no branch ${branch} to read ${ALLOWLIST} from`);
  if (text === null) return { entries: [], dropped: [] };
  let listed: { entries: DispatchEntry[]; dropped: Dropped[] };
  try {
    listed = parseAllowlist(text, reserved);
  } catch (err) {
    return none(`${ALLOWLIST} on ${branch} is unusable: ${reason(err)}`);
  }

  const checked = await Promise.all(
    listed.entries.map(async (entry): Promise<Dropped | null> => {
      try {
        const specs = dispatchInputs(await github.workflowFile(entry.file, tip));
        if (!specs) throw new Error(`no workflow_dispatch trigger on ${branch}`);
        const unsettable = unsetEnvironment(specs);
        if (unsettable) throw new Error(`it requires environment input ${unsettable}, which this tong never sets`);
        return null;
      } catch (err) {
        return { verb: entry.verb, why: `${entry.file}: ${reason(err)}` };
      }
    }),
  );
  return {
    entries: listed.entries.filter((_, i) => checked[i] === null),
    dropped: [...listed.dropped, ...checked.filter((drop): drop is Dropped => drop !== null)],
  };
}
