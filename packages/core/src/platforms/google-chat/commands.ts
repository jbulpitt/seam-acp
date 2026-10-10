export const GOOGLE_CHAT_COMMANDS = [
  { command: "new", id: 1, name: "/new", description: "Start a fresh DM session: /new [name]", type: "SLASH_COMMAND" },
  { command: "cancel", id: 2, name: "/cancel", description: "Cancel work in this session", type: "SLASH_COMMAND" },
  { command: "agent", id: 3, name: "/agent", description: "Set this session's agent: /agent <id>", type: "SLASH_COMMAND" },
  { command: "model", id: 4, name: "/model", description: "Set this session's model: /model <id>", type: "SLASH_COMMAND" },
] as const;

export type GoogleChatCommandName = typeof GOOGLE_CHAT_COMMANDS[number]["command"];

export interface GoogleChatCommand {
  command: GoogleChatCommandName;
  args: string;
  space: string;
  thread: string | null;
  user: { id: string; name: string };
}

/** Flat non-add-on Event, as delivered by the Pub/Sub connection. */
export interface GoogleChatCommandEvent {
  type: string;
  appCommandMetadata?: { appCommandId?: number; appCommandType?: string };
  space?: { name?: string };
  thread?: { name?: string };
  user?: { name?: string; displayName?: string };
  message?: {
    argumentText?: string | null;
    text?: string;
    thread?: { name?: string };
    slashCommand?: { commandId?: string | number };
    annotations?: Array<{
      type?: string;
      slashCommand?: { commandId?: string | number; type?: string };
    }>;
  };
}

/** Slash commands normally arrive as MESSAGE; APP_COMMAND carries app metadata. */
export function parseGoogleChatCommand(event: GoogleChatCommandEvent): GoogleChatCommand | null {
  let commandId: string | number | undefined;
  let quickCommand = false;
  if (event.type === "MESSAGE" || event.type === "ADDED_TO_SPACE") {
    commandId = event.message?.slashCommand?.commandId ?? event.message?.annotations
      ?.find((annotation) => annotation.type === "SLASH_COMMAND" && annotation.slashCommand?.type !== "ADD")
      ?.slashCommand?.commandId;
  } else if (event.type === "APP_COMMAND") {
    const type = event.appCommandMetadata?.appCommandType;
    if (type !== "SLASH_COMMAND" && type !== "QUICK_COMMAND") return null;
    commandId = event.appCommandMetadata?.appCommandId;
    quickCommand = type === "QUICK_COMMAND";
  } else return null;
  const spec = GOOGLE_CHAT_COMMANDS.find((entry) => String(entry.id) === String(commandId));
  if (!spec) return null;
  const text = quickCommand ? "" : (event.message?.argumentText ?? event.message?.text ?? "").trim();
  // argumentText removes app mentions, not the slash-command token.
  const hasToken = text === spec.name || (text.startsWith(spec.name) && /\s/.test(text[spec.name.length] ?? ""));
  const userId = required(event.user?.name, "command user.name");
  return {
    command: spec.command,
    args: hasToken ? text.slice(spec.name.length).trim() : text,
    space: required(event.space?.name, "command space.name"),
    thread: event.thread?.name ?? event.message?.thread?.name ?? null,
    user: { id: userId, name: event.user?.displayName ?? userId },
  };
}

function required(value: string | undefined, field: string): string {
  if (value === undefined || value === "") throw new TypeError(`Missing ${field}`);
  return value;
}
