'use strict';
/*
 * Every Arabic text a person can read in the page source, as the fragments the screens are built from:
 * JS string literals split at their HTML tags, the static markup's own text, and title / placeholder /
 * aria-label values. Writes the fragments that src/i18n-en.json does not translate yet.
 *
 *   node tools/i18n-extract.js            → prints the count, writes tools/i18n-missing.json ({fragment: ""})
 */
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'src', 'daftar.html');
const DICT = path.join(__dirname, '..', 'src', 'i18n-en.json');
const ar = /[؀-ۿ]/;

function fragments() {
  const s = fs.readFileSync(SRC, 'utf8');
  const out = new Set();
  const add = (t) => {
    String(t).replace(/<[^>]*>/g, '\u0001').split('\u0001').forEach(f => {
      f = f.replace(/\\n/g, '\n');
      f.split('\n').forEach(g => {
        // the tail of one attribute and the head of the next (`">افتح`, `" aria-label="اسم الفرع">`) are not text
        g = g.replace(/[\w-]+="/g, '"').replace(/^["'>\s]+|["'<>\s]+$/g, '');
        g = g.replace(/\s+/g, ' ').trim();
        // the parts a number or a name is spliced between are separate fragments already
        if (ar.test(g) && g.length < 600) out.add(g);
      });
    });
  };
  // 1. JS string literals (single, double quotes)
  for (const m of s.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
    const v = m[1] != null ? m[1] : m[2];
    if (!ar.test(v)) continue;
    // a regular expression or a character class is code, not text
    if (/^\[.*\]$|\\u06|\[٠-٩\]/.test(v)) continue;
    add(v.replace(/\\'/g, "'").replace(/\\"/g, '"'));
  }
  // 2. the static markup outside the scripts and styles
  const html = s.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of html.matchAll(/>([^<>]+)</g)) if (ar.test(m[1])) add(m[1]);
  for (const m of html.matchAll(/(?:title|placeholder|aria-label|content)="([^"]+)"/g)) if (ar.test(m[1])) add(m[1]);
  // 3. regular-expression literals and comments are not text: drop what is obviously code
  return [...out].filter(f => !/^[/\\]|\\[sdwb]|^\/\*|^\/\//.test(f));
}

if (require.main === module) {
  const all = fragments();
  const dict = fs.existsSync(DICT) ? JSON.parse(fs.readFileSync(DICT, 'utf8')) : {};
  const missing = all.filter(f => !(f in dict));
  fs.writeFileSync(path.join(__dirname, 'i18n-missing.json'), JSON.stringify(Object.fromEntries(missing.map(f => [f, ''])), null, 1), 'utf8');
  console.log('fragments: ' + all.length + ' · translated: ' + (all.length - missing.length) + ' · missing: ' + missing.length);
}
module.exports = { fragments };
