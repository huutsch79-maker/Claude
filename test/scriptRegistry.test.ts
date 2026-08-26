import { describe, expect, it } from "vitest";
import { getScript, listScripts, SCRIPTS } from "../src/core/scriptRegistry.js";

describe("script registry", () => {
  it("only contains the explicitly registered scripts", () => {
    expect(Object.keys(SCRIPTS).sort()).toEqual([
      "apply-migration",
      "apply-website-file",
      "redeploy-jarvis",
      "vacuum-analyze",
    ]);
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

  it("apply-website-file is auto_fix (explicit user decision — see docs/architecture.md)", () => {
    expect(getScript("apply-website-file")?.trustTier).toBe("auto_fix");
  });

  it("redeploy-jarvis is requires_approval (restarts JARVIS itself)", () => {
    expect(getScript("redeploy-jarvis")?.trustTier).toBe("requires_approval");
  });

  it("listScripts returns every registered script", () => {
    expect(listScripts().map((s) => s.name).sort()).toEqual([
      "apply-migration",
      "apply-website-file",
      "redeploy-jarvis",
      "vacuum-analyze",
    ]);
  });

  it("apply-website-file rejects a path traversal attempt", async () => {
    const script = getScript("apply-website-file")!;
    await expect(
      script.run({ pool: {} as never, args: { path: "../../etc/passwd", contentBase64: "AAAA" } }),
    ).rejects.toThrow(/unsafe path/);
  });

  it("apply-website-file refuses to write into .github/", async () => {
    const script = getScript("apply-website-file")!;
    await expect(
      script.run({ pool: {} as never, args: { path: ".github/workflows/deploy.yml", contentBase64: "AAAA" } }),
    ).rejects.toThrow(/\.github/);
  });

  it("apply-website-file requires path and contentBase64 args", async () => {
    const script = getScript("apply-website-file")!;
    await expect(script.run({ pool: {} as never, args: {} })).rejects.toThrow(/requires args\.path/);
    await expect(script.run({ pool: {} as never, args: { path: "x" } })).rejects.toThrow(/requires args\.contentBase64/);
  });

  it("redeploy-jarvis requires JARVIS_DEPLOY_AGENT_URL to be set", async () => {
    const script = getScript("redeploy-jarvis")!;
    delete process.env.JARVIS_DEPLOY_AGENT_URL;
    await expect(script.run({ pool: {} as never, args: {} })).rejects.toThrow(/JARVIS_DEPLOY_AGENT_URL/);
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
