import { describe, expect, it } from "vitest";
import { decideReconcile, type ReconcileInputs } from "../src/saves/reconcile";

const cloud = (revision: number) => ({ revision, schemaVersion: 1, payload: { coins: 1 }, updatedAt: "2026-09-17T00:00:00Z" });
const base: ReconcileInputs = { signedIn: true, cloud: null, local: null, record: null, owner: null, userId: "u1" };

describe("decideReconcile (spec §5.4 table)", () => {
  it("signed out wins over everything", () => {
    expect(decideReconcile({ ...base, signedIn: false, cloud: cloud(3), local: { coins: 2 } })).toBe("signed_out");
  });
  it("no cloud row", () => {
    expect(decideReconcile(base)).toBe("nothing");
    expect(decideReconcile({ ...base, local: { coins: 2 } })).toBe("upload");                       // unclaimed
    expect(decideReconcile({ ...base, local: { coins: 2 }, owner: "u1" })).toBe("upload");          // own
    expect(decideReconcile({ ...base, local: { coins: 2 }, owner: "u9" })).toBe("ownership_prompt"); // another account's
  });
  it("cloud row, nothing local", () => {
    expect(decideReconcile({ ...base, cloud: cloud(3) })).toBe("use_cloud");
  });
  it("cloud row and a local save with no usable record", () => {
    expect(decideReconcile({ ...base, cloud: cloud(3), local: { coins: 2 } })).toBe("conflict_prompt");                 // unclaimed
    expect(decideReconcile({ ...base, cloud: cloud(3), local: { coins: 2 }, owner: "u9", record: { revision: 3, dirty: false } })).toBe("conflict_prompt"); // other owner
    expect(decideReconcile({ ...base, cloud: cloud(3), local: { coins: 2 }, owner: "u1" })).toBe("conflict_prompt");    // own but never synced
  });
  it("cloud row and a record for this user", () => {
    const withRecord = (revision: number, dirty: boolean) => ({ ...base, cloud: cloud(3), local: { coins: 2 }, owner: "u1", record: { revision, dirty } });
    expect(decideReconcile(withRecord(3, false))).toBe("current");
    expect(decideReconcile(withRecord(3, true))).toBe("restore_dirty");
    expect(decideReconcile(withRecord(2, false))).toBe("use_cloud");
    expect(decideReconcile(withRecord(2, true))).toBe("conflict_prompt");
    expect(decideReconcile(withRecord(4, false))).toBe("conflict_prompt"); // record ahead of cloud: impossible, treat as conflict
  });
});
