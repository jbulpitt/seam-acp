import { describe, expect, it } from "vitest";
import * as commands from "../packages/core/src/platforms/google-chat/commands.js";

const parse = (args: string) => (commands as any).parseGoogleChatNewArgs(args);

describe("Google Chat /new space arguments", () => {
  it("starts with argumentText, not the raw mentioned message text", () => {
    const command = commands.parseGoogleChatCommand({ type: "MESSAGE", space: { name: "spaces/origin" },
      user: { name: "users/person" }, message: { slashCommand: { commandId: 1 },
        text: "@Seam /new wrong", argumentText: "/new Intake cleanup agent=codex@remote model=provider-new effort=high repo=/work" } });
    expect(command?.args).toBe("Intake cleanup agent=codex@remote model=provider-new effort=high repo=/work");
    expect(parse(command!.args)).toEqual({ name: "Intake cleanup",
      overrides: { agent: "codex@remote", model: "provider-new", effort: "high", repo: "/work" } });
  });

  it("joins all non-option tokens as the name, including tokens after options", () => {
    expect(parse("Intake agent=codex@remote cleanup model=native-id follow up"))
      .toEqual({ name: "Intake cleanup follow up", overrides: { agent: "codex@remote", model: "native-id" } });
  });

  it.each(["", "agent=codex", "model=default effort=auto repo=/repo"])("uses the default title for %s", args => {
    expect(parse(args).name).toBe("seam");
  });

  it("keeps quoted repo paths intact for the existing repo resolver", () => {
    expect(parse('My task repo="/work/chosen repo" model=provider-alias'))
      .toEqual({ name: "My task", overrides: { repo: "/work/chosen repo", model: "provider-alias" } });
  });

  it("leaves provider-specific model and effort ids for shared semantic validation", () => {
    expect(parse("Case model=provider/future-model effort=provider-special"))
      .toEqual({ name: "Case", overrides: { model: "provider/future-model", effort: "provider-special" } });
  });

  it.each(["agnet=codex", "location=remote", "permissions=always"])("reports the unknown key in %s", args => {
    expect(() => parse(args)).toThrow(`Unknown /new option: ${args.split("=")[0]}`);
  });

  it.each(["agent", "model", "effort", "repo"])("does not quietly inherit an empty %s value", key => {
    expect(() => parse(`Task ${key}=`)).toThrow(key);
  });
});
