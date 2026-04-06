#!/bin/bash
# Show jmux changelog — recent releases with formatted notes
# Usage: release-notes.sh <current-tag>

CURRENT="${1:-v0.0.0}"
REPO="jarredkenny/jmux"

bun -e "
const resp = await fetch('https://api.github.com/repos/${REPO}/releases?per_page=10', {
  headers: { 'Accept': 'application/vnd.github.v3+json' }
});
if (!resp.ok) {
  console.log('\n  \x1b[2mjmux ${CURRENT}\x1b[0m\n');
  console.log('  \x1b[2mCould not fetch release notes.\x1b[0m\n');
  process.exit(0);
}
const releases = await resp.json();
const current = '${CURRENT}';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const green = '\x1b[32m';
const cyan = '\x1b[36m';
const reset = '\x1b[0m';
const bar = '\x1b[90m';
const sep = '  ' + bar + '─'.repeat(44) + reset;

console.log('');
console.log('  ' + green + bold + 'jmux' + reset + ' ' + dim + 'changelog' + reset);
console.log(sep);
console.log('');

for (const r of releases) {
  const tag = r.tag_name;
  const date = (r.published_at || '').split('T')[0];
  const name = r.name || tag;
  const isCurrent = tag === current;

  if (isCurrent) {
    console.log('  ' + green + bold + name + reset + '  ' + green + '← current' + reset);
  } else {
    console.log('  ' + bold + name + reset);
  }
  console.log('  ' + dim + date + reset);
  console.log('');

  const body = (r.body || '').trim();
  if (body) {
    const lines = body.split('\n');
    for (const line of lines) {
      let out = line
        .replace(/^## (.*)/, '  ' + bold + '\$1' + reset)
        .replace(/^- /, '  • ')
        .replace(/\*\*([^*]+)\*\*/g, bold + '\$1' + reset)
        .replace(/\x60([^\x60]+)\x60/g, cyan + '\$1' + reset);
      if (out.trim() === '') out = '';
      console.log(out);
    }
    console.log('');
  }

  console.log(sep);
  console.log('');
}

console.log('  ' + dim + 'github.com/${REPO}/releases' + reset);
console.log('');
" 2>/dev/null | less -R -P "q to close"
