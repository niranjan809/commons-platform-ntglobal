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

const SPEED = 210, AVATAR_R = 28, MEADOW_W = 1200, MEADOW_H = 800; // SPEED in px/second
const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd']);

const STATUS_COLOR = { available:'#48d077', busy:'#e07070', break:'#e8b86d', offline:'#888888' };
const STATUS_LABEL = { available:'Available', busy:'Busy', break:'On Break', offline:'Away' };
const BREAK_EMOJI = { lunch:'\u{1f371}', coffee:'☕', brb:'\u{1f6b6}', focus:'\u{1f3a7}', call:'\u{1f4de}' };

const $ = id => document.getElementById(id);
const joinScreen = $('join-screen'), appEl = $('app'),
  memberList = $('member-list'), statusSelect = $('status-select'),
  breakComposer = $('break-composer'), breakTypeEl = $('break-type'),
  breakMinsEl = $('break-minutes'), selfDot = $('self-dot'),
  selfName = $('self-name-label'), selfAvatar = $('self-avatar-label'),
  chatMessages = $('chat-messages'), chatInput = $('chat-input'),
  chatChannName = $('chat-channel-name'), proximityToast = $('proximity-toast'),
  profilePop = $('profile-popover');

let selectedAvatar = '\u{1f431}';
let zohoToken = null;

// ── Zoho OAuth popup ────────────────────────────────────────────────
function applyZohoUser(name, email, token) {
  $('join-name').value = name;
  zohoToken = token || null;
  const badge = $('zoho-user-badge');
  badge.textContent = '✓ Signed in as ' + name + (email ? ' (' + email + ')' : '');
  badge.classList.remove('hidden');
  $('zoho-login-btn').style.display = 'none';
}

$('zoho-login-btn').addEventListener('click', () => {
  const popup = window.open('/auth/zoho', 'zoho-auth',
    'width=520,height=620,left=' + ((screen.width-520)/2) + ',top=' + ((screen.height-620)/2));
  const onMsg = e => {
    if (!e.data || e.data.type !== 'zoho-auth') return;
    window.removeEventListener('message', onMsg);
    if (e.data.error) { alert('Zoho login failed — please try again.'); return; }
    applyZohoUser(e.data.name, e.data.email, e.data.token);
    if (popup && !popup.closed) popup.close();
  };
  window.addEventListener('message', onMsg);
});

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
    team: $('join-team').value.trim() || '', avatar: selectedAvatar, zohoToken });
});

