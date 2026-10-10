export interface GoogleChatSpace {
  name?: string;
  spaceType?: string;
  spaceThreadingState?: string;
  type?: string;
  displayName?: string;
}

export interface GoogleChatAnnotation {
  type?: string;
  startIndex?: number;
  length?: number;
  userMention?: { type?: string; user?: { name?: string; type?: string } };
  slashCommand?: { commandId?: string | number; type?: string };
}

export interface GoogleChatSpaceLifecycle {
  type: "ADDED_TO_SPACE" | "REMOVED_FROM_SPACE";
  space: GoogleChatSpace & { name: string };
}

export function isSharedSpace(space: GoogleChatSpace): boolean {
  return space.spaceType === "SPACE" || space.spaceType === "GROUP_CHAT" || space.type === "ROOM";
}

function appMention(annotation: GoogleChatAnnotation): boolean {
  return annotation.type === "USER_MENTION" && annotation.userMention?.type === "MENTION"
    && annotation.userMention.user?.type === "BOT";
}

export function hasAppMention(annotations: GoogleChatAnnotation[] = []): boolean {
  return annotations.some(appMention);
}

// Match Google's argumentText: remove annotated app mentions, not human mentions.
export function stripAppMentions(text: string, annotations: GoogleChatAnnotation[] = []): string {
  const spans = annotations.filter(appMention).sort((a, b) => (b.startIndex ?? 0) - (a.startIndex ?? 0));
  for (const span of spans) {
    const start = span.startIndex ?? 0;
    text = text.slice(0, start) + text.slice(start + (span.length ?? 0));
  }
  return text.trim();
}
