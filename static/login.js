/* Sign-in / first-run page. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let setup = false, minPassword = 10;

  // small animated desk scene, same style as the office
  const cv = $('login-scene'), c = cv.getContext('2d'); c.imageSmoothingEnabled = false;
  const F = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  let f = 0;
  function scene() {
    f++;
    F(0, 0, 176, 112, '#2b3049'); F(0, 36, 176, 76, '#8b5a38');
    for (let y = 36; y < 112; y += 16) { F(0, y, 176, 1, '#6b4227'); for (let x = (y / 16) % 2 * 24; x < 176; x += 48) F(x, y, 1, 16, '#6b4227'); }
    F(0, 33, 176, 3, '#3a4062');
    // shelf, clock, plant
    F(10, 6, 48, 24, '#5e3a20'); F(12, 8, 44, 20, '#7a4c2a'); F(12, 18, 44, 2, '#4c2e18');
    ['#c43b3b', '#3b6bc4', '#3ba05a', '#e0b83b', '#e07a3b', '#8a4bb8', '#e8e8e8', '#2a8a8a', '#c43b3b', '#3b6bc4'].forEach((col, i) => { F(14 + i * 4, 10 + (i % 3), 3, 8 - (i % 3), col); F(14 + i * 4, 21 + (i % 2), 3, 7 - (i % 2), col); });
    c.fillStyle = '#c43b3b'; c.beginPath(); c.arc(88, 18, 8, 0, Math.PI * 2); c.fill(); c.fillStyle = '#f4f4f4'; c.beginPath(); c.arc(88, 18, 6, 0, Math.PI * 2); c.fill(); F(88, 13, 1, 5, '#222'); F(88, 18, 4, 1, '#222');
    F(150, 22, 12, 8, '#8b5e3c'); F(148, 20, 16, 3, '#a06e44'); F(150, 6, 12, 14, '#2f7a3f'); F(146, 10, 6, 6, '#3a8f4a'); F(160, 10, 6, 6, '#3a8f4a'); F(154, 4, 6, 4, '#3a8f4a');
    // desk + monitor
    const dx = 56, dy = 60;
    F(dx + 4, dy + 22, 5, 10, '#3a3a4a'); F(dx + 61, dy + 22, 5, 10, '#3a3a4a');
    F(dx, dy + 6, 70, 16, '#c9a56b'); F(dx, dy + 20, 70, 5, '#a67c4a'); F(dx, dy + 6, 70, 2, '#dcbb84');
    F(dx + 24, dy - 12, 22, 18, '#d9d9d9'); F(dx + 26, dy - 10, 18, 13, '#2f5f4d');
    for (let i = 0; i < 5; i++) F(dx + 28, dy - 8 + i * 2, 4 + ((f >> 3) + i) % 9, 1, '#7fd6a0');
    F(dx + 33, dy + 6, 4, 3, '#444'); F(dx + 24, dy + 12, 22, 4, '#e4e4e4'); F(dx + 52, dy + 12, 5, 4, '#e4e4e4');
    // character at the desk, facing the screen, typing
    const x = dx + 27, y = dy + 18, skin = '#e6b894', hair = '#3b2418', shirt = '#4a9a6a';
    F(x + 3, y + 18, 10, 2, 'rgba(0,0,0,0.2)');
    F(x + 3, y + 9, 10, 6, shirt); F(x + 2, y + 10, 2, 4, shirt); F(x + 12, y + 10, 2, 4, shirt);
    const b = (f >> 2) & 1; F(x + 1, y + 8 - b, 3, 2, skin); F(x + 12, y + 8 - (1 - b), 3, 2, skin);
    F(x + 4, y + 6, 8, 3, skin); F(x + 4, y + 1, 8, 2, hair); F(x + 3, y + 2, 10, 6, hair); F(x + 3, y + 5, 2, 4, hair); F(x + 11, y + 5, 2, 4, hair);
    F(x + 5, y + 2, 3, 1, 'rgba(255,255,255,0.18)');
    // chair back
    F(x - 1, y + 14, 18, 3, '#5a3418');
    requestAnimationFrame(() => setTimeout(scene, 90));
  }
  scene();

  fetch('/api/auth/status').then(r => r.json()).then(s => {
    if (!s.enabled || s.authenticated) { location.href = '/'; return; }
    setup = !s.configured; minPassword = s.min_password || 10;
    if (setup) {
      $('heading').textContent = 'Create the account';
      $('intro').textContent = `No account exists yet. Choose a username and a password of at least ${minPassword} characters; everyone who opens this address will need them.`;
      $('confirm-row').hidden = false; $('go').textContent = 'Create account'; $('pw').autocomplete = 'new-password';
      if (s.setup_needs_token) $('token-row').hidden = false;
    }
    $('foot').textContent = location.host;
  }).catch(() => { $('err').textContent = 'The server did not answer. Is Agent-Master running?'; });

  document.addEventListener('keydown', e => { if (typeof e.getModifierState === 'function') $('caps').hidden = !e.getModifierState('CapsLock'); });

  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    const username = $('user').value.trim(), pw = $('pw').value, err = $('err'), go = $('go');
    err.textContent = '';
    if (!username) { err.textContent = 'Enter a username.'; $('user').focus(); return; }
    if (!pw) { err.textContent = 'Enter the password.'; $('pw').focus(); return; }
    if (setup) {
      if (pw.length < minPassword) { err.textContent = `Use at least ${minPassword} characters for the password.`; return; }
      if (pw !== $('pw2').value) { err.textContent = 'Passwords do not match.'; return; }
    }
    go.disabled = true; go.textContent = setup ? 'Creating…' : 'Signing in…';
    const payload = { username, password: pw };
    if (setup && !$('token-row').hidden) payload.setup_token = $('token').value.trim();
    try {
      const r = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { location.href = '/'; return; }
      err.textContent = d.error || 'Sign in failed.';
    } catch (ex) { err.textContent = 'Could not reach the server.'; }
    go.disabled = false; go.textContent = setup ? 'Create account' : 'Sign in';
  });
})();