$('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click(); });

function joinGame(profile) {
  joinScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  const canvas = $('meadow-canvas');
  state.canvas = canvas; state.ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  canvas.addEventListener('click', onMeadowClick);
  state.socket = io();
  bindSocket();
  state.socket.emit('join', { name: profile.name, role: profile.role,
    team: profile.team, avatar: profile.avatar, color: randomGreen(),
    zohoToken: profile.zohoToken || null });
  selfName.textContent = profile.name;
  selfAvatar.textContent = profile.avatar;
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  // Resilience: never let a held key get "stuck" when focus/visibility is lost.
  // A popup (Zoho/Meet login), tab switch, or alt-tab swallows the keyup otherwise,
  // leaving the key logically "down" — the avatar then drifts or freezes in place.
  window.addEventListener('blur', clearKeys);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearKeys(); else lastFrameTime = 0;
  });
  loop();
  setTimeout(hideMoveHint, 8000);
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
  s.on('user:moved', ({ id, x, y }) => {
    if (id === state.me?.id) return;            // we are authoritative for our own position
    const u = state.users.get(id); if (u) { u.x = x; u.y = y; }
  });
  s.on('user:status', ({ id, status, breakType, breakReturnAt, breakNote }) => {
    const u = state.users.get(id);
    if (u) Object.assign(u, { status, breakType, breakReturnAt, breakNote });
    if (id === state.me?.id) { Object.assign(state.me, { status, breakType, breakReturnAt, breakNote }); updateSelfDot(); }
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

let lastEmit = 0, lastFrameTime = 0;

function loop(ts) {
  const now = ts != null ? ts
    : (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0.016;
  lastFrameTime = now;
  if (dt > 0.1) dt = 0.1;     // tab was backgrounded/lagging and just resumed — don't teleport
  if (!(dt > 0)) dt = 0.016;  // guard against 0/NaN on the very first frame
  handleMovement(dt);
  drawMeadow();
  state.animFrame = requestAnimationFrame(loop);
}

// WASD is handled case-insensitively (Shift/CapsLock would otherwise strand an
// uppercase key whose keyup never matches); arrow keys keep their full name.
function keyName(e) { return e.key.length === 1 ? e.key.toLowerCase() : e.key; }
function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
         el.tagName === 'SELECT' || el.isContentEditable;
}
function onKeyDown(e) {
  if (isTyping()) return;          // cursor is in chat/search/admin — don't walk
  const k = keyName(e);
  if (!MOVE_KEYS.has(k)) return;
  state.keys[k] = true;
  e.preventDefault();              // stop arrows from scrolling the page
}
function onKeyUp(e) { state.keys[keyName(e)] = false; }
function clearKeys() { for (const k in state.keys) state.keys[k] = false; }

let moveHintHidden = false;
function hideMoveHint() {
  if (moveHintHidden) return;
  moveHintHidden = true;
  const h = document.getElementById('move-hint');
  if (h) { h.classList.add('fade'); setTimeout(() => h.classList.add('hidden'), 700); }
}

function handleMovement(dt) {
  if (!state.me) return;
  const step = SPEED * dt;
  let dx = 0, dy = 0;
  if (state.keys['ArrowLeft']  || state.keys['a']) dx -= 1;
  if (state.keys['ArrowRight'] || state.keys['d']) dx += 1;
  if (state.keys['ArrowUp']    || state.keys['w']) dy -= 1;
  if (state.keys['ArrowDown']  || state.keys['s']) dy += 1;

  let moved = false;
  if (dx !== 0 || dy !== 0) {
    state.moveTarget = null;                                   // keyboard cancels click-to-move
    if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }  // diagonals shouldn't be faster
    state.me.x += dx * step; state.me.y += dy * step;
    moved = true;
  } else if (state.moveTarget) {                               // walk toward a clicked point
    const tx = state.moveTarget.x - state.me.x, ty = state.moveTarget.y - state.me.y;
    const dist = Math.hypot(tx, ty);
    if (dist <= step + 0.5) { state.me.x = state.moveTarget.x; state.me.y = state.moveTarget.y; state.moveTarget = null; }
    else { state.me.x += (tx / dist) * step; state.me.y += (ty / dist) * step; }
    moved = true;
  }
  if (!moved) return;

  if (!moveHintHidden) hideMoveHint();
  state.me.x = Math.max(AVATAR_R, Math.min(MEADOW_W - AVATAR_R, state.me.x));
  state.me.y = Math.max(AVATAR_R, Math.min(MEADOW_H - AVATAR_R, state.me.y));
  const u = state.users.get(state.me.id);
  if (u) { u.x = state.me.x; u.y = state.me.y; }
  const now = Date.now();
  if (now - lastEmit > 40) {
    state.socket.emit('move', { x: Math.round(state.me.x), y: Math.round(state.me.y) });
    lastEmit = now;
  }
}

// Click anywhere on the meadow to walk there — a reliable input path that does
// not depend on keyboard focus.
function onMeadowClick(e) {
  if (!state.me || !state.view) return;
  const c = state.canvas, rect = c.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const sx = (e.clientX - rect.left) * (c.width / rect.width);
  const sy = (e.clientY - rect.top) * (c.height / rect.height);
  state.moveTarget = {
    x: Math.max(AVATAR_R, Math.min(MEADOW_W - AVATAR_R, (sx - state.view.offX) / state.view.scale)),
    y: Math.max(AVATAR_R, Math.min(MEADOW_H - AVATAR_R, (sy - state.view.offY) / state.view.scale)),
  };
  if (!moveHintHidden) hideMoveHint();
}

// ── Ghibli meadow scenery (deterministic positions so nothing flickers) ──────
const PATCHES = [
  {x:180,y:160,r:150,c:'rgba(120,190,130,0.32)'},{x:540,y:120,r:120,c:'rgba(160,214,168,0.30)'},
  {x:1000,y:240,r:170,c:'rgba(120,190,130,0.28)'},{x:780,y:580,r:150,c:'rgba(160,214,168,0.26)'},
  {x:300,y:660,r:140,c:'rgba(120,190,130,0.30)'},{x:1080,y:700,r:120,c:'rgba(160,214,168,0.28)'}
];
const TREES = [{x:120,y:130},{x:910,y:95},{x:1090,y:470},{x:210,y:600},{x:770,y:210},{x:1130,y:720}];
const BUSHES = [{x:340,y:90},{x:640,y:300},{x:980,y:600},{x:170,y:380}];
const FLOWERS = [
  {x:150,y:450,c:'#f6a5c0'},{x:700,y:110,c:'#ffd36b'},{x:950,y:360,c:'#c79bf0'},
  {x:430,y:520,c:'#ff9a9a'},{x:620,y:680,c:'#ffd36b'},{x:840,y:470,c:'#f6a5c0'},
  {x:260,y:300,c:'#c79bf0'},{x:1010,y:560,c:'#ff9a9a'},{x:540,y:250,c:'#ffd36b'},
  {x:380,y:430,c:'#f6a5c0'},{x:880,y:160,c:'#c79bf0'}
];
const GRASS = [
  {x:340,y:200},{x:600,y:430},{x:820,y:300},{x:480,y:600},{x:700,y:540},{x:240,y:500},
  {x:920,y:620},{x:1020,y:180},{x:160,y:280},{x:780,y:680},{x:450,y:160},{x:1080,y:380}
];
const MUSHROOMS = [{x:280,y:430},{x:890,y:540},{x:560,y:170}];
const POND = { x:520, y:390, rx:130, ry:82 };
const LILIES = [{dx:-40,dy:-10},{dx:35,dy:20},{dx:10,dy:-25}];

function drawMeadow() {
  const { ctx, canvas, me } = state;
  if (!ctx || !me) return;
  const W = canvas.width, H = canvas.height;
  const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  // Fit the whole 1200x800 meadow into the canvas (uniform scale, centered) — no
  // scrolling camera, so the avatar always stays on screen and visibly walks
  // around instead of being pinned to the centre while the background scrolls.
  const scale = Math.min(W / MEADOW_W, H / MEADOW_H);
  const offX = (W - MEADOW_W * scale) / 2;
  const offY = (H - MEADOW_H * scale) / 2;
  state.view = { scale, offX, offY };
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#8fcb98'; ctx.fillRect(0, 0, W, H);   // letterbox backdrop
  ctx.save();
  ctx.translate(offX, offY);
  ctx.scale(scale, scale);

  // base meadow gradient (soft, layered greens)
  const grad = ctx.createLinearGradient(0, 0, 0, MEADOW_H);
  grad.addColorStop(0, '#c4e6c9'); grad.addColorStop(0.5, '#aadcb0'); grad.addColorStop(1, '#8fcb98');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, MEADOW_W, MEADOW_H);

  for (const p of PATCHES) { ctx.beginPath(); ctx.ellipse(p.x, p.y, p.r, p.r*0.66, 0, 0, Math.PI*2); ctx.fillStyle = p.c; ctx.fill(); }
  drawPath(ctx);
  drawCloudShadows(ctx, t);
  drawPond(ctx, t);
  for (const b of BUSHES) drawBush(ctx, b.x, b.y);
  for (const tr of TREES) drawTree(ctx, tr.x, tr.y);
  for (const g of GRASS) drawGrass(ctx, g.x, g.y, t);
  for (const f of FLOWERS) drawFlower(ctx, f.x, f.y, f.c, t);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '20px serif';
  for (const m of MUSHROOMS) ctx.fillText('\u{1f344}', m.x, m.y);

  for (const [, u] of state.users) drawAvatar(ctx, u, u.id === me.id);
  ctx.restore();

  // screen-space ambience: floating pollen + warm light vignette
  drawParticles(ctx, W, H, t);
  const vig = ctx.createRadialGradient(W/2, H*0.4, Math.min(W,H)*0.2, W/2, H*0.5, Math.max(W,H)*0.75);
  vig.addColorStop(0, 'rgba(255,245,210,0)'); vig.addColorStop(1, 'rgba(120,90,40,0.14)');
  ctx.fillStyle = vig; ctx.fillRect(0, 0, W, H);
}

