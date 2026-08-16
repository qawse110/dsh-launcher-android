/**
 * dsh-j-space-cognition — J-Space Cognition Suite Skill 插件。
 *
 * 把 Tiger3807861189/J-Space-Cognition-Suite-V3.6 的 j-space 目录打包为 DSH
 * bundled skill provider；SKILL.md 是唯一注册入口，modules/references/scripts
 * 通过 resourceBase 按需读取。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-j-space-cognition'
export const inject = ['skills']

const PROVIDER_NAME = 'dsh-j-space-cognition'
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))
const BUNDLED_SKILL_RANK = 600
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function parseFrontmatter(text, filePath) {
  const match = FRONTMATTER_RE.exec(text)
  if (!match) throw new Error(`${filePath}: missing YAML frontmatter`)
  const record = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_-]+):\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S.*))?\s*$/.exec(line)
    if (!m) continue
    record[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  const skillName = record['name']
  if (typeof skillName !== 'string' || !KEBAB_RE.test(skillName)) {
    throw new Error(`${filePath}: frontmatter "name" must be kebab-case, got ${JSON.stringify(skillName)}`)
  }
  const description = record['description']
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`${filePath}: frontmatter "description" must be a non-empty string`)
  }
  const whenToUse = record['whenToUse']
  if (whenToUse !== undefined && typeof whenToUse !== 'string') {
    throw new Error(`${filePath}: frontmatter "whenToUse" must be a string`)
  }
  return {
    name: skillName,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    modelInvocable: true,
    userInvocable: true,
    filePath,
    body: match[2] ?? '',
  }
}

function loadSkillEntries() {
  const entries = []
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = join(SKILLS_DIR, entry.name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    entries.push(parseFrontmatter(readFileSync(skillFile, 'utf8'), skillFile))
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function locatorFor(entry) {
  return { filePath: entry.filePath }
}

function candidateFor(entry) {
  return {
    name: entry.name,
    description: entry.description,
    ...(entry.whenToUse ? { whenToUse: entry.whenToUse } : {}),
    invocation: {
      modelInvocable: entry.modelInvocable,
      userInvocable: entry.userInvocable,
    },
    source: 'bundled',
    provider: PROVIDER_NAME,
    resourceBase: { kind: 'directory', path: dirname(entry.filePath) },
    rank: BUNDLED_SKILL_RANK,
    locator: locatorFor(entry),
    path: entry.filePath,
  }
}

async function loadDefinition(candidate) {
  const locator = candidate.locator
  const text = await readFile(locator.filePath, 'utf8')
  const entry = parseFrontmatter(text, locator.filePath)
  return {
    name: entry.name,
    description: entry.description,
    ...(entry.whenToUse ? { whenToUse: entry.whenToUse } : {}),
    invocation: {
      modelInvocable: entry.modelInvocable,
      userInvocable: entry.userInvocable,
    },
    source: 'bundled',
    provider: PROVIDER_NAME,
    resourceBase: { kind: 'directory', path: dirname(entry.filePath) },
    content: entry.body,
    path: entry.filePath,
  }
}

function createProvider() {
  const entries = loadSkillEntries()
  const candidates = entries.map(candidateFor)
  return {
    name: PROVIDER_NAME,
    list: async () => candidates,
    get: async (candidate) => loadDefinition(candidate),
  }
}

export function apply(ctx) {
  return ctx.skills.registerProvider(() => createProvider())
}