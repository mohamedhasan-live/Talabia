'use strict';
/*
 * Kill app processes left behind by an earlier test run.
 *
 * This matters more than it looks. A portable .exe unpacks itself into %TEMP%
 * and runs from there, so killing the launcher leaves the real process alive,
 * still holding its --remote-debugging-port. The next run then connects to the
 * OLD instance — which is reading a previous run's scratch folder — and reports
 * failures that have nothing to do with the code under test.
 *
 * Only processes started by a test are killed: a test always passes
 * --user-data-dir, and the shop's own app never does. So an app the owner has
 * open on this machine is left alone.
 */
const { execFileSync } = require('child_process');

const PS = [
  "Get-CimInstance Win32_Process |",
  "  Where-Object { $_.Name -match '^(CANEL|CHEZZZ|Daftar|Talabia)' -and $_.CommandLine -match 'user-data-dir' } |",
  "  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
].join(' ');

function killOrphans() {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS],
      { stdio: 'ignore', timeout: 30000 });
  } catch (e) { /* nothing to kill, or powershell unavailable */ }
}

module.exports = { killOrphans };
