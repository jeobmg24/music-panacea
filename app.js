// ─── CREDENTIALS (from config.js) ────────────────────────────────────────────
const SPOTIFY_CLIENT_ID    = CONFIG.SPOTIFY_CLIENT_ID;
const SPOTIFY_REDIRECT_URI = window.location.origin + '/host.html';
const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'streaming',
].join(' ');

// ─── STATE ────────────────────────────────────────────────────────────────────
let spotifyToken     = null;
let hostPeer         = null;
let sessionCode      = null;
let requestIdSeq     = 0;
let autoAccept       = false;
let queuePollTimer   = null;
const pendingRequests = []; // { id, guestReqId, track, conn, guestName }
const addedTracks     = []; // { track, guestName }
const guestConns      = new Set(); // all active guest DataConnections

// ─── ELEMENTS ─────────────────────────────────────────────────────────────────
const signInScreen     = document.getElementById('signInScreen');
const hostDashboard    = document.getElementById('hostDashboard');
const hostStatus       = document.getElementById('hostStatus');
const peerStatus       = document.getElementById('peerStatus');
const guestLinkDisplay = document.getElementById('guestLinkDisplay');
const pendingList      = document.getElementById('pendingList');
const addedList        = document.getElementById('addedList');
const addedCard        = document.getElementById('addedCard');
const noPending        = document.getElementById('noPending');
const autoAcceptNote   = document.getElementById('autoAcceptNote');
const pendingCount     = document.getElementById('pendingCount');
const autoAcceptToggle = document.getElementById('autoAcceptToggle');

autoAcceptToggle.addEventListener('change', () => {
  autoAccept = autoAcceptToggle.checked;
  // Swap which empty-state message is visible
  noPending.classList.toggle('hidden', autoAccept && pendingRequests.length === 0);
  autoAcceptNote.classList.toggle('hidden', !autoAccept || pendingRequests.length > 0);
  renderPending();
});

// ─── SPOTIFY PKCE LOGIN ───────────────────────────────────────────────────────
document.getElementById('spotifyBtn').addEventListener('click', startSpotifyLogin);

async function startSpotifyLogin() {
  if (!SPOTIFY_CLIENT_ID || SPOTIFY_CLIENT_ID.startsWith('YOUR_')) {
    showHostError('Paste your Spotify Client ID into config.js first.');
    return;
  }
  const verifier  = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  sessionStorage.setItem('pkce_verifier', verifier);

  const params = new URLSearchParams({
    client_id:             SPOTIFY_CLIENT_ID,
    response_type:         'code',
    redirect_uri:          SPOTIFY_REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge:        challenge,
    scope:                 SPOTIFY_SCOPES,
    show_dialog:           'true',
  });
  window.location.href = 'https://accounts.spotify.com/authorize?' + params;
}

async function handleSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const error  = params.get('error');

  if (error)  { showHostError('Spotify sign-in was cancelled.'); return; }
  if (!code)  return;

  const verifier = sessionStorage.getItem('pkce_verifier');
  if (!verifier) { showHostError('Session expired — please try signing in again.'); return; }

  showHostInfo('Completing sign-in…');

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  SPOTIFY_REDIRECT_URI,
    client_id:     SPOTIFY_CLIENT_ID,
    code_verifier: verifier,
  });

  const res  = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', body });
  const data = await res.json();

  sessionStorage.removeItem('pkce_verifier');
  window.history.replaceState({}, '', window.location.pathname);

  if (!res.ok) {
    showHostError('Token exchange failed: ' + (data.error_description || data.error));
    return;
  }

  spotifyToken = data.access_token;
  localStorage.setItem('spotify_token',      data.access_token);
  localStorage.setItem('spotify_refresh',    data.refresh_token);
  localStorage.setItem('spotify_expires_at', Date.now() + data.expires_in * 1000);

  launchDashboard();
}

function generateCodeVerifier(len = 128) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

async function generateCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function launchDashboard() {
  signInScreen.classList.add('hidden');
  hostDashboard.classList.remove('hidden');
  initHostPeer();
  startQueuePolling();
}

document.getElementById('endSessionBtn').addEventListener('click', endSession);

function endSession() {
  stopQueuePolling();
  if (hostPeer) { hostPeer.destroy(); hostPeer = null; }
  guestConns.clear();
  spotifyToken = null;
  sessionCode  = null;
  localStorage.removeItem('spotify_token');
  localStorage.removeItem('spotify_refresh');
  localStorage.removeItem('spotify_expires_at');
  hostStatus.textContent = '';
  signInScreen.classList.remove('hidden');
  hostDashboard.classList.add('hidden');
}

