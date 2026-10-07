'use strict';
/*
 * Electron "fuses": switches baked into the program file that turn off ways of
 * running arbitrary code through it. Flipped here, after packaging and before
 * the installer is made, with no extra dependency:
 *
 *   RunAsNode                        off  — Talabia.exe cannot be used as a plain Node.js
 *   EnableNodeOptionsEnvironmentVar  off  — NODE_OPTIONS cannot inject code at start-up
 *   EnableNodeCliInspectArguments    off  — --inspect cannot attach a debugger to it
 *   EnableCookieEncryption           on
 *   OnlyLoadAppFromAsar              on   — only the packaged app.asar is loaded
 *
 * The fuse wire is a sentinel string followed by a version byte, a length byte
 * and one byte per fuse ('0' off, '1' on). Anything unexpected aborts the build
 * rather than guessing.
 */
const fs = require('fs');
const path = require('path');

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const WANT = { 0: '0', 1: '1', 2: '0', 3: '0', 5: '1' };
const NAMES = ['RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges'];

function flip(exe) {
  const buf = fs.readFileSync(exe);
  const at = buf.indexOf(SENTINEL);
  if (at < 0) throw new Error('fuse wire not found in ' + exe);
  if (buf.indexOf(SENTINEL, at + 1) >= 0) throw new Error('fuse wire found twice in ' + exe);
  const ver = buf[at + SENTINEL.length], len = buf[at + SENTINEL.length + 1];
  if (ver !== 1 || len < 6 || len > 32) throw new Error('unexpected fuse wire v' + ver + ' len ' + len);
  const start = at + SENTINEL.length + 2;
  const out = [];
  for (const i of Object.keys(WANT).map(Number)) {
    const cur = String.fromCharCode(buf[start + i]);
    if (cur !== '0' && cur !== '1') throw new Error('fuse ' + NAMES[i] + ' is "' + cur + '", not a switch');
    buf[start + i] = WANT[i].charCodeAt(0);
    out.push(NAMES[i] + '=' + WANT[i]);
  }
  fs.writeFileSync(exe, buf);
  return out;
}

module.exports = async function afterPack(context) {
  const info = context.packager.appInfo;
  const plat = context.electronPlatformName;
  const exe = plat === 'win32' ? path.join(context.appOutDir, info.productFilename + '.exe')
    : plat === 'darwin' ? path.join(context.appOutDir, info.productFilename + '.app', 'Contents', 'MacOS', info.productFilename)
    : path.join(context.appOutDir, context.packager.executableName || info.productFilename.toLowerCase());
  const done = flip(exe);
  console.log('  • fuses   ' + done.join(' '));
};
module.exports.flip = flip;
