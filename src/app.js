import './style.css';
import QRCode from 'qrcode';
import { colorForPosition, positionFromStep, stepFromPosition } from './spectrum.mjs';

const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const roomCode = (params.get('room') || '').trim().toUpperCase();
const view = params.get('view') === 'host' ? 'host' : params.get('view') === 'display' ? 'display' : 'participant';
const tokenKey = 'council-host-token';
let hostToken = readStorage(sessionStorage, tokenKey);
let participantToken = roomCode ? readStorage(localStorage, `council-participant-${roomCode}`) : '';
let participantId = '';
let state = null;
let status = { ready: false, local: false };
let connection = 'connecting';
let connectionMessage = '';
let pollTimer;
let polling = false;
let structureKey = '';
let pageEpoch = 0;
let selection = null;
let selectionRound = -1;
let dragging = false;
let pendingVote = null;
let inFlightVote = null;
let voteTimer;
let voteSequence = Date.now();
let lastVoteSentAt = 0;
let roomUnavailable = false;
let voteState = 'idle';
let voteError = '';
let roundEpoch = 0;
let controlling = false;

function readStorage(storage, key) { try { return storage.getItem(key) || ''; } catch { return ''; } }
function writeStorage(storage, key, value) { try { storage.setItem(key, value); } catch { /* Polling still works for this visit. */ } }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function joinURL(code = roomCode) { return `${location.origin}/?room=${encodeURIComponent(code)}`; }
function displayURL() { return `${location.origin}/?view=display&room=${encodeURIComponent(roomCode)}`; }
function percent(count, total) { return total ? `${Math.round(count / total * 100)}%` : '0%'; }
function councilTitle(title) { return String(title).replace(/Cross Market Readers Council/gi, 'Crossmarket Readers Council'); }
function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }
function icon(name) {
  const paths = { arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>', expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>', check: '<path d="m5 12 4 4L19 6"/>', pause: '<path d="M8 5v14M16 5v14"/>', plus: '<path d="M12 5v14M5 12h14"/>', external: '<path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H3v18h18v-7"/>' };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.arrow}</svg>`;
}

async function api(path, { method = 'GET', body, token, signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`/api${path}`, {
      method, cache: 'no-store', signal: controller.signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('The server could not be reached. Please try again.'); }
    if (!response.ok) { const error = new Error(data.error || 'That did not go through. Please try again.'); error.status = response.status; throw error; }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The connection took too long. Please try again.');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

function shell(content, { wide = false, mode = '' } = {}) {
  pageEpoch++;
  app.innerHTML = `${status.local ? '<div class="rehearsal-banner">Local rehearsal <span>•</span> not published</div>' : ''}
    <header class="site-header"><a href="/" class="brand" aria-label="Technical.ly home">Technical<span class="brand-dot">.</span>ly</a>
      <span class="header-context">Crossmarket<br class="mobile-break"> Readers Council</span>
      <div class="header-right">${mode ? `<span class="mode-label">${esc(mode)}</span>` : ''}<span id="connection" class="connection" role="status"></span></div></header>
    <main id="main" class="${wide ? 'wide-main' : 'standard-main'}">${content}</main>
    <footer class="site-footer"><span>Technical.ly Readers Council</span></footer>`;
  updateConnection();
}

function setConnection(next, message = '') { connection = next; connectionMessage = message; updateConnection(); }
function updateConnection() {
  const el = document.querySelector('#connection');
  if (!el) return;
  el.className = `connection ${connection}`;
  el.textContent = connection === 'online' ? 'Connected' : connection === 'offline' ? 'Reconnecting' : 'Connecting';
  el.title = connectionMessage || (connection === 'online' ? 'Connected to the room' : 'Checking your connection');
  const warning = document.querySelector('#connection-warning');
  if (warning) { warning.hidden = connection !== 'offline'; warning.textContent = connectionMessage ? `${connectionMessage} Retrying automatically.` : 'Connection interrupted. Retrying automatically.'; }
}

function errorMessage(id, message) { const el = document.querySelector(`#${id}`); if (el) { el.textContent = message; el.hidden = !message; } }

