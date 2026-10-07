'use strict';
/*
 * Signing in to Supabase (GoTrue) for the cloud sync.
 *
 * The anon key that ships inside the program is public by design: on its own
 * it can do nothing, because the table only answers signed-in members (see
 * the SQL in cloud.js). What unlocks the data is a member's session:
 *
 *  - the password is sent once, to Supabase, and never stored;
 *  - the refresh token is kept on disk encrypted by Windows for this user
 *    (Electron safeStorage / DPAPI) — another Windows account, or a copy of the
 *    file on another computer, cannot read it;
 *  - the short-lived access token lives in memory only.
 */
const fs = require('fs');

function makeAuth({ url, key, file, safeStorage, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const base = String(url || '').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  let session = null;       // { access, exp, refresh, email, userId }
  let lastEmail = null;     // kept even when a session ends, to fill the sign-in form
  let refreshing = null;

  function canEncrypt() {
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; }
  }
  function persist() {
    if (!file) return;
    try {
      if (!session && !lastEmail) { if (fs.existsSync(file)) fs.unlinkSync(file); return; }
      if (!canEncrypt()) return;                     // never write a token in the clear
      const blob = safeStorage.encryptString(JSON.stringify(session
        ? { refresh: session.refresh, email: session.email, userId: session.userId, base }
        : { refresh: null, email: lastEmail, base }));
      fs.writeFileSync(file, blob);
    } catch (e) { /* a lost session only means signing in again */ }
  }
  /*
   * Windows encryption only becomes available once Electron is ready, which is
   * after this module is created. Reading the saved session at creation time
   * found it "unavailable" and silently started signed out on every launch, so
   * the read now waits for the first moment the session is actually needed.
   */
  let restored = false;
  function ensureRestored() {
    if (restored || session) { restored = true; return; }
    if (!file || !canEncrypt()) return;          // not ready yet: try again next time
    restored = true;
    restore();
  }
  function restore() {
    if (!file || !canEncrypt()) return;
    try {
      if (!fs.existsSync(file)) return;
      const s = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      if (s && s.base === base) {
        lastEmail = s.email || null;
        if (s.refresh) session = { access: null, exp: 0, refresh: s.refresh, email: s.email, userId: s.userId };
      }
    } catch (e) { /* unreadable (other user / other machine): start signed out */ }
  }
  async function call(path, body, bearer) {
    const res = await doFetch(base + '/auth/v1/' + path, {
      method: 'POST',
      headers: Object.assign({ apikey: key, 'Content-Type': 'application/json' }, bearer ? { Authorization: 'Bearer ' + bearer } : {}),
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
    return { ok: res.ok, status: res.status, json };
  }
  function take(j) {
    session = {
      access: j.access_token, exp: Date.now() + Math.max(30, (+j.expires_in || 3600) - 60) * 1000,
      refresh: j.refresh_token, email: j.user && j.user.email, userId: j.user && j.user.id
    };
    lastEmail = session.email || lastEmail;
    persist();
  }

  async function signIn(email, password) {
    restored = true;
    email = String(email || '').trim().toLowerCase();
    if (!email || !password) return { ok: false, reason: 'missing' };
    try {
      const r = await call('token?grant_type=password', { email, password });
      if (!r.ok) {
        const msg = (r.json && (r.json.error_description || r.json.msg || r.json.message)) || ('HTTP ' + r.status);
        return { ok: false, reason: r.status === 400 || r.status === 401 ? 'credentials' : 'http', error: msg };
      }
      take(r.json);
      return { ok: true, email: session.email };
    } catch (e) {
      const c = e && e.cause && e.cause.cause;
      return { ok: false, reason: 'net', error: String(e.message || e) + (c && c.code ? ' [' + c.code + ']' : '') };
    }
  }

  async function refresh() {
    ensureRestored();
    if (!session || !session.refresh) return false;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const r = await call('token?grant_type=refresh_token', { refresh_token: session.refresh });
        if (r.ok && r.json && r.json.access_token) { take(r.json); return true; }
        // Only a definite "this session no longer exists" from Supabase ends it:
        // the account was deleted, or it was revoked on the server. Being offline,
        // a server error or a rate limit never signs anyone out; the session waits.
        const code = String((r.json && (r.json.error_code || r.json.error)) || '');
        if ((r.status === 400 || r.status === 401 || r.status === 403) &&
            /refresh_token_not_found|invalid_grant|session_not_found|user_not_found|user_banned/.test(code)) {
          session = null; persist();
        }
        return false;
      } catch (e) { return false; }                // offline: keep the session for later
      finally { refreshing = null; }
    })();
    return refreshing;
  }

  /** A valid access token, refreshed when close to expiry; null when signed out. */
  async function token() {
    ensureRestored();
    if (!session) return null;
    if (session.access && Date.now() < session.exp) return session.access;
    return (await refresh()) ? session.access : null;
  }

  async function signOut() {
    const s = session;
    session = null; persist();
    // scope=local: signing out here must not sign the same account out on other devices
    if (s && s.access) { try { await call('logout?scope=local', {}, s.access); } catch (e) { /* offline: the local sign-out stands */ } }
    return { ok: true };
  }

  return {
    signIn, signOut, token, refresh,
    state: () => { ensureRestored(); return { signedIn: !!session, email: session ? session.email : null, lastEmail, stored: canEncrypt() }; },
    invalidate: () => { if (session) { session.access = null; session.exp = 0; } }
  };
}

module.exports = { makeAuth };
