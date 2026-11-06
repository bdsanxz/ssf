// Shared helpers. Each skill declares what it uses; bundles duplicate per skill.

export function clampText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return input.slice(0, maxChars);
}