function renderLanding() {
  shell(`<div class="welcome-grid"><section class="welcome-copy"><h1>What does your<br><em>ecosystem</em> need?</h1><div class="intro-spectrum" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><span></span></div></section>
    <section class="join-card"><span class="card-index">LET’S GET TOGETHER</span><h2>Join the room</h2><p>Enter the room code shared by your host.</p><form id="join-form"><label for="room-code">Room code</label><input id="room-code" name="room" class="room-input" placeholder="ABCDEFGH" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="8" required aria-describedby="join-error"><p id="join-error" class="error-text" hidden role="alert"></p><button type="submit" class="button primary full">Find my place ${icon('arrow')}</button></form><div class="join-bottom">Hosting the conversation? <a href="/?view=host">Set up a session ${icon('arrow')}</a></div></section></div>`);
  document.querySelector('#join-form').addEventListener('submit', e => { e.preventDefault(); const code = document.querySelector('#room-code').value.trim().toUpperCase(); if (!/^[A-Z2-9]{8}$/.test(code)) return errorMessage('join-error', 'Use the room code shared by your host.'); location.href = joinURL(code); });
}

function renderLogin() {
  shell(`<div class="narrow-page"><a class="back-link" href="/">← Back to join</a><p class="eyebrow">Make room for a little perspective</p><h1>Host a conversation.</h1><p class="intro small">Up to four questions. Thirty perspectives.<br>One shared starting point.</p><section class="panel"><h2>Host sign-in</h2><p>Your password keeps the session controls in your hands.</p><form id="login-form"><label for="password">Host password</label><input id="password" type="password" autocomplete="current-password" required>${status.local ? '<p class="field-hint">For this local rehearsal, use <code>rehearsal-only-local</code>.</p>' : ''}<p id="login-error" class="error-text" hidden role="alert"></p><button class="button primary full" type="submit">Continue ${icon('arrow')}</button></form></section></div>`, { mode: 'Host' });
  document.querySelector('#login-form').addEventListener('submit', async e => {
    e.preventDefault(); const button = e.currentTarget.querySelector('button'); button.disabled = true; errorMessage('login-error', '');
    try { const result = await api('/host/login', { method: 'POST', body: { password: document.querySelector('#password').value } }); hostToken = result.token; writeStorage(sessionStorage, tokenKey, hostToken); if (roomCode) await loadRoom(); else renderSetup(); }
    catch (error) { errorMessage('login-error', error.message); button.disabled = false; }
  });
}

function questionEditor(index) {
  return `<fieldset class="question-editor"><legend><span class="question-number">${String(index + 1).padStart(2, '0')}</span> Question ${index + 1}</legend><button type="button" class="remove-question" aria-label="Remove question ${index + 1}" ${index === 0 ? 'hidden' : ''}>Remove</button><label for="prompt-${index}">What do you want to ask?</label><textarea id="prompt-${index}" name="prompt" rows="2" maxlength="240" placeholder="For example: What helps an innovation economy grow?" required></textarea><div class="endpoint-fields"><div><label for="left-${index}">Left end of the spectrum</label><input id="left-${index}" name="left" maxlength="70" placeholder="For example: Local connections" required></div><div><label for="right-${index}">Right end of the spectrum</label><input id="right-${index}" name="right" maxlength="70" placeholder="For example: Outside perspectives" required></div></div></fieldset>`;
}