// ─── PEERS HOST ──────────────────────────────────────────────────────────────
function initHostPeer() {
  peerStatus.textContent = 'Connecting to relay…';

  hostPeer = new Peer();

  hostPeer.on('open', id => {
    sessionCode = id;
    const guestUrl = `${window.location.origin}/guest.html?session=${id}`;
    guestLinkDisplay.textContent = guestUrl;
    peerStatus.textContent = 'Ready — share the link above with guests.';
  });

  hostPeer.on('connection', conn => {
    let guestName = 'Guest';
    guestConns.add(conn);

    conn.on('open', () => {
      conn.send({ type: 'connected' });
      // Send the current queue immediately on join
      fetchAndBroadcastQueue();
    });

    conn.on('data', data => {
      if (data.type === 'hello')        { guestName = data.name || 'Guest'; return; }
      if (data.type === 'search')       handleGuestSearch(data.query, conn);
      if (data.type === 'song_request') addPendingRequest(data.track, data.id, conn, guestName);
    });

    conn.on('close', () => {
      guestConns.delete(conn);
      for (let i = pendingRequests.length - 1; i >= 0; i--) {
        if (pendingRequests[i].conn === conn) pendingRequests.splice(i, 1);
      }
      renderPending();
    });
  });

  hostPeer.on('error', err => {
    peerStatus.innerHTML = `<span class="error">Relay error: ${err.message || err.type}. Refresh to retry.</span>`;
  });
}

