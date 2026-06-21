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

app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();
const PROXIMITY_RADIUS = 80;
const huddles = new Map();

// ── Attendance log ────────────────────────────────────────────────────────────
const attendanceLog = [];
function logAttendance(type, user, extra = {}) {
  attendanceLog.push({
    type, userId: user.id, userName: user.name,
    avatar: user.avatar || '🐱', role: user.role || '',
    ts: new Date().toISOString(), ...extra
  });
  if (attendanceLog.length > 10000) attendanceLog.shift();
}

// ── Chat history (per channel, last 500 msgs) ─────────────────────────────────
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
  if (!token) return�V�ð��7��2gV�7F���GFV�B�F������WB�6��B�&�6W72�V�b�����$u��B���V�ð��WB&W6V�FW%�V�B��V�ð���b��6��B���G'���6��7B��f�&W2�v�B���2�vWB�v�GG3���66�V�G2��������WF��c"�W6W&��f�r����VFW'3��WF��&��F���u������WF�F��V�r�F��Тғ��6��6��R���r�uW6W&��f�r��4���7G&��v�g����f�&W2�FF��7V'7G&��r��#����6��7BB���f�&W2�FF���6��B�B�4��B��B�6��B��B��&u��C��&W6V�FW%�V�B�B�T�B��B�7V"��B�W6W$�B��B�C���6F6���R���6��7B7FGW2��R�&W7��6Rbb�R�&W7��6R�7FGW3��6��6��R�W'&�"�uW6W&��f�f��VB�r�7FGW2�r��r��R��W76vR����b�7FGW2���C�F�&�r��VVG5&Vg&W6��G'VRӰ�ТР��b��6��B���6��6��R�W'&�"�t���6��B(	BFB�����$u��BF�&��v�V�bf'2r���&WGW&��V�ð�Р�6��7B��r��WrFFR�FFR���r����R�c�3��c�2�c���6��7BB����7G&��r���E7F'B�"�sr���6��7B���F�2��t��r�tfV"r�t�"r�t"r�t��r�t�V�r�t�V�r�tVrr�u6Wr�t�7Br�t��br�tFV2uӰ�6��7B�#B���r�vWEUD4��W'2����6��7B����#B��"�u�r�t�s��6��7B�"��#BR"��#��6��7B7F'EF��R����F�5���r�vWEUD4���F�����rr�B���r�vWEUD4FFR����r�r���r�vWEUD4gV�ŖV"����rr�B��"��s�r�B���r�vWEUD4֖�WFW2����rr��Ӱ��6��7B&W6V�FW"�&W6V�FW%�V�B��&�6W72�V�b����$U4T�DU%��T�DB���V�ð�6��7B6W76������B��6W76�����F��3�F��2��t�ff�6R�VFF�Rr��7F'EF��R�GW&F���3c�F��W���S�t6��6�7WGFr�����&W6V�FW"��&W6V�FW#��V�&W"�&W6V�FW"����Ґ��Ӱ��6��7B&W2�v�B���2��7B��v�GG3����VWF��r���������c"�r��6��B�r�6W76���2�6��r��6W76������B����VFW'3��WF��&��F���u������WF�F��V�r�F���t6��FV�B�G�Rs�vƖ6F�����6��6�'6WC�UDbӂr�Т���6��6��R���r�u�����VWF��r7&VFVC�r��4���7G&��v�g��&W2�FF��7V'7G&��r��3����6��7B��&W2�FFbb�&W2�FF�6W76�����&W2�FF���&WGW&���bb������Ɩ���������W&��������W&��������Ɩ���������Ɩ沒����V�ð�Р�G'���&WGW&�v�BGFV�B�F��V⓰��6F6��R���6��7B7FGW2�R�&W7��6RbbR�&W7��6R�7FGW3���b�R��VVG5&Vg&W6���7FGW2���C���6��6��R���r�uF��V�W��&VB�7FGW2r�7FGW2�r�(	B&Vg&W6���r���r���6��7Bg&W6��v�B&Vg&W6�����F��Vₓ���b�g&W6����G'��&WGW&�v�BGFV�B�g&W6����6F6��S"���6��6��R�W'&�"�t�VWF��rW'&�"gFW"&Vg&W6��r�S"��W76vR��4���7G&��v�g��S"�&W7��6RbbS"�&W7��6R�FF��7V'7G&��r��#����ТТ�V�6R��6��6��R�W'&�"�u�����VWF��rW'&�#�r�R��W76vR��4���7G&��v�g��R�&W7��6RbbR�&W7��6R�FF��7V'7G&��r��3����Т&WGW&��V�ð�ЧР�7��2gV�7F����7E6�6��W76vR�6���V��FW�B����b�&�6W72�V�b�4�4��$�E�D��T�&WGW&㰢G'���v�B���2��7B�v�GG3���6�6��6�����6�B��7D�W76vRr��6���V��FW�B�����VFW'3��uthorization: 'Bearer ' + process.env.SLACK_BOT_TOKEN } });
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
      status: 'available', breakType: null, breakReturnAt: null,
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
            'You are near *' + other.name + '* in the office — Zoho huddle: ' + meetLink);
          if (other.slackUsername) postSlackMessage(other.slackUsername,
            'You are near *' + user.name + '* in the office — Zoho huddle: ' + meetLink);
        });
      }
    }

    for (const [key] of huddles) {
      const parts = key.split('::');
      if (parts[0] === socket.id || parts[1] === socket.id) {
        const otherId = parts[0] === socket.id ? parts[1] : parts[0];
        const otherW6W"�W6W'2�vWB��F�W$�B����b��F�W%W6W"���6��7BG��W6W"���F�W%W6W"烰�6��7BG��W6W"���F�W%W6W"瓰��b��F��7'B�G��G��G��G���$���ԕE��$D�U2��R����VFF�W2�FV�WFR��W�������F�6�6�WB�B��V֗B�w&���֗G���VgBr��v�F���F�W%W6W"ғ�����F��F�W$�B��V֗B�w&���֗G���VgBr��v�F��W6W"ғ��ТТТТғ���6�6�WB���w7FGW3�6WBr��FF�����6��7BW6W"�W6W'2�vWB�6�6�WB�B����b�W6W"�&WGW&㰢W6W"�7FGW2�FF�7FGW3��W6W"�'&V�G�R�FF�'&V�G�R���V�ð�W6W"�'&V�&WGW&�B�FF�'&V�&WGW&�B���V�ð���tGFV�F�6R�FF�7FGW2�W6W"�FF�'&V�G�R��'&V�G�S�FF�'&V�G�R�'&V�&WGW&�C�FF�'&V�&WGW&�B���ғ�����V֗B�wW6W#�7FGW2r���C�6�6�WB�B�7FGW3�W6W"�7FGW2�'&V�G�S�W6W"�'&V�G�R�'&V�&WGW&�C�W6W"�'&V�&WGW&�Bғ��6��7BV�������f��&�S�s��&vU�w&VV��6�&6�S�r�'W7��s�&VE�6�&6�S�r�'&V��s�W6U�'WGF��r��ffƖ�S�s�&�6��6�&6�S�rӰ�6��7BFW�D���f��&�S�t��F�R�ff�6Rr�'W7��t'W7�r�'&V��FF�'&V�G�R�t��r�FF�'&V�G�R�r'&V�r�t��'&V�r��ffƖ�S�tv�rӰ�WFFU6�6�7FGW2�W6W"�6�6�W6W&��R�FW�D��FF�7FGW5���rr�V������FF�7FGW5���rr���ғ���6�6�WB���w&�f��S�WFFRr��FF�����6��7BW6W"�W6W'2�vWB�6�6�WB�B����b�W6W"�&WGW&㰢�b�FF�&��R��V�FVf��VB�W6W"�&��R�FF�&��S���b�FF�6�6�W6W&��R��V�FVf��VB�W6W"�6�6�W6W&��R�FF�6�6�W6W&��S���b�FF�����VWDƖ���V�FVf��VB�W6W"�����VWDƖ��FF�����VWDƖ泰��b�FF�7F�f�G���V�FVf��VB�W6W"�7F�f�G��FF�7F�f�G����b�FF�FV���V�FVf��VB�W6W"�FV��FF�FVӰ����V֗B�wW6W#�&�f��Rr���C�6�6�WB�B����FFғ��ғ���6�6�WB���v6�C�6V�Br���FW�B�6���V�Ғ����6��7BW6W"�W6W'2�vWB�6�6�WB�B����b�W6W"��FW�B�G&�҂��&WGW&㰢6��7B�6r����C�FFR���r���W6W$�C�6�6�WB�B�W6W$��S�W6W"���R��fF#�W6W"�fF"�6���#�W6W"�6���"�FW�C�FW�B�G&�҂���6���Vâ6���V���vvV�W&�r�G3��WrFFR���F��4�7G&��r���Ӱ�7F�&T6�D�6r��6r������V֗B�v6�C��W76vRr��6r����b�&�6W72�V�b�4�4��$�E�D��T����7E6�6��W76vR�r2r��6���V���vvV�W&�r��r�r�W6W"���R�r��r�FW�B�G&�҂����Тғ���6�6�WB���vF�66���V7Br�������6��7BW6W"�W6W'2�vWB�6�6�WB�B����b�W6W"�����tGFV�F�6R�v�VfRr�W6W"���6��6��R���r�W6W"���R�rF�66���V7FVBr���W6W'2�FV�WFR�6�6�WB�B���f�"�6��7B�W��b�VFF�W2�W�2������b��W���6�VFW2�6�6�WB�B���VFF�W2�FV�WFR��W����Т���V֗B�wW6W#��VgBr���C�6�6�WB�Bғ��Тғ��ғ�����7B�r����VWB�7&VFRr�7��2�&W�&W2�����G'���6��7B�VWDƖ��v�B7&VFU�����VWF��r��&W�&�G�bb&W�&�G��F��2���t�ff�6R�VWF��rr���&W2�6�⇲�VWDƖ�ғ���6F6��R���&W2�7FGW2�S��6�⇲W'&�#�R��W76vRғ��Чғ����vWB�r���W6W'2r��&W�&W2�����&W2json(getUsersArray());
});