function renderSetup() {
  shell(`<div class="setup-heading"><div><p class="eyebrow">Host your next conversation</p><h1>Set the spectrum.</h1><p class="intro small">Ask a question with two ends. Let everyone find their place.</p></div><span class="anonymous-badge">◎ &nbsp; Anonymous responses</span></div><form id="setup-form" class="setup-grid"><section><div class="panel session-details"><label for="session-title">Session name</label><input id="session-title" maxlength="100" value="Crossmarket Readers Council" required><p class="field-hint">This appears on participants’ screens.</p></div><div id="question-editors">${questionEditor(0)}</div><button type="button" class="button secondary add-question" id="add-question">${icon('plus')} Add a question <span id="question-limit">1 of 4</span></button></section><aside class="setup-aside"><span class="card-index">HOW IT WORKS</span><ol class="steps"><li><span>01</span><div><strong>Invite the room</strong><p>Share a link or QR code. Everyone joins anonymously.</p></div></li><li><span>02</span><div><strong>Let perspectives move</strong><p>Open a question. Each person moves one dot across the spectrum.</p></div></li><li><span>03</span><div><strong>Freeze. Then discuss.</strong><p>Reveal the split, hear each other out, then move to the next question.</p></div></li></ol><p class="setup-note">Each response counts toward the left or right. Joining the room doesn’t count as a response.</p><p id="setup-error" class="error-text" hidden role="alert"></p><button class="button primary full" id="create-room" type="submit">Create the room ${icon('arrow')}</button></aside></form>`, { mode: 'Host' });
  const editors = document.querySelector('#question-editors');
  const refreshEditors = () => {
    const fields = [...editors.querySelectorAll('fieldset')];
    fields.forEach((field, i) => { field.querySelector('legend').innerHTML = `<span class="question-number">${String(i + 1).padStart(2, '0')}</span> Question ${i + 1}`; field.querySelector('.remove-question').hidden = fields.length === 1; field.querySelector('.remove-question').setAttribute('aria-label', `Remove question ${i + 1}`); });
    document.querySelector('#question-limit').textContent = `${fields.length} of 4`; document.querySelector('#add-question').disabled = fields.length >= 4;
  };
  let nextQuestionId = 1;
  document.querySelector('#add-question').addEventListener('click', () => { if (editors.children.length >= 4) return; editors.insertAdjacentHTML('beforeend', questionEditor(nextQuestionId++)); refreshEditors(); editors.lastElementChild.querySelector('textarea').focus(); });
  editors.addEventListener('click', e => { if (e.target.closest('.remove-question') && editors.children.length > 1) { e.target.closest('fieldset').remove(); refreshEditors(); } });
  document.querySelector('#setup-form').addEventListener('submit', async e => {
    e.preventDefault(); const button = document.querySelector('#create-room'); button.disabled = true; errorMessage('setup-error', '');
    const questions = [...editors.querySelectorAll('fieldset')].map(field => Object.fromEntries(['prompt', 'left', 'right'].map(key => [key, field.querySelector(`[name="${key}"]`).value.trim()])));
    try { const result = await api('/rooms', { method: 'POST', token: hostToken, body: { title: document.querySelector('#session-title').value.trim(), questions } }); location.href = `/?view=host&room=${encodeURIComponent(result.code)}`; }
    catch (error) { if (error.status === 401) { hostToken = ''; writeStorage(sessionStorage, tokenKey, ''); return renderLogin(); } errorMessage('setup-error', error.message); button.disabled = false; }
  });
}

function phaseLabel() { return ({ waiting: 'Getting ready', open: 'Live now', frozen: 'Responses frozen', finished: 'That’s a wrap' })[state.status]; }
function summaryMarkup(results, question, compact = false) {
  return `<div class="results-grid ${compact ? 'compact-results' : ''}"><div class="result left-result"><span class="result-label">${esc(question.left)}</span><strong>${results.left}<small>${percent(results.left, results.total)}</small></strong><span>${plural(results.left, 'response').replace(/^\d+ /, '')}</span></div><div class="result right-result"><span class="result-label">${esc(question.right)}</span><strong>${results.right}<small>${percent(results.right, results.total)}</small></strong><span>${plural(results.right, 'response').replace(/^\d+ /, '')}</span></div></div>`;
}

