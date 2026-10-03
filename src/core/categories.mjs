// Group tools into a few categories (for color and filtering) and work phases
// (for spotting pivots such as "exploring" → "building").

export const CATEGORIES = ['read', 'write', 'exec', 'web', 'agent', 'mcp', 'meta', 'other'];

export const CATEGORY_LABELS = {
  read: 'Read & search',
  write: 'Write & edit',
  exec: 'Shell',
  web: 'Web & browser',
  agent: 'Subagents',
  mcp: 'MCP',
  meta: 'Planning & meta',
  other: 'Other',
};

const BY_NAME = {
  Read: 'read', Glob: 'read', Grep: 'read', LS: 'read', NotebookRead: 'read',
  Write: 'write', Edit: 'write', MultiEdit: 'write', NotebookEdit: 'write',
  Bash: 'exec', PowerShell: 'exec', BashOutput: 'exec', KillShell: 'exec', Monitor: 'exec', TaskStop: 'exec',
  WebFetch: 'web', WebSearch: 'web',
  Agent: 'agent', Task: 'agent', SendMessage: 'agent',
  TodoWrite: 'meta', ToolSearch: 'meta', Skill: 'meta', AskUserQuestion: 'meta', ExitPlanMode: 'meta',
  EnterPlanMode: 'meta', SlashCommand: 'meta',
};

const TEST_CMD = /\b(npm (run )?test|pnpm test|yarn test|node --test|pytest|jest|vitest|mocha|go test|cargo test|dotnet test|mvn test|gradle test|rspec|phpunit|tox)\b|\bvalidate\b/i;
const READ_CMD = /^\s*(cd\s+\S+\s*&&\s*)?(ls|cat|head|tail|grep|rg|find|wc|tree|pwd|which|type|git (status|log|diff|show|branch)|Get-ChildItem|Get-Content|Select-String)\b/i;
const BROWSER_MCP = /^mcp__(Claude_Browser|claude-in-chrome|playwright|puppeteer|browser)/i;

export function categorizeTool(name, input) {
  if (BY_NAME[name]) return BY_NAME[name];
  if (typeof name === 'string' && name.startsWith('mcp__')) return BROWSER_MCP.test(name) ? 'web' : 'mcp';
  return 'other';
}

/**
 * Phase of work a tool call represents: explore, build, verify, or null (neutral).
 * Shell commands are split by what they run: tests count as verify, read-only commands as explore.
 */
export function phaseOf(name, input, category = categorizeTool(name, input)) {
  if (category === 'read' || category === 'web') return 'explore';
  if (category === 'write') return 'build';
  if (category === 'exec') {
    const cmd = typeof input?.command === 'string' ? input.command : '';
    if (TEST_CMD.test(cmd)) return 'verify';
    if (READ_CMD.test(cmd)) return 'explore';
    return 'build';
  }
  return null;
}

export const PHASE_LABELS = { explore: 'Exploring', build: 'Building', verify: 'Verifying' };

/** One-line summary of a tool call's input, for tree rows and tooltips. */
export function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.description ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url
    ?? input.query ?? input.prompt ?? input.title ?? input.skill ?? input.action ?? null;
  if (pick == null) {
    const first = Object.values(input).find((v) => typeof v === 'string');
    return first ? String(first).split('\n')[0].slice(0, 140) : '';
  }
  return String(pick).split('\n')[0].slice(0, 140);
}
