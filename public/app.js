'use strict';

const state = {
  me: null, users: new Map(), socket: null,
  canvas: null, ctx: null, keys: {},
  animFrame: null, currentChannel: 'general',
  popoverTarget: null,
  chatHistory: { general: [], random: [], team: [] },
  searchQuery: '',
  adminPwd: null
};

const SPEED = 3, AVATAR_R = 28, MEADOW_W = 1200, MEADOW_H = 800;

const STATUS_COLOR = { available:'#48d077', busy:'#e07070', break:'#e8b86d', offline:'#888888' };
const STATUS_LABEL = { available:'Available', busy:'Busy', break:'On Break', offline:'Away' };
const BREAK_EMOJI = { lunch:'🍱', coffee:'☕', brb:'🚶', focus:'🎧', call:'📞' };

const $ = id => document.getElementById(id);
const joinScreen = $('join-screen'), appEl = $('app'),
  memberList = $('member-list'), statusSelect = $('status-select'),
  breakComposer = $('break-composer'), breakTypeEl = $('break-type'),
  breakMinsEl = $('break-minutes'), selfDot = $('self-dot'),
  selfName = $('self-name-label'), selfAvatar = $('self-avatar-label'),
  chatMessages = $('chat-messages'), chatInput = $('chat-input'),
  chatChannName = $('chat-channel-name'), proximityToast = $('proximity-toast'),
  profilePop = $('profile-popover');

let selectedAvatar = '🐱';

let zohoToken = null; // set when user logs in via Zoho

// ── Read Zoho params from URL (after OAuth redirect) ─────────────────────────
(function () {
  const p = new URLSearchParams(window.location.search);
  const zName = p.get('zoho_name');
  const zEmail = p.get('zoho_email');
  const zToken = p.get('zoho_token');
  if (zName) {
    $('join-name').value = zName;
    zohoToken = zToken || null;
    const badge = $('zoho-user-badge');
    badge.textContent = '\u2713 Signed in as ' + zName + (zEmail ? ' (' + zEmail + ')' : '');
    badge.classList.remove('hidden');
    $('zoho-login-btn').style.display = 'none';
    history.replaceState({}, '', '/');
  }
  if (p.get('error') === 'auth_failed') {
    alert('Zoho login failed \u2014 please try again.');
    history.replaceState({}, '', '/');
  }
})();
// ─────────────────────────────────────────────────────────────────────────────

document.querySelectorAll('.av-opt').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.av-opt').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    selectedAvatar = el.dataset.av;
  });
});

$('join-btn').addEventListener('click', () => {
  const name = $('join-name').value.trim();
  if (!name) { $('join-name').focus(); return; }
  joinGame({ name, role: $('join-role').value.trim() || 'Team Member',
    team: $('join-team').value.trim() || '', avatar: selectedAvatar });
});

$('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click(); });

function joinGame(profile) {
  joinScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  const canvas = $('meadow-canvas');
  state.canvas = canvas; state.ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  state.socket = io();
  bindSocket();
  state.socket.emit('join', { name: profile.name, role: profile.role,
    team: profile.team, avatar: profile.avatar, color: randomGreen() });
  selfName.textContent = profile.name;
  selfAvatar.textContent = profile.avatar;
  document.addEventListener('keydown', e => {
    state.keys[e.key] = true;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) e.preventDefault();
  });
  document.addEventListener('keyup', e => { state.keys[e.key] = false; });
  loop();
}

function resizeCanvas() {
  state.canvas.width = state.canvas.offsetWidth;
  state.canvas.height = state.canvas.offsetHeight;
}

function randomGreen() {
  const g = ['#7ec8a0','#5a9470','#a8d4e8','#e8b86d','#c8a0e8','#e8a0a0'];
  return g[Math.floor(Math.random() * g.length)];
}