function spectrumMarkup() {
  return `<div class="spectrum-wrap"><div class="spectrum-topline"><span id="response-count"></span></div><div class="spectrum-labels"><span>${esc(state.question.left)}</span><span>${esc(state.question.right)}</span></div><div id="dot-field" class="dot-field" role="img" aria-label="Anonymous responses across the spectrum"><div class="dividing-line" aria-hidden="true"></div><div class="field-ticks" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="field-message" id="field-message"></div><div id="dots" class="dots"></div></div></div>`;
}

function qrMarkup(compact = false) {
  return `<div class="qr-panel ${compact ? 'qr-compact' : ''}"><div class="qr-image"><canvas id="qr-code" aria-label="QR code to join this session"></canvas></div><div class="qr-copy"><span class="card-index">JOIN THE CONVERSATION</span><p>Scan to find your place.</p><span class="room-code-label">Room code <strong>${esc(state.code)}</strong></span><a class="join-url" href="${esc(joinURL())}" target="_blank" rel="noopener">${esc(location.host)}</a></div></div>`;
}

function roomHeader() { return `<div class="room-heading"><div><p class="eyebrow">${esc(councilTitle(state.title))}</p><div class="round-line"><span>QUESTION ${state.round + 1} <span class="muted">/ ${state.totalQuestions}</span></span><span class="phase-pill ${state.status}"><i></i>${phaseLabel()}</span></div></div><div class="people-count"><strong id="joined-count">${state.joined}</strong><span>joined the room</span></div></div><div id="connection-warning" class="connection-warning" role="status" hidden></div>`; }

function participantMarkup() {
  const q = state.question;
  if (state.status === 'waiting') return `<section class="participant-waiting"><span class="waiting-orbit" aria-hidden="true"><i></i><i></i><i></i></span><p class="eyebrow">You’re in the room</p><h1>Get ready to vote</h1><p class="intro small">Your host will open the question soon.<br>Then move your slider to share your perspective.</p><div class="next-question"><span class="card-index">COMING UP</span><h2>${esc(q.prompt)}</h2><div class="mini-endpoints"><span>${esc(q.left)}</span><span>↔</span><span>${esc(q.right)}</span></div></div><p class="privacy-note">◎ &nbsp; Your response is anonymous.</p></section>`;
  return `<section class="question-stage"><h1 class="question-prompt">${esc(q.prompt)}</h1>${state.status === 'open' ? '<p class="question-subtitle">There’s room for nuance. Move the slider to show where you stand.</p>' : ''}
    ${state.status === 'open' ? `<div class="participant-control"><div class="slider-labels"><label for="position">${esc(q.left)}</label><span>${esc(q.right)}</span></div><div class="range-wrap"><input id="position" type="range" min="0" max="99" step="1" value="49" aria-label="Your position between ${esc(q.left)} and ${esc(q.right)}" aria-describedby="vote-status slider-help"></div><div class="slider-under"><span id="position-label">Move to choose a position</span></div><div class="vote-status" id="vote-status" role="status" aria-live="polite"></div><p id="slider-help" class="field-hint">Keep moving until the host freezes responses. Use the arrow keys for a precise position.</p></div>` : `<div class="frozen-personal" id="frozen-personal"></div>${summaryMarkup(state.results, q)}`}
    ${spectrumMarkup()}</section>`;
}

