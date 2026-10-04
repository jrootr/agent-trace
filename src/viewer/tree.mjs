// Virtualized call tree. Only the rows in view are in the DOM, so huge sessions stay smooth.
import { escapeHtml, fmtDuration, fmtTokens, icon, INFLECTION_ICONS } from './format.mjs';
import { INFLECTION_KINDS } from '../core/analysis.mjs';

const ROW_H = 26;
const OVERSCAN = 8;
const INDENT = 16;

function kindColorVar(s) {
  if (s.status === 'error') return 'var(--error)';
  if (s.kind === 'turn') return 'var(--turn-strong)';
  if (s.kind === 'llm') return 'var(--llm)';
  if (s.kind === 'agent') return 'var(--cat-agent)';
  if (s.kind === 'session') return 'var(--text-3)';
  return `var(--cat-${s.attrs?.['tool.category'] ?? 'other'})`;
}

/**
 * Rows to show: depth-first, honouring collapsed nodes and the active filter.
 * order 'desc' lists siblings newest first at every level (parents still precede children).
 */
export function flattenRows(prepared, collapsed, matchIds, order = 'asc') {
  const rows = [];
  const keep = matchIds ? new Set() : null;
  if (matchIds) {
    for (const id of matchIds) {
      let cur = prepared.byId.get(id);
      while (cur) {
        if (keep.has(cur.id)) break;
        keep.add(cur.id);
        cur = cur.parentId ? prepared.byId.get(cur.parentId) : null;
      }
    }
  }
  const visit = (parentKey, depth) => {
    const siblings = prepared.children.get(parentKey) ?? [];
    for (const s of order === 'desc' ? [...siblings].reverse() : siblings) {
      if (keep && !keep.has(s.id)) continue;
      const kids = prepared.children.get(s.id) ?? [];
      const isRoot = s.kind === 'session' && parentKey === null;
      if (isRoot) {
        visit(s.id, depth); // the session row adds nothing; show its turns at the top level
        continue;
      }
      const expanded = matchIds ? true : !collapsed.has(s.id);
      rows.push({ span: s, depth, hasChildren: kids.length > 0, expanded, dim: Boolean(matchIds && !matchIds.has(s.id)) });
      if (kids.length && expanded) visit(s.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

export function createTree({ root, store, onSelect, onActivate }) {
  root.innerHTML = '<div class="tree-viewport" role="tree" tabindex="0" aria-label="Call tree"><div class="tree-spacer"></div><div class="tree-rows"></div></div><div class="tree-empty" hidden>No spans match the current filter.</div>';
  const viewport = root.querySelector('.tree-viewport');
  const spacer = root.querySelector('.tree-spacer');
  const rowsEl = root.querySelector('.tree-rows');
  const empty = root.querySelector('.tree-empty');
  let rows = [];
  let rowIndex = new Map();
  let frame = 0;

  function rebuild() {
    const { prepared, collapsed, matchIds, treeOrder } = store.get();
    rows = prepared ? flattenRows(prepared, collapsed, matchIds, treeOrder) : [];
    rowIndex = new Map(rows.map((r, i) => [r.span.id, i]));
    spacer.style.height = `${rows.length * ROW_H}px`;
    empty.hidden = rows.length > 0 || !prepared;
    render();
  }

  function rangeFor(s, prepared, scale) {
    // Mini-bar: where this span sits inside its turn (or inside the whole session for turns).
    let frameSpan = prepared.trace;
    if (s.kind !== 'turn') {
      let cur = s;
      while (cur.parentId && prepared.byId.get(cur.parentId)?.kind !== 'session' && prepared.byId.has(cur.parentId)) cur = prepared.byId.get(cur.parentId);
      if (cur !== s) frameSpan = cur;
    }
    const f0 = scale.toV(frameSpan.start);
    const f1 = Math.max(scale.toV(frameSpan.end), f0 + 1);
    const a = (scale.toV(s.start) - f0) / (f1 - f0);
    const b = (scale.toV(s.end) - f0) / (f1 - f0);
    return [Math.max(0, Math.min(1, a)), Math.max(0.004, Math.min(1, b) - Math.max(0, a))];
  }

  function rowHtml(row, i, state) {
    const { span: s, depth, hasChildren, expanded, dim } = row;
    const { prepared, scale, selectedId } = state;
    const a = s.attrs ?? {};
    const infs = prepared.inflectionsBySpan.get(s.id) ?? [];
    const badges = infs.slice(0, 3).map((inf) => {
      const group = INFLECTION_KINDS[inf.kind]?.group ?? 'system';
      return `<span class="badge-inf" style="--c: var(--inf-${group})" title="${escapeHtml(inf.label)}">${icon(INFLECTION_ICONS[inf.kind] ?? 'spark', 12)}</span>`;
    }).join('');
    let detail = '';
    if (s.kind === 'tool' || s.kind === 'agent') detail = a['tool.summary'] ?? '';
    else if (s.kind === 'llm') {
      const parts = [];
      if (a['llm.tokens.output']) parts.push(`${fmtTokens(a['llm.tokens.output'])} out`);
      if (a['llm.tokens.thinking']) parts.push(`${fmtTokens(a['llm.tokens.thinking'])} thinking`);
      if (a['llm.tool_calls']) parts.push(`${a['llm.tool_calls']} tool call${a['llm.tool_calls'] > 1 ? 's' : ''}`);
      detail = parts.join(' · ');
    } else if (s.kind === 'turn') {
      const kids = prepared.children.get(s.id) ?? [];
      const tools = kids.filter((k) => k.kind === 'tool').length;
      detail = `${tools} tool${tools === 1 ? '' : 's'}`;
    }
    const name = s.kind === 'llm' ? 'Model' : s.name;
    const [left, width] = scale ? rangeFor(s, prepared, scale) : [0, 0];
    const cls = ['tree-row', `kind-${s.kind}`, s.id === selectedId ? 'is-selected' : '', s.status === 'error' ? 'is-error' : '', dim ? 'is-dim' : ''].join(' ');
    return `<div class="${cls}" role="treeitem" aria-level="${depth + 1}" ${hasChildren ? `aria-expanded="${expanded}"` : ''} aria-selected="${s.id === selectedId}" data-id="${escapeHtml(s.id)}" style="transform:translateY(${i * ROW_H}px)">` +
      `<span class="tr-indent" style="width:${depth * INDENT}px"></span>` +
      (hasChildren ? `<span class="tr-twisty${expanded ? ' is-open' : ''}" data-toggle="1">${icon('chevron', 14)}</span>` : '<span class="tr-twisty is-leaf"></span>') +
      `<span class="tr-dot" style="--c:${kindColorVar(s)}"></span>` +
      `<span class="tr-name">${escapeHtml(name)}</span>` +
      `<span class="tr-detail">${escapeHtml(detail)}</span>` +
      `<span class="tr-badges">${badges}</span>` +
      `<span class="tr-bar" aria-hidden="true"><i style="left:${(left * 100).toFixed(2)}%;width:${(width * 100).toFixed(2)}%;background:${kindColorVar(s)}"></i></span>` +
      `<span class="tr-dur">${fmtDuration(s.end - s.start)}</span>` +
      '</div>';
  }

  function render() {
    frame = 0;
    const state = store.get();
    if (!state.prepared) {
      rowsEl.innerHTML = '';
      return;
    }
    const top = viewport.scrollTop;
    const h = viewport.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((top + h) / ROW_H) + OVERSCAN);
    let html = '';
    for (let i = first; i < last; i++) html += rowHtml(rows[i], i, state);
    rowsEl.innerHTML = html;
  }

  const requestRender = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };

  function toggle(id, open) {
    const { collapsed } = store.get();
    const next = new Set(collapsed);
    const isOpen = !collapsed.has(id);
    if (open ?? !isOpen) next.delete(id);
    else next.add(id);
    store.set({ collapsed: next });
  }

  function scrollToId(id) {
    const { prepared, collapsed } = store.get();
    if (!prepared) return;
    let cur = prepared.byId.get(id);
    const next = new Set(collapsed);
    let changed = false;
    while (cur?.parentId) {
      if (next.delete(cur.parentId)) changed = true;
      cur = prepared.byId.get(cur.parentId);
    }
    if (changed) store.set({ collapsed: next });
    const i = rowIndex.get(id);
    if (i === undefined) return;
    const top = i * ROW_H;
    if (top < viewport.scrollTop + ROW_H) viewport.scrollTop = Math.max(0, top - ROW_H * 2);
    else if (top > viewport.scrollTop + viewport.clientHeight - ROW_H * 2) viewport.scrollTop = top - viewport.clientHeight + ROW_H * 3;
  }

  viewport.addEventListener('scroll', requestRender, { passive: true });
  rowsEl.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    if (e.target.closest('[data-toggle]')) {
      toggle(row.dataset.id);
      return;
    }
    onSelect({ spanId: row.dataset.id, from: 'tree' });
  });
  rowsEl.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tree-row');
    if (row && !e.target.closest('[data-toggle]')) onActivate(row.dataset.id);
  });
  viewport.addEventListener('keydown', (e) => {
    const { selectedId, prepared } = store.get();
    if (!prepared || !rows.length) return;
    let i = rowIndex.get(selectedId) ?? -1;
    const row = rows[i];
    const select = (j) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (r) onSelect({ spanId: r.span.id, from: 'tree' });
    };
    switch (e.key) {
      case 'ArrowDown': select(i + 1); break;
      case 'ArrowUp': select(i < 0 ? 0 : i - 1); break;
      case 'Home': select(0); break;
      case 'End': select(rows.length - 1); break;
      case 'PageDown': select(i + Math.floor(viewport.clientHeight / ROW_H)); break;
      case 'PageUp': select(i - Math.floor(viewport.clientHeight / ROW_H)); break;
      case 'ArrowRight':
        if (row?.hasChildren && !row.expanded) toggle(row.span.id, true);
        else if (row?.hasChildren) select(i + 1);
        break;
      case 'ArrowLeft':
        if (row?.hasChildren && row.expanded) toggle(row.span.id, false);
        else if (row?.span.parentId && rowIndex.has(row.span.parentId)) select(rowIndex.get(row.span.parentId));
        break;
      case 'Enter': if (row) onActivate(row.span.id); break;
      default: return;
    }
    e.preventDefault();
  });

  new ResizeObserver(requestRender).observe(viewport);

  store.subscribe((state, changed) => {
    if (changed.has('treeOrder')) {
      rebuild();
      // keep the user's place: the selected row stays in view, otherwise start at the top
      if (state.selectedId && rowIndex.has(state.selectedId)) scrollToId(state.selectedId);
      else viewport.scrollTop = 0;
      return;
    }
    if (changed.has('prepared') || changed.has('collapsed') || changed.has('matchIds') || changed.has('scale')) rebuild();
    else if (changed.has('selectedId') || changed.has('theme')) requestRender();
    if (changed.has('selectedId') && state.selectedId) scrollToId(state.selectedId);
  });

  return {
    focus: () => viewport.focus(),
    expandAll: () => store.set({ collapsed: new Set() }),
    collapseAll: () => {
      const { prepared } = store.get();
      store.set({ collapsed: new Set(prepared.trace.spans.filter((s) => s.kind === 'turn' || s.kind === 'agent' || (prepared.children.get(s.id)?.length && s.kind !== 'session')).map((s) => s.id)) });
    },
  };
}
