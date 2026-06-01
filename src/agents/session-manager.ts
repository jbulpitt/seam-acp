export interface SessionSummaryLine {
  sender: "human" | "agent";
  text: string;
}

export interface SessionSummary {
  sessionId: string;
  createdAt?: number;       // timestamp in ms
  lastActivityAt?: number;  // timestamp in ms
  previewLines: SessionSummaryLine[];
  estimatedTokens?: number;
}

export interface ContextUsage {
  /** Underlying API model id if known (e.g. "claude-opus-4-7"). */
  model: string | null;
  /** Total tokens currently in the context window. */
  totalUsed: number;
  /** Context window size for the active model. */
  contextLimit: number;
}

export interface ISessionManager {
  listSessions(cwd: string): Promise<SessionSummary[]>;
  cloneSession(cwd: string, oldSessionId: string, newSessionId: string): Promise<void>;
  deleteSession(cwd: string, sessionId: string): Promise<void>;
  getTranscript(cwd: string, sessionId: string): Promise<string>;
  repairSession?(cwd: string, sessionId: string): Promise<void>;
  compactSession?(cwd: string, sessionId: string, summary: string): Promise<void>;
  /** Optional side-channel readout of the most recent context-window usage
   *  (e.g. parsed from session transcripts on disk). Used by profiles where
   *  the ACP path doesn't surface live `usage_update` notifications. */
  getUsage?(cwd: string, sessionId?: string, newerThanMs?: number): Promise<ContextUsage>;
  /** Optional: write an uploaded attachment to the agent's filesystem and
   *  return the absolute path. Used by network-restricted profiles (e.g.
   *  remote-mac) where the agent can't fetch Discord CDN URLs but can
   *  consume local files. */
  writeAttachment?(
    cwd: string,
    filename: string,
    base64: string
  ): Promise<{ path: string }>;
}

export function cleanTextForPreview(text: string): string {
  if (!text) return "";

  // Remove XML/HTML tags (like <thoughts>, <USER_REQUEST>, etc.)
  let clean = text.replace(/<[^>]+>/g, " ");

  // Split into lines to filter out code blocks and structural markup
  const rawLines = clean.split(/\r?\n/);
  const cleanLines: string[] = [];

  for (let line of rawLines) {
    line = line.trim();
    if (!line) continue;

    // Skip code block fences
    if (/^`{3,}/.test(line)) continue;

    // Skip lines that look like comments
    if (/^\s*(\/\/|#|\/\*|\*\/)/.test(line)) continue;

    // Skip lines that only contain structural code/JSON symbols (braces, brackets, punctuation, quotes)
    if (/^[{}[\],.;():\s"'+=\-*\/\\|&!%?^~<>#`@_]{3,}$/.test(line)) continue;

    // Skip slash commands (e.g. /model model default)
    if (/^\/[a-zA-Z]/.test(line)) continue;

    // Skip model configuration messages (e.g. Set model to claude-opus-4-7[1m], model default, model: claude)
    if (/^(set\s+|active\s+|current\s+)?model\s*(to\b|is\b|default\b|set\b|:)/i.test(line)) continue;
    if (/^set\s+model\b/i.test(line)) continue;

    // Strip markdown formatting symbols on the line
    let cleanLine = line
      .replace(/^#+\s+/, "") // strip headers
      .replace(/^>\s*/, "")  // strip blockquotes
      .replace(/^([*\-+]|\d+\.)\s+/, "") // strip list bullets
      .replace(/[`*_~]+/g, "") // strip code backticks, bold, italic, strike
      .trim();

    // Skip bot thoughts and programmatic outputs beginning with "I will"
    if (/^i\s+will\b/i.test(cleanLine)) continue;

    if (cleanLine.length > 0) {
      cleanLines.push(cleanLine);
    }
  }

  // Now, merge/concat short lines with the next line, or skip them
  const finalLines: string[] = [];
  let buffer = "";

  for (let i = 0; i < cleanLines.length; i++) {
    const current = cleanLines[i]!;
    // If it's a very short line (e.g. < 4 characters or mostly punctuation), let's skip it or concat it
    if (current.length < 4) {
      continue;
    }

    if (buffer) {
      buffer += " " + current;
    } else {
      buffer = current;
    }

    // If the buffer is long enough or it's the last line, push it
    if (buffer.length >= 15 || i === cleanLines.length - 1) {
      finalLines.push(buffer);
      buffer = "";
    }
  }

  if (buffer) {
    finalLines.push(buffer);
  }

  // Join the final lines with a space
  return finalLines.join(" ").trim();
}