function drawPath(ctx) {
  ctx.save(); ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(206,180,132,0.55)'; ctx.lineWidth = 38;
  ctx.beginPath(); ctx.moveTo(-40, 210);
  ctx.bezierCurveTo(300, 320, 360, 560, 700, 540);
  ctx.bezierCurveTo(980, 520, 1040, 720, MEADOW_W + 40, 770); ctx.stroke();
  ctx.strokeStyle = 'rgba(232,214,172,0.65)'; ctx.lineWidth = 20; ctx.stroke();
  ctx.restore();
}

function drawCloudShadows(ctx, t) {
  const clouds = [{x:200,y:300,r:95},{x:700,y:520,r:130},{x:980,y:200,r:85},{x:430,y:680,r:100}];
  for (const c of clouds) {
    const cx = ((c.x + t*10) % (MEADOW_W + 320)) - 160;
    ctx.beginPath(); ctx.ellipse(cx, c.y, c.r, c.r*0.5, 0, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(70,110,80,0.06)'; ctx.fill();
  }
}

function drawPond(ctx, t) {
  ctx.save();
  ctx.beginPath(); ctx.ellipse(POND.x, POND.y, POND.rx+9, POND.ry+9, 0, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(90,150,120,0.30)'; ctx.fill();
  const g = ctx.createRadialGradient(POND.x-24, POND.y-18, 12, POND.x, POND.y, POND.rx);
  g.addColorStop(0, '#cdeef6'); g.addColorStop(1, '#7fc2dd');
  ctx.beginPath(); ctx.ellipse(POND.x, POND.y, POND.rx, POND.ry, 0, 0, Math.PI*2);
  ctx.fillStyle = g; ctx.fill();
  const rp = (t * 18) % 64;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5;
  ctx.globalAlpha = Math.max(0, 1 - rp/64);
  ctx.beginPath(); ctx.ellipse(POND.x, POND.y, 22+rp, (22+rp)*0.62, 0, 0, Math.PI*2); ctx.stroke();
  ctx.globalAlpha = 1;
  for (const l of LILIES) { ctx.beginPath(); ctx.ellipse(POND.x+l.dx, POND.y+l.dy, 9, 6, 0.3, 0, Math.PI*2); ctx.fillStyle = '#5fae6b'; ctx.fill(); }
  ctx.restore();
}

function drawTree(ctx, x, y) {
  ctx.beginPath(); ctx.ellipse(x, y+34, 30, 11, 0, 0, Math.PI*2); ctx.fillStyle = 'rgba(60,90,60,0.22)'; ctx.fill();
  ctx.fillStyle = '#9b6b43'; ctx.fillRect(x-5, y+8, 10, 28);
  const layers = [{dx:-19,dy:0,r:23,c:'#56995f'},{dx:19,dy:0,r:23,c:'#56995f'},{dx:0,dy:-20,r:29,c:'#6fb074'},{dx:0,dy:-2,r:30,c:'#63a86b'}];
  for (const L of layers) { ctx.beginPath(); ctx.arc(x+L.dx, y+L.dy, L.r, 0, Math.PI*2); ctx.fillStyle = L.c; ctx.fill(); }
  ctx.beginPath(); ctx.arc(x-9, y-26, 9, 0, Math.PI*2); ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fill();
}

function drawBush(ctx, x, y) {
  ctx.beginPath(); ctx.ellipse(x, y+10, 24, 8, 0, 0, Math.PI*2); ctx.fillStyle = 'rgba(60,90,60,0.18)'; ctx.fill();
  for (const d of [{dx:-13,r:14},{dx:13,r:14},{dx:0,r:17}]) { ctx.beginPath(); ctx.arc(x+d.dx, y, d.r, 0, Math.PI*2); ctx.fillStyle = '#62a96a'; ctx.fill(); }
}

function drawFlower(ctx, x, y, c, t) {
  const sway = Math.sin(t*1.4 + x*0.05) * 2;
  ctx.save(); ctx.translate(x + sway, y);
  ctx.strokeStyle = '#5a9470'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0,2); ctx.lineTo(-sway, 11); ctx.stroke();
  for (let i = 0; i < 5; i++) { const a = i*Math.PI*2/5; ctx.beginPath(); ctx.arc(Math.cos(a)*4.5, Math.sin(a)*4.5 - 2, 3, 0, Math.PI*2); ctx.fillStyle = c; ctx.fill(); }
  ctx.beginPath(); ctx.arc(0, -2, 2.3, 0, Math.PI*2); ctx.fillStyle = '#fff3c4'; ctx.fill();
  ctx.restore();
}

function drawGrass(ctx, x, y, t) {
  const sway = Math.sin(t*2 + x*0.03);
  ctx.strokeStyle = '#5a9470'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(x+i*4, y); ctx.quadraticCurveTo(x+i*4+sway*3, y-8, x+i*4+sway*6, y-15); ctx.stroke(); }
}