// ─── SEARCH RELAY (host searches Spotify on guest's behalf) ──────────────────
async function handleGuestSearch(query, conn) {
  if (!query || query.trim().length < 2) return;

  const token = spotifyToken || localStorage.getItem('spotify_token');
  if (!token) return;

  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=6`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) return;

  const data    = await res.json();
  const results = (data.tracks?.items || []).map(t => ({
    uri:    t.uri,
    title:  t.name,
    artist: t.artists.map(a => a.name).join(', '),
    album:  t.album.name,
    artUrl: t.album.images[2]?.url || t.album.images[0]?.url || '',
  }));

  conn.send({ type: 'search_results', query, results });
}

// ─── QUEUE BROADCAST ──────────────────────────────────────────────────────────
async function fetchAndBroadcastQueue() {
  const token = spotifyToken || localStorage.getItem('spotify_token');
  if (!token || guestConns.size === 0) return;

  const res = await fetch('https://api.spotify.com/v1/me/player/queue', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return;

  const data = await res.json();

  const nowPlaying = data.currently_playing ? {
    uri:    data.currently_playing.uri,
    title:  data.currently_playing.name,
    artist: data.currently_playing.artists.map(a => a.name).join(', '),
    album:  data.currently_playing.album.name,
    artUrl: data.currently_playing.album.images[2]?.url || data.currently_playing.album.images[0]?.url || '',
  } : null;

  const queue = (data.queue || []).slice(0, 10).map(t => ({
    uri:    t.uri,
    title:  t.name,
    artist: t.artists.map(a => a.name).join(', '),
    album:  t.album.name,
    artUrl: t.album.images[2]?.url || t.album.images[0]?.url || '',
  }));

  const msg = { type: 'queue_update', nowPlaying, queue };
  for (const conn of guestConns) {
    if (conn.open) conn.send(msg);
  }
}

function startQueuePolling() {
  fetchAndBroadcastQueue();
  queuePollTimer = setInterval(fetchAndBroadcastQueue, 5000);
}

function stopQueuePolling() {
  clearInterval(queuePollTimer);
  queuePollTimer = null;
}

// ─── PENDING REQUESTS ─────────────────────────────────────────────────────────
async function addPendingRequest(track, guestReqId, conn, guestName) {
  if (autoAccept) {
    const result = await addUriToQueue(track.uri);
    if (result.ok) {
      conn.send({ type: 'added', id: guestReqId });
      addedTracks.unshift({ track, guestName });
      renderAdded();
      setTimeout(fetchAndBroadcastQueue, 1500);
    } else {
      // Still ack so guest sees a pending state, then send an error
      conn.send({ type: 'ack', id: guestReqId });
      conn.send({ type: 'declined', id: guestReqId });
      showToast(result.error);
    }
    return;
  }

  const id = ++requestIdSeq;
  pendingRequests.push({ id, guestReqId, track, conn, guestName });
  conn.send({ type: 'ack', id: guestReqId });
  renderPending();
}

function renderPending() {
  const hasPending = pendingRequests.length > 0;
  noPending.classList.toggle('hidden',      hasPending || autoAccept);
  autoAcceptNote.classList.toggle('hidden', !autoAccept || hasPending);
  pendingCount.textContent = pendingRequests.length;
  pendingCount.classList.toggle('hidden', !hasPending);

  pendingList.innerHTML = pendingRequests.map(r => `
    <li class="request-item" data-id="${r.id}">
      ${r.track.artUrl ? `<img class="q-art" src="${escHtml(r.track.artUrl)}" alt="" />` : ''}
      <div class="request-info">
        <strong>${escHtml(r.track.title)}</strong>
        <span>${escHtml(r.track.artist)}</span>
        <span class="req-by">by ${escHtml(r.guestName)}</span>
      </div>
      <div class="request-actions">
        <button class="btn-add"     onclick="handleAdd(${r.id})">Add</button>
        <button class="btn-decline" onclick="handleDecline(${r.id})">Decline</button>
      </div>
    </li>
  `).join('');
}

async function handleAdd(id) {
  const req = pendingRequests.find(r => r.id === id);
  if (!req) return;

  const btn = document.querySelector(`[data-id="${id}"] .btn-add`);
  if (btn) { btn.textContent = 'Adding…'; btn.disabled = true; }

  const result = await addUriToQueue(req.track.uri);

  if (result.ok) {
    req.conn.send({ type: 'added', id: req.guestReqId });
    addedTracks.unshift({ track: req.track, guestName: req.guestName });
    removePending(id);
    renderAdded();
    setTimeout(fetchAndBroadcastQueue, 1500);
  } else {
    if (btn) { btn.textContent = 'Add'; btn.disabled = false; }
    const item = document.querySelector(`[data-id="${id}"]`);
    if (item) {
      let err = item.querySelector('.req-error');
      if (!err) { err = document.createElement('p'); err.className = 'req-error'; item.appendChild(err); }
      err.textContent = result.error;
    }
  }
}

function handleDecline(id) {
  const req = pendingRequests.find(r => r.id === id);
  if (req) req.conn.send({ type: 'declined', id: req.guestReqId });
  removePending(id);
}

function removePending(id) {
  const idx = pendingRequests.findIndex(r => r.id === id);
  if (idx !== -1) pendingRequests.splice(idx, 1);
  renderPending();
}

// ─── ADDED LIST ───────────────────────────────────────────────────────────────
function renderAdded() {
  addedCard.style.display = addedTracks.length ? '' : 'none';
  addedList.innerHTML = addedTracks.map(({ track: t, guestName }) => `
    <li class="request-item added">
      ${t.artUrl ? `<img class="q-art" src="${escHtml(t.artUrl)}" alt="" />` : ''}
      <div class="request-info">
        <strong>${escHtml(t.title)}</strong>
        <span>${escHtml(t.artist)}</span>
        <span class="req-by">by ${escHtml(guestName)}</span>
      </div>
      <span class="added-badge">Added</span>
    </li>
  `).join('');
}

// ─── TOAST (for auto-accept errors) ──────────────────────────────────────────
function showToast(msg) {
  let toast = document.getElementById('hostToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'hostToast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('toast-visible');
  setTimeout(() => toast.classList.remove('toast-visible'), 4000);
}

// ─── SPOTIFY ADD TO QUEUE ─────────────────────────────────────────────────────
async function addUriToQueue(uri) {
  const token = spotifyToken || localStorage.getItem('spotify_token');
  if (!token) return { ok: false, error: 'Not signed in to Spotify.' };

  const res = await fetch(
    `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  );

  if (res.status === 404) return { ok: false, error: 'No active Spotify player — open Spotify on any device first.' };
  if (res.status === 403) return { ok: false, error: 'Spotify Premium is required to control the queue.' };
  if (res.status === 401) return { ok: false, error: 'Spotify token expired — refresh the page to sign in again.' };
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    return { ok: false, error: e.error?.message || 'Failed to add to queue.' };
  }
  return { ok: true };
}

// ─── COPY LINK ────────────────────────────────────────────────────────────────
document.getElementById('copyLinkBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(guestLinkDisplay.textContent).then(() => {
    const btn = document.getElementById('copyLinkBtn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
  });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function showHostError(msg) { hostStatus.innerHTML = `<span class="error">${msg}</span>`; }
function showHostInfo(msg)  { hostStatus.textContent = msg; }
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
handleSpotifyCallback();

if (signInScreen && !signInScreen.classList.contains('hidden')) {
  const token     = localStorage.getItem('spotify_token');
  const expiresAt = Number(localStorage.getItem('spotify_expires_at'));
  if (token && Date.now() < expiresAt) {
    spotifyToken = token;
    launchDashboard();
  }
}
