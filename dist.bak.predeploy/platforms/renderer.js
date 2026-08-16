/**
 * Serialize a {@link StructuredPanel} to plain text. Used as a fallback when
 * the chat adapter doesn't support rich panels (embeds).
 */
export function serializePanelText(panel) {
    const lines = [];
    lines.push(`**${panel.title}**`);
    lines.push("```text");
    const maxKey = panel.fields.reduce((m, f) => Math.max(m, f.name.length), 0);
    for (const f of panel.fields) {
        lines.push(`${f.name.padEnd(maxKey)} : ${f.value}`);
    }
    lines.push("```");
    if (panel.description) {
        lines.push(panel.description);
    }
    if (panel.footer) {
        lines.push(`_${panel.footer}_`);
    }
    return lines.join("\n").replace(/\s+$/, "");
}
//# sourceMappingURL=renderer.js.map