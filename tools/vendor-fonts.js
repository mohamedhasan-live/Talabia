'use strict';
/*
 * Put the app's fonts inside the app, so they look the same with no internet:
 * IBM Plex Sans Arabic (all Arabic text and the UI), IBM Plex Mono (numbers) and
 * Archivo Black (the CHEZZZ wordmark). All three are SIL Open Font License fonts.
 *
 *   node tools/vendor-fonts.js        writes app/vendor/fonts/{*.woff2, fonts.css, OFL-*.txt}
 *
 * Run once (or to refresh); the build only copies what is already there.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'app', 'vendor', 'fonts');
const CSS_URL = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&family=Archivo+Black&display=swap';
// a current browser's user agent, so the stylesheet offers woff2
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const LICENSES = {
  'OFL-IBM-Plex-Sans-Arabic.txt': 'https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsansarabic/OFL.txt',
  'OFL-IBM-Plex-Mono.txt': 'https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/OFL.txt',
  'OFL-Archivo-Black.txt': 'https://raw.githubusercontent.com/google/fonts/main/ofl/archivoblack/OFL.txt'
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const css = await (await fetch(CSS_URL, { headers: { 'User-Agent': UA } })).text();
  if (!/@font-face/.test(css)) throw new Error('no @font-face in the stylesheet');
  let n = 0, bytes = 0, out = css;
  const urls = [...new Set([...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].map(m => m[1]))];
  for (const u of urls) {
    const name = path.basename(new URL(u).pathname);
    const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
    if (buf.length < 1000) throw new Error('font looks truncated: ' + u);
    fs.writeFileSync(path.join(OUT, name), buf);
    out = out.split(u).join(name);
    n++; bytes += buf.length;
  }
  fs.writeFileSync(path.join(OUT, 'fonts.css'),
    '/* IBM Plex Sans Arabic, IBM Plex Mono, Archivo Black — SIL Open Font License 1.1 (see OFL-*.txt). Embedded by tools/vendor-fonts.js. */\n' + out, 'utf8');
  for (const [file, url] of Object.entries(LICENSES)) {
    const t = await (await fetch(url)).text();
    if (!/Open Font License/i.test(t)) throw new Error('licence text not found: ' + url);
    fs.writeFileSync(path.join(OUT, file), t, 'utf8');
  }
  console.log('fonts  -> app/vendor/fonts: ' + n + ' woff2 files, ' + Math.round(bytes / 1024) + ' KB, fonts.css and 3 licences');
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
