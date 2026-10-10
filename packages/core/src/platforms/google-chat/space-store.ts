import type Database from "better-sqlite3";
import type { GoogleChatSpace } from "./spaces.js";
import type { GoogleChatSpaceSubscription } from "./space-subscriptions.js";

export interface StoredGoogleChatSpace {
  space: GoogleChatSpace & { name: string };
  appUser?: string;
  subscription?: GoogleChatSpaceSubscription;
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

  delete(name: string): void { this.db.prepare("DELETE FROM google_chat_spaces WHERE name = ?").run(name); }
}
