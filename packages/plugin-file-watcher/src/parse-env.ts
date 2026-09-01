// Minimal .env parser: KEY=VALUE lines, `#` full-line comments, surrounding quotes.
// Limits: no export prefixes, no multiline values, no escape sequences; inline
// comments are only stripped from unquoted values at the first ` #`.
// Forbidden keys (`__proto__`, `constructor`, `prototype`) are skipped.

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isQuoted(value: string): boolean {
  return (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  );
}

export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (FORBIDDEN_KEYS.has(key)) continue;
    let value = line.slice(eqIdx + 1).trim();
    if (isQuoted(value)) {
      value = value.slice(1, -1);
    } else {
      const commentIdx = value.indexOf(" #");
      if (commentIdx !== -1) value = value.slice(0, commentIdx).trimEnd();
      if (isQuoted(value)) value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
