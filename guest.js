// ─── STATE ────────────────────────────────────────────────────────────────────
let guestPeer     = null;
let hostConn      = null;
let guestName     = '';
let reqIdSeq      = 0;
let searchTimeout = null;
let latestQuery   = '';
let searchResults = [];
const myRequests  = [];

// ─── ELEMENTS ─────────────────────────────────────────────────────────────────
const nameScreen       = document.getElementById('nameScreen');
const joinScreen       = document.getElementById('joinScreen');
const connectingScreen = document.getElementById('connectingScreen');
const requestScreen    = document.getElementById('requestScreen');
const connectingMsg    = document.getElementById('connectingMsg');
const nameStatus       = document.getElementById('nameStatus');
const joinStatus       = document.getElementById('joinStatus');
const searchInput      = document.getElementById('searchInput');
const clearBtn         = document.getElementById('clearSearch');
const resultsEl        = document.getElementById('searchResults');
const searchHint       = document.getElementById('searchHint');
const searchStatus     = document.getElementById('searchStatus');
const myRequestsCard   = document.getElementById('myRequestsCard');
const myRequestsList   = document.getElementById('myRequestsList');
const queueCard        = document.getElementById('queueCard');
const nowPlayingRow    = document.getElementById('nowPlayingRow');
const nowPlayingItem   = document.getElementById('nowPlayingItem');
const queueList        = document.getElementById('queueList');
const queueEmpty       = document.getElementById('queueEmpty');

const sessionParam = new URLSearchParams(window.location.search).get('session');

// ─── NAME SCREEN ─────────────────────────────────────────────────────────────
// Pre-fill from sessionStorage if they've been here before
const savedName = sessionStorage.getItem('guest_name');
if (savedName) document.getElementById('nameInput').value = savedName;

document.getElementById('continueBtn').addEventListener('click', submitName);
document.getElementById('nameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitName();
});

function submitName() {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) { nameStatus.textContent = 'Enter your name to continue.'; return; }

  guestName = name;
  sessionStorage.setItem('guest_name', name);

  if (sessionParam) {
    showScreen(connectingScreen);
    initGuestPeer(sessionParam);
  } else {
    showScreen(joinScreen);
  }
}

// ─── MANUAL JOIN ──────────────────────────────────────────────────────────────
document.getElementById('joinBtn').addEventListener('click', () => {
  const raw = document.getElementById('codeInput').value.trim();
  if (!raw) { joinStatus.textContent = 'Paste the session link from your host.'; return; }

  let id = raw;
  try {
    const u = new URL(raw);
    id = u.searchParams.get('session') || raw;
  } catch (_) { /* bare ID */ }

  showScreen(connectingScreen);
  initGuestPeer(id);
});

// ─── PEERJS GUEST ─────────────────────────────────────────────────────────────
function initGuestPeer(hostId) {
  connectingMsg.textContent = 'Connecting to host…';
  guestPeer = new Peer();

  guestPeer.on('open', () => {
    hostConn = guestPeer.connect(hostId, { reliable: true });

    hostConn.on('open', () => {
      // Send our name as soon as the channel is open
      hostConn.send({ type: 'hello', name: guestName });
    });

    hostConn.on('data', handleHostMessage);

    hostConn.on('close', () => {
      searchStatus.innerHTML = '<span class="error">Lost connection to host.</span>';
    });

    hostConn.on('error', err => {
      connectingMsg.innerHTML = `<span class="error">Could not connect: ${err.message || 'unknown error'}.</span>`;
    });
  });

  guestPeer.on('error', err => {
    const msg = err.type === 'peer-unavailable'
      ? 'Host session not found — it may have ended. Ask your host for a new link.'
      : `Connection error: ${err.message || err.type}`;
    connectingMsg.innerHTML = `<span class="error">${msg}</span>`;
  });
}

// ─── HOST MESSAGES ────────────────────────────────────────────────────────────
function handleHostMessage(data) {
  if (data.type === 'connected') {
    document.getElementById('sessionLabel').textContent = `Joined as ${guestName} · Request a song.`;
    showScreen(requestScreen);
    searchInput.focus();
    return;
  }

  if (data.type === 'search_results') {
    if (data.query === latestQuery) renderResults(data.results);
    return;
  }

  if (data.type === 'queue_update') {
    renderQueue(data.nowPlaying, data.queue);
    return;
  }

  const req = myRequests.find(r => r.id === data.id);
  if (!req) return;

  if      (data.type === 'ack')      req.status = 'pending';
  else if (data.type === 'added')    req.status = 'added';
  else if (data.type === 'declined') req.status = 'declined';

  renderMyRequests();
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  clearBtn.classList.toggle('hidden', !q);

  if (!q) {
    clearTimeout(searchTimeout);
    latestQuery = '';
    hideResults();
    searchHint.classList.remove('hidden');
    return;
  }

  searchHint.classList.add('hidden');
  if (q.length < 2) return;

  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    if (!hostConn?.open) {
      searchStatus.innerHTML = '<span class="error">Not connected to host.</span>';
      return;
    }
    latestQuery = q;
    searchStatus.textContent = 'Searching…';
    hostConn.send({ type: 'search', query: q });
  }, 350);
});

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearBtn.classList.add('hidden');
  latestQuery = '';
  hideResults();
  searchHint.classList.remove('hidden');
  searchStatus.textContent = '';
  searchInput.focus();
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-card')) hideResults();
});