function hostControls() {
  const last = state.round === state.totalQuestions - 1;
  const action = state.status === 'waiting' ? 'open' : state.status === 'open' ? 'freeze' : last ? 'finish' : 'next';
  const label = { open: 'Open the question', freeze: 'Freeze responses', next: 'Next question', finish: 'Finish the session' }[action];
  const help = { open: 'Everyone can join now. Open the question when the room is ready.', freeze: 'Ready for the reveal? Freeze locks the final positions for everyone.', next: 'Responses are locked. Take time to discuss before moving on.', finish: 'This was your last question. Finish to show the session recap.' }[action];
  return `<aside class="host-controls"><div><span class="card-index">YOU’RE THE HOST</span><p>${help}</p></div><div class="host-actions"><button class="button ${action === 'freeze' ? 'freeze-button' : 'primary'}" id="host-action" data-action="${action}">${action === 'freeze' ? icon('pause') : ''}${label}${action === 'freeze' ? '' : icon('arrow')}</button><p id="control-error" class="error-text" hidden role="alert"></p></div></aside>`;
}

function finishedMarkup() {
  const history = state.history || [];
  return `<div class="finished-heading"><p class="eyebrow">${esc(councilTitle(state.title))}</p><h1>Different perspectives.<br><em>One conversation.</em></h1><p class="intro small">Thanks for sharing where you stand.</p><div class="finished-stats"><span>${state.joined} people joined</span><span>${state.totalQuestions} ${state.totalQuestions === 1 ? 'question' : 'questions'}</span><span>Always anonymous</span></div></div><div class="recap-list">${history.map((entry, i) => `<section class="recap-card"><span class="card-index">QUESTION ${i + 1}</span><h2>${esc(entry.question.prompt)}</h2>${summaryMarkup(entry.results, entry.question, true)}<p class="field-hint">${plural(entry.results.total, 'response')}. Percentages may not add to 100% due to rounding.</p></section>`).join('')}</div>${view === 'host' ? '<div class="finish-link"><a href="/?view=host" class="button primary">Create another session →</a></div>' : '<div class="finish-link"><a href="/" class="back-link">← Leave the room</a></div>'}`;
}

function renderRoom() {
  if (!state) return;
  const key = `${view}:${state.status}:${state.round}:${state.question?.prompt}`;
  if (key !== structureKey) {
    structureKey = key;
    if (state.status === 'finished') {
      shell(finishedMarkup(), { wide: view !== 'participant', mode: view === 'host' ? 'Host' : '' });
      return;
    }
    let content;
    if (view === 'participant') content = `${roomHeader()}${participantMarkup()}`;
    else content = `${roomHeader()}<div class="presentation-tools">${view === 'host' ? `<button class="text-button" id="copy-link">${icon('copy')} Copy invite link</button><a class="text-button" href="${esc(displayURL())}" target="_blank" rel="noopener">${icon('external')} Open presentation</a>` : `<button class="text-button" id="fullscreen">${icon('expand')} Full screen</button>`}</div><div class="presentation-layout ${state.status === 'waiting' ? 'is-waiting' : ''}"><section class="question-stage"><h1 class="question-prompt">${esc(state.question.prompt)}</h1>${state.status === 'frozen' ? '' : `<p class="question-subtitle">${state.status === 'waiting' ? 'Join the room. Your host will open the question shortly.' : 'Move your slider. Find your place. See the room shift.'}</p>`}${spectrumMarkup()}${state.status === 'frozen' ? `${summaryMarkup(state.results, state.question)}<p class="results-footnote">${plural(state.results.total, 'response')} · Percentages are rounded</p>` : ''}</section>${qrMarkup(state.status !== 'waiting')}</div>${view === 'host' ? hostControls() : '<p class="display-footer-note">Anonymous perspectives. A shared conversation.</p>'}`;
    shell(content, { wide: view !== 'participant', mode: view === 'host' ? 'Host' : view === 'display' ? 'Presentation' : '' });
    bindRoomEvents();
    if (document.querySelector('#qr-code')) {
      const epoch = pageEpoch;
      QRCode.toCanvas(document.querySelector('#qr-code'), joinURL(), { width: 200, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#022333', light: '#FFFFFF' } }).catch(() => { if (epoch === pageEpoch) document.querySelector('.qr-image').textContent = 'Use the room code below.'; });
    }
  }
  updateRoom();
}

function bindRoomEvents() {
  document.querySelector('#copy-link')?.addEventListener('click', async e => {
    const button = e.currentTarget;
    try { await navigator.clipboard.writeText(joinURL()); button.innerHTML = `${icon('check')} Link copied`; }
    catch { button.outerHTML = `<input class="copy-fallback" aria-label="Invite link: select and copy" readonly value="${esc(joinURL())}">`; document.querySelector('.copy-fallback').select(); }
  });
  document.querySelector('#fullscreen')?.addEventListener('click', async e => {
    try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); }
    catch { e.currentTarget.textContent = 'Use your browser’s full-screen view'; }
  });
  document.querySelector('#host-action')?.addEventListener('click', controlRoom);
  const slider = document.querySelector('#position');
  if (slider) {
    slider.addEventListener('pointerdown', () => { dragging = true; });
    slider.addEventListener('input', () => choosePosition(positionFromStep(slider.value)));
    slider.addEventListener('change', () => { dragging = false; choosePosition(positionFromStep(slider.value), true); });
    slider.addEventListener('pointerup', () => { dragging = false; flushVote(); });
    slider.addEventListener('pointercancel', () => { dragging = false; });
  }
}

