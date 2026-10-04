import fs from "node:fs";
import path from "node:path";

/** Host-assigned aliases retain a built-in's existing files without a migration. */
export class PluginStorage {
  constructor(private readonly root: string, readonly namespace: string, private readonly aliases: Readonly<Record<string, string>> = {}) {
    if (!/^[a-z][a-z0-9-]*$/.test(namespace)) throw new Error(`invalid storage namespace ${namespace}`);
  }

  path(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`invalid plugin storage name ${name}`);
    const target = this.aliases[name] ?? path.join(this.root, "plugins", this.namespace, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return target;
  }
}
