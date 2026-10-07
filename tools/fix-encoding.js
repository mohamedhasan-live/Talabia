'use strict';
/*
 * Repair a UTF-8 file that was read as ANSI and written back — the classic
 * Windows PowerShell round trip that turns "الأحد" into "Ø§Ù„Ø£Ø­Ø¯".
 * The damage is reversible: re-read the text's own bytes as latin1 and decode
 * them as UTF-8. Run with --apply once the preview looks right.
 */
const fs = require('fs');

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!file) { console.error('usage: node tools/fix-encoding.js <file> [--apply]'); process.exit(1); }

/*
 * Windows PowerShell writes with CP1252, not latin1, and the two differ over
 * 0x80–0x9F — which is exactly where Arabic's lead bytes land. Decoding the
 * damaged text as latin1 therefore loses characters; mapping those 27 code
 * points back to their bytes first recovers the file exactly.
 */
const CP1252_HIGH = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
  0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
  0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
  0x017E: 0x9E, 0x0178: 0x9F
};
function fromCp1252(text) {
  const out = Buffer.alloc(text.length * 4);
  let n = 0, lost = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x100) { out[n++] = cp; }
    else if (CP1252_HIGH[cp] != null) { out[n++] = CP1252_HIGH[cp]; }
    else { n += out.write(ch, n, 'utf8'); lost++; }   // genuinely not mangled
  }
  return { buf: out.subarray(0, n), lost };
}

const s = fs.readFileSync(file, 'utf8');
const conv = fromCp1252(s);
const fixed = conv.buf.toString('utf8');

const MOJIBAKE = /Ø[\u0080-¿]|Ù[\u0080-¿]/g;
const ARABIC = /[؀-ۿ]/g;

const before = { mojibake: (s.match(MOJIBAKE) || []).length, arabic: (s.match(ARABIC) || []).length };
const after = { mojibake: (fixed.match(MOJIBAKE) || []).length, arabic: (fixed.match(ARABIC) || []).length };

console.log('before : ' + before.mojibake + ' mojibake sequences, ' + before.arabic + ' Arabic characters');
console.log('after  : ' + after.mojibake + ' mojibake sequences, ' + after.arabic + ' Arabic characters');

function sample(text, needle) {
  const i = text.indexOf(needle);
  return i < 0 ? '(not found)' : text.slice(i, i + 64).replace(/\n/g, ' ');
}
console.log('\nsample before : ' + sample(s, 'DOW_AR'));
console.log('sample after  : ' + sample(fixed, 'DOW_AR'));

if (after.mojibake > 0) {
  console.error('\nstill damaged after the transform — not writing');
  process.exit(1);
}
if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); process.exit(0); }

fs.copyFileSync(file, file + '.mangled');
fs.writeFileSync(file, fixed, 'utf8');
console.log('\nrepaired: ' + file + '  (damaged copy kept as ' + file + '.mangled)');
