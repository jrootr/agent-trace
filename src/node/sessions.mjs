// Node-only helpers: find Claude Code sessions on disk and read a trace file (plus subagents).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function projectsDir() {
  return process.env.AGENT_TRACE_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects');
}

/** All session transcripts, newest first. Subagent transcripts are excluded (they're merged in later). */
export function findSessions(root = projectsDir()) {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const p of projects) {
    const dir = path.join(root, p.name);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        out.push({ file, id: f.replace(/\.jsonl$/, ''), project: p.name, mtime: st.mtimeMs, size: st.size });
      } catch {
        // vanished while listing
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Turn a CLI target into a file: nothing = latest session; a file path; a directory (latest .jsonl
 * inside); or a session id / id prefix.
 */
export function resolveTarget(target, root = projectsDir()) {
  if (!target) {
    const latest = findSessions(root)[0];
    if (!latest) throw new Error(`No Claude Code sessions found in ${root}. Pass a file path instead.`);
    return latest.file;
  }
  if (fs.existsSync(target)) {
    const st = fs.statSync(target);
    if (st.isFile()) return path.resolve(target);
    const own = fs.readdirSync(target)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(target, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const newest = own[0] ?? findSessions(target)[0]?.file;
    if (!newest) throw new Error(`No .jsonl transcripts in ${target}`);
    return path.resolve(newest);
  }
  const matches = findSessions(root).filter((s) => s.id.startsWith(target));
  if (matches.length === 1) return matches[0].file;
  if (matches.length > 1) throw new Error(`"${target}" matches ${matches.length} sessions; use more characters.`);
  throw new Error(`No file or session matching "${target}".`);
}

/** Read a transcript and append any subagent transcripts stored next to it. */
export function readTraceText(file) {
  let text = fs.readFileSync(file, 'utf8');
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  if (fs.existsSync(subDir)) {
    for (const f of fs.readdirSync(subDir).filter((n) => n.endsWith('.jsonl')).sort()) {
      text += '\n' + fs.readFileSync(path.join(subDir, f), 'utf8');
    }
  }
  return text;
}
