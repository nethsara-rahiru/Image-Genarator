const SAMPLE = [
  { name: 'Ceylon Leaf Tea Co.', category: 'Food & Drink', city: 'Kandy', description: 'Single-estate black and green teas, packed by hand in the hill country.' },
  { name: 'Lanka Loom', category: 'Fashion', city: 'Colombo', description: 'Handloom sarongs, scarves and cushion covers woven by family workshops.' },
  { name: 'Spice Route Organics', category: 'Food & Drink', city: 'Matale', description: 'Cinnamon, pepper and cardamom grown without chemicals and sold in small batches.' },
  { name: 'Coir & Craft', category: 'Home & Living', city: 'Galle', description: 'Doormats, baskets and planters made from coconut coir.' },
  { name: 'Batik by Nilu', category: 'Fashion', city: 'Kandy', description: 'Hand-drawn batik dresses and wall art, made to order.' },
  { name: 'Serendib Print Studio', category: 'Services', city: 'Negombo', description: 'Business cards, labels and packaging printed in small runs for SMEs.' }
];

let activeCategory = 'All';
const grid = document.getElementById('grid');
const search = document.getElementById('search');
const chipBox = document.getElementById('chips');

let registered = [];
function allBusinesses() { return [...registered, ...SAMPLE]; }

function renderChips() {
  const cats = ['All', ...new Set(allBusinesses().map(b => b.category).filter(Boolean))];
  chipBox.innerHTML = cats.map(c => `<button class="chip" aria-pressed="${c === activeCategory}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
}

function renderGrid() {
  const q = search.value.trim().toLowerCase();
  const list = allBusinesses().filter(b =>
    (activeCategory === 'All' || b.category === activeCategory) &&
    (!q || `${b.name} ${b.description} ${b.city || ''}`.toLowerCase().includes(q)));
  grid.innerHTML = list.length ? list.map(b => `
    <article class="card">
      <div class="card-head">${logoHTML(b)}<div><h3>${esc(b.name)}</h3>
      <div class="meta">${esc(b.category || 'General')}${b.city ? ' · ' + esc(b.city) : ''}</div></div></div>
      <p>${esc(b.description)}</p>
      <button class="btn btn-ghost" data-contact="${esc(b.name)}">Contact seller</button>
    </article>`).join('') : '<p class="empty">No businesses match your search. Try another word or category.</p>';
}

chipBox.addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  activeCategory = c.dataset.cat; renderChips(); renderGrid();
  chipBox.querySelector('[aria-pressed="true"]')?.focus();
});
search.addEventListener('input', renderGrid);
grid.addEventListener('click', async e => {
  const b = e.target.closest('[data-contact]'); if (!b) return;
  if (!(await Auth.me())) { location.href = 'login.html'; return; }
  toast('Contact request for ' + b.dataset.contact + ' will be available once the backend is connected.');
});
renderChips(); renderGrid();
api('/businesses').then(r => { registered = r.businesses; renderChips(); renderGrid(); }).catch(() => {});