searchInput.addEventListener('focus', () => {
  if (searchResults.length) renderResults(searchResults);
});

function hideResults() {
  resultsEl.classList.add('hidden');
  searchResults = [];
}

function renderResults(tracks) {
  searchStatus.textContent = '';
  searchResults = tracks;

  if (!tracks.length) {
    resultsEl.innerHTML = '<li class="result-empty">No results found.</li>';
    resultsEl.classList.remove('hidden');
    return;
  }

  resultsEl.innerHTML = tracks.map((t, i) => `
    <li class="search-result-item" role="option" data-idx="${i}">
      ${t.artUrl
        ? `<img class="result-art" src="${escHtml(t.artUrl)}" alt="" />`
        : `<div class="result-art result-art-placeholder"></div>`}
      <div class="result-info">
        <strong>${escHtml(t.title)}</strong>
        <span>${escHtml(t.artist)}<span class="result-album"> · ${escHtml(t.album)}</span></span>
      </div>
    </li>
  `).join('');

  resultsEl.classList.remove('hidden');
}

resultsEl.addEventListener('click', e => {
  const item = e.target.closest('.search-result-item');
  if (!item) return;
  const track = searchResults[Number(item.dataset.idx)];
  if (track) requestTrack(track);
});

// ─── SEND REQUEST ─────────────────────────────────────────────────────────────
function requestTrack(track) {
  if (!hostConn?.open) {
    searchStatus.innerHTML = '<span class="error">Not connected to host.</span>';
    return;
  }

  const id = ++reqIdSeq;
  myRequests.unshift({ id, track, status: 'sending' });
  renderMyRequests();

  hostConn.send({ type: 'song_request', id, track });

  searchInput.value = '';
  clearBtn.classList.add('hidden');
  latestQuery = '';
  hideResults();
  searchHint.classList.remove('hidden');
  searchStatus.textContent = '';
}

// ─── MY REQUESTS ─────────────────────────────────────────────────────────────
function renderMyRequests() {
  myRequestsCard.style.display = myRequests.length ? '' : 'none';

  const statusHtml = {
    sending:  '<span class="req-status sending">Sending…</span>',
    pending:  '<span class="req-status pending">Pending</span>',
    added:    '<span class="req-status added">Added ✓</span>',
    declined: '<span class="req-status declined">Declined</span>',
  };

  myRequestsList.innerHTML = myRequests.map(r => `
    <li class="request-item">
      ${r.track.artUrl ? `<img class="q-art" src="${escHtml(r.track.artUrl)}" alt="" />` : ''}
      <div class="request-info">
        <strong>${escHtml(r.track.title)}</strong>
        <span>${escHtml(r.track.artist)}</span>
      </div>
      ${statusHtml[r.status] || ''}
    </li>
  `).join('');
}

// ─── QUEUE DISPLAY ───────────────────────────────────────────────────────────
function renderQueue(nowPlaying, queue) {
  const hasAnything = nowPlaying || (queue && queue.length > 0);
  queueCard.style.display = hasAnything ? '' : 'none';

  if (nowPlaying) {
    nowPlayingRow.classList.remove('hidden');
    nowPlayingItem.innerHTML = trackHtml(nowPlaying, true);
  } else {
    nowPlayingRow.classList.add('hidden');
    nowPlayingItem.innerHTML = '';
  }

  if (queue && queue.length) {
    queueEmpty.classList.add('hidden');
    queueList.innerHTML = queue.map(t => `<li class="request-item queue-item">${trackHtml(t, false)}</li>`).join('');
  } else {
    queueEmpty.classList.remove('hidden');
    queueList.innerHTML = '';
  }
}

function trackHtml(t, isNowPlaying) {
  const art = t.artUrl
    ? `<img class="q-art${isNowPlaying ? ' q-art-np' : ''}" src="${escHtml(t.artUrl)}" alt="" />`
    : `<div class="q-art${isNowPlaying ? ' q-art-np' : ''}"></div>`;
  return `
    ${art}
    <div class="request-info">
      <strong>${escHtml(t.title)}</strong>
      <span>${escHtml(t.artist)}</span>
    </div>
  `;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function showScreen(el) {
  [nameScreen, joinScreen, connectingScreen, requestScreen].forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
