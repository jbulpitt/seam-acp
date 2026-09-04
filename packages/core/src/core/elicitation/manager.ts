import { randomUUID } from "node:crypto";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import type { Logger } from "../../lib/logger.js";
import type {
  ChatAdapter,
  ComponentEvent,
  ElicitationCardPost,
  MessageRef,
} from "../../platforms/chat-adapter.js";
import type { SessionRecord } from "../types.js";
import type { SessionStore } from "../session-store.js";
import {
  ELICITATION_MAX_FIELDS,
  ELICITATION_MAX_MESSAGE,
  ELICITATION_MAX_OPTIONS,
  ELICITATION_MAX_TEXT,
  ELICITATION_MODAL_LEASE_MS,
  ELICITATION_PAGE_SIZE,
  ELICITATION_TTL_MS,
  elicitationCustomId,
  parseElicitationCustomId,
  responseForTerminal,
  type ElicitationField,
  type ElicitationRequestContext,
  type ElicitationRow,
  type ElicitationTerminalStatus,
  type ElicitationValues,
  type ValidatedForm,
} from "./types.js";

type FormRequest = CreateElicitationRequest & {
  mode: "form";
  requestedSchema: {
    type?: "object";
    title?: string | null;
    description?: string | null;
    properties?: Record<string, ElicitationPropertySchema>;
    required?: string[] | null;
    _meta?: Record<string, unknown> | null;
  };
};
type UrlRequest = CreateElicitationRequest & {
  mode: "url";
  elicitationId: string;
  url: string;
};

type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const SENSITIVE = /(?:password|passcode|secret|api[ _-]?key|access[ _-]?token|private[ _-]?key|credential)/iu;
const SAFE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ELICITATION_MAX_WIRE_BYTES = 64 * 1024;

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function metadataLooksSensitive(key: string, schema: ElicitationPropertySchema): boolean {
  if (SENSITIVE.test(key)) return true;
  const candidate = schema as Record<string, unknown>;
  if (SENSITIVE.test(String(candidate.title ?? "")) || SENSITIVE.test(String(candidate.description ?? ""))) {
    return true;
  }
  const meta = candidate._meta;
  if (!meta || typeof meta !== "object") return false;
  const record = meta as Record<string, unknown>;
  return record.sensitive === true || record.writeOnly === true ||
    Object.entries(record).some(([k, v]) => SENSITIVE.test(k) && v !== false && v != null);
}

function enumOptions(schema: ElicitationPropertySchema): Array<{
  label: string;
  value: string;
  description?: string;
}> | null {
  const value = schema as Record<string, unknown>;
  if (schema.type === "string") {
    if (Array.isArray(value.oneOf)) {
      return (value.oneOf as Array<{ title: string; const: string; description?: string | null }>).map((item) => ({
        label: item.title,
        value: item.const,
        ...(item.description ? { description: item.description } : {}),
      }));
    }
    if (Array.isArray(value.enum)) {
      return (value.enum as string[]).map((item) => ({ label: item, value: item }));
    }
    return null;
  }
  if (schema.type === "array") {
    const items = schema.items as Record<string, unknown>;
    if (Array.isArray(items.anyOf)) {
      return (items.anyOf as Array<{ title: string; const: string; description?: string | null }>).map(
        (item) => ({
          label: item.title,
          value: item.const,
          ...(item.description ? { description: item.description } : {}),
        })
      );
    }
    if (Array.isArray(items.enum)) {
      return (items.enum as string[]).map((value) => ({ label: value, value }));
    }
  }
  return null;
}

function validateOptions(
  options: ReturnType<typeof enumOptions>,
  fieldName: string
): Validation<NonNullable<ReturnType<typeof enumOptions>>> {
  if (!options || options.length < 1 || options.length > ELICITATION_MAX_OPTIONS) {
    return { ok: false, error: `${fieldName} must declare 1-${ELICITATION_MAX_OPTIONS} choices.` };
  }
  const values = new Set<string>();
  for (const option of options) {
    if (!text(option.label, 100) || !text(option.value, 100)) {
      return { ok: false, error: `${fieldName} has a choice label/value outside Discord's 100-character limit.` };
    }
    if (option.description && !text(option.description, 100)) {
      return { ok: false, error: `${fieldName} has a choice description outside Discord's 100-character limit.` };
    }
    if (values.has(option.value)) {
      return { ok: false, error: `${fieldName} has duplicate choice values.` };
    }
    values.add(option.value);
  }
  return { ok: true, value: options };
}

