import type { SessionRecord, StructuredLayout, StructuredPanel } from "../core/types.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { MessagePageItem, MessagePageRequest } from "../core/message-reader.js";

/** Reference to a channel or thread on a chat platform. */
export interface ChannelRef {
  /** Platform id ("discord"). */
  platform: string;
  /** Stable id from the platform (channel or thread snowflake on Discord). */
  id: string;
  /** Optional parent channel id (for threads). */
  parentId?: string;
}

/** Reference to a previously-sent message; used for `editMessage`. */
export interface MessageRef {
  channel: ChannelRef;
  id: string;
}

/** A file attached to an incoming message, normalized across platforms. */
export interface MessageAttachment {
  /** Stable URL the bot can fetch (Discord CDN URL). */
  url: string;
  filename: string;
  /** MIME type if the platform reported one. */
  contentType: string | null;
  /** Size in bytes. */
  size: number;
}

/** Incoming user message, normalized across platforms. */
export interface IncomingMessage {
  /** Stable platform message id. Real Discord user messages always provide it;
   * synthetic turns omit it and therefore do not enter the inbound ledger. */
  messageId?: string;
  channel: ChannelRef;
  authorId: string;
  /** Resolved, sanitized display name of the author (issue #57). Optional so
   *  other adapters and synthetic messages need no change; the Discord adapter
   *  resolves it per D5 (override map → nickname → global name → username). */
  authorName?: string;
  authorIsBot: boolean;
  text: string;
  /** Files attached to the message, if any. */
  attachments?: MessageAttachment[];
  /** Platform-specific raw object for advanced handlers. */
  raw?: unknown;
}

/**
 * Generic chat adapter contract. Discord today, Slack tomorrow.
 *
 * The adapter is responsible for:
 *  - connecting to the platform
 *  - receiving messages (filtered to "the bot should respond to this")
 *  - sending / editing messages
 *  - creating threads (if supported)
 *
 * Anything platform-specific (slash command schema, mentions, reactions,
 * etc.) lives under each adapter's own folder.
 */
export interface ChatAdapter {
  readonly platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;

  sendMessage(channel: ChannelRef, text: string): Promise<MessageRef>;
  editMessage(message: MessageRef, text: string): Promise<void>;

  /**
   * Optional: upload a file to the channel. Required for the agent → Discord
   * file path. Implementations may also send caption text alongside the file.
   */
  sendFile?(
    channel: ChannelRef,
    file: {
      data: Buffer;
      filename: string;
      mimeType: string;
      caption?: string;
      /** Render this audio attachment as a native platform voice message. */
      voiceMessage?: {
        durationSeconds: number;
        /** Base64-encoded sampled amplitude bytes. */
        waveform: string;
      };
    }
  ): Promise<MessageRef>;

  /** Optional: platforms that support threads should implement this. */
  createThread?(parent: ChannelRef, name: string): Promise<ChannelRef>;

  /** Optional: rename a thread (no-op on platforms that don't support it). */
  renameThread?(channel: ChannelRef, name: string): Promise<void>;

  /**
   * Optional: add a user to a thread so it appears in their channel list.
   * Discord: PUT /channels/{thread}/thread-members/{user}. Throws on failure
   * so the caller can fall back to a mention.
   */
  addThreadMember?(thread: ChannelRef, userId: string): Promise<void>;

  /** Optional: return the current display name of a thread/channel. */
  getThreadName?(channel: ChannelRef): Promise<string | undefined>;

  /**
   * Optional: display name of any channel, thread or not — used for the parent
   * channel of an originating thread on observability cards (#153). Returns
   * undefined for an unknown or bot-invisible (obfuscated) channel.
   */
  getChannelName?(channelId: string): Promise<string | undefined>;

  /** Optional: fetch historical messages for a thread (chronological order). */
  fetchThreadMessages?(
    channel: ChannelRef
  ): Promise<Array<{ authorIsBot: boolean; text: string; authorName?: string }>>;

  /** Optional: one cursor-addressed page of raw conversational messages. */
  fetchMessagePage?(threadId: string, request: MessagePageRequest): Promise<MessagePageItem[]>;

  /** Optional: this application's bot user id, used to identify Seam assistant posts. */
  getBotUserId?(): string | undefined;

  /** Optional: register a handler called when a thread is deleted (channelRef =
   *  the thread id). Used by scheduled prompts for instant cleanup. */
  onThreadDelete?(handler: (channelRef: string) => void | Promise<void>): void;

  /** Optional: install a predicate the message gate consults to allow a channel
   *  at runtime, additive to the static env allowlist (DB-backed activation, #22). */
  setActiveChannelCheck?(check: (channelRef: string) => boolean): void;

  /** Optional: live state of a thread. Returns `undefined` only when the thread
   *  is *confirmed gone* (e.g. Discord "Unknown Channel"); throws on transient
   *  errors so callers don't mistake a blip for a deletion. Used by scheduled
   *  prompts to decide run / skip-locked / drop-deleted at fire time. */
  getThreadLiveState?(
    channel: ChannelRef
  ): Promise<{ locked: boolean; archived: boolean } | undefined>;

