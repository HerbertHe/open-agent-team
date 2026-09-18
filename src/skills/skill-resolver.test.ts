import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillResolver } from "./skill-resolver";

async function temporaryWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "oat-skill-cache-"));
}

test("an in-place local skill collection never invokes npx and is cached", async (context) => {
  const workspace = await temporaryWorkspace();
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "skills", "local-one"), { recursive: true });
  await fs.writeFile(path.join(workspace, "skills", "local-one", "SKILL.md"), "---\nname: local-one\ndescription: test\n---\n");
  let commands = 0;
  const resolver = new SkillResolver(async () => { commands += 1; return {}; });
  const entries = [{ source: "./skills", names: ["local-one"] }];

  await resolver.installSkillsToWorkspace(entries, workspace);
  await resolver.installSkillsToWorkspace(entries, workspace);

  assert.equal(commands, 0);
  const manifest = JSON.parse(await fs.readFile(path.join(workspace, ".oat", "skills-manifest.json"), "utf8"));
  assert.deepEqual(manifest.installedSkills, ["local-one"]);
  assert.equal(await fs.readlink(path.join(workspace, ".pi", "skills")), "../skills");
});

test("local skill content changes invalidate the manifest and resynchronize", async (context) => {
  const root = await temporaryWorkspace();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "library", "local-one");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: local-one\ndescription: v1\n---\n");
  const resolver = new SkillResolver(async () => { throw new Error("npx must not run for direct local skills"); });
  const entries = [{ source: path.dirname(source), names: ["local-one"] }];

  await resolver.installSkillsToWorkspace(entries, workspace);
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: local-one\ndescription: v2\n---\n");
  await resolver.installSkillsToWorkspace(entries, workspace);

  assert.match(await fs.readFile(path.join(workspace, "skills", "local-one", "SKILL.md"), "utf8"), /v2/);
});

test("remote skills invoke npx only when the cached installation is missing", async (context) => {
  const workspace = await temporaryWorkspace();
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let commands = 0;
  const resolver = new SkillResolver(async (_file, _args, options) => {
    commands += 1;
    const target = path.join(options.cwd, "skills", "remote-one");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "SKILL.md"), "---\nname: remote-one\ndescription: test\n---\n");
    return {};
  });
  const entries = [{ source: "example/remote-skills", names: ["remote-one"] }];

  await resolver.installSkillsToWorkspace(entries, workspace);
  await resolver.installSkillsToWorkspace(entries, workspace);
  assert.equal(commands, 1);

  await fs.rm(path.join(workspace, "skills", "remote-one"), { recursive: true, force: true });
  await resolver.installSkillsToWorkspace(entries, workspace);
  assert.equal(commands, 2);
});
