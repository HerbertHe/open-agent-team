import fs from "node:fs/promises";
import path from "node:path";

export class SkillResolver {
  constructor(private readonly repoRoot: string) {}

  async syncSkillsToWorkspace(skillNames: string[], workspacePath: string): Promise<void> {
    const skillsSrcRoot = path.join(this.repoRoot, "skills");
    const target = path.join(workspacePath, ".opencode", "skills");
    await fs.mkdir(target, { recursive: true });

    for (const skill of skillNames) {
      const src = path.join(skillsSrcRoot, skill, "SKILL.md");
      const dstDir = path.join(target, skill);
      const dst = path.join(dstDir, "SKILL.md");
      await fs.mkdir(dstDir, { recursive: true });
      await fs.copyFile(src, dst);
    }
  }
}