function drawParticles(ctx, W, H, t) {
  for (let i = 0; i < 20; i++) {
    const px = (i*137 + t*16 + Math.sin(t*0.6 + i)*45) % W;
    const py = (i*83 + Math.sin(t*0.9 + i*1.3)*28 + t*5) % H;
    ctx.beginPath(); ctx.arc(px, py, 1.5 + Math.sin(t + i)*0.6, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,250,200,0.5)'; ctx.fill();
  }
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
  ctx.fillText(u.avatar || '\u{1f431}', x, y);
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
      if (u.breakNote) breakInfo += '<span class="member-break-note">' + escHtml(u.breakNote) + '</span>';
      sub = '';
    }
    li.innerHTML = '<span class="member-emoji">' + (u.avatar||'\u{1f431}') + '</span>' +
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

function emitStatus(status, breakType, breakReturnAt, breakNote) {
  if (!state.socket || !state.me) return;
  breakNote = breakNote || null;
  Object.assign(state.me, { status, breakType, breakReturnAt, breakNote });
  const u = state.users.get(state.me.id);
  if (u) Object.assign(u, { status, breakType, breakReturnAt, breakNote });
  state.socket.emit('status:set', { status, breakType, breakReturnAt, breakNote });
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
    refreshChatView();
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

function renderChatMsg(msg, highlight) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (msg.fromSlack ? ' msg-from-slack' : '');
  div.dataset.msgId = msg.id;
  const time = new Date(msg.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const rawText = escHtml(msg.text);
  const displayText = highlight
    ? rawText.replace(new RegExp('(' + escRegex(escHtml(highlight)) + ')', 'gi'),
        '<mark class="msg-highlight">$1</mark>')
    : rawText;
  const slackBadge = msg.fromSlack ? '<span class="slack-badge">Slack</span>' : '';
  div.innerHTML = '<div class="msg-avatar">' + (msg.avatar||'\u{1f431}') + '</div>' +
    '<div class="msg-body"><div class="msg-header"><span class="msg-name">' + msg.userName +
    slackBadge + '</span><span class="msg-time">' + time + '</span></div>' +
    '<div class="msg-text">' + displayText + '</div></div>';
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
  $('pop-avatar').textContent = u.avatar || '\u{1f431}';
  $('pop-name').textContent = u.name;
  $('pop-role').textContent = u.role || 'Team Member';
  let statusTxt = STATUS_LABEL[u.status] || 'Available';
  if (u.status === 'break' && u.breakType) {
    const emoji = BREAK_EMOJI[u.breakType] || '⏸';
    const cd = u.breakReturnAt ? getCountdown(u.breakReturnAt) : '';
    statusTxt = emoji + ' On ' + u.breakType + ' break' + (cd ? ' · back in ' + cd : '');
  }
  $('pop-status').textContent = statusTxt;
  $('pop-team').textContent = u.team ? ('Team: ' + u.team) : '';
  $('pop-activity').textContent = (u.status === 'break' && u.breakNote)
    ? ('“' + u.breakNote + '”')
    : (u.activity ? ('Currently: ' + u.activity) : '');
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
  profilePop.style.left = Math.max(4, rect.right + 8) + 'px';
  profilePop.classList.remove('hidden');
}

$('popover-close-btn').addEventListener('click', () => profilePop.classList.add('hidden'));

// ── Zoho Meeting quick-start ────────────────────────────────────────────
$('quick-meet-btn').addEventListener('click', async () => {
  const btn = $('quick-meet-btn');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Creating meeting…';
  try {
    const res = await fetch('/api/meet/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Quick Meet — ' + (state.me?.name || 'Commons') })
    });
    const data = await res.json();
    if (data.meetLink) {
      window.open(data.meetLink, '_blank');
      if (state.socket && state.me) state.socket.emit('user:profile', { zohoMeetLink: data.meetLink });
    } else {
      alert('Could not start meeting: ' + (data.error || 'Zoho not configured'));
    }
  } catch (e) { alert('Error: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = original; }
});