function bindSocket() {
  const s = state.socket;
  s.on('init', ({ you, users }) => {
    state.me = you; state.users.clear();
    users.forEach(u => state.users.set(u.id, u));
    state.users.set(you.id, you);
    renderMemberList();
  });
  s.on('user:joined', u => { state.users.set(u.id, u); renderMemberList(); addSystemMsg(u.avatar + ' ' + u.name + ' joined'); });
  s.on('user:left', ({ id }) => {
    const u = state.users.get(id);
    if (u) addSystemMsg(u.avatar + ' ' + u.name + ' left');
    state.users.delete(id); renderMemberList();
  });
  s.on('user:moved', ({ id, x, y }) => { const u = state.users.get(id); if (u) { u.x = x; u.y = y; } });
  s.on('user:status', ({ id, status, breakType, breakReturnAt }) => {
    const u = state.users.get(id);
    if (u) { u.status = status; u.breakType = breakType; u.breakReturnAt = breakReturnAt; }
    if (id === state.me?.id) { Object.assign(state.me, { status, breakType, breakReturnAt }); updateSelfDot(); }
    renderMemberList();
  });
  s.on('user:profile', ({ id, ...data }) => { const u = state.users.get(id); if (u) Object.assign(u, data); renderMemberList(); });
  s.on('chat:history', ({ channel, messages }) => {
    state.chatHistory[channel] = messages;
    if (channel === state.currentChannel) refreshChatView();
  });
  s.on('chat:message', msg => {
    if (!state.chatHistory[msg.channel]) state.chatHistory[msg.channel] = [];
    state.chatHistory[msg.channel].push(msg);
    if (msg.channel === state.currentChannel) {
      if (!state.searchQuery || msg.text.toLowerCase().includes(state.searchQuery.toLowerCase())) {
        renderChatMsg(msg, state.searchQuery);
      }
    }
  });
  s.on('proximity:meet', ({ with: other, meetLink }) => showProximityToast(other, meetLink));
  s.on('proximity:left', () => dismissToast());
}

let lastEmit = 0;
function loop() {
  handleMovement(); drawMeadow();
  state.animFrame = requestAnimationFrame(loop);
}

function handleMovement() {
  if (!state.me) return;
  let dx = 0, dy = 0;
  if (state.keys['ArrowLeft']  || state.keys['a']) dx -= SPEED;
  if (state.keys['ArrowRight'] || state.keys['d']) dx += SPEED;
  if (state.keys['ArrowUp']    || state.keys['w']) dy -= SPEED;
  if (state.keys['ArrowDown']  || state.keys['s']) dy += SPEED;
  if (dx !== 0 || dy !== 0) {
    state.me.x = Math.max(AVATAR_R, Math.min(MEADOW_W - AVATAR_R, state.me.x + dx));
    state.me.y = Math.max(AVATAR_R, Math.min(MEADOW_H - AVATAR_R, state.me.y + dy));
    const u = state.users.get(state.me.id);
    if (u) { u.x = state.me.x; u.y = state.me.y; }
    const now = Date.now();
    if (now - lastEmit > 40) { state.socket.emit('move', { x: state.me.x, y: state.me.y }); lastEmit = now; }
  }
}

function drawMeadow() {
  const { ctx, canvas, me } = state;
  if (!ctx || !me) return;
  const W = canvas.width, H = canvas.height;
  const camX = me.x - W/2, camY = me.y - H/2;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(-camX, -camY);
  const grad = ctx.createLinearGradient(0, 0, 0, MEADOW_H);
  grad.addColorStop(0, '#c8e6d4'); grad.addColorStop(1, '#a0c8b0');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, MEADOW_W, MEADOW_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
  for (let x = 0; x <= MEADOW_W; x += 80) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,MEADOW_H); ctx.stroke(); }
  for (let y = 0; y <= MEADOW_H; y += 80) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(MEADOW_W,y); ctx.stroke(); }
  drawDecorations(ctx);
  for (const [, u] of state.users) drawAvatar(ctx, u, u.id === me.id);
  ctx.restore();
}

const DECO = [
  {x:120,y:100,t:'🌳'},{x:900,y:80,t:'🌳'},{x:400,y:700,t:'🌳'},
  {x:1050,y:500,t:'🌳'},{x:200,y:600,t:'🌳'},{x:750,y:200,t:'🌳'},
  {x:600,y:650,t:'🌿'},{x:300,y:300,t:'🌿'},{x:850,y:650,t:'🌿'},
  {x:150,y:450,t:'🌸'},{x:700,y:100,t:'🌸'},{x:950,y:350,t:'🌸'},
  {x:500,y:350,t:'🪑'},{x:680,y:420,t:'🪑'}
];

function drawDecorations(ctx) {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '32px serif';
  for (const d of DECO) ctx.fillText(d.t, d.x, d.y);
}