function dotLane(id) { let hash = 0; for (const char of id) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0; return Math.abs(hash) % 9; }
function updateDots() {
  const container = document.querySelector('#dots');
  if (!container) return;
  const votes = state.votes || [];
  const existing = new Map([...container.children].map(dot => [dot.dataset.id, dot]));
  for (const vote of votes) {
    let dot = existing.get(vote.id);
    if (!dot) { dot = document.createElement('span'); dot.className = 'response-dot'; dot.dataset.id = vote.id; container.append(dot); }
    dot.classList.toggle('my-dot', vote.id === participantId);
    dot.style.backgroundColor = colorForPosition(vote.position);
    dot.style.left = `${vote.position}%`; dot.style.top = `${12 + dotLane(vote.id) * 9.5}%`; dot.title = vote.id === participantId ? 'Your response' : 'Anonymous response'; existing.delete(vote.id);
  }
  for (const dot of existing.values()) dot.remove();
  const field = document.querySelector('#dot-field');
  field?.classList.toggle('frozen', state.status === 'frozen');
  field?.setAttribute('aria-label', `${plural(votes.length, 'anonymous response')} across the spectrum. ${state.status === 'frozen' ? `${state.results.left} left, ${state.results.right} right.` : 'Final counts appear when responses are frozen.'}`);
  const message = document.querySelector('#field-message');
  message.hidden = votes.length > 0;
  message.textContent = state.status === 'waiting' ? 'The room is gathering.' : state.status === 'frozen' ? 'No responses this round.' : 'The first perspective starts the picture.';
}

function positionText(position) {
  if (position === null) return 'Move to choose a position';
  if (position === 50) return `Counted toward ${state.question.right}`;
  if (position === 0) return `All the way toward ${state.question.left}`;
  if (position === 100) return `All the way toward ${state.question.right}`;
  return `${Math.round(Math.abs(position - 50) * 2)}% toward ${position < 50 ? state.question.left : state.question.right}`;
}

function updateVoteUI() {
  const slider = document.querySelector('#position');
  if (slider) {
    if (!dragging) slider.value = selection === null ? 49 : stepFromPosition(selection);
    slider.style.setProperty('--position', `${selection ?? 50}%`);
    slider.classList.toggle('untouched', selection === null);
    slider.setAttribute('aria-valuetext', positionText(selection));
    document.querySelector('#position-label').textContent = positionText(selection);
  }
  const voteStatus = document.querySelector('#vote-status');
  if (voteStatus) {
    voteStatus.className = `vote-status ${voteState}`;
    const labels = { idle: 'No response yet. Move the slider to choose a side.', saving: 'Saving your position…', saved: 'Your position is saved. You can keep moving.', error: voteError || 'Position not saved. Try again.' };
    voteStatus.textContent = labels[voteState];
    if (voteState === 'error') { const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.textContent = 'Try again'; retry.addEventListener('click', () => { if (selection !== null) choosePosition(selection, true); }); voteStatus.append(' ', retry); }
  }
}

