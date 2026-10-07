// The CI verbs: the GitHub Actions runs for a commit, a job's steps, and its log.

import type { Job, JobStep, Progress, WorkflowRun } from "./github.js";
import type { Context } from "./server.js";

/** The most log lines one ci_log call returns. */
export const MAX_LOG_LINES = 1000;
export const DEFAULT_LOG_LINES = 200;

/** What one ci_log call returns at most, whatever `limit` says. */
export const MAX_LOG_OUTPUT_CHARS = 50_000;
const MAX_LINE_CHARS = 1000;

/** Conclusions that did not fail. */
const PASSED = new Set(["success", "skipped", "neutral"]);

// Whole OSC, CSI, and two-byte escapes; then C0 but tab, DEL, C1, and bidi or zero-width marks.
const UNSAFE = new RegExp(
  [
    /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/,
    /\x1b\[[0-?]*[ -/]*[@-~]/,
    /\x1b[@-_]?/,
    /[\x00-\x08\x0a-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/,
  ]
    .map((part) => part.source)
    .join("|"),
  "g",
);

/** Text from GitHub or from CI, made safe to show on one line. */
export function clean(text: string): string {
  return text.replace(/\n/g, " ").replace(UNSAFE, "");
}

function failed(item: Progress): boolean {
  return item.completed && !PASSED.has(item.state);
}

/** `2m50s`, or null when either end is unknown. */
function duration(from: string | null, to: string | null): string | null {
  const ms = Date.parse(to ?? "") - Date.parse(from ?? "");
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function timing(item: { completed: boolean; createdAt?: string | null; startedAt: string | null }, end: string | null) {
  const parts: string[] = [];
  const queued = item.createdAt === undefined ? null : duration(item.createdAt, item.startedAt);
  if (queued) parts.push(`queued ${queued}`);
  const ran = item.completed ? duration(item.startedAt, end) : null;
  if (ran) parts.push(`ran ${ran}`);
  else if (item.startedAt && !item.completed) parts.push(`since ${item.startedAt}`);
  return parts;
}

/** Only a step that started has any log to open at. */
function firstFailedStep(job: Job): JobStep | undefined {
  return job.steps.find((step) => failed(step) && step.startedAt);
}

export type CiStatusInput = { sha?: string; pr?: number };

type Target = { sha: string; label: string; note?: string };

/** By default, the checked-out branch as origin has it. */
async function resolveTarget(context: Context, input: CiStatusInput): Promise<Target> {
  if (input.sha !== undefined && input.pr !== undefined) throw new Error("pass 'sha' or 'pr', not both.");
  if (input.sha !== undefined) return { sha: input.sha, label: input.sha.slice(0, 12) };
  if (input.pr !== undefined) {
    const pr = await context.github.pullRequest(input.pr);
    if (!pr.headSha) throw new Error(`GitHub reported no head commit for pull request #${pr.number}.`);
    return { sha: pr.headSha, label: `#${pr.number} (${clean(pr.head)} at ${pr.headSha.slice(0, 12)})` };
  }

  const branch = await context.repo.currentBranch();
  if (!branch) throw new Error("HEAD is detached; pass 'sha' or 'pr'.");
  const sha = await context.repo.remoteTrackingSha(branch);
  if (!sha) throw new Error(`origin has no ${branch}; push it first, or pass 'sha' or 'pr'.`);
  const head = await context.repo.headSha();
  return {
    sha,
    label: `origin/${branch} at ${sha.slice(0, 12)}`,
    note: head === sha ? undefined : `HEAD is at ${head.slice(0, 12)}, which is not what origin/${branch} has.`,
  };
}

function renderJob(job: Job): string {
  const step = firstFailedStep(job);
  const where = step ? `step ${step.number} (${clean(step.name)})` : "";
  const state = !step ? job.state : job.completed ? `${job.state} at ${where}` : `${job.state}, ${where} failed`;
  return [`  job ${job.id} ${clean(job.name)}: ${state}`, ...timing(job, job.completedAt)].join(" · ");
}

function renderRun(run: WorkflowRun, jobs: { jobs: Job[]; more: boolean }): string {
  const attempt = run.attempt > 1 ? `, attempt ${run.attempt}` : "";
  const head = [
    `${clean(run.name)} (${clean(run.event)}): ${run.state}`,
    ...timing(run, run.updatedAt),
    `run ${run.id}${attempt}`,
  ];
  return [
    head.join(" · "),
    run.url,
    ...jobs.jobs.map(renderJob),
    ...(jobs.more ? [`  ...and more jobs than the ${jobs.jobs.length} shown`] : []),
  ].join("\n");
}

export async function ciStatus(context: Context, input: CiStatusInput): Promise<string> {
  const target = await resolveTarget(context, input);
  const { runs, more } = await context.github.workflowRuns(target.sha);
  const note = target.note ? [target.note] : [];
  if (runs.length === 0) {
    return [
      `No workflow runs for ${target.label}. If it was just pushed, runs can take a few seconds to appear.`,
      ...note,
    ].join("\n");
  }

  const jobs = await Promise.all(runs.map((run) => context.github.runJobs(run.id)));
  const count = `${runs.length}${more ? "+" : ""} workflow run${runs.length === 1 && !more ? "" : "s"}`;
  return [
    [`CI for ${target.label}: ${count}, newest first.`, ...note].join("\n"),
    ...runs.map((run, i) => renderRun(run, jobs[i])),
    "Read a job's steps with ci_job and its log with ci_log.",
  ].join("\n\n");
}

export async function ciJob(context: Context, input: { job_id: number }): Promise<string> {
  const job = await context.github.job(input.job_id);
  const labels = job.labels.length ? ` (${job.labels.map(clean).join(", ")})` : "";
  const runner = job.runner ? [`runner ${clean(job.runner)}${labels}`] : [];
  const steps = job.steps.map((step) => {
    const offset = duration(job.startedAt, step.startedAt);
    const took = step.completed ? duration(step.startedAt, step.completedAt) : null;
    return [
      `  ${step.number}. ${clean(step.name)}: ${step.state}`,
      ...(offset ? [`at +${offset}`] : []),
      ...(took ? [`took ${took}`] : []),
    ].join(" · ");
  });
  return [
    `job ${job.id} ${clean(job.name)}: ${job.state} · run ${job.runId}, attempt ${job.attempt}`,
    [...runner, ...timing(job, job.completedAt)].join(" · "),
    job.url,
    "",
    ...(steps.length ? steps : ["  (no steps reported)"]),
  ].join("\n");
}

type LogLine = { text: string; time: number };

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) /;

/** A line with no timestamp of its own takes the one before it. */
export function parseLog(text: string): LogLine[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  let time = NaN;
  return lines.map((line) => {
    const match = STAMP.exec(line);
    if (match) time = Date.parse(match[1]);
    return { text: clean(line), time };
  });
}

/** Step times are whole seconds, so the window takes in all of its first and last second. */
export function stepRange(lines: readonly LogLine[], step: JobStep): [number, number] {
  if (!step.startedAt) throw new Error(`step ${step.number} (${clean(step.name)}) never started, so it has no log.`);
  const from = Math.floor(Date.parse(step.startedAt) / 1000) * 1000;
  const to = step.completedAt ? Math.floor(Date.parse(step.completedAt) / 1000) * 1000 + 1000 : Infinity;
  const first = lines.findIndex((line) => line.time >= from);
  if (first === -1) return [lines.length, lines.length];
  const end = lines.findIndex((line, i) => i >= first && line.time >= to);
  return [first, end === -1 ? lines.length : end];
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)}... (${line.length - MAX_LINE_CHARS} more characters)`
    : line;
}

export type CiLogInput = { job_id: number; step?: number; start?: number; limit?: number };

export async function ciLog(context: Context, input: CiLogInput): Promise<string> {
  const [job, log] = await Promise.all([context.github.job(input.job_id), context.github.jobLog(input.job_id)]);
  const lines = parseLog(log.text);
  const limit = input.limit ?? DEFAULT_LOG_LINES;

  // A failed job's log opens at the step that failed, unless the caller is paging.
  const step =
    input.step !== undefined
      ? job.steps.find((s) => s.number === input.step)
      : input.start === undefined && failed(job)
        ? firstFailedStep(job)
        : undefined;
  if (input.step !== undefined && !step) {
    throw new Error(`job ${job.id} has no step ${input.step}; ci_job lists its steps.`);
  }
  const [rangeStart, rangeEnd] = step ? stepRange(lines, step) : [0, lines.length];
  const scope = step
    ? `step ${step.number} (${clean(step.name)}), log lines ${rangeStart + 1}-${rangeEnd}`
    : `log lines 1-${lines.length}`;
  const title = `job ${job.id} ${clean(job.name)} (${job.state})`;
  if (rangeStart === rangeEnd) return `${title}: ${step ? `step ${step.number} has` : "the log has"} no lines.`;
  if (input.start !== undefined && (input.start - 1 < rangeStart || input.start > rangeEnd)) {
    throw new Error(`start=${input.start} is outside ${scope}.`);
  }

  // From `start` forwards, else the last `limit` lines; either way within the budget.
  const forward = input.start !== undefined;
  let first = forward ? input.start! - 1 : Math.max(rangeStart, rangeEnd - limit);
  let end = forward ? Math.min(rangeEnd, first + limit) : rangeEnd;
  const shown: string[] = [];
  let budget = MAX_LOG_OUTPUT_CHARS;
  for (let i = forward ? first : end - 1; forward ? i < end : i >= first; forward ? i++ : i--) {
    const text = clip(lines[i].text);
    budget -= text.length + 1;
    if (budget < 0 && shown.length > 0) {
      if (forward) end = i;
      else first = i + 1;
      break;
    }
    if (forward) shown.push(text);
    else shown.unshift(text);
  }

  const call = `call ci_log with ${step ? `step=${step.number}, ` : ""}start=`;
  const footer = [
    ...(first > rangeStart ? [`Earlier: ${call}${Math.max(rangeStart, first - shown.length) + 1}.`] : []),
    ...(end < rangeEnd ? [`Later: ${call}${end + 1}.`] : []),
  ];
  return [
    `${title}: ${scope}; showing ${first + 1}-${end}.`,
    ...(log.truncated ? ["Only the end of this log was kept; line 1 is where that starts."] : []),
    "",
    ...shown,
    ...(footer.length ? ["", ...footer] : []),
  ].join("\n");
}
