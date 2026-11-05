const $ = id => document.getElementById(id);

(async () => {
  const user = await Auth.me();
  if (!user) { location.replace('login.html'); return; }

  $('hello').textContent = `Welcome, ${user.name.split(' ')[0]}`;

  /* account details */
  const acc = $('accountForm');
  acc.elements['name'].value = user.name;
  acc.elements['email'].value = user.email;
  acc.elements['phone'].value = user.phone || '';
  acc.addEventListener('submit', async e => {
    e.preventDefault();
    const name = acc.elements['name'].value.trim(), phone = acc.elements['phone'].value.trim();
    $('accNameErr').textContent = name.length >= 2 ? '' : 'Enter your full name.';
    $('accPhoneErr').textContent = !phone || /^\+?[0-9\s-]{7,15}$/.test(phone) ? '' : 'Enter a valid phone number.';
    if ($('accNameErr').textContent || $('accPhoneErr').textContent) return;
    try {
      Auth._me = (await api('/account', { method: 'PATCH', body: { name, phone } })).user;
      $('hello').textContent = `Welcome, ${Auth._me.name.split(' ')[0]}`;
      toast('Account details saved.');
    } catch (err) { toast(err.message); }
  });

  /* setup overview + post approval (business owners) */
  if (user.role !== 'owner') { $('overview').hidden = true; $('notOwner').hidden = false; return; }
  $('approval').hidden = false; initApproval();
  let profile = null;
  try { profile = (await api('/profile')).profile; } catch { /* show as not set up */ }
  $('overview').innerHTML = `
    <div class="card"><h3>Business profile</h3>
      ${profile ? `<div class="card-head">${logoHTML(profile)}<div><strong>${esc(profile.name)}</strong><div class="meta">${esc(profile.category || 'General')}${profile.city ? ' · ' + esc(profile.city) : ''}</div></div></div>`
                : '<p>Not set up yet. Add your name, logo and description so buyers can find you.</p>'}
      <a class="btn btn-ghost" href="business.html">${profile ? 'Edit' : 'Set up'} business profile</a></div>
    <div class="card"><h3>Post preferences</h3><p>${esc(prefsSummary(user.preferences))}</p>
      <a class="btn btn-ghost" href="preferences.html">Edit preferences</a></div>
    <div class="card"><h3>Marketplace</h3><p>See how businesses appear to customers.</p>
      <a class="btn btn-ghost" href="index.html#marketplace">Open marketplace</a></div>`;
})();

/* ---------- post approval ---------- */
function initApproval() {
  const area = $('postArea');
  let editing = false, posts = [];
  const badge = s => s === 'approved' ? '<span class="badge ok">Approved</span>' : '<span class="badge no">Skipped</span>';

  function render() {
    const draft = posts.find(p => p.status === 'draft');
    const past = posts.filter(p => p.status !== 'draft').slice(0, 5);
    let html = '';
    if (draft) {
      html += `<div class="post-card"><div class="top"><span>Posting to: ${esc((draft.platforms || []).join(', ') || 'no platform chosen')}</span><span class="badge">Waiting for you</span></div>
        ${editing ? `<textarea id="editText" rows="5" maxlength="800">${esc(draft.text)}</textarea>
          <div class="draft-actions"><button class="btn btn-primary" data-act="save">Save changes</button><button class="btn btn-ghost" data-act="cancel">Cancel</button></div>`
        : `<p class="text">${esc(draft.text)}</p>
          <div class="draft-actions"><button class="btn btn-primary" data-act="approve">Approve and post</button><button class="btn btn-ghost" data-act="edit">Edit</button><button class="btn btn-ghost" data-act="skip">Skip</button></div>`}</div>`;
    } else {
      html += `<p class="hint" style="margin-top:0">No posts are waiting for your approval.</p><button class="btn btn-primary" data-act="new">Create a draft post</button>`;
    }
    if (past.length) html += `<ul class="post-list">${past.map(p => `<li>${badge(p.status)}<span class="t">${esc(p.text)}</span></li>`).join('')}</ul>`;
    area.innerHTML = html;
  }

  async function load() { try { posts = (await api('/posts')).posts; } catch (err) { toast(err.message); } render(); }

  area.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, draft = posts.find(p => p.status === 'draft');
    try {
      if (act === 'edit') { editing = true; render(); return; }
      if (act === 'cancel') { editing = false; render(); return; }
      if (act === 'new') { await api('/posts/draft', { method: 'POST' }); toast('Draft created. Review it below.'); }
      if (act === 'save') { await api('/posts/' + draft._id, { method: 'PATCH', body: { text: $('editText').value } }); editing = false; toast('Changes saved.'); }
      if (act === 'approve') { await api('/posts/' + draft._id, { method: 'PATCH', body: { status: 'approved' } }); toast('Post approved.'); }
      if (act === 'skip') { await api('/posts/' + draft._id, { method: 'PATCH', body: { status: 'rejected' } }); toast('Post skipped.'); }
      await load();
    } catch (err) { toast(err.message); await load(); }
  });
  load();
}
