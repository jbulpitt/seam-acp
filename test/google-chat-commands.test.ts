import { describe, expect, it } from "vitest";
import { GOOGLE_CHAT_COMMANDS, parseGoogleChatCommand, type GoogleChatCommandEvent } from "../packages/core/src/platforms/google-chat/commands.js";

const event: GoogleChatCommandEvent = {
  type: "MESSAGE", space: { name: "spaces/dm" }, user: { name: "users/person", displayName: "A Person" },
  message: { argumentText: "/model unlisted-model", slashCommand: { commandId: "4" }, thread: { name: "spaces/dm/threads/session" } },
};

describe("Google Chat non-add-on commands", () => {
  it("exposes the exact MVP console entries", () => {
    expect(GOOGLE_CHAT_COMMANDS.map(({ name, id, type }) => ({ name, id, type }))).toEqual([
      { name: "/new", id: 1, type: "SLASH_COMMAND" }, { name: "/cancel", id: 2, type: "SLASH_COMMAND" },
      { name: "/agent", id: 3, type: "SLASH_COMMAND" }, { name: "/model", id: 4, type: "SLASH_COMMAND" },
    ]);
    for (const entry of GOOGLE_CHAT_COMMANDS) expect(entry.description.length).toBeLessThanOrEqual(50);
  });

  it("reads MESSAGE slashCommand.commandId and mention-stripped argumentText", () => {
    expect(parseGoogleChatCommand(event)).toEqual({
      command: "model", args: "unlisted-model", space: "spaces/dm", thread: "spaces/dm/threads/session",
      user: { id: "users/person", name: "A Person" },
    });
  });

  it.each(GOOGLE_CHAT_COMMANDS)("maps $name by its configured id, including numeric wire ids", (entry) => {
    expect(parseGoogleChatCommand({ ...event, message: { slashCommand: { commandId: entry.id }, argumentText: `${entry.name} value` } }))
      .toMatchObject({ command: entry.command, args: "value" });
  });

  it("uses Event.thread when present and represents a top-level space command without a thread", () => {
    expect(parseGoogleChatCommand({ ...event, thread: { name: "spaces/dm/threads/invocation" } })?.thread)
      .toBe("spaces/dm/threads/invocation");
    expect(parseGoogleChatCommand({ ...event, message: { slashCommand: { commandId: "1" }, argumentText: "/new" } })?.thread).toBeNull();
  });

  it("accepts the documented annotation metadata and the add-to-space slash event", () => {
    expect(parseGoogleChatCommand({ ...event, message: { argumentText: "/agent claude", annotations: [
      { type: "USER_MENTION" }, { type: "SLASH_COMMAND", slashCommand: { commandId: "3", type: "INVOKE" } },
    ] } })).toMatchObject({ command: "agent", args: "claude" });
    expect(parseGoogleChatCommand({ ...event, type: "ADDED_TO_SPACE" }))
      .toMatchObject({ command: "model", args: "unlisted-model" });
  });

  it("reads APP_COMMAND appCommandMetadata without an add-on envelope", () => {
    expect(parseGoogleChatCommand({ ...event, type: "APP_COMMAND",
      appCommandMetadata: { appCommandId: 4, appCommandType: "SLASH_COMMAND" },
      message: { argumentText: "/model provider-alias" },
    })).toMatchObject({ command: "model", args: "provider-alias" });
  });

  it("does not take quick-command context message text as command arguments", () => {
    expect(parseGoogleChatCommand({ ...event, type: "APP_COMMAND",
      appCommandMetadata: { appCommandId: 2, appCommandType: "QUICK_COMMAND" },
      message: { text: "unrelated context", argumentText: "not arguments" },
    })).toMatchObject({ command: "cancel", args: "" });
  });

  it.each([
    [" /model\talias\n", "alias"],
    ["/model provider model id", "provider model id"],
    ["/model /model", "/model"],
    ["provider-alias", "provider-alias"],
    ["/modelSuffix", "/modelSuffix"],
    ["/model", ""],
  ])("extracts %s without tokenizing the model id", (argumentText, args) => {
    expect(parseGoogleChatCommand({ ...event, message: { slashCommand: { commandId: "4" }, argumentText } })?.args).toBe(args);
  });

  it("prefers argumentText over text and accepts message text when no argumentText is present", () => {
    expect(parseGoogleChatCommand({ ...event, message: {
      slashCommand: { commandId: "4" }, text: "@Seam /model wrong", argumentText: "/model right",
    } })?.args).toBe("right");
    expect(parseGoogleChatCommand({ ...event, message: { slashCommand: { commandId: "4" }, text: "/model fallback" } })?.args).toBe("fallback");
  });

  it("does not interpret plain slash-like prose, unrelated ids or message actions as commands", () => {
    expect(parseGoogleChatCommand({ ...event, message: { text: "/cancel" } })).toBeNull();
    expect(parseGoogleChatCommand({ ...event, message: { slashCommand: { commandId: "999" } } })).toBeNull();
    expect(parseGoogleChatCommand({ ...event, message: { slashCommand: { commandId: "4junk" } } })).toBeNull();
    expect(parseGoogleChatCommand({ ...event, type: "CARD_CLICKED" })).toBeNull();
    expect(parseGoogleChatCommand({ ...event, type: "APP_COMMAND", appCommandMetadata: { appCommandId: 4, appCommandType: "MESSAGE_ACTION" } })).toBeNull();
    expect(parseGoogleChatCommand({ type: "APP_COMMAND" })).toBeNull();
    expect(parseGoogleChatCommand({ ...event, message: { annotations: [{ type: "SLASH_COMMAND", slashCommand: { commandId: "4", type: "ADD" } }] } })).toBeNull();
  });

  it("names missing required identities rather than making them up", () => {
    expect(() => parseGoogleChatCommand({ ...event, space: undefined })).toThrow("Missing command space.name");
    expect(() => parseGoogleChatCommand({ ...event, user: undefined })).toThrow("Missing command user.name");
    expect(parseGoogleChatCommand({ ...event, user: { name: "users/person" } })?.user).toEqual({ id: "users/person", name: "users/person" });
  });

  it("does not mutate its wire event", () => {
    const before = JSON.stringify(event);
    parseGoogleChatCommand(event);
    expect(JSON.stringify(event)).toBe(before);
  });
});
