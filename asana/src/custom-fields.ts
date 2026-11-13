import * as z from "zod";
import { GID, type Compact, type CustomField, type CustomFieldWrite } from "./asana.js";

const MAX_FIELDS = 20;
const MAX_VALUES = 20;
const MAX_PEOPLE = 20;
const MAX_LISTED = 20;

/** The most elements plus members a `customFieldsInput` map adds to a tool's arguments. */
export const MAX_CUSTOM_FIELD_ELEMENTS = MAX_FIELDS * (1 + MAX_VALUES);

const oneLineText = z
  .string()
  .max(1024)
  .regex(/^[^\x00-\x1f\x7f-\x9f\u2028\u2029]*$/, "must be one line");

export const customFieldsInput = z
  .preprocess(
    (raw, ctx) => {
      if (typeof raw === "object" && raw !== null && Object.hasOwn(raw, "__proto__")) {
        ctx.addIssue({ code: "custom", message: "__proto__ is not a custom field this tong can set" });
      }
      return raw;
    },
    z
      .record(oneLineText.min(1), z.union([oneLineText, z.number(), z.array(oneLineText).max(MAX_VALUES), z.null()]))
      .refine((fields) => {
        const count = Object.keys(fields).length;
        return count >= 1 && count <= MAX_FIELDS;
      }, `must name 1-${MAX_FIELDS} custom fields`),
  )
  .describe(
    "Values by field gid or exact name: an option's name or gid as get_task shows it (enum), a list of them " +
      "(multi_enum), user gids or 'me' (people), a number, text, or YYYY-MM-DD or ISO 8601 date-time (date). " +
      "null clears.",
  );

export type CustomFieldsInput = z.infer<typeof customFieldsInput>;

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

const SETTABLE_TYPES = new Set(["text", "number", "enum", "multi_enum", "date", "people"]);

const quote = (name: string) => JSON.stringify(name);

function quotedList(names: string[]): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, MAX_LISTED).map(quote).join(", ") || "none";
  return unique.length > MAX_LISTED ? `${shown}, and ${unique.length - MAX_LISTED} more` : shown;
}

function byGidOrName<Item extends Compact>(items: Item[], key: string): Item[] {
  const byGid = items.find((item) => item.gid === key);
  if (byGid) return [byGid];
  return [...new Map(items.filter((item) => item.name === key).map((item) => [item.gid, item])).values()];
}

function pick<Item extends Compact>(items: Item[], key: string, owner: string, noun: string): Item {
  const [item, ...others] = byGidOrName(items, key);
  if (!item) {
    const names = quotedList(items.map((each) => each.name));
    throw new Error(`${owner} has no ${noun} ${quote(key)}; its ${noun}s are ${names}.`);
  }
  if (others.length) {
    const gids = [item, ...others].map((each) => each.gid).join(", ");
    throw new Error(`${owner} has ${others.length + 1} ${noun}s named ${quote(key)}; pass a gid: ${gids}.`);
  }
  return item;
}

function optionGid(field: CustomField, key: string): string {
  const what = `custom field ${quote(field.name)}`;
  const enabled = field.enumOptions.filter((option) => option.enabled);
  const [disabled] = byGidOrName(field.enumOptions, key);
  if (disabled && !byGidOrName(enabled, key).length) {
    throw new Error(`${what}'s option ${quote(disabled.name)} is disabled.`);
  }
  return pick(enabled, key, what, "option").gid;
}

function toWrite(field: CustomField, value: CustomFieldsInput[string]): CustomFieldWrite {
  const what = `custom field ${quote(field.name)} (${field.type ?? "unknown type"})`;
  const refuse = (expected: string) => new Error(`${what} takes ${expected}, or null to clear it.`);
  if (field.readOnly) throw new Error(`${what} cannot be set.`);
  if (value === null && SETTABLE_TYPES.has(field.type ?? "")) return null;
  switch (field.type) {
    case "text":
      if (typeof value !== "string") throw refuse("text");
      return value;
    case "number":
      if (typeof value !== "number") throw refuse("a number");
      return value;
    case "enum":
      if (typeof value !== "string") throw refuse("an option's name or gid");
      return optionGid(field, value);
    case "multi_enum":
      if (!Array.isArray(value)) throw refuse("a list of option names or gids");
      return [...new Set(value.map((option) => optionGid(field, option)))];
    case "date":
      if (typeof value === "string" && isoDate.safeParse(value).success) return { date: value };
      if (typeof value === "string" && isoDateTime.safeParse(value).success) return { date_time: value };
      throw refuse("YYYY-MM-DD or an ISO 8601 date-time");
    case "people":
      if (!Array.isArray(value) || !value.every((person) => person === "me" || GID.test(person))) {
        throw refuse("a list of user gids or 'me'");
      }
      return value;
    default:
      throw new Error(`${what} cannot be set.`);
  }
}

/** `resolvePerson` maps a user gid or "me" to a gid, and throws for a user the caller must not set. */
export async function resolveCustomFields(
  input: CustomFieldsInput,
  available: CustomField[],
  where: string,
  resolvePerson: (person: string) => Promise<string>,
): Promise<Record<string, CustomFieldWrite>> {
  const resolved = new Map<string, CustomFieldWrite>();
  const peopleByField = new Map<string, string[]>();
  for (const [key, value] of Object.entries(input)) {
    const field = pick(available, key, where, "custom field");
    if (resolved.has(field.gid)) throw new Error(`custom field ${quote(field.name)} is given twice.`);
    const write = toWrite(field, value);
    resolved.set(field.gid, write);
    if (field.type === "people" && Array.isArray(write)) peopleByField.set(field.gid, write);
  }
  const people = new Set([...peopleByField.values()].flat());
  if (people.size > MAX_PEOPLE) throw new Error(`pass at most ${MAX_PEOPLE} people across 'custom_fields'.`);
  const personGids = new Map<string, string>();
  for (const person of people) personGids.set(person, await resolvePerson(person));
  for (const [gid, fieldPeople] of peopleByField) {
    resolved.set(gid, [...new Set(fieldPeople.map((person) => personGids.get(person)!))]);
  }
  return Object.fromEntries(resolved);
}
