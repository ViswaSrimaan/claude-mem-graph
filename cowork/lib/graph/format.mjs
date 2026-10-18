// Compact text for facts and entities, as shown to the model.

const pad = (n) => String(n).padStart(2, '0');
export const day = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function entityLabel(e) {
  return `${e.name} (${e.kind}${e.status ? `: ${e.status}` : ''})`;
}

// "Priya —prefers format→ PDF (stated, since 2026-10-13; replaced Word) · why: portal"
export function factLine(f, { previous = [] } = {}) {
  const when = f.current ? `since ${day(f.valid_from)}` : `${day(f.valid_from)} → ${day(f.valid_to)}`;
  const was = previous.length ? `; replaced ${[...new Set(previous.map((p) => p.dst_name))].join(', ')}` : '';
  const detail = f.fact ? ` — ${f.fact}` : '';
  const why = f.why ? ` · why: ${f.why}` : '';
  return `${f.src_name} —${f.type}→ ${f.dst_name} (${String(f.confidence).toLowerCase()}, ${when}${was})${detail}${why}`;
}
