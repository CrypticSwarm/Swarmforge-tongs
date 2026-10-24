// Dispatch verbs: run an allowlisted workflow, inputs checked against its file first, and list_workflows.

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

/** Caps on what list_workflows shows of a file, which on the checked-out branch is the agent's. */
const MAX_DESCRIPTION_CHARS = 200;
const MAX_VALUE_CHARS = 80;
const MAX_OPTIONS_SHOWN = 20;
/** Shared among the verbs a listing shows. */
export const MAX_LISTING_CHARS = 50_000;

/** What GitHub accepts as an input name. */
export const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;

const INPUT_TYPES = ["string", "boolean", "choice", "number", "environment"] as const;

export type InputSpec = {
  name: string;
  type: (typeof INPUT_TYPES)[number];
  required: boolean;
  hasDefault: boolean;
  /** As text, and empty without a default. */
  default: string;
  options: string[];
  description: string;
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
  const count = Object.keys(inputs).length;
  if (count > MAX_INPUTS) throw new Error(`the workflow declares ${count} inputs; GitHub allows ${MAX_INPUTS}.`);
  return Object.entries(inputs).map(([name, raw]) => {
    const spec = isMap(raw) ? raw : {};
    const type = spec.type ?? "string";
    if (!INPUT_NAME.test(name)) {
      throw new Error(`input '${clean(name).slice(0, 80)}' has a name GitHub does not accept.`);
    }
    if (name === "__proto__") throw new Error("input __proto__ has a name this tong cannot pass.");
    if (!(INPUT_TYPES as readonly unknown[]).includes(type)) {
      throw new Error(`input ${name} has type '${clean(String(type)).slice(0, 40)}', which this tong does not know.`);
    }
    const options = Array.isArray(spec.options) ? spec.options.map(String) : [];
    if (type === "choice" && options.length === 0) throw new Error(`choice input ${name} lists no options.`);
    const hasDefault = spec.default !== undefined && spec.default !== null;
    return {
      name,
      type: type as InputSpec["type"],
      required: spec.required === true,
      hasDefault,
      default: !hasDefault ? "" : typeof spec.default === "object" ? JSON.stringify(spec.default) : `${spec.default}`,
      options,
      description: typeof spec.description === "string" ? spec.description : "",
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
  const unset = specs.filter((spec) => mustPass(spec) && !out.has(spec.name));
  const missing = unset.filter((spec) => spec.required).map((spec) => spec.name);
  const booleans = unset.filter((spec) => !spec.required).map((spec) => spec.name);
  const pass = (names: string[]) => (names.length === 1 ? "it" : "them");
  const are = booleans.length === 1 ? "is a boolean" : "are booleans";
  const whys = [
    ...(missing.length ? [`the workflow requires ${missing.join(", ")}; pass ${pass(missing)}.`] : []),
    ...(booleans.length ? [`${booleans.join(", ")} ${are} with no default, which GitHub refuses unset; pass ${pass(booleans)}.`] : []),
  ];
  if (whys.length) throw new Error(whys.join(" "));
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

/** `a (required), b (boolean, must pass), c`, or `none`, leaving out environment inputs. */
function describeInputs(specs: readonly InputSpec[]): string {
  const settable = specs.filter((spec) => spec.type !== "environment");
  if (!settable.length) return "none";
  const label = (spec: InputSpec) =>
    !mustPass(spec) ? spec.name : spec.required ? `${spec.name} (required)` : `${spec.name} (boolean, must pass)`;
  return settable.map(label).join(", ");
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
export async function resolveRef(
  context: Context,
  entry: DispatchEntry,
  defaultBranch: string,
  tipOf = (branch: string) => context.github.branchTip(branch),
) {
  let branch = defaultBranch;
  if (entry.ref === "current") {
    const current = await context.repo.currentBranch();
    if (!current) throw new Error("HEAD is detached; check out the branch to dispatch on.");
    branch = current;
    if (branch === defaultBranch) {
      throw new Error(`${clean(branch)} is the default branch; this verb runs only on other branches.`);
    }
  }
  const tip = await tipOf(branch);
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

/** The default branch's tip, and the verbs its allowlist lists there now. */
async function listedNow(
  context: Context,
  defaultBranch: string,
  failed: string,
): Promise<{ tip: string; listed: DispatchEntry[] }> {
  let now: string;
  let tip: string | null;
  let text: string | null;
  try {
    ({ defaultBranch: now } = await context.github.repository());
    tip = await context.github.branchTip(defaultBranch);
    text = tip && (await context.github.allowlistFile(tip));
  } catch (err) {
    throw new Error(`checking ${ALLOWLIST} failed${failed}: ${clause(err)}.`);
  }
  if (now !== defaultBranch) {
    throw new Error(`the default branch is now ${clean(now)}, not ${clean(defaultBranch)}; restart the session.`);
  }
  if (!tip) throw new Error(`GitHub has no branch ${clean(defaultBranch)}.`);
  try {
    // The names passed the reserved check at startup; this only compares bindings.
    return { tip, listed: text === null ? [] : parseAllowlist(text, new Set()).entries };
  } catch (err) {
    throw new Error(`${ALLOWLIST} on ${clean(defaultBranch)} is unusable now: ${clause(err)}.`);
  }
}

/** Refuses a verb the allowlist no longer binds as at startup, so removing an entry revokes it at once. */
function checkListed(entry: DispatchEntry, listed: readonly DispatchEntry[], defaultBranch: string): void {
  const current = listed.find((listedEntry) => listedEntry.verb === entry.verb);
  if (current?.file !== entry.file || current.ref !== entry.ref) {
    throw new Error(`${ALLOWLIST} on ${clean(defaultBranch)} no longer lists ${entry.verb} as it did at startup.`);
  }
}

export async function dispatch(
  context: Context,
  entry: DispatchEntry,
  input: { inputs?: Record<string, InputValue> },
): Promise<string> {
  const defaultBranch = context.dispatch?.defaultBranch;
  if (!defaultBranch) throw new Error("this tong has no dispatch verbs.");
  const now = await listedNow(context, defaultBranch, ", so nothing was dispatched");
  checkListed(entry, now.listed, defaultBranch);
  // The default branch's tip is the one its allowlist was just read at.
  const tipOf = (branch: string) => (branch === defaultBranch ? Promise.resolve(now.tip) : context.github.branchTip(branch));
  const { branch, tip } = await resolveRef(context, entry, defaultBranch, tipOf);
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

function clip(text: string, max: number): string {
  const line = clean(text);
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A value as the JSON the verb takes for this input's type. */
function asPassed(spec: InputSpec, value: string): string {
  const bare =
    (spec.type === "boolean" && (value === "true" || value === "false")) ||
    (spec.type === "number" && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value));
  const literal = bare ? value : JSON.stringify(value);
  return clip(literal, MAX_VALUE_CHARS);
}

/** `tier (choice): one of "small", "large"; default "small" · Which size.` */
function renderInput(spec: InputSpec): string {
  const required = (mustPass(spec) && spec.required) || unsetEnvironment([spec]);
  const kind = required ? `${spec.type}, required` : mustPass(spec) ? "boolean, must pass" : spec.type;
  const shown = spec.options.slice(0, MAX_OPTIONS_SHOWN).map((option) => asPassed(spec, option));
  const more = spec.options.length - shown.length;
  const parts = [
    ...(spec.type === "choice" ? [`one of ${shown.join(", ")}${more ? `, and ${more} more` : ""}`] : []),
    ...(spec.hasDefault ? [`default ${asPassed(spec, spec.default)}`] : []),
    ...(spec.type === "environment" ? ["never set by this tong"] : []),
  ];
  const about = clip(spec.description, MAX_DESCRIPTION_CHARS);
  return `  ${spec.name} (${kind})${parts.length ? `: ${parts.join("; ")}` : ""}${about ? ` · ${about}` : ""}`;
}

/** The lines that fit in `budget` characters, and a count of the rest. */
function withinBudget(lines: readonly string[], budget: number): string[] {
  let used = 0;
  const kept = lines.filter((line) => (used += line.length + 1) <= budget);
  const rest = lines.length - kept.length;
  return rest ? [...kept, `  ...and ${rest} more input${rest === 1 ? "" : "s"}`] : kept;
}

/**
 * Where to read a verb's file for the listing, and why a dispatch would refuse now.
 * A refusal still lists inputs: from GitHub's copy of the branch if it has one, else the default branch's.
 */
async function listingRef(
  context: Context,
  entry: DispatchEntry,
  defaultBranch: string,
  tips: (branch: string) => Promise<string | null>,
) {
  try {
    const { branch, tip } = await resolveRef(context, entry, defaultBranch, tips);
    return { branch, tip, refusal: "" };
  } catch (err) {
    const refusal = clean((err as Error).message);
    const current = entry.ref === "current" ? await context.repo.currentBranch() : null;
    const branchTip = current && current !== defaultBranch ? await tips(current) : null;
    if (current && branchTip) return { branch: current, tip: branchTip, refusal };
    const tip = await tips(defaultBranch);
    if (!tip) throw err;
    return { branch: defaultBranch, tip, refusal };
  }
}

/** Each dispatch verb's workflow and inputs, read on its branch now, and each verb dropped at startup. */
export async function listWorkflows(context: Context): Promise<string> {
  const config = context.dispatch;
  if (!config) throw new Error("this tong has no dispatch verbs.");
  // Verbs sharing a branch or a file at one tip ask GitHub once.
  const tipsAsked = new Map<string, Promise<string | null>>();
  let unlisted = (_entry: DispatchEntry) => "";
  if (config.entries.length) {
    try {
      const now = await listedNow(context, config.defaultBranch, "");
      tipsAsked.set(config.defaultBranch, Promise.resolve(now.tip));
      unlisted = (entry) => {
        try {
          checkListed(entry, now.listed, config.defaultBranch);
          return "";
        } catch (err) {
          return (err as Error).message;
        }
      };
    } catch (err) {
      unlisted = () => (err as Error).message;
    }
  }
  const tips = (branch: string) => {
    if (!tipsAsked.has(branch)) tipsAsked.set(branch, context.github.branchTip(branch));
    return tipsAsked.get(branch)!;
  };
  const files = new Map<string, Promise<string>>();
  // Each verb gets a share, so one agent-written file cannot crowd the others out.
  const budget = Math.floor(MAX_LISTING_CHARS / Math.max(1, config.entries.length));
  const sections = [];
  for (const entry of config.entries) {
    const file = `.github/workflows/${entry.file}`;
    try {
      const { branch, tip, refusal } = await listingRef(context, entry, config.defaultBranch, tips);
      const key = `${entry.file}@${tip}`;
      if (!files.has(key)) files.set(key, context.github.workflowFile(entry.file, tip));
      const specs = dispatchInputs(await files.get(key)!);
      // Labelled by the verb's own branch; a fallback read says whose inputs these are.
      const where =
        entry.ref === "default"
          ? `${clean(branch)} (default branch)`
          : branch === config.defaultBranch
            ? `the checked-out branch (inputs as on ${clean(branch)})`
            : `${clean(branch)} (checked out)`;
      const unsettable = specs && unsetEnvironment(specs);
      const whys = [
        clip(unlisted(entry), 500),
        refusal,
        !specs ? `${entry.file} on ${clean(branch)} has no workflow_dispatch trigger.` : "",
        unsettable ? `the workflow requires environment input ${unsettable}, which this tong never sets.` : "",
      ].filter(Boolean);
      const inputs = !specs ? [] : specs.length ? specs.map(renderInput) : ["  no inputs"];
      const head = [
        `${entry.verb}: ${file} on ${where}, at ${tip.slice(0, 12)}`,
        ...whys.map((why) => `  cannot dispatch now: ${why}`),
      ];
      sections.push([...head, ...withinBudget(inputs, budget - head.join("\n").length)].join("\n"));
    } catch (err) {
      const whys = [unlisted(entry), (err as Error).message].filter(Boolean).map((why) => clip(why, 500));
      sections.push([`${entry.verb}: ${file}`, ...whys.map((why) => `  cannot dispatch now: ${why}`)].join("\n"));
    }
  }
  const dropped = config.dropped.map(({ verb, why }) => `${verb}: dropped at startup\n  ${why}.`);
  const none = config.unusable
    ? [`No dispatch verbs this session: ${config.unusable}.`]
    : !sections.length && !dropped.length
      ? [`No dispatch verbs this session: ${ALLOWLIST} on ${clean(config.defaultBranch)} had none at startup.`]
      : [];
  return [...sections, ...dropped, ...none].join("\n\n");
}
