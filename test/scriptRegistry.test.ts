import { describe, expect, it } from "vitest";
import { getScript, listScripts, SCRIPTS } from "../src/core/scriptRegistry.js";

describe("script registry", () => {
  it("only contains the explicitly registered scripts", () => {
    expect(Object.keys(SCRIPTS).sort()).toEqual(["apply-migration", "vacuum-analyze"]);
  });

  it("returns null for an unregistered script name instead of guessing", () => {
    expect(getScript("delete-everything")).toBeNull();
    expect(getScript("")).toBeNull();
  });

  it("vacuum-analyze is auto_fix (reversible, routine)", () => {
    expect(getScript("vacuum-analyze")?.trustTier).toBe("auto_fix");
  });

  it("apply-migration is requires_approval (structural/schema change)", () => {
    expect(getScript("apply-migration")?.trustTier).toBe("requires_approval");
  });

  it("listScripts returns every registered script", () => {
    expect(listScripts().map((s) => s.name).sort()).toEqual(["apply-migration", "vacuum-analyze"]);
  });

  it("apply-migration rejects a filename with a path separator (traversal attempt)", async () => {
    const script = getScript("apply-migration")!;
    await expect(
      script.run({ pool: {} as never, args: { file: "../../etc/passwd" } }),
    ).rejects.toThrow(/unsafe filename/);
  });

  it("apply-migration rejects a filename that doesn't exist on disk", async () => {
    const script = getScript("apply-migration")!;
    await expect(
      script.run({ pool: {} as never, args: { file: "0001_does_not_exist.sql" } }),
    ).rejects.toThrow(/not a known migration/);
  });

  it("apply-migration requires a file arg", async () => {
    const script = getScript("apply-migration")!;
    await expect(script.run({ pool: {} as never, args: {} })).rejects.toThrow(/requires/);
  });
});
