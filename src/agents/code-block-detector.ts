/**
 * Detect "file-shaped" fenced code blocks in agent text and turn them
 * into uploadable file payloads.
 *
 * Models often emit large, complete artifacts (markdown docs, JSON
 * configs, Python scripts, etc.) inline as fenced code blocks rather
 * than writing them to disk. This module finds those blocks, decides
 * which are large/file-shaped enough to warrant an attachment, and
 * builds the payload the orchestrator can upload to chat.
 */

export interface DetectedBlock {
  /** Suggested filename, e.g. "snippet-1.md". */
  filename: string;
  /** MIME type matching the language tag. */
  mimeType: string;
  /** Raw text content of the block (no fences). */
  content: string;
  /** Original language tag the model wrote (lowercased). Empty when none. */
  lang: string;
}

/** Language tag → file extension. The longest tag listed wins on aliases. */
const LANG_EXT: Record<string, string> = {
  markdown: "md",
  md: "md",
  json: "json",
  yaml: "yml",
  yml: "yml",
  csv: "csv",
  html: "html",
  htm: "html",
  xml: "xml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  python: "py",
  py: "py",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  bash: "sh",
  sh: "sh",
  zsh: "sh",
  shell: "sh",
  dockerfile: "Dockerfile",
  rust: "rs",
  rs: "rs",
  go: "go",
  java: "java",
  kotlin: "kt",
  kt: "kt",
  cpp: "cpp",
  "c++": "cpp",
  c: "c",
  cs: "cs",
  csharp: "cs",
  rb: "rb",
  ruby: "rb",
  php: "php",
  swift: "swift",
  scala: "scala",
  r: "r",
  pl: "pl",
  perl: "pl",
  lua: "lua",
  hcl: "hcl",
  tf: "tf",
  terraform: "tf",
  proto: "proto",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  diff: "diff",
  patch: "patch",
};

const EXT_MIME: Record<string, string> = {
  md: "text/markdown",
  json: "application/json",
  yml: "application/yaml",
  csv: "text/csv",
  html: "text/html",
  xml: "application/xml",
  toml: "application/toml",
  ini: "text/plain",
  sql: "application/sql",
  py: "text/x-python",
  ts: "application/typescript",
  tsx: "application/typescript",
  js: "application/javascript",
  jsx: "application/javascript",
  sh: "application/x-sh",
  Dockerfile: "text/plain",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  kt: "text/x-kotlin",
  cpp: "text/x-c++",
  c: "text/x-c",
  cs: "text/x-csharp",
  rb: "text/x-ruby",
  php: "application/x-php",
  swift: "text/x-swift",
  scala: "text/x-scala",
  r: "text/x-r",
  pl: "text/x-perl",
  lua: "text/x-lua",
  hcl: "text/x-hcl",
  tf: "text/x-hcl",
  proto: "text/plain",
  graphql: "application/graphql",
  vue: "text/x-vue",
  svelte: "text/x-svelte",
  diff: "text/x-diff",
  patch: "text/x-diff",
};

export interface DetectOpts {
  /** Minimum line count for non-markdown blocks. Default 20. */
  minLines?: number;
  /** Minimum line count for markdown blocks. Default 5. */
  minLinesMarkdown?: number;
  /** Filename prefix; counter appended. Default "snippet". */
  filenamePrefix?: string;
}

/**
 * Walk `text` and return all fenced code blocks that look like files
 * the user would want attached. Untagged blocks and blocks below the
 * threshold are skipped.
 */
export function detectFileBlocks(
  text: string,
  opts: DetectOpts = {}
): DetectedBlock[] {
  if (!text) return [];
  const minLines = opts.minLines ?? 20;
  const minLinesMd = opts.minLinesMarkdown ?? 5;
  const prefix = opts.filenamePrefix ?? "snippet";

  const out: DetectedBlock[] = [];
  // Match ``` followed by an optional language tag, then content, then
  // a closing ``` on its own line. Multiline; non-greedy body.
  const re = /```([\w+#.-]*)\s*\n([\s\S]*?)\n```/g;
  let counter = 0;
  for (const m of text.matchAll(re)) {
    const langRaw = (m[1] ?? "").trim().toLowerCase();
    const body = m[2] ?? "";
    if (!body.trim()) continue;
    if (!langRaw) continue; // skip untagged: too noisy

    const ext = LANG_EXT[langRaw];
    if (!ext) continue;

    const lineCount = body.split("\n").length;
    const isDocish = ext === "md";
    if (lineCount < (isDocish ? minLinesMd : minLines)) continue;

    counter++;
    const mimeType = EXT_MIME[ext] ?? "text/plain";
    const filename =
      ext === "Dockerfile"
        ? counter === 1
          ? "Dockerfile"
          : `Dockerfile.${counter}`
        : `${prefix}-${counter}.${ext}`;
    out.push({ filename, mimeType, content: body, lang: langRaw });
  }
  return out;
}
