import { describe, it, vi } from "vitest";
import { expectConsole } from "./setup/consoleGuard";

// The guard fails a test from its afterEach hook; `it.fails` asserts that the test (hook included)
// failed, which is how the guard's own failure modes are pinned here.
describe("consoleGuard", () => {
  it("allows a warning the test declared (RegExp or substring), any number of times", () => {
    expectConsole("warn", /^hello \d$/);
    expectConsole("error", "boom");
    console.warn("hello 1");
    console.warn("hello 2");
    console.error("it went", "boom");
  });
  // A /g or /y RegExp carries lastIndex between test() calls: without a reset, the second of two
  // identical messages would fail to match and be reported as undeclared.
  it("matches a global or sticky pattern consistently across repeated messages", () => {
    expectConsole("warn", /repeat/g);
    expectConsole("error", /^again$/y);
    console.warn("repeat");
    console.warn("repeat");
    console.warn("repeat");
    console.error("again");
    console.error("again");
  });
  it.fails("fails a test that writes an undeclared console.warn", () => {
    console.warn("surprise");
  });
  it.fails("fails a test that writes an undeclared console.error", () => {
    console.error("surprise");
  });
  it.fails("fails a test whose declared message never appeared", () => {
    expectConsole("warn", "never written");
  });
  it.fails("a declaration for one level does not whitelist the other", () => {
    expectConsole("warn", "x");
    console.warn("x");
    console.error("x");
  });
  it.fails("survives vi.restoreAllMocks() inside the test", () => {
    vi.restoreAllMocks();
    console.warn("still seen");
  });
});
