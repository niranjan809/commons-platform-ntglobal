require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Zoho OAuth callback: Zoho redirects to root URL with ?code= (matches registered redirect URI)
app.get('/', async (req, res, next) => {
  if (!req.query.code) return next();
  const RURI = process.env.BASE_URL || 'https://commons-platform-ntglobal-production.up.railway.app';
  try {
    const tokenRes = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
      params: {
        grant_type: 'authorization_code',
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri: RURI,
        code: req.query.code
      }
    });
    const access_token = tokenRes.data.access_token;
    let name = 'Zoho User', email = '';
    try {
      const profileRes = await axios.get('https://accounts.zoho.in/oauth/v2/userinfo', {
        headers: { Authorization: 'Zoho-oauthtoken ' + access_token }
      });
      const p = profileRes.data;
      name = ((p.First_Name || p.given_name || '') + ' ' + (p.Last_Name || p.family_name || '')).trim()
             || p.Display_Name || p.name || 'Zoho User';
      email = p.Email || p.email || '';
    } catch (pe) { console.error('Profile fetch (non-fatal):', pe.message); }
    const payload = JSON.stringify({ type: 'zoho-auth', name, email, token: access_token });
    res.send('<!DOCTYPE html><html><body><script>if(window.opener){window.opener.postMessage(' + payload + ',"*");window.close();}else{location.href="/";}</script></body></html>');
  } catch (e) {
    console.error('Zoho token exchange error:', e.message, e.response && JSON.stringify(e.response.data));
    res.send('<script>window.opener&&window.opener.postMessage({type:"zoho-auth",error:"auth_failed"},"*");window.close();</script>');
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();
const PROXIMITY_RADIUS = 80;
const huddles = new Map();

// -- Attendance log
const attendanceLog = [];
function logAttendance(type, user, extra = {}) {
  attendanceLog.push({
    type, userId: user.id, userName: user.name,
    avatar: user.avatar || '🐱', role: user.role || '',
    ts: new Date().toISOString(), ...extra
  });
  if (attendanceLog.length > 10000) attendanceLog.shift();
}

// -- Chat history (per channel, last 500 msgs)
const chatHistory = { general: [], random: [], team: [] };
function storeChatMsg(msg) {
  const ch = msg.channel || 'general';
  if (!chatHistory[ch]) chatHistory[ch] = [];
  chatHistory[ch].push(msg);
  if (chatHistory[ch].length > 500) chatHistory[ch].shift();
}

function getUsersArray() {
  return Array.from(users.values()).map(u => ({ ...u, socketId: undefined, zohoToken: undefined }));
}

function checkProximity(movedUser) {
  const nearby = [];
  for (const [, other] of users) {
    if (other.id === movedUser.id) continue;
    const dx = movedUser.x - other.x;
    const dy = movedUser.y - other.y;
    if (Math.sqrt(dx*dx + dy*dy) <= PROXIMITY_RADIUS) nearby.push(other);
  }
  return nearby;
}

function huddleKey(a, b) { return [a, b].sort().join('::'); }

async function refreshZohoToken() {
  if (!process.env.ZOHO_REFRESH_TOKEN || !process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_CLIENT_SECRET) return null;
  try {
    const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
      params: {
        grant_type: 'refresh_token',
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        refresh_token: process.env.ZOHO_REFRESH_TOKEN
      }
    });
    if (res.data && res.data.access_token) {
      process.env.ZOHO_ACCESS_TOKEN = res.data.access_token;
      console.log('Zoho token refreshed successfully');
      return res.data.access_token;
    }
    console.error('Refresh missing access_token:', JSON.stringify(res.data).substring(0, 200));
  } catch (e) {
    console.error('Token refresh failed:', e.message, JSON.stringify(e.response && e.response.data).substring(0, 150));
  }
  return null;
}

