import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const dist = (file: string) => pathToFileURL(path.resolve(__dirname, "..", "dist", file)).href;

// Vitest's own module transform resolves extensionless relative specifiers
// for us, so a plain `await import(dist(...))` inside a vitest test masks
// the defect this test exists to catch (it stays green before AND after the
// fix). Load the built file in a bare Node child process instead, with no
// bundler/transform in the loop, so the only resolver in play is strict
// Node ESM — this form fails before the fix and passes after.
const loadUnderNode = (specifier: string, checks: string) =>
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const mod = await import(process.argv[1]); ${checks}`,
      "--",
      specifier,
    ],
    { encoding: "utf8" },
  );

describe("dist is valid strict ESM", () => {
  it("index.js loads under Node's resolver (all relative specifiers carry .js)", () => {
    expect(() =>
      loadUnderNode(
        dist("index.js"),
        `if (typeof mod.createAccountKit !== "function") throw new Error("createAccountKit missing");
         if (typeof mod.mountAccountHeader !== "function") throw new Error("mountAccountHeader missing");
         if (typeof mod.validateReturnPath !== "function") throw new Error("validateReturnPath missing");`,
      ),
    ).not.toThrow();
  });
  it("react.js loads under Node's resolver", () => {
    expect(() =>
      loadUnderNode(
        dist("react.js"),
        `if (typeof mod.useAccount !== "function") throw new Error("useAccount missing");`,
      ),
    ).not.toThrow();
  });
});
