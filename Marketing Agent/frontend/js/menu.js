/* Hamburger menu: add data-menu to <body> on any page that should have it */
(function () {
  if (!document.body.hasAttribute('data-menu')) return;
  const wrap = document.querySelector('.site-header .wrap');
  const brand = wrap.querySelector('.brand');

  const btn = document.createElement('button');
  btn.className = 'menu-btn'; btn.type = 'button';
  btn.setAttribute('aria-label', 'Open menu'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'drawer');
  btn.innerHTML = '<span></span><span></span><span></span>';
  const group = document.createElement('div'); group.className = 'brand-group';
  brand.replaceWith(group); group.append(btn, brand);

  const page = location.pathname.split('/').pop() || 'index.html';
  const items = [
    ['Home', 'index.html', false],
    ['Dashboard', 'dashboard.html', false],
    ['Business profile', 'business.html', true],
    ['Post preferences', 'preferences.html', true],
    ['Settings', 'settings.html', false, 'last']
  ];
  const overlay = document.createElement('div'); overlay.className = 'drawer-overlay'; overlay.hidden = true;
  const drawer = document.createElement('aside'); drawer.className = 'drawer'; drawer.id = 'drawer'; drawer.setAttribute('aria-label', 'Menu');
  drawer.innerHTML = `<div class="drawer-head"><span>Menu</span><button class="drawer-close" type="button" aria-label="Close menu">&times;</button></div>
    <nav>${items.map(([label, href, owner, cls]) => {
      const current = (href === page) ? ' aria-current="page"' : '';
      return `<a href="${href}"${current}${owner ? ' data-owner' : ''}${cls ? ` class="${cls}"` : ''}>${label}</a>`;
    }).join('')}</nav>`;
  document.body.append(overlay, drawer);

  function open() { drawer.classList.add('open'); overlay.hidden = false; btn.setAttribute('aria-expanded', 'true'); drawer.querySelector('a:not([hidden])').focus(); }
  function close() { drawer.classList.remove('open'); overlay.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  btn.addEventListener('click', () => (drawer.classList.contains('open') ? close() : open()));
  overlay.addEventListener('click', close);
  drawer.querySelector('.drawer-close').addEventListener('click', () => { close(); btn.focus(); });
  drawer.addEventListener('click', e => { if (e.target.closest('a')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('open')) { close(); btn.focus(); } });

  // business-only items are hidden for customer / B2B accounts
  Auth.me().then(u => { if (u && u.role !== 'owner') drawer.querySelectorAll('[data-owner]').forEach(a => { a.hidden = true; }); });
})();