async function createZohoMeeting(topic, userToken) {
  let token = userToken || process.env.ZOHO_ACCESS_TOKEN;
  if (!token) return null;

  async function attempt(tok) {
    let zsoid = process.env.ZOHO_ORG_ID || null;
    let presenterZuid = null;

    if (!zsoid) {
      try {
        const infoRes = await axios.get('https://accounts.zoho.in/oauth/v2/userinfo', {
          headers: { Authorization: 'Zoho-oauthtoken ' + tok }
        });
        console.log('Userinfo:', JSON.stringify(infoRes.data).substring(0, 200));
        const d = infoRes.data;
        zsoid = d.ZSOID || d.zsoid || d.org_id;
        presenterZuid = d.ZUID || d.sub || d.userId || d.id;
      } catch (ie) {
        const status = ie.response && ie.response.status;
        console.error('Userinfo failed (' + status + '):', ie.message);
        if (status === 401) throw { needsRefresh: true };
      }
    }

    if (!zsoid) {
      console.error('No zsoid -- add ZOHO_ORG_ID to Railway env vars');
      return null;
    }

    const now = new Date(Date.now() + (5 * 60 + 30) * 60000 + 3 * 60000);
    const pad = n => String(n).padStart(2, '0');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const h24 = now.getUTCHours();
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 || 12;
    const startTime = months[now.getUTCMonth()] + ' ' + pad(now.getUTCDate()) + ', ' + now.getUTCFullYear() +
      ' ' + pad(h12) + ':' + pad(now.getUTCMinutes()) + ' ' + ampm;

    const presenter = presenterZuid || process.env.ZOHO_PRESENTER_ZUIDD || null;
    const sessionPayload = { session: {
      topic: topic || 'Office Huddle',
      startTime, duration: 3600000, timezone: 'Asia/Calcutta',
      ...(presenter ? { presenter: Number(presenter) } : {})
    }};

    const res = await axios.post(
      'https://meeting.zoho.in/api/v2/' + zsoid + '/sessions.json',
      sessionPayload,
      { headers: { Authorization: 'Zoho-oauthtoken ' + tok, 'Content-Type': 'application/json;charset=UTF-8' } }
    );
    console.log('Zoho Meeting created:', JSON.stringify(res.data).substring(0, 300));
    const m = res.data && (res.data.session || res.data);
    return (m && (m.joinLink || m.join_url || m.joinUrl || m.joinlink || m.join_link)) || null;
  }

  try {
    return await attempt(token);
  } catch (e) {
    const status = e.response && e.response.status;
    if (e.needsRefresh || status === 401) {
      console.log('Token expired (status ' + status + ') -- refreshing...');
      const fresh = await refreshZohoToken();
      if (fresh) {
        try { return await attempt(fresh); } catch (e2) {
          console.error('Meeting error after refresh:', e2.message, JSON.stringify(e2.response && e2.response.data).substring(0, 200));
        }
      }
    } else {
      console.error('Zoho Meeting error:', e.message, JSON.stringify(e.response && e.response.data).substring(0, 300));
    }
    return null;
  }
}

async function postSlackMessage(channel, text) {
  if (!process.env.SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', { channel, text },
      { headers: { Authorization: 'Bearer ' + process.env.SLACK_BOT_TOKEN } });
  } catch (e) { console.error('Slack error:', e.message); }
}

async function updateSlackStatus(slackUsername, statusText, statusEmoji) {
  if (!process.env.SLACK_BOT_TOKEN || !slackUsername) return;
  try {
    await axios.post('https://slack.com/api/users.profile.set',
      { profile: { status_text: statusText, status_emoji: statusEmoji } },
      { headers: { Authorization: 'Bearer ' + process.env.SLACK_BOT_TOKEN } });
  } catch (e) { console.error('Slack status error:', e.message); }
}