export function validateFormRequest(request: FormRequest): Validation<ValidatedForm> {
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > ELICITATION_MAX_WIRE_BYTES) {
    return { ok: false, error: "The form request is too large." };
  }
  if (!text(request.message, ELICITATION_MAX_MESSAGE) || !request.message.trim()) {
    return { ok: false, error: `The request message must be 1-${ELICITATION_MAX_MESSAGE} characters.` };
  }
  const schema = request.requestedSchema;
  if (!schema || typeof schema !== "object" || (schema.type != null && schema.type !== "object")) {
    return { ok: false, error: "The requested schema must be an object." };
  }
  if ((schema.title != null && !text(schema.title, 256)) ||
      (schema.description != null && !text(schema.description, 1_000))) {
    return { ok: false, error: "The form title or description is too long." };
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return { ok: false, error: "The form must declare properties." };
  }
  const entries = Object.entries(properties);
  if (entries.length < 1 || entries.length > ELICITATION_MAX_FIELDS) {
    return { ok: false, error: `Discord forms support 1-${ELICITATION_MAX_FIELDS} fields.` };
  }
  const required = new Set(schema.required ?? []);
  if (required.size !== (schema.required ?? []).length ||
      [...required].some((key) => !Object.hasOwn(properties, key))) {
    return { ok: false, error: "The required list contains a duplicate or unknown field." };
  }
  const fields: ElicitationField[] = [];
  for (const [key, property] of entries) {
    if (!key || key.length > 64 || /[\u0000-\u001f\u007f]/u.test(key)) {
      return { ok: false, error: "Field names must be printable and at most 64 characters." };
    }
    if (!property || typeof property !== "object" || metadataLooksSensitive(key, property)) {
      return {
        ok: false,
        error: "Sensitive or credential-like fields must use URL elicitation so Seam never receives them.",
      };
    }
    if (!["string", "number", "integer", "boolean", "array"].includes(property.type)) {
      return { ok: false, error: `${key} uses an unsupported field type.` };
    }
    const p = property as Record<string, unknown>;
    if ((p.title != null && !text(p.title, 100)) ||
        (p.description != null && !text(p.description, 1_000))) {
      return { ok: false, error: `${key} has an overlong title or description.` };
    }
    if (property.type === "string") {
      const minLength = p.minLength as number | null | undefined;
      const maxLength = p.maxLength as number | null | undefined;
      if ((minLength != null && (!Number.isSafeInteger(minLength) || minLength < 0)) ||
          (maxLength != null && (!Number.isSafeInteger(maxLength) || maxLength < 0 ||
            maxLength > ELICITATION_MAX_TEXT)) ||
          (minLength != null && maxLength != null && minLength > maxLength)) {
        return { ok: false, error: `${key} has invalid string length bounds.` };
      }
      if (p.pattern != null) {
        if (!text(p.pattern, 256)) return { ok: false, error: `${key} has an overlong pattern.` };
        try { new RegExp(p.pattern as string, "u"); } catch {
          return { ok: false, error: `${key} has an invalid pattern.` };
        }
      }
      const opts = enumOptions(property);
      if (opts) {
        const checked = validateOptions(opts, key);
        if (!checked.ok) return checked;
      }
      if (typeof p.default === "string") {
        const checkedDefault = parseValue(
          { key, schema: property, required: true, title: key },
          p.default
        );
        if (!checkedDefault.ok) return { ok: false, error: `${key} has an invalid default.` };
      }
    } else if (property.type === "number" || property.type === "integer") {
      const minimum = p.minimum as number | null | undefined;
      const maximum = p.maximum as number | null | undefined;
      const defaultValue = p.default as number | null | undefined;
      if ((minimum != null && !Number.isFinite(minimum)) ||
          (maximum != null && !Number.isFinite(maximum)) ||
          (minimum != null && maximum != null && minimum > maximum) ||
          (defaultValue != null && !Number.isFinite(defaultValue)) ||
          (property.type === "integer" && defaultValue != null && !Number.isSafeInteger(defaultValue))) {
        return { ok: false, error: `${key} has invalid numeric bounds or default.` };
      }
      if (defaultValue != null &&
          ((minimum != null && defaultValue < minimum) ||
           (maximum != null && defaultValue > maximum))) {
        return { ok: false, error: `${key} has a default outside its bounds.` };
      }
    } else if (property.type === "array") {
      const checked = validateOptions(enumOptions(property), key);
      if (!checked.ok) return checked;
      const min = (p.minItems as number | null | undefined) ?? 0;
      const max = (p.maxItems as number | null | undefined) ?? checked.value.length;
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) ||
          min < 0 || max < 1 || min > max || max > checked.value.length) {
        return { ok: false, error: `${key} has invalid selection bounds.` };
      }
      const defaults = p.default;
      if (defaults != null &&
          (!Array.isArray(defaults) ||
           new Set(defaults).size !== defaults.length ||
           defaults.some((value) => typeof value !== "string" ||
             !checked.value.some((option) => option.value === value)) ||
           defaults.length < min || defaults.length > max)) {
        return { ok: false, error: `${key} has an invalid default selection.` };
      }
    }
    fields.push({
      key,
      schema: property,
      required: required.has(key),
      title: typeof p.title === "string" ? p.title.trim() || key : key,
    });
  }
  const pages = Array.from(
    { length: Math.ceil(fields.length / ELICITATION_PAGE_SIZE) },
    (_, index) => fields.slice(index * ELICITATION_PAGE_SIZE, (index + 1) * ELICITATION_PAGE_SIZE)
  );
  let directDecision: ValidatedForm["directDecision"] = null;
  if (fields.length === 1) {
    const field = fields[0]!;
    if (field.schema.type === "boolean") {
      directDecision = { kind: "boolean", field };
    } else {
      const options = enumOptions(field.schema);
      if (options) {
        const checked = validateOptions(options, field.key);
        if (!checked.ok) return checked;
        directDecision = {
          kind: field.schema.type === "array" ? "multi" : "single",
          field,
          options: checked.value,
          min: field.schema.type === "array"
            ? (((field.schema as Record<string, unknown>).minItems as number | null | undefined) ?? 0)
            : 1,
          max: field.schema.type === "array"
            ? (((field.schema as Record<string, unknown>).maxItems as number | null | undefined) ??
              checked.value.length)
            : 1,
        };
      }
    }
  }
  return { ok: true, value: { request, fields, pages, directDecision } };
}

