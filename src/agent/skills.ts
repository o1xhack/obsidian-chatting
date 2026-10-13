import { App, TFile, TFolder, normalizePath, prepareFuzzySearch } from "obsidian";
import type { ToolResult } from "../types";

/**
 * Skills, as Claude Code and Codex have them: a folder per skill in the
 * vault's skills folder, with a `SKILL.md` whose properties give its
 * `name` and `description`, and any other files it needs. The system
 * prompt lists names and descriptions; `use_skill` loads a skill's
 * instructions when the model picks it; `/name` in a message loads it
 * along with the message.
 */

export const SKILL_FILE = "SKILL.md";
export const DEFAULT_SKILLS_FOLDER = "Skills";
/** Characters of a SKILL.md given to the model (as for AGENTS.md). */
export const SKILL_CHARS = 32768;
/** A skill's other files listed at most. */
const MAX_RESOURCES = 50;
/** Offered in the `/` list. */
const CANDIDATES = 8;

export interface Skill {
  name: string;
  description: string;
  /** The SKILL.md file. */
  path: string;
}

/** The skills in `folder`: each subfolder with a SKILL.md, by name. */
export function findSkills(app: App, folder: string): Skill[] {
  const root = app.vault.getFolderByPath(normalizePath(folder || DEFAULT_SKILLS_FOLDER));
  if (!(root instanceof TFolder)) return [];
  const skills: Skill[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    const file = app.vault.getFileByPath(`${child.path}/${SKILL_FILE}`);
    if (!file) continue;
    const properties: unknown = app.metadataCache.getFileCache(file)?.frontmatter;
    const value = (key: string) => {
      const found = properties && typeof properties === "object" ? (properties as Record<string, unknown>)[key] : undefined;
      return typeof found === "string" ? found.trim() : "";
    };
    // The folder's name when the file has none, as Claude Code does.
    skills.push({ name: value("name") || child.name, description: value("description"), path: file.path });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** For the system prompt: the skills and when to use them; null without skills. */
export function skillsPrompt(skills: Skill[]): string | null {
  if (skills.length === 0) return null;
  const list = skills.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"}`).join("\n");
  return `Skills are instructions for particular tasks that the user keeps in the vault. When a task matches a skill's description, call use_skill with its name before you start, then follow it. A message that names a skill as /name has it loaded already.

${list}`;
}

/** The skill named `name` (any case). */
export function skillNamed(skills: Skill[], name: string): Skill | undefined {
  const wanted = name.trim().replace(/^\//, "").toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === wanted);
}

/**
 * A skill for the model: its instructions (SKILL.md without its
 * properties, capped) and the other files in its folder, which it reads
 * with the vault tools.
 */
export async function loadSkill(app: App, skill: Skill): Promise<string> {
  const file = app.vault.getFileByPath(skill.path);
  if (!file) return `The skill "${skill.name}" is gone (${skill.path} not found).`;
  const text = await app.vault.cachedRead(file);
  const end = app.metadataCache.getFileCache(file)?.frontmatterPosition?.end.offset;
  let body = (end !== undefined ? text.slice(end) : text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")).trim();
  if (body.length > SKILL_CHARS) body = `${body.slice(0, SKILL_CHARS)}\n(cut after ${SKILL_CHARS} characters)`;
  const resources = file.parent ? filesIn(file.parent).filter((path) => path !== file.path) : [];
  const listed = resources.slice(0, MAX_RESOURCES).map((path) => `- ${path}`).join("\n");
  const more = resources.length > MAX_RESOURCES ? `\n…and ${resources.length - MAX_RESOURCES} more.` : "";
  return `<skill name="${skill.name}" path="${skill.path}">
${body || "(empty)"}
</skill>${resources.length ? `\nThe skill's other files (read them when its instructions call for them):\n${listed}${more}` : ""}`;
}

function filesIn(folder: TFolder): string[] {
  return folder.children.flatMap((child) =>
    child instanceof TFolder ? filesIn(child) : child instanceof TFile ? [child.path] : []).sort();
}

/** `use_skill`: the named skill's instructions and files; an error lists the skills there are. */
export async function useSkill(app: App, folder: string, input: Record<string, unknown>): Promise<ToolResult> {
  const skills = findSkills(app, folder);
  const name = typeof input.name === "string" ? input.name : "";
  const skill = skillNamed(skills, name);
  if (!skill) {
    return { result: `No skill named "${name}". Skills: ${skills.map((s) => s.name).join(", ") || "none"}.`, isError: true };
  }
  return { result: await loadSkill(app, skill), isError: false };
}

/**
 * The skills a message names as `/name` (at its start or after a space;
 * any case), each once, in the order named. A name may have spaces (a
 * folder name) and may be followed by punctuation.
 */
export function invokedSkills(text: string, skills: Skill[]): Skill[] {
  return skills
    .map((skill) => {
      const name = skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { skill, at: text.search(new RegExp(`(?:^|\\s)\\/${name}(?![\\p{L}\\p{N}_-])`, "iu")) };
    })
    .filter((found) => found.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((found) => found.skill);
}

/** The skills a message invokes as `/name`, loaded, for its context; null when none. */
export async function invokedSkillsText(app: App, folder: string, text: string): Promise<string | null> {
  const invoked = invokedSkills(text, findSkills(app, folder));
  if (invoked.length === 0) return null;
  const loaded = await Promise.all(invoked.map((skill) => loadSkill(app, skill)));
  return `[Skills the user invoked with /name; follow them for this request:]\n${loaded.join("\n\n")}`;
}

/** The `/name` being typed: a `/` at the start of a line or after a space, up to the caret. */
export function skillAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)\/([\p{L}\p{N}_.-]*)$/u.exec(text.slice(text.lastIndexOf("\n", caret - 1) + 1, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

/** Skills that match `query` (fuzzy on the name, best first); all for an empty one. */
export function skillCandidates(skills: Skill[], query: string): Skill[] {
  if (!query) return skills.slice(0, CANDIDATES);
  const match = prepareFuzzySearch(query);
  return skills
    .map((skill) => ({ skill, score: match(skill.name)?.score }))
    .filter((item): item is { skill: Skill; score: number } => item.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATES)
    .map((item) => item.skill);
}

/** A SKILL.md to start from, for "New skill" in the settings. */
export const SKILL_TEMPLATE = (name: string) => `---
name: ${name}
description: What this skill does and when to use it, in one or two sentences. The AI picks the skill by this.
---

Write the instructions here, as steps or rules. Other files in this folder (templates, examples) can be named here; the AI reads them when needed.
`;
