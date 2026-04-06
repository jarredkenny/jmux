#!/bin/bash
# Show jmux changelog — interactive scrollable viewer
# Usage: release-notes.sh <current-tag>

CURRENT="${1:-v0.0.0}"
REPO="jarredkenny/jmux"

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

const dim = '\x1b[2m';
const bold = '\x1b[1m';
const green = '\x1b[32m';
const cyan = '\x1b[36m';
const reset = '\x1b[0m';
const bar = '\x1b[90m';

// Build all lines
const lines = [''];
lines.push('  ' + green + bold + 'jmux' + reset + ' ' + dim + 'changelog' + reset);
lines.push('  ' + bar + '─'.repeat(44) + reset);
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
      lines.push(out || '');
    }
    lines.push('');
  }

  lines.push('  ' + bar + '─'.repeat(44) + reset);
  lines.push('');
}

lines.push('  ' + dim + 'github.com/' + repo + '/releases' + reset);
lines.push('');

// Interactive viewer — get actual popup dimensions via stty
let rows = 24;
let cols = 80;
try {
  const stty = Bun.spawnSync(['stty', 'size'], { stdin: 'inherit', stdout: 'pipe' });
  const [r, c] = stty.stdout.toString().trim().split(' ').map(Number);
  if (r > 0) rows = r;
  if (c > 0) cols = c;
} catch {
  rows = process.stdout.rows || 24;
  cols = process.stdout.columns || 80;
}
const viewportHeight = rows - 1; // leave 1 row for status
let scroll = 0;
const maxScroll = Math.max(0, lines.length - viewportHeight);

function render() {
  let buf = '';
  for (let i = 0; i < viewportHeight; i++) {
    const lineIdx = scroll + i;
    const line = lineIdx < lines.length ? lines[lineIdx] : '';
    // Use absolute cursor positioning for each line (1-indexed)
    buf += '\x1b[' + (i + 1) + ';1H' + line + '\x1b[K';
  }
  // Status bar on last row
  const pct = maxScroll > 0 ? Math.round((scroll / maxScroll) * 100) : 100;
  const status = dim + '  ↑↓/jk scroll  q close' + (maxScroll > 0 ? '  ' + pct + '%' : '') + reset;
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