export function validateUrlRequest(request: UrlRequest): Validation<URL> {
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > ELICITATION_MAX_WIRE_BYTES) {
    return { ok: false, error: "The URL request is too large." };
  }
  if (!text(request.message, ELICITATION_MAX_MESSAGE) || !request.message.trim()) {
    return { ok: false, error: `The request message must be 1-${ELICITATION_MAX_MESSAGE} characters.` };
  }
  if (!text(request.elicitationId, 128) || !request.elicitationId.trim()) {
    return { ok: false, error: "The URL elicitation id is invalid." };
  }
  if (!text(request.url, 2_000)) return { ok: false, error: "The elicitation URL is too long." };
  try {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username || url.password) {
      return { ok: false, error: "URL elicitation requires an HTTPS URL without embedded credentials." };
    }
    return { ok: true, value: url };
  } catch {
    return { ok: false, error: "The elicitation URL is invalid." };
  }
}

function parseStored<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function durableRequest(request: CreateElicitationRequest): string {
  // ACP metadata is opaque and can contain application secrets. Seam does not
  // need it to render, validate, correlate, or answer, so never persist it.
  return JSON.stringify(request, (key, value) => key === "_meta" ? undefined : value);
}

function defaultValues(form: ValidatedForm): ElicitationValues {
  const values: ElicitationValues = {};
  for (const field of form.fields) {
    const value = (field.schema as Record<string, unknown>).default;
    if (typeof value === "string" || typeof value === "number" ||
        typeof value === "boolean" ||
        (Array.isArray(value) && value.every((item) => typeof item === "string"))) {
      values[field.key] = value as ElicitationValues[string];
    }
  }
  return values;
}

function parseValue(field: ElicitationField, raw: string): Validation<unknown> {
  if (!raw && !field.required) return { ok: true, value: undefined };
  const schema = field.schema;
  const valueSchema = schema as Record<string, unknown>;
  if (schema.type === "string") {
    if (raw.length < ((valueSchema.minLength as number | null | undefined) ?? 0) ||
        raw.length > ((valueSchema.maxLength as number | null | undefined) ?? ELICITATION_MAX_TEXT)) {
      return { ok: false, error: `${field.title} does not meet its length requirement.` };
    }
    if (typeof valueSchema.pattern === "string" && !new RegExp(valueSchema.pattern, "u").test(raw)) {
      return { ok: false, error: `${field.title} does not match the requested format.` };
    }
    if (valueSchema.format === "email" && !SAFE_EMAIL.test(raw)) {
      return { ok: false, error: `${field.title} must be an email address.` };
    }
    if (valueSchema.format === "uri") {
      try { new URL(raw); } catch { return { ok: false, error: `${field.title} must be a URL.` }; }
    }
    if (valueSchema.format === "date" &&
        (!SAFE_DATE.test(raw) || !Number.isFinite(Date.parse(`${raw}T00:00:00Z`)))) {
      return { ok: false, error: `${field.title} must be YYYY-MM-DD.` };
    }
    if (valueSchema.format === "date-time" && !Number.isFinite(Date.parse(raw))) {
      return { ok: false, error: `${field.title} must be an ISO date-time.` };
    }
    const options = enumOptions(schema);
    if (options && !options.some((option) => option.value === raw)) {
      return { ok: false, error: `${field.title} must exactly match one of its listed values.` };
    }
    return { ok: true, value: raw };
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (!raw.trim()) return { ok: false, error: `${field.title} must be a number.` };
    const value = Number(raw);
    if (!Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value)) ||
        (typeof valueSchema.minimum === "number" && value < valueSchema.minimum) ||
        (typeof valueSchema.maximum === "number" && value > valueSchema.maximum)) {
      return { ok: false, error: `${field.title} is outside its numeric constraints.` };
    }
    return { ok: true, value };
  }
  if (schema.type === "boolean") {
    if (!/^(?:true|false|yes|no)$/iu.test(raw.trim())) {
      return { ok: false, error: `${field.title} must be true/false or yes/no.` };
    }
    return { ok: true, value: /^(?:true|yes)$/iu.test(raw.trim()) };
  }
  const values = raw.split(",").map((item) => item.trim()).filter(Boolean);
  const options = enumOptions(schema) ?? [];
  const allowed = new Set(options.map((option) => option.value));
  if (new Set(values).size !== values.length || values.some((value) => !allowed.has(value)) ||
      values.length < (((valueSchema.minItems as number | null | undefined) ?? 0)) ||
      values.length > (((valueSchema.maxItems as number | null | undefined) ?? options.length))) {
    return { ok: false, error: `${field.title} must contain valid comma-separated listed values.` };
  }
  return { ok: true, value: values };
}

