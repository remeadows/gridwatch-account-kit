// Fails any test that writes to console.warn / console.error without declaring it.
//
// vitest's reporter here does not surface console output from passing tests, so "this path is
// quiet" was never actually proven. Every warn/error call made during a test is recorded; in
// afterEach, the test fails if any call was not whitelisted by expectConsole(), or if an
// expectConsole() it declared never matched anything.
//
// The guard replaces console.warn / console.error with plain functions (not vi.spyOn), so a test's
// own vi.restoreAllMocks() / mockRestore() cannot remove it. A test that installs its OWN spy with
// mockImplementation() silences the call before it reaches the guard: that test has taken
// ownership of the console for itself (and asserts on its spy); anything that still reaches the
// real console is checked here.
import { format } from "node:util";
import { afterEach, beforeEach } from "vitest";

type Level = "warn" | "error";
type Expectation = { level: Level; pattern: RegExp | string; hits: number };

let calls: Array<{ level: Level; message: string }> = [];
let expectations: Expectation[] = [];
const original = { warn: console.warn, error: console.error };

// A /g or /y pattern carries lastIndex between test() calls; reset it so every message is matched
// from the start, whatever an earlier match (or the caller) left behind.
const matches = (pattern: RegExp | string, message: string) => {
  if (typeof pattern === "string") return message.includes(pattern);
  pattern.lastIndex = 0;
  return pattern.test(message);
};

/** Declare that this test is expected to write `pattern` (a RegExp, or a substring) to
 *  console[level]. Every matching call is allowed; the test fails if none happens. */
export function expectConsole(level: Level, pattern: RegExp | string): void {
  expectations.push({ level, pattern, hits: 0 });
}

beforeEach(() => {
  calls = [];
  expectations = [];
  console.warn = (...args: unknown[]) => { calls.push({ level: "warn", message: format(...args) }); };
  console.error = (...args: unknown[]) => { calls.push({ level: "error", message: format(...args) }); };
});

afterEach(() => {
  console.warn = original.warn;
  console.error = original.error;
  const unexpected: string[] = [];
  for (const call of calls) {
    const hit = expectations.filter((e) => e.level === call.level && matches(e.pattern, call.message));
    if (hit.length === 0) unexpected.push(`console.${call.level}: ${call.message}`);
    for (const e of hit) e.hits += 1;
  }
  const missing = expectations.filter((e) => e.hits === 0).map((e) => `expected console.${e.level} matching ${String(e.pattern)} was never written`);
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`[consoleGuard]\n${[...unexpected, ...missing].join("\n")}`);
  }
});