io.on('connection', (socket) => {
  console.log('Client connected: ' + socket.id);

  socket.on('join', (data) => {
    const user = {
      id: socket.id, socketId: socket.id,
      name: data.name || 'Unnamed', role: data.role || 'Team Member',
      avatar: data.avatar || '🐱', color: data.color || '#7ec8a0',
      x: data.x || Math.floor(Math.random() * 600 + 100),
      y: data.y || Math.floor(Math.random() * 400 + 100),
      status: 'available', breakType: null, breakReturnAt: null, breakNote: null,
      slackUsername: data.slackUsername || '', zohoMeetLink: data.zohoMeetLink || '',
      zohoToken: data.zohoToken || null,
      activity: '', team: data.team || ''
    };
    users.set(socket.id, user);
    logAttendance('join', user);
    socket.emit('init', { you: user, users: getUsersArray() });
    for (const [ch, msgs] of Object.entries(chatHistory)) {
      if (msgs.length) socket.emit('chat:history', { channel: ch, messages: msgs });
    }
    socket.broadcast.emit('user:joined', user);
    console.log(user.name + ' joined' + (user.zohoToken ? ' (Zoho SSO)' : ''));
  });

  socket.on('move', ({ x, y }) => {
    const user = users.get(socket.id);
    if (!user) return;
    user.x = x; user.y = y;
    io.emit('user:moved', { id: socket.id, x, y });

    const nearby = checkProximity(user);
    for (const other of nearby) {
      const key = huddleKey(socket.id, other.id);
      if (!huddles.has(key)) {
        huddles.set(key, { zohoMeetLink: null, createdAt: Date.now() });
        const meetToken = user.zohoToken || other.zohoToken || null;
        createZohoMeeting('Huddle: ' + user.name + ' & ' + other.name, meetToken).then((meetLink) => {
          huddles.set(key, { zohoMeetLink: meetLink, createdAt: Date.now() });
          io.to(socket.id).emit('proximity:meet', { with: other, meetLink });
          io.to(other.id).emit('proximity:meet', { with: user, meetLink });
          if (user.slackUsername) postSlackMessage(user.slackUsername,
            'You are near *' + other.name + '* in the office -- Zoho huddle: ' + meetLink);
          if (other.slackUsername) postSlackMessage(other.slackUsername,
            'You are near *' + user.name + '* in the office -- Zoho huddle: ' + meetLink);
        });
      }
    }

    for (const [key] of huddles) {
      const parts = key.split('::');
      if (parts[0] === socket.id || parts[1] === socket.id) {
        const otherId = parts[0] === socket.id ? parts[1] : parts[0];
        const otherUser = users.get(otherId);
        if (otherUser) {
          const dx = user.x - otherUser.x;
          const dy = user.y - otherUser.y;
          if (Math.sqrt(dx*dx + dy*dy) > PROXIMITY_RADIUS * 1.5) {
            huddles.delete(key);
            io.to(socket.id).emit('proximity:left', { with: otherUser });
            io.to(otherId).emit('proximity:left', { with: user });
          }
        }
      }
    }
  });

  socket.on('status:set', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    user.status = data.status;
    user.breakType = data.breakType || null;
    user.breakReturnAt = data.breakReturnAt || null;
    user.breakNote = (data.breakNote || '').toString().trim().slice(0, 80) || null;
    logAttendance(data.status, user, data.breakType ? { breakType: data.breakType, breakReturnAt: data.breakReturnAt, breakNote: user.breakNote } : {});
    io.emit('user:status', { id: socket.id, status: user.status, breakType: user.breakType, breakReturnAt: user.breakReturnAt, breakNote: user.breakNote });
    const emojiMap = { available: ':large_green_circle:', busy: ':red_circle:', break: ':pause_button:', offline: ':black_circle:' };
    let breakText = data.breakType ? 'On ' + data.breakType + ' break' : 'On break';
    if (user.breakNote) breakText += ' — ' + user.breakNote;
    const textMap = { available: 'In the office', busy: 'Busy', break: breakText, offline: 'Away' };
    updateSlackStatus(user.slackUsername, textMap[data.status] || '', emojiMap[data.status] || '');
  });

  socket.on('profile:update', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    if (data.role !== undefined) user.role = data.role;
    if (data.slackUsername !== undefined) user.slackUsername = data.slackUsername;
    if (data.zohoMeetLink !== undefined) user.zohoMeetLink = data.zohoMeetLink;
    if (data.activity !== undefined) user.activity = data.activity;
    if (data.team !== undefined) user.team = data.team;
    io.emit('user:profile', { id: socket.id, ...data });
  });

  socket.on('chat:send', ({ text, channel }) => {
    const user = users.get(socket.id);
    if (!user || !text.trim()) return;
    const msg = {
      id: Date.now(), userId: socket.id, userName: user.name,
      avatar: user.avatar, color: user.color, text: text.trim(),
      channel: channel || 'general', ts: new Date().toISOString()
    };
    storeChatMsg(msg);
    io.emit('chat:message', msg);
    if (process.env.SLACK_BOT_TOKEN) {
      postSlackMessage('#' + (channel || 'general'), '*' + user.name + '*: ' + text.trim());
    }
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      logAttendance('leave', user);
      console.log(user.name + ' disconnected');
      users.delete(socket.id);
      for (const key of huddles.keys()) {
        if (key.includes(socket.id)) huddles.delete(key);
      }
      io.emit('user:left', { id: socket.id });
    }
  });
});

app.post('/api/meet/create', async (req, res) => {
  try {
    const meetLink = await createZohoMeeting((req.body && req.body.topic) || 'Office Meeting');
    res.json({ meetLink });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/users', (req, res) => {
  res.json(getUsersArray());
});

const REDIRECT_URI = process.env.BASE_URL || 'https://commons-platform-ntglobal-production.up.railway.app';

app.get('/auth/zoho', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ZOHO_CLIENT_ID || '',
    redirect_uri: REDIRECT_URI,
    scope: 'ZohoMeeting.meeting.CREATE',
    access_type: 'offline'
  });
  res.redirect('https://accounts.zoho.in/oauth/v2/auth?' + params);
});

