(async () => {
  const user = await Auth.me();
  if (!user) { location.replace('login.html'); return; }
  const setErr = (form, name, msg) => { form.querySelector(`[data-err="${name}"]`).textContent = msg || ''; return !msg; };

  /* theme */
  const saved = localStorage.getItem('ma_theme') || 'system';
  document.querySelectorAll('input[name=theme]').forEach(r => {
    r.checked = r.value === saved;
    r.addEventListener('change', () => { localStorage.setItem('ma_theme', r.value); applyTheme(r.value); toast('Theme updated.'); });
  });

  /* change password */
  const pw = document.getElementById('pwForm');
  pw.addEventListener('submit', async e => {
    e.preventDefault();
    const cur = pw.elements['current'].value, next = pw.elements['next'].value, conf = pw.elements['confirm'].value;
    const valid = [setErr(pw, 'current', cur ? '' : 'Enter your current password.'),
                   setErr(pw, 'next', next.length >= 8 ? '' : 'Use at least 8 characters.'),
                   setErr(pw, 'confirm', conf === next ? '' : 'Passwords do not match.')].every(Boolean);
    if (!valid) return;
    try { await api('/account/password', { method: 'POST', body: { currentPassword: cur, newPassword: next } }); pw.reset(); toast('Password changed.'); }
    catch (err) { setErr(pw, 'current', err.message); }
  });

  /* delete account */
  const del = document.getElementById('delForm');
  del.addEventListener('submit', async e => {
    e.preventDefault();
    const password = del.elements['password'].value;
    if (!setErr(del, 'password', password ? '' : 'Enter your password.')) return;
    if (!confirm('Delete your account and business profile permanently?')) return;
    try { await api('/account', { method: 'DELETE', body: { password } }); location.href = 'index.html'; }
    catch (err) { setErr(del, 'password', err.message); }
  });
})();
