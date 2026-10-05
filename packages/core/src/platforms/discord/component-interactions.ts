import type { MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import type { ComponentEvent } from "../chat-adapter.js";

// Native handles stay in transport; built-ins receive capability wrappers.
export const discordComponentInteractions = new WeakMap<ComponentEvent, MessageComponentInteraction | ModalSubmitInteraction>();
