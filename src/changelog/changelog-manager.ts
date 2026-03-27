import fs from "node:fs/promises";
import path from "node:path";

export class ChangelogManager {
  static changelogPath(workspacePath: string): string {
    return path.join(workspacePath, "CHANGELOG.md");
  }

  async readChangelog(workspacePath: string): Promise<string> {
    const p = ChangelogManager.changelogPath(workspacePath);
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      return "";
    }
  }
}

