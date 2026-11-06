// Example script entry (source). Build bundles this file; agents only call it by id.

export function summarizeNotes(input: string): string {
  return `summarize-notes received ${input.length} chars`;
}
