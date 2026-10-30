/* =====================================================================
   The Stacks — script
   Reads the catalogue + events from a Google Sheet, and looks up covers
   and descriptions on Open Library (then Google Books as a fallback).
   ===================================================================== */

/* ---------- SETUP: edit this block only ---------- */
const CONFIG = {
  SHEET_ID: '19xw_V1NFzpNxLi7fkdB2ZjyBai-hmOd1S2hX6T991eQ',
  TABS: {
    kids:   'Catalogue Kids',
    adults: 'Catalogue Adults',
    events: 'Events'
  },
  USE_OPEN_LIBRARY: true,      // look up cover + info when a book is clicked
  USE_GOOGLE_BOOKS: true,      // second source, used only if Open Library has gaps
  PREFER_OPEN_LIBRARY: false,  // false = your sheet's values win, lookups only fill blanks
  GOOGLE_BOOKS_KEY: ''         // optional free API key
};

/* Column headers are matched ignoring case, spaces and punctuation. */
const COLUMNS = {
  title:       ['title', 'bookname', 'name', 'book'],
  author:      ['author', 'authors', 'writer'],
  year:        ['year', 'publishedyear', 'firstpublished', 'published'],
  isbn:        ['isbn', 'isbn13', 'isbn10'],
  cover:       ['cover', 'coverurl', 'image', 'imageurl', 'photo'],
  description: ['description', 'summary', 'about', 'blurb'],
  subjects:    ['subjects', 'subject', 'genre', 'genres', 'category', 'tags'],

  eventTitle:  ['title', 'event', 'eventname', 'name'],
  eventWhen:   ['when', 'datetime', 'schedule'],
  eventDate:   ['date', 'day'],
  eventTime:   ['time'],
  eventBlurb:  ['description', 'details', 'blurb', 'about']
};

/* Quotes shown on the home page */
const QUOTES = [
  { text: 'Today a reader, tomorrow a leader.',                        by: 'Margaret Fuller' },
  { text: 'Books are a uniquely portable magic.',                      by: 'Stephen King' },
  { text: 'A book is a dream that you hold in your hand.',             by: 'Neil Gaiman' },
  { text: 'Reading is to the mind what exercise is to the body.',      by: 'Joseph Addison' },
  { text: 'I have always imagined that Paradise will be a kind of library.', by: 'Jorge Luis Borges' },
  { text: 'Children are made readers on the laps of their parents.',   by: 'Emilie Buchwald' },
  { text: 'A room without books is like a body without a soul.',       by: 'attributed to Cicero' },
  { text: 'Once you learn to read, you will be forever free.',         by: 'attributed to Frederick Douglass' },
  { text: 'There is no friend as loyal as a book.',                    by: 'attributed to Ernest Hemingway' },
  { text: 'So many books, so little time.',                            by: 'Frank Zappa' }
];

/* ---------- page elements ---------- */
const bookSpread = document.getElementById('bookSpread');
const homePanel = document.getElementById('homePanel');
const listEl = document.getElementById('list-catalogue');
const eventsPanel = document.getElementById('eventsPanel');
const audienceSelect = document.getElementById('audienceSelect');
const catalogueSearch = document.getElementById('catalogueSearch');
const catalogueSearchBtn = document.getElementById('catalogueSearchBtn');
const quoteText = document.getElementById('quoteText');
const quoteAuthor = document.getElementById('quoteAuthor');
const quoteBtn = document.getElementById('quoteBtn');
const homeLink = document.getElementById('homeLink');

let currentAudience = 'kids';
const shelves = {
  kids:   { all: [], visible: [], loaded: false, error: null, selectedIndex: null, query: '' },
  adults: { all: [], visible: [], loaded: false, error: null, selectedIndex: null, query: '' }
};

/* Show any script error on screen instead of leaving "Loading…" forever */
window.addEventListener('error', e => {
  listEl.innerHTML = '<div class="list-status">Script error: ' + escapeHtml(e.message) + '</div>';
});

