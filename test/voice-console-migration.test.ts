import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../packages/core/src/core/session-store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Voice Console V2 migration", () => {
  it("additively upgrades a shipped V1 database and active row exactly once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-voice-console-migration-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE thread_voice_sessions (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_ref TEXT NOT NULL,
        parent_ref TEXT, guild_id TEXT NOT NULL, voice_channel_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL, owner_name TEXT NOT NULL, status TEXT NOT NULL,
        notice_message_id TEXT, transmitted_audio_ms INTEGER NOT NULL DEFAULT 0,
        created_utc TEXT NOT NULL, updated_utc TEXT NOT NULL, ended_utc TEXT, end_reason TEXT
      );
      CREATE UNIQUE INDEX idx_thread_voice_active_thread
        ON thread_voice_sessions(platform, channel_ref)
        WHERE status IN ('starting','ready','stopping');
      CREATE UNIQUE INDEX idx_thread_voice_active_guild
        ON thread_voice_sessions(guild_id)
        WHERE status IN ('starting','ready','stopping');
      CREATE TABLE thread_voice_segments (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        author_id TEXT NOT NULL, transcript TEXT NOT NULL, state TEXT NOT NULL,
        audio_ms INTEGER NOT NULL DEFAULT 0, dispatch_id TEXT,
        captured_started_utc TEXT NOT NULL, captured_ended_utc TEXT NOT NULL,
        created_utc TEXT NOT NULL, updated_utc TEXT NOT NULL, error TEXT,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE voice_console_mutations (
        console_id TEXT NOT NULL, mutation_id TEXT NOT NULL, revision INTEGER NOT NULL,
        created_utc TEXT NOT NULL, PRIMARY KEY (console_id, mutation_id)
      );
      INSERT INTO voice_console_mutations VALUES
        ('legacy-console','legacy-interaction',1,'2026-08-27T12:00:00.000Z');
      INSERT INTO thread_voice_sessions VALUES
        ('tv_legacy','discord','thread-1','parent-1','guild-1','vc-1',
         'owner-1','Owner','ready','notice-1',1250,
         '2026-08-27T12:00:00.000Z','2026-08-27T12:01:00.000Z',NULL,NULL);
      INSERT INTO thread_voice_segments VALUES
        ('tvs_old','tv_legacy',1,'owner-1','preserved text','pending',500,NULL,
         'start','end','created','updated',NULL);
    `);
    legacy.close();

    const store = new SessionStore(dbPath);
    const columns = new Database(dbPath, { readonly: true })
      .prepare("PRAGMA table_info(thread_voice_sessions)")
      .all()
      .map((row: any) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining(["console_id", "alias_normalized", "tts_voice", "output_enabled"])
    );
    const mutationDb = new Database(dbPath, { readonly: true });
    expect(
      mutationDb
        .prepare("PRAGMA table_info(voice_console_mutations)")
        .all()
        .map((row: any) => row.name)
    ).toEqual(expect.arrayContaining(["action", "input_fingerprint"]));
    expect(
      mutationDb
        .prepare("SELECT action FROM voice_console_mutations WHERE mutation_id = ?")
        .get("legacy-interaction")
    ).toEqual({ action: "legacy" });
    expect(
      mutationDb
        .prepare("PRAGMA table_info(voice_console_add_interactions)")
        .all()
        .map((row: any) => row.name)
    ).toEqual(expect.arrayContaining(["input_fingerprint", "status", "failure_code"]));
    expect(
      mutationDb
        .prepare("PRAGMA table_info(voice_console_capture_terminals)")
        .all()
        .map((row: any) => row.name)
    ).toEqual(
      expect.arrayContaining([
        "capture_id",
        "console_id",
        "outcome",
        "reason",
        "result_source",
        "audio_ms",
        "forwarded_audio_ms",
      ])
    );
    mutationDb.close();
    expect(() =>
      store.updateVoiceConsoleCard("legacy-console", {
        expectedRevision: 1,
        cardPage: 1,
        interactionId: "legacy-interaction",
      })
    ).toThrow(/different Voice Console action or input/);

    const upgraded = store.upgradeActiveV1ThreadVoiceSessions(
      {
        aliasFor: () => "Legacy",
        profileFor: () => ({ voice: "Aoede", pace: "normal", style: null }),
      },
      "2026-08-28T12:00:00.000Z"
    );
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0]).toMatchObject({
      id: expect.stringMatching(/^tvc_/),
      guildId: "guild-1",
      voiceChannelId: "vc-1",
      cardChannelId: "vc-1",
      forwardedAudioMs: 1250,
      fanoutArmed: false,
    });
    expect(store.getVoiceConsoleBinding("tv_legacy")).toMatchObject({
      consoleId: upgraded[0]?.id,
      alias: "Legacy",
      ttsVoice: "Aoede",
      outputEnabled: true,
      status: "active",
    });
    expect(store.listVoiceConsoleInputTargets(upgraded[0]!.id).map((row) => row.bindingId)).toEqual([
      "tv_legacy",
    ]);
    expect(store.getVoiceConsoleSegment("tvs_old")).toMatchObject({
      transcript: "preserved text",
      captureId: null,
      fanoutGroupId: null,
    });
    expect(
      store.upgradeActiveV1ThreadVoiceSessions({
        aliasFor: () => "Legacy",
        profileFor: () => ({ voice: "Aoede", pace: null, style: null }),
      })
    ).toEqual([]);
    store.close();

    const reopened = new SessionStore(dbPath);
    expect(reopened.listActiveVoiceConsoles()).toHaveLength(1);
    expect(reopened.getVoiceConsoleBinding("tv_legacy")?.consoleId).toBe(upgraded[0]?.id);
    reopened.close();
  });
});