// ── Helpers ───────────────────────────────────────────────────────────────────────────────
function getCountdown(isoStr) {
  if (!isoStr) return '';
  const diff = new Date(isoStr) - new Date();
  if (diff <= 0) return '';
  return Math.ceil(diff / 60000) + 'm';
}

function showProximityToast(other, meetLink) {
  $('toast-avatar').textContent = other.avatar || '\u{1f431}';
  $('toast-name').textContent = other.name;
  const link = $('toast-meet-link');
  link.href = meetLink || '#';
  link.style.display = meetLink ? '' : 'none';
  proximityToast.classList.remove('hidden');
}

function dismissToast() { proximityToast.classList.add('hidden'); }
window.dismissToast = dismissToast;

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Chat search ─────────────────────────────────────────────────────────────────────────────
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

// ── Break: custom minutes + return display + auto-return ──────────────────────────────────
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
  const note = $('break-note').value.trim();
  emitStatus('break', type, returnAt, note);
  const retTime = new Date(returnAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  breakReturnTimeEl.textContent = retTime;
  breakReturnDisplay.classList.remove('hidden');
});

breakCancelBtn.addEventListener('click', () => {
  emitStatus('available', null, null);
  $('status-select').value = 'available';
  breakComposer.classList.add('hidden');
  breakReturnDisplay.classList.add('hidden');
  $('break-note').value = '';
});