  /** Optional: fetch historical messages with timestamps (ms epoch), optionally
   *  bounded to [fromTs, toTs]. Used by premium compaction to pull only the
   *  Discord ranges the gap-detector flagged as higher-fidelity than the session
   *  store. Chronological order. */
  fetchThreadMessagesTimed?(
    channel: ChannelRef,
    opts?: { fromTs?: number; toTs?: number }
  ): Promise<Array<{ ts: number; authorIsBot: boolean; text: string; authorName?: string }>>;

  /** Optional: send a rich structured panel (embed on Discord). */
  sendPanel?(channel: ChannelRef, panel: StructuredPanel): Promise<MessageRef>;

  /** Optional: edit a previously-sent panel. */
  editPanel?(message: MessageRef, panel: StructuredPanel): Promise<void>;

  /**
   * Optional: persistent component interactions (classic buttons / modals)
   * whose custom_id the adapter does not consume itself. Used by the thread
   * config editor (#90) so hub buttons outlive the 15-minute slash token.
   */
  onComponent?(handler: (evt: ComponentEvent) => void | Promise<void>): void;

  /** Optional: pin a message (status card lives as the sticky post in its thread). */
  pinMessage?(message: MessageRef): Promise<void>;

  /** Optional: delete a previously-sent message (used to migrate embed → v2). */
  deleteMessage?(message: MessageRef): Promise<void>;

  /**
   * Optional: keep a thread present in Discord's navigation without notifying
   * members. Implementations post a silent zero-width-space message and delete it.
   */
  bumpThread?(channel: ChannelRef): Promise<void>;

  /**
   * Optional: send a Components v2 layout (Container + separators).
   * Cannot mix with embeds on the same message.
   */
  sendLayout?(channel: ChannelRef, layout: StructuredLayout): Promise<MessageRef>;

  /** Optional: edit a previously-sent v2 layout message. */
  editLayout?(message: MessageRef, layout: StructuredLayout): Promise<void>;

  /**
   * Optional: present an interactive choice picker (buttons / select menu)
   * and resolve when the user picks one. Returns null on timeout / cancel.
   * Discord select menus cap at 25 options — implementations should paginate
   * rather than silently dropping overflow. `allowCustom` opens a modal for a
   * free-typed value (select menus cannot accept arbitrary input).
   */
  sendChoicePicker?(
    channel: ChannelRef,
    opts: {
      prompt?: string;
      panel?: StructuredPanel;
      choices: ReadonlyArray<{ value: string; label: string; description?: string }>;
      timeoutMs?: number;
      authorizedUserIds?: ReadonlySet<string>;
      successPanel?: (picked: { value: string; label: string }, username: string) => StructuredPanel;
      /**
       * Durable side effect that must finish BEFORE any success panel is shown.
       * Return `{ ok:false }` (or throw) to render a failure panel instead.
       */
      commit?: (
        picked: { value: string; label: string },
        username: string
      ) => Promise<
        | { ok: true; successPanel?: StructuredPanel }
        | { ok: false; error: string; failurePanel?: StructuredPanel }
      >;
      /**
       * When set, the picker includes a button that opens a modal for a
       * free-typed value (e.g. a repo path that isn't in the listed folders).
       * Discord select menus cannot accept arbitrary typed values themselves.
       */
      allowCustom?: {
        buttonLabel?: string;
        modalTitle?: string;
        inputLabel?: string;
        placeholder?: string;
      };
      /**
       * Return an error string to reject the pick (ephemeral notice) and keep
       * the picker open. Used to sandbox a custom-typed path before committing.
       */
      validate?: (value: string) => Promise<string | null | undefined> | string | null | undefined;
    }
  ): Promise<{ value: string; userId: string } | null>;

  /** Subscribe to bot-relevant incoming messages. */
  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void;

  /**
   * Optional: trigger a typing indicator in the channel. The indicator
   * lasts ~10 s on Discord; call again before it expires to extend it.
   * Best-effort — implementations should never throw.
   */
  sendTyping?(channel: ChannelRef): Promise<void>;

  /**
   * Optional: ask the user to approve / deny a tool permission request,
   * blocking until they respond or the timeout elapses. Required for the
   * `ask` permission policy. Implementations should default to "cancelled"
   * on timeout.
   */
  requestApproval?(
    channel: ChannelRef,
    req: RequestPermissionRequest,
    opts?: { timeoutMs?: number }
  ): Promise<RequestPermissionResponse>;

  /**
   * Optional: post a propose-then-confirm card (#58 D5) into a channel and
   * resolve when a human clicks Apply / Reject (or it times out). The card is
   * POSTED before this resolves; the returned `decision` promise settles later
   * when the human acts, so the caller can acknowledge "card posted" immediately
   * and apply the change in the background on confirmation.
   */
  postConfirmation?(
    channel: ChannelRef,
    card: ConfirmationCard,
    opts?: { timeoutMs?: number; authorizedUserIds?: ReadonlySet<string> }
  ): Promise<{ decision: Promise<ConfirmationDecision> }>;

