#!/bin/bash
# Show jmux changelog — interactive scrollable viewer
# Usage: release-notes.sh <current-tag>

CURRENT="${1:-v0.0.0}"
REPO="jarredkenny/jmux"
POPUP_SIZE=$(stty size 2>/dev/null || echo "24 80")
POPUP_ROWS=$(echo "$POPUP_SIZE" | awk '{print $1}')
POPUP_COLS=$(echo "$POPUP_SIZE" | awk '{print $2}')

bun -e "
const current = '${CURRENT}';
const repo = '${REPO}';

const resp = await fetch('https://api.github.com/repos/' + repo + '/releases?per_page=10', {
  headers: { 'Accept': 'application/vnd.github.v3+json' }
});
if (!resp.ok) {
  console.log('\n  \x1b[2mCould not fetch release notes.\x1b[0m');
  process.exit(0);
}
const releases = await resp.json();

// Popup dimensions — must be set before building lines
const rows = parseInt('${POPUP_ROWS}', 10) || 24;
const cols = parseInt('${POPUP_COLS}', 10) || 80;

const dim = '\x1b[2m';
const bold = '\x1b[1m';
const green = '\x1b[32m';
const cyan = '\x1b[36m';
const reset = '\x1b[0m';
const bar = '\x1b[90m';

// Word wrap helper — strips ANSI for length calculation, preserves codes in output
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// Truncate a string to a visible width, preserving ANSI codes
function truncateToWidth(s, width) {
  let visible = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end >= 0) { i = end + 1; continue; }
    }
    if (visible >= width) break;
    visible++;
    i++;
  }
  return s.slice(0, i) + reset;
}

function wordWrap(text, width) {
  const indent = '  ';
  const plain = stripAnsi(text);
  if (plain.length <= width) return [text];

  // Find the leading whitespace/indent of the original line
  const leadMatch = plain.match(/^(\s*)/);
  const leadLen = leadMatch ? leadMatch[1].length : 0;
  const wrapIndent = indent + ' '.repeat(Math.min(leadLen, 6));
  const contWidth = width - stripAnsi(wrapIndent).length;

  const result = [];
  let remaining = text;
  let isFirst = true;
  while (stripAnsi(remaining).length > (isFirst ? width : contWidth)) {
    const maxW = isFirst ? width : contWidth;
    // Find last space within width (on the plain text)
    const rPlain = stripAnsi(remaining);
    let breakAt = -1;
    let plainIdx = 0;
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i] === '\x1b') {
        const end = remaining.indexOf('m', i);
        if (end >= 0) { i = end; continue; }
      }
      if (remaining[i] === ' ' && plainIdx <= maxW) breakAt = i;
      plainIdx++;
      if (plainIdx > maxW && breakAt >= 0) break;
    }
    if (breakAt <= 0) break; // no good break point
    result.push((isFirst ? '' : wrapIndent) + remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt + 1);
    isFirst = false;
  }
  if (remaining) result.push((isFirst ? '' : wrapIndent) + remaining);
  return result;
}

// Build all lines
const lines = [''];
lines.push('  ' + green + bold + 'jmux' + reset + ' ' + dim + 'changelog' + reset);
const sepWidth = Math.max(10, cols - 6);
lines.push('  ' + bar + '─'.repeat(sepWidth) + reset);
lines.push('');

for (const r of releases) {
  const tag = r.tag_name;
  const date = (r.published_at || '').split('T')[0];
  const name = r.name || tag;
  const isCurrent = tag === current;

  if (isCurrent) {
    lines.push('  ' + green + bold + name + reset + '  ' + green + '← current' + reset);
  } else {
    lines.push('  ' + bold + name + reset);
  }
  lines.push('  ' + dim + date + reset);
  lines.push('');

  const body = (r.body || '').trim();
  if (body) {
    for (const line of body.split('\n')) {
      let out = line
        .replace(/^## (.*)/, '  ' + bold + '\$1' + reset)
        .replace(/^- /, '  • ')
        .replace(/\*\*([^*]+)\*\*/g, bold + '\$1' + reset)
        .replace(/\x60([^\x60]+)\x60/g, cyan + '\$1' + reset);
      if (out === '') { lines.push(''); continue; }
      for (const wrapped of wordWrap(out, cols - 4)) {
        lines.push(wrapped);
      }
    }
    lines.push('');
  }

  lines.push('  ' + bar + '─'.repeat(sepWidth) + reset);
  lines.push('');
}

lines.push('  ' + dim + 'github.com/' + repo + '/releases' + reset);
lines.push('');

// Interactive viewer
const viewportHeight = rows - 1; // leave 1 row for status
let scroll = 0;
const maxScroll = Math.max(0, lines.length - viewportHeight);

function render() {
  let buf = '';
  for (let i = 0; i < viewportHeight; i++) {
    const lineIdx = scroll + i;
    let line = lineIdx < lines.length ? lines[lineIdx] : '';
    // Truncate to popup width to prevent wrapping past the right edge
    if (stripAnsi(line).length > cols) line = truncateToWidth(line, cols);
    buf += '\x1b[' + (i + 1) + ';1H' + line + '\x1b[K';
  }
  // Status bar on last row
  const pct = maxScroll > 0 ? Math.round((scroll / maxScroll) * 100) : 100;
  let status = dim + '  ↑↓/jk scroll  q close' + (maxScroll > 0 ? '  ' + pct + '%' : '') + reset;
  if (stripAnsi(status).length > cols) status = truncateToWidth(status, cols);
  buf += '\x1b[' + rows + ';1H' + status + '\x1b[K';
  process.stdout.write(buf);
}

// Raw mode
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\x1b[?25l'); // hide cursor
process.stdout.write('\x1b[2J');   // clear screen

render();

process.stdin.on('data', (data) => {
  const key = data.toString();
  if (key === 'q' || key === '\x1b' || key === '\x03') {
    process.stdout.write('\x1b[?25h'); // show cursor
    process.exit(0);
  }
  if (key === 'j' || key === '\x1b[B' || key === '\r') {
    scroll = Math.min(maxScroll, scroll + 1);
    render();
  }
  if (key === 'k' || key === '\x1b[A') {
    scroll = Math.max(0, scroll - 1);
    render();
  }
  if (key === 'd' || key === ' ') {
    scroll = Math.min(maxScroll, scroll + Math.floor(viewportHeight / 2));
    render();
  }
  if (key === 'u') {
    scroll = Math.max(0, scroll - Math.floor(viewportHeight / 2));
    render();
  }
  if (key === 'g') {
    scroll = 0;
    render();
  }
  if (key === 'G') {
    scroll = maxScroll;
    render();
  }
});
" 2>/dev/null