setInterval(() => {
  if (state.me && state.me.status === 'break' && state.me.breakReturnAt) {
    if (new Date(state.me.breakReturnAt) <= new Date()) {
      emitStatus('available', null, null);
      $('status-select').value = 'available';
      breakComposer.classList.add('hidden');
      breakReturnDisplay.classList.add('hidden');
      $('break-note').value = '';
      addSystemMsg('Your break is over — you are back as Available');
    }
  }
}, 10000);

// ── Admin panel ───────────────────────────────────────────────────────────────────────────────
$('admin-open-btn').addEventListener('click', () => $('admin-modal').classList.remove('hidden'));
$('admin-close').addEventListener('click', () => $('admin-modal').classList.add('hidden'));

let adminPwd = '';
$('admin-login-btn').addEventListener('click', fetchAttendance);
$('admin-pwd-input').addEventListener('keydown', e => { if (e.key === 'Enter') fetchAttendance(); });
$('admin-refresh-btn').addEventListener('click', fetchAttendance);

$('admin-reset-btn').addEventListener('click', async () => {
  if (!adminPwd) return;
  if (!confirm('Kick everyone and reset the room?')) return;
  const res = await fetch('/api/admin/reset?pwd=' + encodeURIComponent(adminPwd), { method: 'POST' });
  if (res.status === 401) { alert('Wrong password'); return; }
  alert('Room reset — all users disconnected.');
  renderLiveUsers([]);
});

async function fetchAttendance() {
  adminPwd = $('admin-pwd-input').value;
  try {
    const [attRes, usersRes] = await Promise.all([
      fetch('/api/admin/attendance?pwd=' + encodeURIComponent(adminPwd)),
      fetch('/api/admin/users?pwd=' + encodeURIComponent(adminPwd))
    ]);
    if (attRes.status === 401) { alert('Wrong password'); return; }
    const { log, count } = await attRes.json();
    const { users: liveUsers } = await usersRes.json();
    $('admin-auth').classList.add('hidden');
    $('admin-content').classList.remove('hidden');
    $('admin-count').textContent = count + ' events';
    renderLiveUsers(liveUsers);
    renderAttendanceTable(log);
  } catch (e) { alert('Error: ' + e.message); }
}