/* ---------- helpers ---------- */
function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function pick(row, names){
  for(const n of names){
    const v = row[n];
    if(v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/* Drive "share" links -> direct image links; normal URLs pass through */
function imageUrl(raw){
  if(!raw) return '';
  const m = raw.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || raw.match(/[?&]id=([\w-]+)/);
  if(raw.includes('drive.google.com') && m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w600`;
  return raw;
}

/* "Godaan (Premchand)" -> title "Godaan", author "Premchand".
   Brackets like "(Book 2)" or "(1998)" are left alone. */
function splitTitleAuthor(rawTitle, rawAuthor){
  let title = (rawTitle || '').trim();
  let author = (rawAuthor || '').trim();
  const m = title.match(/^(.*?)\s*[\(\[]([^\)\]]+)[\)\]]\s*$/);
  if(m){
    const inside = m[2].trim();
    const looksLikeAuthor = !/\d/.test(inside) && !/^(book|vol|volume|part|edition|ed|no|series)\b/i.test(inside);
    if(looksLikeAuthor){
      title = m[1].trim();
      if(!author) author = inside;
    }
  }
  author = author.replace(/^[\(\[]\s*|\s*[\)\]]$/g, '').trim();
  return { title, author };
}

/* Minimal CSV parser: handles quotes, commas and line breaks inside cells */
function parseCSV(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i + 1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if(c === '"') inQuotes = true;
    else if(c === ','){ row.push(field); field = ''; }
    else if(c === '\n' || c === '\r'){
      if(c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if(field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

async function fetchTab(tabName){
  if(!CONFIG.SHEET_ID || CONFIG.SHEET_ID.startsWith('PASTE_')) throw new Error('setup');

  const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);      // give up after 20 seconds
  let res;
  try{ res = await fetch(url, { signal: ctrl.signal }); }
  catch(e){ throw new Error('timeout'); }
  finally{ clearTimeout(timer); }

  if(!res.ok) throw new Error('http');
  const text = await res.text();
  if(text.trim().startsWith('<')) throw new Error('access'); // login page: sheet isn't shared

  const rows = parseCSV(text);
  if(rows.length < 2) return [];
  const headers = rows[0].map(norm);
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { if(h) obj[h] = r[i] != null ? r[i] : ''; });
    return obj;
  });
}

function errorMessage(err){
  const m = err && err.message;
  if(m === 'setup')   return 'Add your Google Sheet ID in the CONFIG block at the top of script.js.';
  if(m === 'access')  return 'The sheet isn’t shared. Set sharing to “Anyone with the link – Viewer”.';
  if(m === 'timeout') return 'The sheet took too long to respond. Check your connection and reload.';
  return 'Couldn’t load the sheet. Check the Sheet ID, the tab name and your connection.';
}

/* ---------- home + quotes ---------- */
let quoteIndex = Math.floor(Date.now() / 86400000) % QUOTES.length;   // a new quote each day

function showQuote(){
  const q = QUOTES[quoteIndex];
  quoteText.textContent = q.text;
  quoteAuthor.textContent = '— ' + q.by;
}

quoteBtn.addEventListener('click', () => {
  quoteIndex = (quoteIndex + 1) % QUOTES.length;
  showQuote();
});

function showHome(){
  const state = shelves[currentAudience];
  state.selectedIndex = null;
  highlightSelected(currentAudience);
  bookSpread.hidden = true;
  homePanel.hidden = false;
}

homeLink.addEventListener('click', showHome);
homeLink.addEventListener('keydown', e => {
  if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); showHome(); }
});

/* ---------- accordion ---------- */
document.querySelectorAll('.nav-item').forEach(item => {
  const header = item.querySelector('.nav-header');
  header.addEventListener('click', () => {
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.nav-item').forEach(i => {
      i.classList.remove('open');
      i.querySelector('.nav-header').setAttribute('aria-expanded', 'false');
    });
    if(!isOpen){
      item.classList.add('open');
      header.setAttribute('aria-expanded', 'true');
    }
  });
});

/* ---------- catalogue ---------- */
async function loadShelf(audience){
  const state = shelves[audience];
  try{
    const rows = await fetchTab(CONFIG.TABS[audience]);
    state.all = rows.map(r => {
      const { title, author } = splitTitleAuthor(pick(r, COLUMNS.title), pick(r, COLUMNS.author));
      return {
        title,
        author,
        year:        pick(r, COLUMNS.year),
        isbn:        pick(r, COLUMNS.isbn).replace(/[^0-9Xx]/g, ''),
        cover:       imageUrl(pick(r, COLUMNS.cover)),
        description: pick(r, COLUMNS.description),
        subjects:    pick(r, COLUMNS.subjects).split(/[,;|]/).map(s => s.trim()).filter(Boolean)
      };
    }).filter(b => b.title);
    state.loaded = true;
    state.error = null;
    applyFilter(audience);
  } catch(err){
    state.error = errorMessage(err);
  }
  if(audience === currentAudience) renderList(audience);
}

function applyFilter(audience){
  const state = shelves[audience];
  const q = state.query.trim().toLowerCase();
  state.visible = !q ? state.all.slice() : state.all.filter(b =>
    [b.title, b.author, b.subjects.join(' ')].join(' ').toLowerCase().includes(q)
  );
  state.selectedIndex = null;
}

function runSearch(){
  const state = shelves[currentAudience];
  state.query = catalogueSearch.value;
  applyFilter(currentAudience);
  renderList(currentAudience);
}

audienceSelect.addEventListener('change', () => {
  currentAudience = audienceSelect.value;
  const state = shelves[currentAudience];
  catalogueSearch.value = state.query;
  catalogueSearch.placeholder = currentAudience === 'kids' ? 'Search kids books…' : 'Search adult books…';
  renderList(currentAudience);
});
catalogueSearchBtn.addEventListener('click', runSearch);
catalogueSearch.addEventListener('keydown', e => { if(e.key === 'Enter') runSearch(); });

function renderList(audience){
  const state = shelves[audience];
  if(state.error){
    listEl.innerHTML = `<div class="list-status">${escapeHtml(state.error)}</div>`;
    return;
  }
  if(!state.loaded){
    listEl.innerHTML = `<div class="list-status">Loading shelf…</div>`;
    return;
  }
  if(state.visible.length === 0){
    listEl.innerHTML = `<div class="list-status">No books found.</div>`;
    return;
  }
  listEl.innerHTML = state.visible.map((book, i) => {
    const title = escapeHtml(book.title);
    const author = escapeHtml(book.author || 'Unknown author');
    const year = book.year ? ` · ${escapeHtml(book.year)}` : '';
    const letter = escapeHtml(book.title.charAt(0));
    const coverInner = book.cover
      ? `<img src="${escapeHtml(book.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-letter="${letter}" />`
      : letter;
    return `
      <div class="card" data-index="${i}" tabindex="0" role="button" aria-label="Open ${title}">
        <div class="card-cover">${coverInner}</div>
        <div class="card-text">
          <p class="card-title">${title}</p>
          <p class="card-meta">${author}${year}</p>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.card-cover img').forEach(img => {
    img.addEventListener('error', () => { img.parentElement.textContent = img.dataset.letter; });
  });
  listEl.querySelectorAll('.card').forEach(el => {
    const open = () => selectBook(audience, parseInt(el.dataset.index, 10));
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => {
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); open(); }
    });
  });
  highlightSelected(audience);
}

function highlightSelected(audience){
  const state = shelves[audience];
  listEl.querySelectorAll('.card').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.index, 10) === state.selectedIndex);
  });
}

/* ---------- Open Library ---------- */
function cleanDescription(d){
  if(!d) return '';
  let text = typeof d === 'string' ? d : (d.value || '');
  text = text.split(/\r?\n-{5,}/)[0];                          // drop "---- Contains:" footers
  text = text.replace(/\[([^\]]+)\]\[\d+\]/g, '$1').replace(/\(\[source\]\[\d+\]\)/gi, '');
  return text.trim();
}

async function lookupOpenLibrary(book){
  try{
    const q = new URLSearchParams({ limit: '1', fields: 'key,author_name,first_publish_year,cover_i,subject' });
    if(book.isbn) q.set('isbn', book.isbn);
    else{
      q.set('title', book.title);
      if(book.author) q.set('author', book.author);
    }
    const res = await fetch(`https://openlibrary.org/search.json?${q}`);
    if(!res.ok) return {};
    const doc = ((await res.json()).docs || [])[0];
    if(!doc) return {};

    const out = {
      cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '',
      year: doc.first_publish_year ? String(doc.first_publish_year) : '',
      author: (doc.author_name || [])[0] || '',
      subjects: (doc.subject || []).slice(0, 8),
      description: ''
    };
    if(doc.key){
      try{
        const w = await fetch(`https://openlibrary.org${doc.key}.json`);
        if(w.ok){
          const work = await w.json();
          out.description = cleanDescription(work.description);
          if(Array.isArray(work.subjects) && work.subjects.length) out.subjects = work.subjects.slice(0, 8);
        }
      } catch(e){ /* keep what we have */ }
    }
    return out;
  } catch(e){ return {}; }
}

/* ---------- Google Books (fallback) ---------- */
function stripHtml(html){
  if(!html) return '';
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n');
  return (new DOMParser().parseFromString(withBreaks, 'text/html').body.textContent || '').trim();
}

function imageLoads(url){
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 1);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

async function lookupGoogleBooks(book){
  const queries = [];
  if(book.isbn) queries.push({ q: `isbn:${book.isbn}`, strict: false });
  queries.push({ q: `intitle:${book.title}` + (book.author ? ` inauthor:${book.author}` : ''), strict: true });
  queries.push({ q: `intitle:${book.title}`, strict: true });
  queries.push({ q: `${book.title} ${book.author || ''}`.trim(), strict: true });

  const wanted = norm(book.title);
  const result = { description: '', cover: '', year: '', subjects: [] };

  for(const { q, strict } of queries){
    try{
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&printType=books`
        + (CONFIG.GOOGLE_BOOKS_KEY ? `&key=${CONFIG.GOOGLE_BOOKS_KEY}` : '');
      const res = await fetch(url);
      if(!res.ok) continue;
      const items = (await res.json()).items || [];
      const matches = items.filter(i => {
        if(!strict) return true;
        const t = norm(i.volumeInfo && i.volumeInfo.title);
        return t && (t.includes(wanted) || wanted.includes(t));
      });
      for(const item of matches){
        const v = item.volumeInfo;
        const img = v.imageLinks || {};
        if(!result.description && v.description) result.description = stripHtml(v.description);
        if(!result.cover && (img.thumbnail || img.smallThumbnail)){
          result.cover = (img.thumbnail || img.smallThumbnail).replace('http://', 'https://').replace('&edge=curl', '');
        }
        if(!result.year && v.publishedDate) result.year = v.publishedDate.slice(0, 4);
        if(!result.subjects.length && v.categories) result.subjects = v.categories.slice(0, 8);
      }
      if(result.description && result.cover) break;
    } catch(e){ /* try the next query */ }
  }
  return result;
}

/* Open Library first, then Google Books for whatever is still missing */
async function lookupDetails(book){
  const ol = await lookupOpenLibrary(book);
  if(!CONFIG.USE_GOOGLE_BOOKS || (ol.description && ol.cover)) return ol;

  const gb = await lookupGoogleBooks(book);
  let cover = ol.cover || gb.cover || '';
  if(!cover && book.isbn){
    const u = `https://covers.openlibrary.org/b/isbn/${book.isbn}-L.jpg?default=false`;
    if(await imageLoads(u)) cover = u;
  }
  return {
    ...ol,
    description: ol.description || gb.description || '',
    cover,
    year: ol.year || gb.year || '',
    subjects: (ol.subjects && ol.subjects.length) ? ol.subjects : (gb.subjects || [])
  };
}

/* ---------- open a book ---------- */
function merge(sheetVal, lookedUp){
  const empty = v => !v || (Array.isArray(v) && v.length === 0);
  if(CONFIG.PREFER_OPEN_LIBRARY) return empty(lookedUp) ? sheetVal : lookedUp;
  return empty(sheetVal) ? lookedUp : sheetVal;
}

function renderBook(book, found, loading){
  found = found || {};
  const title = escapeHtml(book.title);
  const authors = escapeHtml(book.author || found.author || 'Unknown author');
  const cover = merge(book.cover, found.cover);
  const year = merge(book.year, found.year);
  const subjects = merge(book.subjects, found.subjects) || [];
  let description = merge(book.description, found.description);
  if(!description) description = loading ? 'Looking for the story…' : 'No description available for this book yet.';

  const coverBlock = cover
    ? `<img src="${escapeHtml(cover)}" alt="Cover of ${title}" referrerpolicy="no-referrer" />`
    : `<span>${loading ? 'Finding the<br/>cover…' : 'No cover<br/>yet'}</span>`;
  const yearTag = year ? `<p class="tag">Published ${escapeHtml(year)}</p>` : '';
  const subjectsBlock = subjects.length
    ? `<div class="subjects">${subjects.slice(0, 8).map(s => `<span>${escapeHtml(s)}</span>`).join('')}</div>`
    : '';

  homePanel.hidden = true;
  bookSpread.hidden = false;
  bookSpread.innerHTML = `
    <div class="left-page">
      <div class="cover-art">${coverBlock}</div>
      ${yearTag}
    </div>
    <div class="right-page">
      <h2>${title}</h2>
      <p class="byline">${authors}</p>
      <hr class="rule" />
      <p class="description">${escapeHtml(description)}</p>
      ${subjectsBlock}
    </div>`;

  const img = bookSpread.querySelector('.cover-art img');
  if(img) img.addEventListener('error', () => { img.parentElement.innerHTML = '<span>No cover<br/>yet</span>'; });
}

async function selectBook(audience, index){
  const state = shelves[audience];
  state.selectedIndex = index;
  highlightSelected(audience);

  const book = state.visible[index];
  if(!book) return;

  if(window.matchMedia('(max-width: 860px)').matches){
    bookSpread.hidden = false;
    bookSpread.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  if(!CONFIG.USE_OPEN_LIBRARY){ renderBook(book, null, false); return; }

  // Show the sheet's info straight away, then upgrade it when the lookup answers
  renderBook(book, book.found || null, !book.found);
  if(book.found) return;                                       // already looked up once

  const found = await lookupDetails(book);
  book.found = found;

  // Only redraw if this book is still the one open
  if(audience === currentAudience && state.visible[state.selectedIndex] === book){
    renderBook(book, found, false);
  }
}

/* ---------- events ---------- */
async function loadEvents(){
  try{
    const rows = await fetchTab(CONFIG.TABS.events);
    const events = rows.map(r => {
      const when = pick(r, COLUMNS.eventWhen) ||
        [pick(r, COLUMNS.eventDate), pick(r, COLUMNS.eventTime)].filter(Boolean).join(' · ');
      return { title: pick(r, COLUMNS.eventTitle), when, blurb: pick(r, COLUMNS.eventBlurb) };
    }).filter(e => e.title);

    eventsPanel.innerHTML = events.length
      ? events.map(e => `
          <div class="event-entry">
            <p class="event-title">${escapeHtml(e.title)}</p>
            ${e.when ? `<p class="event-when">${escapeHtml(e.when)}</p>` : ''}
            ${e.blurb ? `<p class="event-blurb">${escapeHtml(e.blurb)}</p>` : ''}
          </div>`).join('')
      : `<div class="list-status">No upcoming events right now.</div>`;
  } catch(err){
    eventsPanel.innerHTML = `<div class="list-status">${escapeHtml(errorMessage(err))}</div>`;
  }
}

/* ---------- start ---------- */
showQuote();
loadShelf('kids');
loadShelf('adults');
loadEvents();
