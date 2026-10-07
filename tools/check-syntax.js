'use strict';
/* Parse every inline <script> in the built page, so a syntax error cannot ship. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const file = process.argv[2] || path.join(__dirname, '..', 'app', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) { console.error('no inline scripts found in ' + file); process.exit(1); }

let bad = 0;
blocks.forEach((code, i) => {
  const tmp = path.join(os.tmpdir(), 'daftar-check-' + i + '.js');
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    console.log('  script ' + (i + 1) + ': OK (' + code.length + ' chars)');
  } catch (e) {
    bad++;
    console.error('  script ' + (i + 1) + ': FAILED\n' + (e.stderr || '').toString().split('\n').slice(0, 6).join('\n'));
  }
  fs.unlinkSync(tmp);
});
console.log(bad ? 'SYNTAX FAILED' : 'SYNTAX OK (' + blocks.length + ' blocks)');
process.exit(bad ? 1 : 0);
