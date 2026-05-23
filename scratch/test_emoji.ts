import { z } from "zod";
import * as path from "path";

const configSchema = z.object({
  REPOS_ROOT: z.string(),
  REPO_EMOJIS: z
    .string()
    .default("")
    .transform((v) => {
      const map = new Map<string, string>();
      for (const entry of v.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = entry.indexOf(":");
        if (idx <= 0) continue;
        const repo = entry.slice(0, idx).trim();
        const emoji = entry.slice(idx + 1).trim();
        map.set(repo, emoji);
      }
      return map;
    }),
});

const config = configSchema.parse({
  REPOS_ROOT: "/home/ubuntu/Projects",
  REPO_EMOJIS: "seam-acp:🧵,open-design:🎨,vzf-gate:🚪,HIPE:🚀,fiserv:🏦,rhc-static:🧊,doc-gen:📚,Spg-plan:📅,jesse-bulpitt:👨💻,vercel-to-discord:🔗,rhc-docs:📖,ridgeline-platform:🏗️,mri:🧠,rhc:🛋️,seam-infra:☁️,runbook-synthesis:📘,ridgeline:⛰️,spgvending:🥤"
});

function repoDisplay(repoPath: string | null): string {
    if (!repoPath) return "(unset)";
    const root = path.resolve(config.REPOS_ROOT);
    const abs = path.resolve(repoPath);
    
    let displayName = abs;
    if (abs === root) {
      displayName = "/";
    } else if (abs.startsWith(root + path.sep)) {
      displayName = abs.slice(root.length + 1);
    }

    if (displayName !== "/" && displayName !== "(unset)" && displayName !== abs) {
      const rootFolder = displayName.split(path.sep)[0] ?? "";
      const emoji = config.REPO_EMOJIS.get(rootFolder) || config.REPO_EMOJIS.get(displayName);
      if (emoji) {
        return `${emoji} ${displayName}`;
      }
    }

    return displayName;
}

console.log(repoDisplay("/home/ubuntu/Projects/seam-acp"));
console.log(repoDisplay("/home/ubuntu/Projects/open-design"));