function drawAvatar(ctx, u, isMe) {
  const x = u.x, y = u.y, r = AVATAR_R;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.2)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2);
  ctx.fillStyle = u.color || '#7ec8a0'; ctx.fill();
  ctx.restore();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2);
  ctx.strokeStyle = isMe ? '#e8b86d' : 'white'; ctx.lineWidth = isMe ? 3.5 : 2; ctx.stroke();
  ctx.font = (r*1.1) + 'px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(u.avatar || '🐱', x, y);
  ctx.beginPath(); ctx.arc(x + r*0.65, y + r*0.65, 7, 0, Math.PI*2);
  ctx.fillStyle = STATUS_COLOR[u.status] || STATUS_COLOR.available; ctx.fill();
  ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = 'bold 12px Nunito, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const label = u.name.split(' ')[0];
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath(); ctx.roundRect(x - tw/2 - 4, y + r + 4, tw + 8, 18, 4); ctx.fill();
  ctx.fillStyle = '#2c3e30'; ctx.fillText(label, x, y + r + 5);
  if (u.breakReturnAt) {
    const cd = getCountdown(u.breakReturnAt);
    if (cd) {
      ctx.font = 'bold 10px Nunito, sans-serif';
      const bw = ctx.measureText(cd).width + 10;
      ctx.fillStyle = '#e8b86d';
      ctx.beginPath(); ctx.roundRect(x - bw/2, y - r - 18, bw, 14, 4); ctx.fill();
      ctx.fillStyle = '#2c2c00'; ctx.textBaseline = 'middle'; ctx.fillText(cd, x, y - r - 11);
    }
  }
}

function renderMemberList() {
  memberList.innerHTML = '';
  const order = { available:0, busy:1, break:2, offline:3 };
  const sorted = Array.from(state.users.values()).sort((a,b) => (order[a.status]??4)-(order[b.status]??4));
  for (const u of sorted) {
    const li = document.createElement('li');
    li.className = 'member-item'; li.dataset.id = u.id;
    const isMe = u.id === state.me?.id ? ' (you)' : '';
    let sub = u.role || 'Team Member', breakInfo = '';
    if (u.status === 'break' && u.breakType) {
      const emoji = BREAK_EMOJI[u.breakType] || '⏸';
      const cd = u.breakReturnAt ? getCountdown(u.breakReturnAt) : '';
      breakInfo = '<span class="member-break-countdown">' + emoji + ' ' + u.breakType + (cd ? ' · ' + cd : '') + '</span>';
      sub = '';
    }
    li.innerHTML = '<span class="member-emoji">' + (u.avatar||'🐱') + '</span>' +
      '<div class="member-info"><div class="member-name">' + u.name + isMe + '</div>' +
      (sub ? '<div class="member-sub">' + sub + '</div>' : '') + breakInfo + '</div>' +
      '<span class="dot dot-' + (u.status||'available') + '"></span>';
    li.addEventListener('click', () => showProfilePopover(u, li));
    memberList.appendChild(li);
  }
}

setInterval(renderMemberList, 15000);

statusSelect.addEventListener('change', () => {
  const val = statusSelect.value;
  if (val === 'break') { breakComposer.classList.remove('hidden'); }
  else { breakComposer.classList.add('hidden'); emitStatus(val, null, null); }
  updateSelfDot();
});

$('break-confirm-btn').addEventListener('click', () => {
  const type = breakTypeEl.value;
  const mins = parseInt(breakMinsEl.value, 10);
  const returnAt = new Date(Date.now() + mins * 60000).toISOString();
  emitStatus('break', type, returnAt);
});

function emitStatus(status, breakType, breakReturnAt) {
  if (!state.socket || !state.me) return;
  state.me.status = status; state.me.breakType = breakType; state.me.breakReturnAt = breakReturnAt;
  const u = state.users.get(state.me.id);
  if (u) { u.status = status; u.breakType = breakType; u.breakReturnAt = breakReturnAt; }
  state.socket.emit('status:set', { status, breakType, breakReturnAt });
  updateSelfDot(); renderMemberList();
}

function updateSelfDot() {
  selfDot.className = 'dot dot-' + (state.me?.status || 'available');
}

document.querySelectorAll('.ch-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ch-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); state.currentChannel = btn.dataset.ch;
    chatChannName.textContent = btn.dataset.ch;
    chatInput.placeholder = 'Message #' + btn.dataset.ch + '...';
    chatMessages.innerHTML = '';
  });
});

$('chat-send-btn').addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !state.socket) return;
  state.socket.emit('chat:send', { text, channel: state.currentChannel });
  chatInput.value = '';
}