  /** Post a frozen #91 choice card (embed + persistent classic action rows). */
  sendChoiceCard?(channel: ChannelRef, card: ChoiceCardPost): Promise<MessageRef>;
  /** Edit a posted choice card (counts; single-user hides buttons after pick). */
  editChoiceCard?(message: MessageRef, card: ChoiceCardPost): Promise<void>;
  /** Persistent `choice:` InteractionCreate handler (not a collector). */
  onChoiceInteraction?(handler: (evt: ChoiceInteraction) => void | Promise<void>): void;

  /** Post/edit an ACP elicitation card with Discord-native controls. */
  sendElicitationCard?(channel: ChannelRef, card: ElicitationCardPost): Promise<MessageRef>;
  editElicitationCard?(message: MessageRef, card: ElicitationCardPost): Promise<void>;
}

/** Durable ACP elicitation card. Values are deliberately absent: saved answers
 * never echo into the public Discord thread. */
export interface ElicitationCardPost {
  panel: StructuredPanel;
  buttons?: ReadonlyArray<{
    customId?: string;
    url?: string;
    label: string;
    style?: "primary" | "secondary" | "success" | "danger" | "link";
    disabled?: boolean;
  }>;
  select?: {
    customId: string;
    placeholder: string;
    options: ReadonlyArray<{ label: string; value: string; description?: string }>;
    min: number;
    max: number;
    disabled?: boolean;
  };
}

/** Frozen choice-card post (#91). Adapter turns this into embed + ActionRows. */
export interface ChoiceCardPost {
  panel: StructuredPanel;
  choiceId: string;
  options: ReadonlyArray<{ label: string; kind: "prompt" | "custom" }>;
  disabled?: boolean;
  /** Single-user after pick / cancel: drop action rows instead of disabled buttons. */
  hideButtons?: boolean;
  /** Present ⇒ multi-select dropdown + Confirm (#94), not the button layout. */
  select?: { min: number; max: number };
  /** Currently-picked option indices (in-memory; re-render sets default:true). */
  pendingSelection?: ReadonlyArray<number>;
}

/** Persistent choice-card interaction (#91). */
export interface ChoiceInteraction {
  customId: string;
  userId: string;
  userName: string;
  channel: ChannelRef;
  messageId: string;
  kind: "button" | "select" | "modal";
  values?: string[];
  fields?: Record<string, string>;
  replyEphemeral: (text: string) => Promise<void>;
  followUpEphemeral: (text: string) => Promise<void>;
  deferUpdate: () => Promise<void>;
  showModal: (opts: {
    customId: string;
    title: string;
    label: string;
    maxLength?: number;
  }) => Promise<void>;
}

/** Persistent button / modal interaction (#90). */
export interface ComponentEvent {
  /** Stable Discord interaction id used for durable idempotency. */
  interactionId: string;
  customId: string;
  userId: string;
  userName: string;
  channel: ChannelRef;
  messageId: string;
  kind: "button" | "select" | "modal";
  values?: string[];
  fields?: Record<string, string>;
  replyEphemeral: (text: string) => Promise<void>;
  followUpEphemeral: (text: string) => Promise<void>;
  editReplyEphemeral: (text: string) => Promise<void>;
  /** Platform-native ephemeral rich view; returns the created message id. */
  replyEphemeralView: (view: {
    embeds: unknown[];
    components?: unknown[];
  }) => Promise<string>;
  updateEphemeralView: (view: {
    embeds: unknown[];
    components?: unknown[];
  }) => Promise<void>;
  followUpEphemeralFile: (file: {
    data: Buffer;
    filename: string;
    mimeType: string;
  }) => Promise<void>;
  deferUpdate: () => Promise<void>;
  showModal: (opts: {
    customId: string;
    title: string;
    inputs: Array<{
      id: string;
      label: string;
      style?: "short" | "paragraph";
      value?: string;
      placeholder?: string;
      maxLength?: number;
      required?: boolean;
    }>;
  }) => Promise<void>;
}

/** A before→after confirmation card (#58 D5). */
export interface ConfirmationCard {
  title: string;
  /** Optional lead paragraph shown above the diff. */
  description?: string;
  /** The diff rows, rendered as `label: before → after`. */
  fields: ReadonlyArray<{ label: string; before: string; after: string }>;
  /** Non-fatal cautions shown under the diff. */
  warnings?: ReadonlyArray<string>;
}

/** Outcome of a confirmation card. */
export interface ConfirmationDecision {
  confirmed: boolean;
  /** The user who clicked (undefined on timeout). */
  userId?: string;
  userName?: string;
}

/**
 * Convenience: the session-router wants to translate channel refs to
 * SessionRecord ids. We expose this as a tiny helper rather than pollute the
 * adapter interface.
 */
export function makeSessionIdFromChannel(channel: ChannelRef): string {
  return `${channel.platform}:${channel.id}`;
}

export type { SessionRecord };