function updateRoom() {
  const joined = document.querySelector('#joined-count'); if (joined) joined.textContent = state.joined;
  const responseCount = document.querySelector('#response-count'); if (responseCount) responseCount.textContent = `${state.responded} of ${state.joined} responded`;
  updateDots(); updateVoteUI(); updateConnection();
  const frozenPersonal = document.querySelector('#frozen-personal');
  if (frozenPersonal) { const vote = state.votes.find(v => v.id === participantId); frozenPersonal.textContent = vote ? `Your final position: ${positionText(vote.position)}.` : 'You didn’t submit a response this round. You’re still part of the conversation.'; }
}

function acceptState(next) {
  if (view === 'host' && !hostToken) return;
  if (state && next.version < state.version) return;
  const previous = state;
  state = next;
  if (selectionRound !== state.round) {
    roundEpoch++; pendingVote = null; clearTimeout(voteTimer); voteTimer = null; inFlightVote?.controller.abort(); inFlightVote = null;
    selectionRound = state.round; selection = state.votes.find(v => v.id === participantId)?.position ?? null; voteState = selection === null ? 'idle' : 'saved'; dragging = false;
  }
  if (state.status !== 'open' && previous?.status === 'open') {
    roundEpoch++; pendingVote = null; clearTimeout(voteTimer); voteTimer = null; inFlightVote?.controller.abort(); inFlightVote = null;
    selection = state.votes.find(v => v.id === participantId)?.position ?? null; dragging = false;
  }
  renderRoom();
}

function choosePosition(position, immediate = false) {
  if (state.status !== 'open') return;
  selection = position; voteState = 'saving'; voteError = '';
  pendingVote = { round: state.round, position, sequence: Math.max(Date.now(), ++voteSequence) }; voteSequence = pendingVote.sequence;
  updateVoteUI();
  if (immediate) flushVote(); else if (!voteTimer && !inFlightVote) voteTimer = setTimeout(flushVote, 250);
}

async function flushVote() {
  clearTimeout(voteTimer); voteTimer = null;
  if (inFlightVote || !pendingVote || state.status !== 'open') return;
  const wait = 300 - (Date.now() - lastVoteSentAt);
  if (wait > 0) { voteTimer = setTimeout(flushVote, wait); return; }
  lastVoteSentAt = Date.now();
  const vote = pendingVote; pendingVote = null;
  const epoch = roundEpoch; const controller = new AbortController(); const flight = { vote, controller }; inFlightVote = flight;
  try {
    await api(`/rooms/${encodeURIComponent(roomCode)}/vote`, { method: 'POST', token: participantToken, body: vote, signal: controller.signal });
    if (epoch !== roundEpoch) return;
    if (!pendingVote) voteState = 'saved';
    setConnection('online');
  } catch (error) {
    if (epoch !== roundEpoch) return;
    voteState = 'error'; voteError = error.status === 409 ? 'The host has closed this question. Checking your final position…' : 'Your latest position isn’t saved. Please try again.';
    if (!error.status) setConnection('offline', 'Your connection was interrupted.');
    if (error.status === 401) participantToken = '';
    refreshState();
  } finally {
    if (inFlightVote === flight) inFlightVote = null;
    if (epoch === roundEpoch) { updateVoteUI(); if (pendingVote) flushVote(); }
  }
}

