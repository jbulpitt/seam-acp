/**
 * Convenience: the session-router wants to translate channel refs to
 * SessionRecord ids. We expose this as a tiny helper rather than pollute the
 * adapter interface.
 */
export function makeSessionIdFromChannel(channel) {
    return `${channel.platform}:${channel.id}`;
}
//# sourceMappingURL=chat-adapter.js.map