/**
 * Shared mappings: language tag → file extension → MIME type.
 *
 * Used by the streaming fence extractor and (legacy) post-turn
 * code-block detector. Extensions are lowercase except for the
 * filename-style "Dockerfile".
 */

export const LANG_EXT: Record<string, string> = {
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

export const EXT_MIME: Record<string, string> = {
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
  txt: "text/plain",
};

/** Infer a MIME type from a filename's extension; defaults to octet-stream. */
export function mimeTypeForFilename(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  if (base === "Dockerfile") return EXT_MIME.Dockerfile ?? "text/plain";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}