async function controlRoom(e) {
  if (controlling) return;
  const action = e.currentTarget.dataset.action; controlling = true; e.currentTarget.disabled = true; errorMessage('control-error', '');
  try { const next = await api(`/rooms/${encodeURIComponent(roomCode)}/control`, { method: 'POST', token: hostToken, body: { action, expectedVersion: state.version } }); acceptState(next); setConnection('online'); }
  catch (error) {
    if (error.status === 401) { hostToken = ''; writeStorage(sessionStorage, tokenKey, ''); clearTimeout(pollTimer); structureKey = ''; return renderLogin(); }
    errorMessage('control-error', error.status === 409 ? 'The room changed. Review its current state, then try again.' : error.message); await refreshState();
  } finally { controlling = false; const button = document.querySelector('#host-action'); if (button) button.disabled = false; }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!state || state.status === 'finished' || roomUnavailable || (view === 'host' && !hostToken)) return;
  const delay = document.hidden ? 5000 : state.status === 'open' ? (view === 'participant' ? 1500 : 500) : 2500;
  pollTimer = setTimeout(refreshState, delay);
}

async function refreshState() {
  if (polling || !roomCode || !state || state.status === 'finished' || (view === 'host' && !hostToken)) return;
  polling = true;
  try { const next = await api(`/rooms/${encodeURIComponent(roomCode)}`); acceptState(next); setConnection('online'); }
  catch (error) {
    if (error.status === 404) { roomUnavailable = true; pendingVote = null; clearTimeout(voteTimer); document.querySelector('#position')?.setAttribute('disabled', ''); }
    setConnection('offline', error.message);
  }
  finally { polling = false; schedulePoll(); }
}

async function loadRoom() {
  roomUnavailable = false;
  shell('<div class="loading-page"><p class="eyebrow">Finding your room</p><h1>One moment…</h1></div>');
  try {
    let next;
    if (view === 'participant') {
      let joined;
      try { joined = await api(`/rooms/${encodeURIComponent(roomCode)}/join`, { method: 'POST', body: { ...(participantToken ? { participantToken } : {}) } }); }
      catch (error) { if (error.status !== 401 || !participantToken) throw error; participantToken = ''; joined = await api(`/rooms/${encodeURIComponent(roomCode)}/join`, { method: 'POST', body: {} }); }
      participantToken = joined.participantToken; participantId = joined.participantId; writeStorage(localStorage, `council-participant-${roomCode}`, participantToken); next = joined.state;
    } else next = await api(`/rooms/${encodeURIComponent(roomCode)}`);
    setConnection('online'); acceptState(next); schedulePoll();
  } catch (error) {
    setConnection('offline', error.message);
    shell(`<div class="narrow-page"><p class="eyebrow">Let’s get you connected</p><h1>We couldn’t open this room.</h1><p class="intro small">${esc(error.message)}</p><button class="button primary" id="retry-room">Try again ${icon('arrow')}</button><a class="back-link block-link" href="/">Enter another room code</a></div>`);
    document.querySelector('#retry-room').addEventListener('click', loadRoom);
  }
}

async function init() {
  try { status = await api('/status'); setConnection(status.ready ? 'online' : 'offline'); }
  catch (error) { setConnection('offline', error.message); }
  if (!status.ready) {
    shell('<div class="narrow-page"><p class="eyebrow">Almost ready</p><h1>The room service isn’t connected yet.</h1><p class="intro small">The host needs to finish the connection before participants can join.</p><button id="retry-service" class="button primary">Check again →</button></div>');
    document.querySelector('#retry-service').addEventListener('click', init); return;
  }
  if (view === 'host' && !hostToken) return renderLogin();
  if (roomCode) return loadRoom();
  if (view === 'host') return renderSetup();
  renderLanding();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && state?.status !== 'finished') refreshState(); });
window.addEventListener('focus', () => { if (state?.status !== 'finished') refreshState(); });
window.addEventListener('online', () => { if (state) refreshState(); });
window.addEventListener('offline', () => setConnection('offline', 'You appear to be offline.'));
init();