interface Waiter {
  resolve: (response: CreateElicitationResponse) => void;
}

export class ElicitationManager {
  private readonly store: SessionStore;
  private readonly adapter: ChatAdapter;
  private readonly logger: Logger;
  private readonly currentUserId: (channelRef: string) => string | undefined;
  private readonly now: () => number;
  private readonly waiters = new Map<string, Waiter>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: {
    store: SessionStore;
    adapter: ChatAdapter;
    logger: Logger;
    currentUserId: (channelRef: string) => string | undefined;
    now?: () => number;
  }) {
    this.store = opts.store;
    this.adapter = opts.adapter;
    this.logger = opts.logger.child({ comp: "elicitation" });
    this.currentUserId = opts.currentUserId;
    this.now = opts.now ?? Date.now;
  }

  async recoverOpen(): Promise<number> {
    const rows = this.store.listOpenElicitations();
    for (const row of rows) {
      const settled = this.store.settleElicitation(
        row.id, "interrupted", "Seam restarted before this request completed.", this.nowUtc()
      );
      if (settled) await this.refresh(settled);
    }
    this.store.clearExpiredElicitationLeases(this.nowUtc());
    return rows.length;
  }

  async create(
    record: SessionRecord,
    request: CreateElicitationRequest,
    context: ElicitationRequestContext
  ): Promise<CreateElicitationResponse> {
    const userId = this.currentUserId(record.channelRef);
    if (!userId || !this.adapter.sendElicitationCard || !this.adapter.editElicitationCard) {
      return { action: "decline" };
    }
    const correlation = this.correlation(record, request);
    if (!correlation.ok) {
      await this.postRefusal(record, request.message, correlation.error);
      return { action: "decline" };
    }
    let validated: ValidatedForm | URL;
    if (request.mode === "form") {
      const result = validateFormRequest(request as FormRequest);
      if (!result.ok) {
        await this.postRefusal(record, request.message, result.error);
        return { action: "decline" };
      }
      validated = result.value;
    } else if (request.mode === "url") {
      const result = validateUrlRequest(request as UrlRequest);
      if (!result.ok) {
        await this.postRefusal(record, request.message, result.error);
        return { action: "decline" };
      }
      validated = result.value;
    } else {
      await this.postRefusal(record, request.message, `Unsupported elicitation mode “${request.mode}”.`);
      return { action: "decline" };
    }

    const now = this.now();
    const row: ElicitationRow & { status: "open" } = {
      id: randomUUID(),
      sessionRecordId: record.id,
      platform: record.platform,
      channelRef: record.channelRef,
      parentRef: record.parentRef,
      authorizedUserId: userId,
      acpSessionId: record.acpSessionId || null,
      requestCorrelation: correlation.value,
      mode: request.mode,
      elicitationId: request.mode === "url" ? (request as UrlRequest).elicitationId : null,
      requestJson: durableRequest(request),
      valuesJson: request.mode === "form"
        ? JSON.stringify(defaultValues(validated as ValidatedForm))
        : "{}",
      completedPagesJson: "[]",
      currentPage: 0,
      status: "open",
      messageId: null,
      leaseToken: null,
      leaseExpiresUtc: null,
      terminalDetail: null,
      createdUtc: new Date(now).toISOString(),
      updatedUtc: new Date(now).toISOString(),
      expiresUtc: new Date(now + ELICITATION_TTL_MS).toISOString(),
    };
    const superseded = this.store.replaceOpenElicitation(row);
    for (const old of superseded) this.finish(old, responseForTerminal(old.status as ElicitationTerminalStatus));

    const response = new Promise<CreateElicitationResponse>((resolve) => {
      this.waiters.set(row.id, { resolve });
    });
    const onAbort = () => void this.cancelOne(row.id, "cancelled", "ACP request was cancelled.");
    if (context.signal.aborted) {
      await this.cancelOne(row.id, "cancelled", "ACP request was already cancelled.");
    } else {
      context.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      for (const old of superseded) await this.refresh(old);
      if (this.store.getElicitation(row.id)?.status === "open") {
        const card = this.render(row, validated);
        const sent = await this.adapter.sendElicitationCard(
          { platform: row.platform, id: row.channelRef, ...(row.parentRef ? { parentId: row.parentRef } : {}) },
          card
        );
        if (!this.store.attachElicitationMessage(row.id, sent.id, this.nowUtc())) {
          const latest = this.store.getElicitation(row.id);
          if (latest) {
            await this.adapter.editElicitationCard(sent, this.render(latest));
          }
        } else {
          row.messageId = sent.id;
        }
        this.armExpiry(row.id, row.expiresUtc);
      }
    } catch (error) {
      this.logger.warn({ error, id: row.id }, "elicitation card post failed");
      const failed = this.store.settleElicitation(
        row.id, "declined", "The Discord card could not be posted.", this.nowUtc()
      );
      if (failed) this.finish(failed, { action: "decline" });
    }
    const result = await response;
    context.signal.removeEventListener("abort", onAbort);
    this.clearTimer(row.id);
    if (result.action === "accept") this.store.clearElicitationValues(row.id);
    return result;
  }

  async handleComponent(event: ComponentEvent): Promise<void> {
    const action = parseElicitationCustomId(event.customId);
    if (!action) return;
    const row = this.store.getElicitation(action.id);
    if (!row || row.channelRef !== event.channel.id || (row.messageId && row.messageId !== event.messageId)) {
      await event.replyEphemeral("That input request is no longer available.").catch(() => {});
      return;
    }
    if (row.authorizedUserId !== event.userId) {
      await event.replyEphemeral("Only the person who started this turn can answer this request.").catch(() => {});
      return;
    }
    if (row.status !== "open") {
      await event.replyEphemeral("That input request has already been settled.").catch(() => {});
      return;
    }
    const request = parseStored<CreateElicitationRequest | null>(row.requestJson, null);
    if (!request) {
      await this.cancelOne(row.id, "declined", "Stored request state was unreadable.");
      await event.replyEphemeral("That input request could not be recovered safely.").catch(() => {});
      return;
    }
    if (action.kind === "cancel") {
      const settled = await this.cancelOne(row.id, "cancelled", "Cancelled by the user.");
      await event.deferUpdate().catch(() => {});
      if (!settled) await event.followUpEphemeral("That request was already settled.").catch(() => {});
      return;
    }
    if (request.mode !== "form") {
      await event.replyEphemeral("Use Open secure page, or Cancel this request.").catch(() => {});
      return;
    }
    const checked = validateFormRequest(request as FormRequest);
    if (!checked.ok) {
      await this.cancelOne(row.id, "declined", checked.error);
      await event.replyEphemeral("That form is no longer valid.").catch(() => {});
      return;
    }
    const form = checked.value;
    if (action.kind === "skip") {
      const direct = form.directDecision;
      if (!direct || direct.field.required) {
        await event.replyEphemeral("That field cannot be skipped.").catch(() => {});
        return;
      }
      await event.deferUpdate().catch(() => {});
      await this.accept(row.id, {}, "The optional decision was skipped.");
      return;
    }
    if (action.kind === "boolean") {
      await event.deferUpdate().catch(() => {});
      await this.accept(row.id, { [form.fields[0]!.key]: action.value }, "Answered on the card.");
      return;
    }
    if (action.kind === "choice") {
      const direct = form.directDecision;
      if (!direct || direct.kind !== "single" || !direct.options[action.index]) {
        await event.replyEphemeral("That choice is not valid.").catch(() => {});
        return;
      }
      await event.deferUpdate().catch(() => {});
      await this.accept(
        row.id,
        { [direct.field.key]: direct.options[action.index]!.value },
        "Answered on the card."
      );
      return;
    }
    if (action.kind === "select") {
      const direct = form.directDecision;
      if (!direct || (direct.kind !== "single" && direct.kind !== "multi")) {
        await event.replyEphemeral("That selection is not valid.").catch(() => {});
        return;
      }
      const indices = (event.values ?? []).map(Number);
      if (indices.some((index) => !Number.isSafeInteger(index) || !direct.options[index]) ||
          indices.length < direct.min || indices.length > direct.max ||
          new Set(indices).size !== indices.length) {
        await event.replyEphemeral("That selection is outside the requested bounds.").catch(() => {});
        return;
      }
      const selected = indices.map((index) => direct.options[index]!.value);
      await event.deferUpdate().catch(() => {});
      await this.accept(
        row.id,
        { [direct.field.key]: direct.kind === "single" ? selected[0]! : selected },
        "Answered on the card."
      );
      return;
    }
    if (action.kind === "previous" || action.kind === "next") {
      const delta = action.kind === "previous" ? -1 : 1;
      const target = Math.max(0, Math.min(form.pages.length - 1, row.currentPage + delta));
      const updated = this.store.setElicitationPage(row.id, target, this.nowUtc());
      await event.deferUpdate().catch(() => {});
      if (updated) await this.refresh(updated, form);
      return;
    }
    if (action.kind === "answer") {
      const lease = randomUUID();
      const leased = this.store.claimElicitationLease(
        row.id, lease, new Date(this.now() + ELICITATION_MODAL_LEASE_MS).toISOString(), this.nowUtc()
      );
      if (!leased) {
        await event.replyEphemeral("That request was already settled.").catch(() => {});
        return;
      }
      const values = parseStored<ElicitationValues>(leased.valuesJson, {});
      const page = form.pages[leased.currentPage] ?? [];
      try {
        await event.showModal({
          customId: elicitationCustomId("submit", row.id, lease),
          title: (form.request.requestedSchema.title?.trim() || "Answer request").slice(0, 45),
          inputs: page.map((field, index) => ({
            id: `f${index}`,
            label: `${field.title}${field.required ? " (required)" : ""}`,
            style: field.schema.type === "string" &&
              (((field.schema as Record<string, unknown>).maxLength as number | undefined) ?? 0) > 100
              ? "paragraph"
              : "short",
            required: field.required,
            maxLength: field.schema.type === "string"
              ? Math.min(
                  ((field.schema as Record<string, unknown>).maxLength as number | undefined) ??
                    ELICITATION_MAX_TEXT,
                  ELICITATION_MAX_TEXT
                )
              : ELICITATION_MAX_TEXT,
            placeholder: this.placeholder(field),
            ...(values[field.key] !== undefined ? { value: this.displayValue(values[field.key]!) } : {}),
          })),
        });
        const leaseTimer = setTimeout(
          () => this.store.clearExpiredElicitationLeases(this.nowUtc()),
          ELICITATION_MODAL_LEASE_MS
        );
        leaseTimer.unref?.();
      } catch (error) {
        this.store.releaseElicitationLease(row.id, lease, this.nowUtc());
        throw error;
      }
      return;
    }
    if (action.kind === "submit") {
      const latest = this.store.getElicitation(row.id);
      if (!latest || latest.status !== "open" || latest.leaseToken !== action.lease) {
        await event.replyEphemeral("That modal is stale; reopen the current page from the card.").catch(() => {});
        return;
      }
      const page = form.pages[latest.currentPage] ?? [];
      const values = parseStored<ElicitationValues>(latest.valuesJson, {});
      for (let index = 0; index < page.length; index++) {
        const field = page[index]!;
        const parsed = parseValue(field, event.fields?.[`f${index}`] ?? "");
        if (!parsed.ok) {
          this.store.releaseElicitationLease(row.id, action.lease, this.nowUtc());
          await event.replyEphemeral(parsed.error).catch(() => {});
          return;
        }
        if (parsed.value === undefined) delete values[field.key];
        else values[field.key] = parsed.value as ElicitationValues[string];
      }
      const completed = new Set(parseStored<number[]>(latest.completedPagesJson, []));
      completed.add(latest.currentPage);
      const allRequired = form.fields.every((field) => !field.required || values[field.key] !== undefined);
      const finalPage = latest.currentPage === form.pages.length - 1;
      if (finalPage && allRequired) {
        const accepted = this.store.acceptElicitation(
          row.id, "All form pages were saved.", this.nowUtc(), action.lease
        );
        await event.replyEphemeral("Saved. The request is complete.").catch(() => {});
        if (accepted) {
          this.finish(accepted, { action: "accept", content: values });
          await this.refresh(accepted, form);
        }
        return;
      }
      const nextPage = Math.min(form.pages.length - 1, latest.currentPage + 1);
      const saved = this.store.saveElicitationPage({
        id: row.id,
        leaseToken: action.lease,
        valuesJson: JSON.stringify(values),
        completedPagesJson: JSON.stringify([...completed].sort((a, b) => a - b)),
        currentPage: nextPage,
        nowUtc: this.nowUtc(),
      });
      await event.replyEphemeral(
        saved ? `Saved page ${latest.currentPage + 1}.` : "That modal was already settled."
      ).catch(() => {});
      if (saved) await this.refresh(saved, form);
    }
  }

  async completeUrl(elicitationId: string, sessionRecordId?: string): Promise<boolean> {
    const row = this.store.findOpenElicitationByExternalId(elicitationId);
    if (!row || row.mode !== "url" ||
        (sessionRecordId !== undefined && row.sessionRecordId !== sessionRecordId)) return false;
    const accepted = this.store.acceptElicitation(
      row.id, "The secure page reported completion.", this.nowUtc()
    );
    if (!accepted) return false;
    this.finish(accepted, { action: "accept" });
    await this.refresh(accepted);
    return true;
  }

  async cancelForSession(
    sessionRecordId: string,
    status: Exclude<ElicitationTerminalStatus, "accepted" | "declined">,
    detail: string
  ): Promise<number> {
    const rows = this.store.settleOpenElicitationsForSession(
      sessionRecordId, status, detail, this.nowUtc()
    );
    for (const row of rows) {
      this.finish(row, { action: "cancel" });
      await this.refresh(row);
    }
    return rows.length;
  }

  async sweep(): Promise<{ expired: number; leases: number }> {
    const nowUtc = this.nowUtc();
    const leases = this.store.clearExpiredElicitationLeases(nowUtc);
    let expired = 0;
    for (const row of this.store.listOpenElicitations()) {
      if (row.expiresUtc > nowUtc) continue;
      if (await this.cancelOne(row.id, "expired", "The request expired.")) expired++;
    }
    return { expired, leases };
  }

  private correlation(
    record: SessionRecord,
    request: CreateElicitationRequest
  ): Validation<string> {
    if ("sessionId" in request) {
      if (!request.sessionId || request.sessionId !== record.acpSessionId) {
        return { ok: false, error: "The elicitation session does not match this Discord session." };
      }
      if (request.toolCallId != null &&
          (typeof request.toolCallId !== "string" || request.toolCallId.length > 128)) {
        return { ok: false, error: "The elicitation tool-call correlation is invalid." };
      }
      return {
        ok: true,
        value: JSON.stringify({ sessionId: request.sessionId, toolCallId: request.toolCallId ?? null }),
      };
    }
    if (!("requestId" in request) ||
        !["string", "number"].includes(typeof request.requestId) ||
        String(request.requestId).length > 128) {
      return { ok: false, error: "The elicitation request correlation is invalid." };
    }
    return { ok: true, value: JSON.stringify({ requestId: request.requestId }) };
  }

  private async postRefusal(record: SessionRecord, message: string, error: string): Promise<void> {
    const channel = {
      platform: record.platform,
      id: record.channelRef,
      ...(record.parentRef ? { parentId: record.parentRef } : {}),
    };
    const panel = {
      color: 0xed4245,
      title: "Input request unavailable",
      description: message.slice(0, ELICITATION_MAX_MESSAGE),
      fields: [{ name: "Reason", value: error }],
      footer: "No answer was collected. Sensitive information must use a secure URL request.",
    };
    if (this.adapter.sendElicitationCard) {
      await this.adapter.sendElicitationCard(channel, { panel }).catch(() => {});
    } else {
      await this.adapter.sendPanel?.(channel, panel).catch(() => {});
    }
  }

  private render(row: ElicitationRow, known?: ValidatedForm | URL): ElicitationCardPost {
    const request = parseStored<CreateElicitationRequest | null>(row.requestJson, null);
    const terminal = row.status !== "open";
    const statusText: Record<string, string> = {
      accepted: "✅ Completed",
      cancelled: "🚫 Cancelled",
      expired: "⌛ Expired",
      superseded: "↪️ Superseded by a newer request",
      interrupted: "♻️ Interrupted by restart/session replacement",
      declined: "⚠️ Declined",
    };
    const panel = {
      color: terminal ? (row.status === "accepted" ? 0x57f287 : 0x747f8d) : 0x5865f2,
      title: request?.mode === "form"
        ? ((request as FormRequest).requestedSchema.title?.trim() || "Input requested")
        : "Secure action requested",
      description: request?.message ?? "This request could not be read.",
      fields: [] as Array<{ name: string; value: string; inline?: boolean }>,
      footer: terminal
        ? statusText[row.status] ?? "Settled"
        : `Only <@${row.authorizedUserId}> can answer · expires in 15 minutes`,
    };
    if (!request || terminal) {
      if (row.terminalDetail) panel.fields.push({ name: "Status", value: row.terminalDetail });
      return { panel };
    }
    if (request.mode === "url") {
      const url = known instanceof URL ? known : validateUrlRequest(request as UrlRequest);
      const href = url instanceof URL ? url.href : url.ok ? url.value.href : undefined;
      panel.fields.push({
        name: "Privacy",
        value: "This opens outside Discord. Seam does not collect or forward answers from that page.",
      });
      return {
        panel,
        buttons: [
          ...(href ? [{ label: "Open secure page", style: "link" as const, url: href }] : []),
          { label: "Cancel", style: "danger", customId: elicitationCustomId("cancel", row.id) },
        ],
      };
    }
    let form: ValidatedForm;
    if (known && !(known instanceof URL)) {
      form = known;
    } else {
      const validated = validateFormRequest(request as FormRequest);
      if (!validated.ok) {
        panel.fields.push({ name: "Validation", value: validated.error });
        return { panel };
      }
      form = validated.value;
    }
    const completed = new Set(parseStored<number[]>(row.completedPagesJson, []));
    panel.fields.push({
      name: form.pages.length === 1 ? "Fields" : `Page ${row.currentPage + 1} of ${form.pages.length}`,
      value: (form.pages[row.currentPage] ?? []).map((field) =>
        `• **${field.title}**${field.required ? " (required)" : ""}`
      ).join("\n"),
    });
    if (form.pages.length > 1) {
      panel.fields.push({
        name: "Saved progress",
        value: form.pages.map((_, index) =>
          `${index === row.currentPage ? "→" : completed.has(index) ? "✓" : "○"} Page ${index + 1}`
        ).join(" · "),
      });
    }
    if (form.directDecision?.kind === "boolean") {
      return {
        panel,
        buttons: [
          { label: "Yes", style: "success", customId: elicitationCustomId("bool", row.id, "1") },
          { label: "No", style: "secondary", customId: elicitationCustomId("bool", row.id, "0") },
          ...(form.directDecision.field.required
            ? []
            : [{ label: "Skip", style: "secondary" as const,
                customId: elicitationCustomId("skip", row.id) }]),
          { label: "Cancel", style: "danger", customId: elicitationCustomId("cancel", row.id) },
        ],
      };
    }
    if (form.directDecision?.kind === "single" &&
        form.directDecision.options.length <= (form.directDecision.field.required ? 4 : 3)) {
      return {
        panel,
        buttons: [
          ...form.directDecision.options.map((option, index) => ({
            label: option.label,
            style: "primary" as const,
            customId: elicitationCustomId("choice", row.id, String(index)),
          })),
          ...(form.directDecision.field.required
            ? []
            : [{ label: "Skip", style: "secondary" as const,
                customId: elicitationCustomId("skip", row.id) }]),
          { label: "Cancel", style: "danger", customId: elicitationCustomId("cancel", row.id) },
        ],
      };
    }
    if (form.directDecision &&
        (form.directDecision.kind === "single" || form.directDecision.kind === "multi")) {
      return {
        panel,
        select: {
          customId: elicitationCustomId("select", row.id),
          placeholder: form.directDecision.field.title,
          options: form.directDecision.options.map((option, index) => ({
            label: option.label,
            value: String(index),
            ...(option.description ? { description: option.description } : {}),
          })),
          min: form.directDecision.min,
          max: form.directDecision.max,
        },
        buttons: [
          ...(!form.directDecision.field.required
            ? [{ label: "Skip", style: "secondary" as const,
                customId: elicitationCustomId("skip", row.id) }]
            : []),
          { label: "Cancel", style: "danger", customId: elicitationCustomId("cancel", row.id) },
        ],
      };
    }
    return {
      panel,
      buttons: [
        { label: completed.has(row.currentPage) ? "Edit answers" : "Answer", style: "primary",
          customId: elicitationCustomId("answer", row.id) },
        ...(form.pages.length > 1 && row.currentPage > 0
          ? [{ label: "Previous", style: "secondary" as const,
              customId: elicitationCustomId("prev", row.id) }]
          : []),
        ...(form.pages.length > 1 && row.currentPage < form.pages.length - 1 &&
          completed.has(row.currentPage)
          ? [{ label: "Next", style: "secondary" as const,
              customId: elicitationCustomId("next", row.id) }]
          : []),
        { label: "Cancel", style: "danger", customId: elicitationCustomId("cancel", row.id) },
      ],
    };
  }

  private placeholder(field: ElicitationField): string | undefined {
    const options = enumOptions(field.schema);
    if (options) return options.map((option) => option.value).join(", ").slice(0, 100);
    if (field.schema.type === "boolean") return "true or false";
    if (field.schema.type === "number" || field.schema.type === "integer") return "Enter a number";
    const description = (field.schema as Record<string, unknown>).description;
    return typeof description === "string" ? description.slice(0, 100) || undefined : undefined;
  }

  private displayValue(value: ElicitationValues[string]): string {
    return Array.isArray(value) ? value.join(", ") : String(value);
  }

  private async accept(id: string, values: ElicitationValues, detail: string): Promise<boolean> {
    const row = this.store.acceptElicitation(id, detail, this.nowUtc());
    if (!row) return false;
    this.finish(row, { action: "accept", content: values });
    await this.refresh(row);
    return true;
  }

  private async cancelOne(
    id: string,
    status: Exclude<ElicitationTerminalStatus, "accepted">,
    detail: string
  ): Promise<boolean> {
    const row = this.store.settleElicitation(id, status, detail, this.nowUtc());
    if (!row) return false;
    this.finish(row, responseForTerminal(status));
    await this.refresh(row);
    return true;
  }

  private finish(row: ElicitationRow, response: CreateElicitationResponse): void {
    const waiter = this.waiters.get(row.id);
    if (!waiter) return;
    this.waiters.delete(row.id);
    waiter.resolve(response);
    this.clearTimer(row.id);
  }

  private async refresh(row: ElicitationRow, known?: ValidatedForm): Promise<void> {
    if (!row.messageId || !this.adapter.editElicitationCard) return;
    const ref: MessageRef = {
      channel: {
        platform: row.platform,
        id: row.channelRef,
        ...(row.parentRef ? { parentId: row.parentRef } : {}),
      },
      id: row.messageId,
    };
    await this.adapter.editElicitationCard(ref, this.render(row, known)).catch((error) => {
      this.logger.warn({ error, id: row.id }, "elicitation card refresh failed");
    });
  }

  private armExpiry(id: string, expiresUtc: string): void {
    this.clearTimer(id);
    const delay = Math.max(0, Date.parse(expiresUtc) - this.now());
    const timer = setTimeout(() => void this.cancelOne(id, "expired", "The request expired."), delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private nowUtc(): string {
    return new Date(this.now()).toISOString();
  }
}
