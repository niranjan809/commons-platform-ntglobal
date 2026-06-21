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

const BASE_URL = process.env.BASE_URL || 'https://commons-platform-ntglobal-production.up.railway.app';
const REDIRECT_URI = BASE_URL;

// ── Zoho OAuth Login ─────────────────────────────────────────────────────────
app.get('/auth/zoho', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ZOHO_CLIENT_ID,
    scope: 'ZohoMeeting.meeting.CREATE',
    redirect_uri: REDIRECT_URI,
    access_type: 'offline',
    prompt: 'consent'
  });
  res.redirect('https://accounts.zoho.in/oauth/v2/auth?' + params);
});

// Root: handles Zoho OAuth callback (when ?code= present) then serves the app
app.get('/', async (req, res, next) => {
  if (!req.query.code) return next();
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
    console.log('Zoho token exchange OK:', JSON.stringify(tokenRes.data).substring(0, 200));
    const access_token = tokenRes.data.access_token;

    // Try profile fetch — non-fatal if it fails
    let name = 'Zoho User', email = '';
    try {
      const profileRes = await axios.get('https://accounts.zoho.in/oauth/v2/user', {
        headers: { Authorization: 'Zoho-oauthtoken ' + access_token }
      });
      const p = profileRes.data;
      name = ((p.First_Name || p.given_name || '') + ' ' + (p.Last_Name || p.family_name || '')).trim()
             || p.Display_Name || p.name || 'Zoho User';
      email = p.Email || p.email || '';
    } catch (pe) {
      console.error('Profile fetch (non-fatal):', pe.message, pe.response && pe.response.data);
    }

    return res.redirect('/?' + new URLSearchParams({ zoho_name: name, zoho_email: email, zoho_token: access_token }));
  } catch (e) {
    console.error('Zoho token exchange error:', e.message, e.response && JSON.stringify(e.response.data));
    return res.redirect('/?error=auth_failed');
  }
});
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();
const PROXIMITY_RADIUS = 80;
const huddles = new Map();

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

async function createZohoMeeting(topic, userToken) {
  const token = userToken || process.env.ZOHO_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const res = await axios.post(
      'https://meeting.zoho.in/api/v1/sessions.json',
      { session: { topic: topic || 'Office Huddle', type: 1 } },
      { headers: { Authorization: 'Zoho-oauthtoken ' + token, 'Content-Type': 'application/json' } }
    );
    console.log('Zoho Meeting response:', JSON.stringify(res.data).substring(0, 300));
    const m = res.data && (res.data.session || res.data);
    return (m && (m.join_url || m.joinUrl || m.joinlink || m.joinLink || m.join_link)) || null;
  } catch (e) {
    console.error('Zoho Meeting error:', e.message, JSON.stringify(e.response && e.response.data));
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
      avatar: data.avatar || '🐱',
      color: data.color || '#7ec8a0',
      x: data.x || Math.floor(Math.random() * 600 + 100),
      y: data.y || Math.floor(Math.random() * 400 + 100),
      status: 'available', breakType: null, breakReturnAt: null,
      slackUsername: data.slackUsername || '', zohoMeetLink: data.zohoMeetLink || '',
      zohoToken: data.zohoToken || '', email: data.email || '',
      activity: '', team: data.team || ''
    };
    users.set(socket.id, user);
    socket.emit('init', { you: user, users: getUsersArray() });
    socket.broadcast.emit('user:joined', user);
    console.log(user.name + ' joined');
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
        const token = user.zohoToken || other.zohoToken || process.env.ZOHO_ACCESS_TOKEN;
        createZohoMeeting('Huddle: ' + user.name + ' & ' + other.name, token).then((meetLink) => {
          huddles.set(key, { zohoMeetLink: meetLink, createdAt: Date.now() });
          io.to(socket.id).emit('proximity:meet', { with: other, meetLink });
          io.to(other.id).emit('proximity:meet', { with: user, meetLink });
          if (meetLink) {
            if (user.slackUsername) postSlackMessage(user.slackUsername,
              'Near *' + other.name + '* in the office — Zoho huddle: ' + meetLink);
            if (other.slackUsername) postSlackMessage(other.slackUsername,
              'Near *' + user.name + '* in the office — Zoho huddle: ' + meetLink);
          }
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
    io.emit('user:status', { id: socket.id, status: user.status, breakType: user.breakType, breakReturnAt: user.breakReturnAt });
    const emojiMap = { available: ':large_green_circle:', busy: ':red_circle:', break: ':pause_button:', offline: ':black_circle:' };
    const textMap = { available: 'In the office', busy: 'Busy', break: data.breakType ? 'On ' + data.breakType + ' break' : 'On break', offline: 'Away' };
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
    io.emit('chat:message', msg);
    if (process.env.SLACK_BOT_TOKEN) {
      postSlackMessage('#' + (channel || 'general'), '*' + user.name + '*: ' + text.trim());
    }
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
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
    const token = (req.body && req.body.zohoToken) || process.env.ZOHO_ACCESS_TOKEN;
    const meetLink = await createZohoMeeting((req.body && req.body.topic) || 'Office Meeting', token);
    res.json({ meetLink });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/users', (req, res) => {
  res.json(getUsersArray());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Commons Platform running at http://localhost:' + PORT);
});
