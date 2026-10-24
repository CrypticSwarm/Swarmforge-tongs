// One strict YAML reader for workflow files and the allowlist.

import { type Document, parseDocument } from "yaml";

/** The document, or why `subject` cannot be read, naming a line and an error code but quoting no file text. */
export function strictYaml(text: string, subject: string): Document.Parsed {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length) {
    const [error] = doc.errors;
    const line = text.slice(0, error.pos[0]).split("\n").length;
    throw new Error(`${subject} is not valid YAML at line ${line}: ${error.code}.`);
  }
  // GitHub reads YAML 1.2; under 1.1, `on` and `yes` read as booleans.
  if (doc.directives?.yaml.version !== "1.2") throw new Error(`${subject} declares a YAML version other than 1.2.`);
  return doc;
}