app.get('/auth/zoho/callback', async (req, res) => {
  if (!req.query.code) {
    return res.send('<script>window.opener&&window.opener.postMessage({type:"zoho-auth",error:"no_code"},"*");window.close();</script>');
  }
  try {
    const tokenRes = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
      params: {
        grant_type: 'authorization_code',
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code: req.query.code
      }
    });
    const access_token = tokenRes.data.access_token;
    let name = 'Zoho User', email = '';
    try {
      const profileRes = await axios.get('https://accounts.zoho.in/oauth/v2/userinfo', {
        headers: { Authorization: 'Zoho-oauthtoken ' + access_token }
      });
      const p = profileRes.data;
      name = ((p.First_Name || p.given_name || '') + ' ' + (p.Last_Name || p.family_name || '')).trim()
             || p.Display_Name || p.name || 'Zoho User';
      email = p.Email || p.email || '';
    } catch (pe) {
      console.error('Profile fetch (non-fatal):', pe.message);
    }
    const payload = JSON.stringify({ type: 'zoho-auth', name, email, token: access_token });
    res.send('<!DOCTYPE html><html><body><script>if(window.opener){window.opener.postMessage(' + payload + ',"*");window.close();}else{location.href="/";}</script></body></html>');
  } catch (e) {
    console.error('Zoho token exchange error:', e.message, e.response && JSON.stringify(e.response.data));
    res.send('<script>window.opener&&window.opener.postMessage({type:"zoho-auth",error:"auth_failed"},"*");window.close();</script>');
  }
});

// Admin: remove individual user
app.delete('/api/admin/user/:id', (req, res) => {
  const pwd = req.query.pwd;
  const required = process.env.ADMIN_PASSWORD || 'commons-admin-2026';
  if (pwd !== required) return res.status(401).json({ error: 'Unauthorized' });
  const user = users.get(req.params.id);
  if (user) {
    const sock = io.sockets.sockets.get(user.socketId);
    if (sock) sock.disconnect(true);
    users.delete(req.params.id);
    io.emit('users', getUsersArray());
    logAttendance('removed', user);
  }
  res.json({ ok: true });
});

// Admin: reset room (kick everyone)
app.post('/api/admin/reset', (req, res) => {
  const pwd = req.query.pwd;
  const required = process.env.ADMIN_PASSWORD || 'commons-admin-2026';
  if (pwd !== required) return res.status(401).json({ error: 'Unauthorized' });
  for (const [, user] of users) {
    const sock = io.sockets.sockets.get(user.socketId);
    if (sock) sock.disconnect(true);
  }
  users.clear();
  io.emit('users', []);
  res.json({ ok: true });
});

// Admin: live users list
app.get('/api/admin/users', (req, res) => {
  const pwd = req.query.pwd;
  const required = process.env.ADMIN_PASSWORD || 'commons-admin-2026';
  if (pwd !== required) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ users: getUsersArray() });
});

// Admin: attendance log
app.get('/api/admin/attendance', (req, res) => {
  const pwd = req.query.pwd || req.headers['x-admin-pwd'];
  const required = process.env.ADMIN_PASSWORD || 'commons-admin-2026';
  if (pwd !== required) return res.status(401).json({ error: 'Wrong password' });
  res.json({ log: attendanceLog.slice().reverse(), count: attendanceLog.length });
});

// Slack Events API webhook
app.post('/api/slack/events', express.raw({ type: 'application/json' }), (req, res) => {
  let body;
  try { body = JSON.parse(req.body); } catch { return res.sendStatus(400); }
  if (body.type === 'url_verification') return res.json({ challenge: body.challenge });
  if (body.event && body.event.type === 'message' && !body.event.subtype && !body.event.bot_id) {
    const evt = body.event;
    const chMap = { [process.env.SLACK_GENERAL_ID||'']: 'general', [process.env.SLACK_RANDOM_ID||'']: 'random', [process.env.SLACK_TEAM_ID||'']: 'team' };
    const channel = chMap[evt.channel] || 'general';
    const msg = {
      id: Date.now(), userId: 'slack:' + evt.user,
      userName: evt.username || ('Slack/' + evt.user),
      avatar: '💬', color: '#4A154B',
      text: evt.text || '', channel, ts: new Date().toISOString(), fromSlack: true
    };
    storeChatMsg(msg);
    io.emit('chat:message', msg);
  }
  res.sendStatus(200);
});

// Chat history endpoint
app.get('/api/chat/history', (req, res) => {
  const ch = req.query.channel || 'general';
  res.json({ messages: chatHistory[ch] || [] });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Commons Platform running at http://localhost:' + PORT);
});
