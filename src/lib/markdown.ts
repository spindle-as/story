const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function inline(s: string) {
  return escape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
}

/** A deliberately small Markdown renderer for chat replies: paragraphs, lists, code. */
export function markdown(src: string): string {
  const out: string[] = [];
  const blocks = src.replace(/\r/g, '').split(/```/);
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      out.push(`<pre>${escape(block.replace(/^[\w-]*\n/, '').replace(/\n$/, ''))}</pre>`);
      return;
    }
    for (const para of block.split(/\n{2,}/)) {
      const text = para.trim();
      if (!text) continue;
      const lines = text.split('\n');
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('')}</ul>`);
      } else {
        out.push(`<p>${lines.map((l) => inline(l.replace(/^#+\s+/, ''))).join('<br>')}</p>`);
      }
    }
  });
  return out.join('');
}
