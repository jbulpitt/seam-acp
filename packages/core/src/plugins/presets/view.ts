export function presetModelSelectOptions(
  models: ReadonlyArray<{ modelId: string; name: string }>,
  selected: string | null
): Array<{ label: string; value: string; description?: string; default?: boolean }> {
  const limit = models.length > 24 ? 23 : 24;
  const visible = models.slice(0, limit);
  if (selected && !visible.some((model) => model.modelId === selected)) {
    const selectedModel = models.find((model) => model.modelId === selected);
    if (selectedModel) visible.splice(Math.max(0, visible.length - 1), 1, selectedModel);
  }
  return [
    { label: "Default", value: "__default__", default: selected === null },
    ...visible.map((model) => ({
      label: model.name.slice(0, 100),
      value: model.modelId,
      default: model.modelId === selected,
    })),
    ...(models.length > 24 ? [{
      label: "More… (full picker)",
      value: "__more__",
      description: `Browse all ${models.length} cached models`,
    }] : []),
  ];
}