function renderChatMsg(msg) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const time = new Date(msg.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  div.innerHTML = '<div class="msg-avatar">' + (msg.avatar||'🐱') + '</div>' +
    '<div class="msg-body"><div class="msg-header"><span class="msg-name">' + msg.userName + '</span>' +
    '<span class="msg-time">' + time + '</span></div>' +
    '<div class="msg-text">' + escHtml(msg.text) + '</div></div>';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.style.cssText = 'text-align:center;font-size:12px;color:#7a9880;padding:4px 0;';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showProfilePopover(u, anchorEl) {
  state.popoverTarget = u;
  $('pop-avatar').textContent = u.avatar || '🐱';
  $('pop-name').textContent = u.name;
  $('pop-role').textContent = u.role || 'Team Member';
  $('pop-status').textContent = (STATUS_COLOR[u.status] ? '' : '') + (STATUS_LABEL[u.status] || 'Available');
  $('pop-team').textContent = u.team ? ('Team: ' + u.team) : '';
  $('pop-activity').textContent = u.activity ? ('Currently: ' + u.activity) : '';
  const links = $('pop-links');
  links.innerHTML = '';
  if (u.slackUsername) {
    const a = document.createElement('a');
    a.className = 'pop-link pop-link-slack';
    a.href = 'slack://user?team=&id=' + u.slackUsername;
    a.textContent = 'Message on Slack';
    links.appendChild(a);
  }
  if (u.zohoMeetLink) {
    const a = document.createElement('a');
    a.className = 'pop-link pop-link-meet';
    a.href = u.zohoMeetLink; a.target = '_blank';
    a.textContent = 'Join Zoho Meeting';
    links.appendChild(a);
  }
  if (!u.slackUsername && !u.zohoMeetLink) {
    links.innerHTML = '<span style="font-size:12px;color:#aaa;">No links added</span>';
  }
  const rect = anchorEl.getBoundingClientRect();
  profilePop.style.top = Math.min(rect.top, window.innerHeight - 360) + 'px';
  profilePop.style.left = (rect.right + 12) + 'px';
  profilePop.classList.remove('hidden');
}

$('popover-close-btn').addEventListener('click', () => { profilePop.classList.add('hidden'); });
document.addEventListener('click', e => {
  if (!profilePop.contains(e.target) && !e.target.closest('.member-item')) profilePop.classList.add('hidden');
});

$('meadow-canvas').addEventListener('click', e => {
  const rect = state.canvas.getBoundingClientRect();
  const me = state.me; if (!me) return;
  const worldX = (e.clientX - rect.left) + (me.x - rect.width/2);
  const worldY = (e.clientY - rect.top)  + (me.y - rect.height/2);
  for (const [, u] of state.users) {
    const dx = worldX - u.x, dy = worldY - u.y;
    if (Math.sqrt(dx*dx + dy*dy) <= AVATAR_R + 6) {
      showProfilePopover(u, { getBoundingClientRect: () => ({ top: e.clientY-20, right: e.clientX+20 }) });
      break;
    }
  }
});

$('quick-meet-btn').addEventListener('click', async () => {
  const res = await fetch('/api/meet/create', { method: 'POST' });
  const { meetLink } = await res.json();
  window.open(meetLink, '_blank');
  if (state.socket && state.me) {
    state.me.zohoMeetLink = meetLink;
    state.socket.emit('profile:update', { zohoMeetLink: meetLink });
  }
});

function showProximityToast(other, meetLink) {
  $('toast-avatar').textContent = other.avatar || '🐱';
  $('toast-name').textContent = "You're near " + other.name;
  $('toast-meet-link').href = meetLink;
  proximityToast.classList.remove('hidden');
}

window.dismissToast = function() { proximityToast.classList.add('hidden'); };

function getCountdown(isoString) {
  const diff = new Date(isoString) - Date.now();
  if (diff <= 0) return null;
  const m = Math.floor(diff / 60000), s = Math.floor((diff % 60000) / 1000);
  return m > 0 ? (m + 'm') : (s + 's');
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Chat search ───────────────────────────────────────────────────────────────
function refreshChatView() {
  chatMessages.innerHTML = '';
  const msgs = state.chatHistory[state.currentChannel] || [];
  const q = state.searchQuery;
  const filtered = q ? msgs.filter(m => m.text && m.text.toLowerCase().includes(q.toLowerCase())) : msgs;
  $('chat-no-results').classList.toggle('hidden', !q || filtered.length > 0);
  for (const m of filtered) renderChatMsg(m, q || null);
}

const chatSearchEl = $('chat-search');
const chatSearchClear = $('chat-search-clear');
chatSearchEl.addEventListener('input', () => {
  state.searchQuery = chatSearchEl.value.trim();
  chatSearchClear.classList.toggle('hidden', !state.searchQuery);
  refreshChatView();
});
chatSearchClear.addEventListener('click', () => {
  chatSearchEl.value = ''; state.searchQuery = '';
  chatSearchClear.classList.add('hidden');
  refreshChatView();
});

// ── Break: custom minutes + return display + auto-return ──────────────────────
const breakMinsEl2 = $('break-minutes');
const breakCustomInput = $('break-custom-mins');
const breakReturnDisplay = $('break-return-display');
const breakReturnTimeEl = $('break-return-time');
const breakCancelBtn = $('break-cancel-btn');

breakMinsEl2.addEventListener('change', () => {
  breakCustomInput.classList.toggle('hidden', breakMinsEl2.value !== 'custom');
});

$('break-confirm-btn').addEventListener('click', () => {
  const type = $('break-type').value;
  let mins = parseInt(breakMinsEl2.value, 10);
  if (breakMinsEl2.value === 'custom') {
    mins = parseInt(breakCustomInput.value, 10);
    if (!mins || mins < 1) { breakCustomInput.focus(); return; }
  }
  const returnAt = new Date(Date.now() + mins * 60000).toISOString();
  emitStatus('break', type, returnAt);
  const retTime = new Date(returnAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  breakReturnTimeEl.textContent = retTime;
  breakReturnDisplay.classList.remove('hidden');
});

breakCancelBtn.addEventListener('click', () => {
  emitStatus('available', null, null);
  $('status-select').value = 'available';
  breakComposer.classList.add('hidden');
  breakReturnDisplay.classList.add('hidden');
});

setInterval(() => {
  if (state.me && state.me.status === 'break' && state.me.breakReturnAt) {
    if (new Date(state.me.breakReturnAt) <= new Date()) {
      emitStatus('available', null, null);
      $('status-select').value = 'available';
      breakComposer.classList.add('hidden');
      breakReturnDisplay.classList.add('hidden');
      addSystemMsg('Your break is over — you are back as Available');
    }
  }
}, 10000);

// ── Admin panel ───────────────────────────────────────────────────────────────
$('admin-open-btn').addEventListener('click', () => $('admin-modal').classList.remove('hidden'));
$('admin-close').addEventListener('click', () => $('admin-modal').classList.add('hidden'));

let adminPwd = '';
$('admin-login-btn').addEventListener('click', fetchAttendance);
$('admin-pwd-input').addEventListener('keydown', e => { if (e.key === 'Enter') fetchAttendance(); });
$('admin-refresh-btn').addEventListener('click', fetchAttendance);

async function fetchAttendance() {
  adminPwd = $('admin-pwd-input').value;
  try {
    const res = await fetch('/api/admin/attendance?pwd=' + encodeURIComponent(adminPwd));
    if (res.status === 401) { alert('Wrong password'); return; }
    const { log, count } = await res.json();
    $('admin-auth').classList.add('hidden');
    $('admin-content').classList.remove('hidden');
    $('admin-count').textContent = count + ' events';
    renderAttendanceTable(log);
  } catch (e) { alert('Error: ' + e.message); }
}

function renderAttendanceTable(log) {
  const tbody = $('admin-tbody');
  tbody.innerHTML = '';
  for (const entry of log) {
    const tr = document.createElement('tr');
    const t = new Date(entry.ts).toLocaleString();
    const retTime = entry.breakReturnAt
      ? new Date(entry.breakReturnAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
      : '';
    const details = entry.breakType ? (entry.breakType + (retTime ? ' back at ' + retTime : '')) : '';
    tr.innerHTML = '<td>' + t + '</td><td>' + (entry.avatar||'') + ' ' + escHtml(entry.userName) +
      '</td><td>' + escHtml(entry.role||'') + '</td><td>' + escHtml(entry.type) +
      '</td><td>' + escHtml(details) + '</td>';
    tbody.appendChild(tr);
  }
  $('admin-csv-btn').onclick = () => {
    const rows = [['Time','User','Role','Event','Details']];
    for (const e of log) {
      rows.push([new Date(e.ts).toLocaleString(), e.userName, e.role||'', e.type, e.breakType||'']);
    }
    const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'attendance-' + Date.now() + '.csv';
    a.click();
  };
}
