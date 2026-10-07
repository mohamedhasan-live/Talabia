'use strict';
/* List the lines whose Arabic was destroyed, so they can be rewritten precisely. */
const fs = require('fs');
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split('\n');
const MOJIBAKE = /Ø[\u0080-¿]|Ù[\u0080-¿]|â€”/;
let n = 0;
lines.forEach((l, i) => {
  if (!MOJIBAKE.test(l)) return;
  n++;
  console.log(String(i + 1).padStart(4) + ': ' + l.trim().slice(0, 150));
});
console.log('\n' + n + ' damaged lines of ' + lines.length);
