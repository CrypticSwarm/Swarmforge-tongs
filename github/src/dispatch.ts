// Dispatch verbs: run a configured workflow, inputs checked against its file first.

import { isNode, parseDocument } from "yaml";
import { clean } from "./ci.js";
import type { DispatchEntry } from "./config.js";
import { GitHubError, NoAnswer, type GitHub } from "./github.js";
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
  const invalid = (why: string) => new Error(`the workflow file is not valid YAML: ${clean(why).slice(0, 200)}`);
  const doc = parseDocument(text);
  if (doc.errors.length) throw invalid(doc.errors[0].message);
  // GitHub reads YAML 1.2; under 1.1, `on` and `yes` read as booleans.
  if (doc.directives?.yaml.version !== "1.2") {
    throw new Error("the workflow file declares a YAML version other than 1.2.");
  }
  // Only `on` is expanded, so anchors used elsewhere in the file count against nothing.
  let on: unknown;
  try {
    const node = doc.get("on", true);
    on = isNode(node) ? node.toJS(doc, { maxAliasCount: 100 }) : node;
  } catch (err) {
    throw invalid((err as Error).message);
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
async function resolveRef(context: Context, entry: DispatchEntry, defaultBranch: string) {
  let branch = defaultBranch;
  if (entry.ref === "current") {
    const current = await context.repo.currentBranch();
    if (!current) throw new Error("HEAD is detached; check out the branch to dispatch on.");
    branch = current;
    if (branch === defaultBranch) {
      throw new Error(`${clean(branch)} is the default branch; this verb runs only on other branches.`);
    }
  }
  const tip = await context.github.branchTip(branch);
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

export async function dispatch(
  context: Context,
  entry: DispatchEntry,
  input: { inputs?: Record<string, InputValue> },
): Promise<string> {
  const defaultBranch = context.dispatch?.defaultBranch;
  if (!defaultBranch) throw new Error("dispatch is not configured.");
  const { branch, tip } = await resolveRef(context, entry, defaultBranch);
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

export type Dropped = { verb: string; why: string };

/** Splits the entries into those dispatchable from the default branch and those dropped, with why. */
export async function usableEntries(
  github: GitHub,
  defaultBranch: string,
  entries: readonly DispatchEntry[],
): Promise<{ entries: DispatchEntry[]; dropped: Dropped[] }> {
  const usable: DispatchEntry[] = [];
  const dropped: Dropped[] = [];
  // Asked once, inside each entry's try, so a failed lookup drops the verbs rather than the tong.
  let lookup: Promise<string | null> | undefined;
  for (const entry of entries) {
    try {
      lookup ??= github.branchTip(defaultBranch);
      const tip = await lookup;
      if (!tip) throw new Error(`GitHub has no branch ${defaultBranch}`);
      const specs = dispatchInputs(await github.workflowFile(entry.file, tip));
      if (!specs) throw new Error(`no workflow_dispatch trigger on ${defaultBranch}`);
      const unsettable = unsetEnvironment(specs);
      if (unsettable) throw new Error(`it requires environment input ${unsettable}, which this tong never sets`);
      usable.push(entry);
    } catch (err) {
      dropped.push({ verb: entry.verb, why: `${entry.file}: ${clean((err as Error).message).replace(/\.$/, "")}` });
    }
  }
  return { entries: usable, dropped };
}