function renderLiveUsers(liveUsers) {
  const tbody = $('admin-live-tbody');
  tbody.innerHTML = '';
  $('admin-live-count').textContent = liveUsers.length + ' online';
  for (const u of liveUsers) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + (u.avatar||'\u{1f431}') + ' ' + escHtml(u.name) + '</td>' +
      '<td>' + escHtml(u.role||'') + '</td>' +
      '<td>' + escHtml(STATUS_LABEL[u.status] || u.status) + '</td>' +
      '<td><button class="btn-sm btn-danger" data-uid="' + u.id + '">Remove</button></td>';
    tr.querySelector('button').addEventListener('click', async () => {
      if (!confirm('Remove ' + u.name + ' from the room?')) return;
      await fetch('/api/admin/user/' + u.id + '?pwd=' + encodeURIComponent(adminPwd), { method: 'DELETE' });
      tr.remove();
      const cnt = parseInt($('admin-live-count').textContent) - 1;
      $('admin-live-count').textContent = Math.max(0, cnt) + ' online';
    });
    tbody.appendChild(tr);
  }
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
    let details = entry.breakType ? (entry.breakType + (retTime ? ' back at ' + retTime : '')) : '';
    if (entry.breakNote) details += (details ? ' — ' : '') + entry.breakNote;
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

// ── Admin: integrations health check ─────────────────────────────────────────
$('diag-btn').addEventListener('click', async () => {
  $('diag-result').innerHTML = '<div class="diag-row">Checking…</div>';
  try {
    const r = await fetch('/api/admin/diagnostics?pwd=' + encodeURIComponent(adminPwd));
    if (r.status === 401) { $('diag-result').innerHTML = '<div class="diag-row err">Wrong password</div>'; return; }
    renderDiagnostics(await r.json());
  } catch (e) { $('diag-result').innerHTML = '<div class="diag-row err">Error: ' + escHtml(e.message) + '</div>'; }
});

function renderDiagnostics(d) {
  const line = (label, info) => {
    if (!info || !info.set) {
      return '<div class="diag-row"><span class="diag-dot off"></span><b>' + label + '</b> <span class="diag-dim">not configured</span></div>';
    }
    if (info.ok) {
      let detail = 'ok';
      if (label === 'Slack') detail = info.team ? (info.team + ' · ' + info.bot) : 'ok';
      else if (label === 'Zoho') detail = info.org ? ('org ' + info.org + (info.email ? ' · ' + info.email : '')) : (info.note || 'ok');
      else if (label === 'Claude') detail = info.models ? (info.models + ' models available') : 'ok';
      else if (label === 'Transcription') detail = info.provider + ' · ' + info.model;
      return '<div class="diag-row"><span class="diag-dot ok"></span><b>' + label + '</b> <span class="diag-dim">' + escHtml(detail) + '</span></div>';
    }
    return '<div class="diag-row"><span class="diag-dot err"></span><b>' + label + '</b> <span class="diag-dim">' + escHtml(info.error || 'failed') + '</span></div>';
  };
  $('diag-result').innerHTML =
    line('Slack', d.slack) + line('Zoho', d.zoho) + line('Claude', d.anthropic) + line('Transcription', d.transcription);
}

// ── AI Notetaker ────────────────────────────────────────────────────────────
const notesModal = $('notes-modal');
$('notes-open-btn').addEventListener('click', async () => {
  notesModal.classList.remove('hidden');
  if (!$('notes-attendees').value) {
    const names = Array.from(state.users.values()).map(u => u.name).filter(Boolean);
    $('notes-attendees').value = names.join(', ');
  }
  try {
    const cfg = await (await fetch('/api/notes/config')).json();
    const parts = [
      cfg.stt ? '🎙️ Transcription: ' + cfg.stt : '🎙️ Transcription: not set — paste a transcript',
      cfg.claude ? '🧠 Summaries: Claude' : '🧠 Summaries: basic (no Claude key)',
      cfg.slack ? '💬 Slack: ready' : '💬 Slack: not set'
    ];
    $('notes-config-hint').innerHTML = parts.map(p => '<span>' + p + '</span>').join('');
  } catch (e) { /* config hint is best-effort */ }
});
$('notes-close').addEventListener('click', () => notesModal.classList.add('hidden'));

