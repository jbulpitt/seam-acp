import type Database from "better-sqlite3";
import type { GoogleChatSpace } from "./spaces.js";
import type { GoogleChatSpaceSubscription } from "./space-subscriptions.js";

export interface StoredGoogleChatSpace {
  space: GoogleChatSpace & { name: string };
  appUser?: string;
  subscription?: GoogleChatSpaceSubscription;
  messageRoots?: Record<string, GoogleChatMessageRoot>;
  ownMessages?: Record<string, true>;
}

export interface GoogleChatMessageRoot {
  name: string;
  sender: string;
  createTime: string;
  text: string;
  filename?: string;
  own: boolean;
}

/** Membership, native threading metadata and Google's returned renewal deadline. */
export class GoogleChatSpaceStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS google_chat_spaces (
      name TEXT PRIMARY KEY, state_json TEXT NOT NULL
    )`);
  }

  get(name: string): StoredGoogleChatSpace | undefined {
    const row = this.db.prepare("SELECT state_json FROM google_chat_spaces WHERE name = ?").get(name) as
      { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) : undefined;
  }

  list(): StoredGoogleChatSpace[] {
    return (this.db.prepare("SELECT state_json FROM google_chat_spaces").all() as { state_json: string }[])
      .map(row => JSON.parse(row.state_json));
  }

  put(state: StoredGoogleChatSpace): void {
    this.db.prepare("INSERT INTO google_chat_spaces(name, state_json) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state_json=excluded.state_json")
      .run(state.space.name, JSON.stringify(state));
  }

  messageRoot(space: string, thread: string): GoogleChatMessageRoot | undefined {
    return this.get(space)?.messageRoots?.[thread];
  }

  recordMessageRoot(space: string, thread: string, message: GoogleChatMessageRoot): void {
    const prior = this.get(space) ?? { space: { name: space } };
    this.put({ ...prior, messageRoots: { ...prior.messageRoots, [thread]: message } });
  }

  /** Reserve the client alias before create, then retain Google's canonical name. */
  recordOwnMessage(name: string): void {
    const space = name.split("/messages/")[0]!;
    const prior = this.get(space) ?? { space: { name: space } };
    this.put({ ...prior, ownMessages: { ...prior.ownMessages, [name]: true } });
  }

  isOwnMessage(message: { name?: string; clientAssignedMessageId?: string }): boolean {
    if (!message.name) return false;
    const space = message.name.split("/messages/")[0]!;
    const known = this.get(space)?.ownMessages;
    return known?.[message.name] === true || Boolean(message.clientAssignedMessageId
      && known?.[`${space}/messages/${message.clientAssignedMessageId}`]);
  }

  delete(name: string): void { this.db.prepare("DELETE FROM google_chat_spaces WHERE name = ?").run(name); }
}
