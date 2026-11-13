import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CustomField } from "../src/asana.js";
import { resolveCustomFields, type CustomFieldsInput } from "../src/custom-fields.js";

const ME = "1200000000000001";
const OTHER = "1200000000000009";

function field(index: number, name: string, type: string, options: string[] = [], disabled: number[] = []) {
  const optionGid = (at: number) => `16${index}000000000000${at}`;
  const enumOptions = options.map((name, at) => ({ gid: optionGid(at), name, enabled: !disabled.includes(at) }));
  return { gid: `160000000000000${index}`, name, type, readOnly: false, enumOptions } satisfies CustomField;
}

const FIELDS = [
  field(1, "Priority", "enum", ["High", "Old", "Twin", "Twin", "Low", "Low", "Gone", "Gone"], [1, 4, 6, 7]),
  field(2, "Tags", "multi_enum", ["Red", "Blue"]),
  field(3, "Points", "number"),
  field(4, "Code", "text"),
  field(5, "Ship", "date"),
  field(6, "Reviewers", "people"),
  field(7, "Score", "formula"),
  field(8, "Dup", "text"),
  field(9, "Dup", "number"),
  { ...field(10, "Calc", "number"), readOnly: true },
];

function resolve(input: Record<string, unknown>, available = FIELDS) {
  const asked: string[] = [];
  const result = resolveCustomFields(input as CustomFieldsInput, available, "task 1", async (person) => {
    asked.push(person);
    return person === "me" ? ME : person;
  });
  return { result, asked };
}

describe("resolveCustomFields", () => {
  it("resolves names and gids to Asana's write shape, asking about each person once", async () => {
    const { result, asked } = resolve({
      Priority: "Low",
      "1600000000000002": ["Red", "1620000000000001", "Red"],
      Points: 3.5,
      Code: "A-1",
      Ship: "2026-11-20",
      Reviewers: ["me", OTHER, ME],
    });
    assert.deepEqual(await result, {
      "1600000000000001": "1610000000000005",
      "1600000000000002": ["1620000000000000", "1620000000000001"],
      "1600000000000003": 3.5,
      "1600000000000004": "A-1",
      "1600000000000005": { date: "2026-11-20" },
      "1600000000000006": [ME, OTHER],
    });
    assert.deepEqual(asked, ["me", OTHER, ME]);
  });

  it("clears with null and sends a date-time as date_time", async () => {
    const { result } = resolve({ Priority: null, Reviewers: null, Ship: "2026-11-20T17:00:00.000Z" });
    assert.deepEqual(await result, {
      "1600000000000001": null,
      "1600000000000006": null,
      "1600000000000005": { date_time: "2026-11-20T17:00:00.000Z" },
    });
  });

  it("refuses invalid fields and values before asking about people", async () => {
    for (const [input, message] of [
      [
        { Nope: 1 },
        'task 1 has no custom field "Nope"; its custom fields are "Priority", "Tags", "Points", "Code", "Ship", ' +
          '"Reviewers", "Score", "Dup", "Calc".',
      ],
      [{ Dup: "x" }, 'task 1 has 2 custom fields named "Dup"; pass a gid: 1600000000000008, 1600000000000009.'],
      [
        { Priority: "Urgent" },
        'custom field "Priority" has no option "Urgent"; its options are "High", "Twin", "Low".',
      ],
      [{ Priority: "Old" }, `custom field "Priority"'s option "Old" is disabled.`],
      [{ Priority: "Gone" }, `custom field "Priority"'s option "Gone" is disabled.`],
      [{ Priority: "1610000000000001" }, `custom field "Priority"'s option "Old" is disabled.`],
      [
        { Tags: ["Red", "Twin"] },
        'custom field "Tags" has no option "Twin"; its options are "Red", "Blue".',
      ],
      [
        { Priority: "Twin" },
        'custom field "Priority" has 2 options named "Twin"; pass a gid: 1610000000000002, 1610000000000003.',
      ],
      [{ Priority: 1 }, `custom field "Priority" (enum) takes an option's name or gid, or null to clear it.`],
      [{ Tags: "Red" }, `custom field "Tags" (multi_enum) takes a list of option names or gids, or null to clear it.`],
      [{ Points: "3" }, `custom field "Points" (number) takes a number, or null to clear it.`],
      [{ Code: 1 }, `custom field "Code" (text) takes text, or null to clear it.`],
      [{ Ship: "2026-11-20T17:00" }, /^custom field "Ship" \(date\) takes YYYY-MM-DD or an ISO 8601 date-time,/],
      [{ Reviewers: ["ada@example.com"] }, /^custom field "Reviewers" \(people\) takes a list of user gids or 'me'/],
      [{ Score: 1 }, 'custom field "Score" (formula) cannot be set.'],
      [{ Score: null }, 'custom field "Score" (formula) cannot be set.'],
      [{ Calc: null }, 'custom field "Calc" (number) cannot be set.'],
      [{ Priority: "High", "1600000000000001": null }, 'custom field "Priority" is given twice.'],
      [
        { Reviewers: Array.from({ length: 21 }, (_, index) => `${1200000000000100 + index}`) },
        "pass at most 20 people across 'custom_fields'.",
      ],
    ] as const) {
      const { result, asked } = resolve(input);
      await assert.rejects(result, { message }, JSON.stringify(input));
      assert.deepEqual(asked, []);
    }
  });

  it("lists at most 20 valid names", async () => {
    const many = Array.from({ length: 25 }, (_, index) => field(10 + index, `F${index}`, "text"));
    await assert.rejects(resolve({ Nope: "x" }, many).result, { message: /"F19", and 5 more\.$/ });
    await assert.rejects(resolve({ Nope: "x" }, []).result, { message: /its custom fields are none\.$/ });
  });
});