$('notes-run-btn').addEventListener('click', async () => {
  const file = $('notes-audio').files[0];
  const transcript = $('notes-transcript').value.trim();
  if (!file && !transcript) { setNotesStatus('Add a recording or paste a transcript first.', 'err'); return; }
  const fd = new FormData();
  if (transcript) fd.append('transcript', transcript);
  else fd.append('audio', file);
  fd.append('attendees', $('notes-attendees').value);
  fd.append('send', $('notes-send').checked ? 'true' : 'false');
  fd.append('channel', $('notes-channel').value || '#general');

  const btn = $('notes-run-btn'); btn.disabled = true;
  $('notes-result').classList.add('hidden');
  setNotesStatus(file && !transcript ? 'Transcribing & summarizing… (longer recordings take a bit)' : 'Summarizing…', 'busy');
  try {
    const res = await fetch('/api/notes/process', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { setNotesStatus(data.error || 'Failed to process.', 'err'); return; }
    renderNotesResult(data);
    setNotesStatus(data.delivery && data.delivery.attempted ? 'Done — see delivery status below.' : 'Done.', 'ok');
  } catch (e) { setNotesStatus('Error: ' + e.message, 'err'); }
  finally { btn.disabled = false; }
});

function setNotesStatus(text, kind) {
  const el = $('notes-status');
  el.className = 'notes-status notes-' + (kind || 'busy');
  el.textContent = text;
  el.classList.remove('hidden');
}

function renderNotesResult(data) {
  const mom = data.mom || {};
  let html = '';
  html += '<div class="notes-section-title">Summary <span class="notes-engine">' + escHtml(mom._engine || '') + '</span></div>';
  html += '<p class="notes-summary">' + escHtml(mom.summary || '') + '</p>';
  if ((mom.decisions || []).length) {
    html += '<div class="notes-section-title">Decisions</div><ul class="notes-list">';
    for (const d of mom.decisions) html += '<li>' + escHtml(d) + '</li>';
    html += '</ul>';
  }
  html += '<div class="notes-section-title">Action items</div>';
  const items = mom.action_items || [];
  if (items.length) {
    html += '<table class="notes-table"><thead><tr><th>Owner</th><th>Task</th><th>Due</th></tr></thead><tbody>';
    for (const it of items) {
      html += '<tr><td>' + escHtml(it.owner || 'Unassigned') + '</td><td>' + escHtml(it.task || '') +
              '</td><td>' + escHtml(it.due || '—') + '</td></tr>';
    }
    html += '</tbody></table>';
  } else {
    html += '<p class="notes-dim">No action items detected.</p>';
  }
  const d = data.delivery || {};
  if (d.attempted) {
    if (d.error) {
      html += '<div class="notes-deliver err">Slack: ' + escHtml(d.error) + '</div>';
    } else {
      const summary = 'Slack summary → ' + escHtml(d.channel) + ': ' +
        (d.summaryPosted ? 'posted ✓' : 'failed' + (d.summaryError ? ' (' + escHtml(d.summaryError) + ')' : ''));
      const dms = (d.dms || []).map(x => escHtml(x.member) + ': ' +
        (x.ok ? 'DM ✓' : 'skipped' + (x.reason ? ' (' + escHtml(x.reason) + ')' : '') + (x.error ? ' (' + escHtml(x.error) + ')' : ''))).join(' · ');
      html += '<div class="notes-deliver">' + summary + (dms ? '<br>' + dms : '') + '</div>';
    }
  }
  if (data.transcriptMeta) {
    html += '<div class="notes-dim notes-transmeta">Transcribed via ' + escHtml(data.transcriptMeta.provider) +
            ' (' + escHtml(data.transcriptMeta.model) + ')</div>';
  }
  const el = $('notes-result');
  el.innerHTML = html;
  el.classList.remove('hidden');
}