// OAuth routes
const REDIRECT_URI = (process.env.BASE_URL || 'https://commons-platform-ntglobal-production.up.railway.app') + '/auth/zoho/callback';

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
    res.send(`<!DOCTYPE html><html><body><script>
      if(window.opener){window.opener.postMessage(${payload},'*');window.close();}
      else{location.href='/';}
    </script></body></html>`);
  } catch (e) {
    console.error('Zoho token exchange error:', e.message, e.response && JSON.stringify(e.response.data));
    res.send('<script>window.opener&&window.opener.postMessage({type:"zoho-auth",error:"auth_failed"},"*");window.close();</script>');
  }
});

// ── Admin: remove individual user ─────────────────────────────────────────────
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

// ── Admin: reset room (kick everyone) ────────────────────────────────────────
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

// ── Admin: live users list ────────────────────────────────────────────────────
app.get('/api/admin/users', (req, res) => {
  const pwd = req.query.pwd;
  const required = process.env.ADMIN_PASSWORD || 'commons-admin-2026';
  if (pwd !== required) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ users: getUsersArray() });
});

// ── Admin: attendance log ─────────────────────────────────────────────────────
app.get('/api/admin/attendance', (req, res) => {
  const pwd = req.query.pwd || req.headers['x-admin-pwd'];
  const required = process.env.ADMIN_PASSWORD || 'commons-admin-2026';
  if (pwd !== required) return res.status(401).json({ error: 'Wrong password' });
  res.json({ log: attendanceLog.slice().reverse(), count: attendanceLog.length });
});

// ── Slack Events API webhook (bidirectional bridge) ───────────────────────────
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

// ── Chat history endpoint ─────────────────────────────────────────────────────
app.get('/api/chat/history', (req, res) => {
  const ch = req.query.channel || 'general';
  res.json({ messages: chatHistory[ch] || [] });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\nCommons Platform running at http://localhost:' + PORT + '\n');
});
