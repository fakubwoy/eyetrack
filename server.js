const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

// ── tunables ──────────────────────────────────────────────────────────────────
const MAX_MESSAGE_BYTES = 200 * 1024;
// ─────────────────────────────────────────────────────────────────────────────

let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch(e) {
  console.warn('ws module not found. Run: npm install ws');
}

// ── Postgres ───────────────────────────────────────────────────────────────────
// Railway injects DATABASE_URL automatically when you add a Postgres plugin.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function query(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// Create tables on startup if they don't exist yet
async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS doctors (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      created_at    BIGINT NOT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS invitations (
      token        TEXT PRIMARY KEY,
      doctor_id    TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      patient_name TEXT NOT NULL,
      note         TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   BIGINT NOT NULL,
      used_at      BIGINT
    )
  `);
  console.log('[db] Tables ready');
}

// ── Auth helpers ───────────────────────────────────────────────────────────────
function hashPassword(pw) {
  return crypto.createHash('sha256').update('centergaze_salt_v1_' + pw).digest('hex');
}
function generateId()    { return crypto.randomBytes(12).toString('hex'); }
function generateToken() { return crypto.randomBytes(20).toString('hex'); }

// In-memory sessions (reset on restart — doctor just logs in again)
const sessions = {};
function createSession(doctorId) {
  const sid = generateToken();
  sessions[sid] = { doctorId, createdAt: Date.now() };
  return sid;
}
async function getSessionDoctor(sid) {
  const s = sessions[sid];
  if (!s) return null;
  if (Date.now() - s.createdAt > 7 * 24 * 60 * 60 * 1000) { delete sessions[sid]; return null; }
  const r = await query('SELECT * FROM doctors WHERE id = $1', [s.doctorId]);
  return r.rows[0] ? rowToDoctor(r.rows[0]) : null;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const [k, ...v] = p.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  });
  return out;
}

// Map snake_case DB rows to camelCase objects the rest of the code expects
function rowToDoctor(r) {
  return { id: r.id, email: r.email, passwordHash: r.password_hash, name: r.name, createdAt: Number(r.created_at) };
}
function rowToInv(r) {
  return { token: r.token, doctorId: r.doctor_id, patientName: r.patient_name, note: r.note,
           status: r.status, createdAt: Number(r.created_at), usedAt: r.used_at ? Number(r.used_at) : null };
}

// ── Static HTML files ─────────────────────────────────────────────────────────
const STATIC = {};
function preload(name, file) {
  try {
    STATIC[name] = fs.readFileSync(path.join(__dirname, file));
    console.log(`[static] loaded ${file} (${(STATIC[name].length/1024).toFixed(1)} KB)`);
  } catch(e) { console.warn(`[static] could not preload ${file}:`, e.message); }
}
preload('patient', 'patient.html');
preload('doctor',  'doctor.html');

process.on('SIGHUP', () => {
  console.log('[reload] SIGHUP — reloading static files');
  preload('patient', 'patient.html');
  preload('doctor',  'doctor.html');
});

// ── Escape helper ─────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// ── Login page ─────────────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CenterGaze — Doctor Login</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#07080d;--surface:#0e0f18;--border:rgba(255,255,255,0.07);--accent:#00f0b0;--accent-dim:rgba(0,240,176,0.10);--danger:#ff3a5c;--text:#dde0f0;--muted:#555a78;--mono:'Space Mono',monospace;--sans:'Syne',sans-serif}
  body{background:var(--bg);color:var(--text);font-family:var(--mono);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background-image:radial-gradient(ellipse at 20% 0%,rgba(0,240,176,0.04) 0%,transparent 60%),radial-gradient(ellipse at 80% 100%,rgba(0,80,200,0.05) 0%,transparent 60%)}
  .card{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:36px 32px}
  .logo{font-family:var(--sans);font-size:22px;font-weight:800;color:#fff;margin-bottom:4px}.logo span{color:var(--accent)}
  .sub{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:32px}
  .tabs{display:flex;margin-bottom:28px;border:1px solid var(--border);border-radius:5px;overflow:hidden}
  .tab{flex:1;padding:10px;text-align:center;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);cursor:pointer;background:transparent;border:none;font-family:var(--mono);transition:all 0.2s}
  .tab.active{background:var(--accent-dim);color:var(--accent)}
  label{display:block;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:6px;margin-top:16px}
  input{width:100%;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:4px;padding:11px 13px;color:var(--text);font-family:var(--mono);font-size:12px;outline:none;transition:border-color 0.2s}
  input:focus{border-color:rgba(0,240,176,0.4)}
  .btn{width:100%;margin-top:24px;padding:13px;background:var(--accent-dim);border:1px solid rgba(0,240,176,0.4);color:var(--accent);font-family:var(--mono);font-size:11px;letter-spacing:2px;text-transform:uppercase;border-radius:5px;cursor:pointer;transition:background 0.2s}
  .btn:hover{background:rgba(0,240,176,0.2)}
  .err{display:none;margin-top:14px;padding:10px 13px;background:rgba(255,58,92,0.1);border:1px solid var(--danger);border-radius:4px;font-size:10px;color:var(--danger);line-height:1.8}
  .err.show{display:block}
  #signupForm{display:none}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Center<span>Gaze</span></div>
  <div class="sub">Doctor Portal</div>
  <div class="tabs">
    <button class="tab active" onclick="showTab('login')">Login</button>
    <button class="tab" onclick="showTab('signup')">Create Account</button>
  </div>
  <form id="loginForm" onsubmit="doLogin(event)">
    <label>Email</label><input type="email" id="lEmail" required autocomplete="email">
    <label>Password</label><input type="password" id="lPass" required autocomplete="current-password">
    <button class="btn" type="submit">Login →</button>
  </form>
  <form id="signupForm" onsubmit="doSignup(event)">
    <label>Full Name</label><input type="text" id="sName" required placeholder="Dr. Smith">
    <label>Email</label><input type="email" id="sEmail" required autocomplete="email">
    <label>Password</label><input type="password" id="sPass" required minlength="8" autocomplete="new-password">
    <label>Confirm Password</label><input type="password" id="sPass2" required autocomplete="new-password">
    <button class="btn" type="submit">Create Account →</button>
  </form>
  <div class="err" id="errBox"></div>
</div>
<script>
function showTab(t){
  document.getElementById('loginForm').style.display=t==='login'?'':'none';
  document.getElementById('signupForm').style.display=t==='signup'?'':'none';
  document.querySelectorAll('.tab').forEach((el,i)=>el.classList.toggle('active',(i===0&&t==='login')||(i===1&&t==='signup')));
  document.getElementById('errBox').classList.remove('show');
}
async function doLogin(e){
  e.preventDefault();
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('lEmail').value,password:document.getElementById('lPass').value})});
  const j=await r.json();
  if(j.ok) location.href='/sessions';
  else{document.getElementById('errBox').textContent=j.error;document.getElementById('errBox').classList.add('show');}
}
async function doSignup(e){
  e.preventDefault();
  if(document.getElementById('sPass').value!==document.getElementById('sPass2').value){document.getElementById('errBox').textContent='Passwords do not match';document.getElementById('errBox').classList.add('show');return;}
  const r=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('sName').value,email:document.getElementById('sEmail').value,password:document.getElementById('sPass').value})});
  const j=await r.json();
  if(j.ok) location.href='/sessions';
  else{document.getElementById('errBox').textContent=j.error;document.getElementById('errBox').classList.add('show');}
}
</script>
</body>
</html>`;

// ── Sessions dashboard ─────────────────────────────────────────────────────────
function buildDashboardHTML(doctor, invitations, origin) {
  const pending = invitations.filter(i => i.status === 'pending');
  const active  = invitations.filter(i => i.status === 'active');
  const used    = invitations.filter(i => i.status === 'used').slice(-10).reverse();

  function invCard(inv) {
    const link = `${origin}/patient/${inv.token}`;
    return `<div class="inv-item">
      <div style="flex:1;min-width:0">
        <div class="inv-name">${escapeHtml(inv.patientName)}</div>
        ${inv.note ? `<div class="inv-meta" style="margin-top:2px">${escapeHtml(inv.note)}</div>` : ''}
        <div class="inv-meta" style="margin-top:2px">Created ${timeAgo(inv.createdAt)}</div>
        <div class="link-box">
          <div class="link-text" id="lnk_${inv.token}">${escapeHtml(link)}</div>
          <button class="copy-btn" onclick="copyLink('${escapeHtml(link)}')">Copy</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0">
        <span class="inv-status pending">Pending</span>
        <button class="btn sm danger" onclick="revokeInvitation('${inv.token}')">Revoke</button>
      </div>
    </div>`;
  }

  function activeCard(inv) {
    return `<div class="inv-item active-session">
      <div style="flex:1;min-width:0">
        <div class="inv-name"><span class="dot green"></span>${escapeHtml(inv.patientName)}</div>
        ${inv.note ? `<div class="inv-meta" style="margin-top:2px">${escapeHtml(inv.note)}</div>` : ''}
        <div class="inv-meta" style="margin-top:2px">Session started ${timeAgo(inv.usedAt)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0">
        <span class="inv-status active">&#9679; Live</span>
        <a href="/doctor" class="monitor-btn">Monitor &#8594;</a>
      </div>
    </div>`;
  }

  function usedCard(inv) {
    return `<div class="inv-item">
      <div style="flex:1;min-width:0">
        <div class="inv-name">${escapeHtml(inv.patientName)}</div>
        ${inv.note ? `<div class="inv-meta" style="margin-top:2px">${escapeHtml(inv.note)}</div>` : ''}
        <div class="inv-meta" style="margin-top:2px">Completed ${timeAgo(inv.usedAt||inv.createdAt)}</div>
      </div>
      <span class="inv-status used">Done</span>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CenterGaze &mdash; Sessions</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#07080d;--surface:#0e0f18;--surface2:#161828;--border:rgba(255,255,255,0.07);--accent:#00f0b0;--accent-dim:rgba(0,240,176,0.10);--danger:#ff3a5c;--danger-dim:rgba(255,58,92,0.12);--warn:#ffb830;--warn-dim:rgba(255,184,48,0.12);--purple:#b48fff;--purple-dim:rgba(180,143,255,0.10);--text:#dde0f0;--muted:#555a78;--mono:'Space Mono',monospace;--sans:'Syne',sans-serif}
  body{background:var(--bg);color:var(--text);font-family:var(--mono);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:18px 16px 60px;background-image:radial-gradient(ellipse at 20% 0%,rgba(0,240,176,0.04) 0%,transparent 60%),radial-gradient(ellipse at 80% 100%,rgba(0,80,200,0.05) 0%,transparent 60%)}
  header{width:100%;max-width:860px;display:flex;align-items:center;gap:14px;margin-bottom:24px;border-bottom:1px solid var(--border);padding-bottom:14px;flex-wrap:wrap}
  .logo{font-family:var(--sans);font-size:20px;font-weight:800;color:#fff;letter-spacing:-0.5px}.logo span{color:var(--accent)}
  .badge{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--accent);border:1px solid rgba(0,240,176,0.35);padding:3px 8px;border-radius:2px;background:var(--accent-dim)}
  .badge.purple{color:var(--purple);border-color:rgba(180,143,255,0.35);background:var(--purple-dim)}
  .ml-auto{margin-left:auto}
  .nav-links{display:flex;align-items:center;gap:16px}
  .nav-link{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);cursor:pointer;transition:color 0.2s;text-decoration:none}
  .nav-link:hover{color:var(--accent)}
  .wrap{width:100%;max-width:860px}
  .stat-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:20px}
  .stat-box{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:16px}
  .stat-num{font-family:var(--sans);font-size:28px;font-weight:700;color:var(--text);line-height:1}
  .stat-num.accent{color:var(--accent)}
  .stat-lbl{font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-top:5px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:22px;margin-bottom:14px}
  .card-title{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:16px;display:flex;align-items:center;gap:8px}
  .card-title::after{content:'';flex:1;height:1px;background:var(--border)}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
  @media(max-width:540px){.form-row{grid-template-columns:1fr}}
  label{display:block;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
  input[type=text],input[type=email]{width:100%;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:4px;padding:10px 13px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;transition:border-color 0.2s}
  input:focus{border-color:rgba(0,240,176,0.4)}
  .btn{padding:10px 20px;background:var(--accent-dim);border:1px solid rgba(0,240,176,0.4);color:var(--accent);font-family:var(--mono);font-size:10px;letter-spacing:2px;text-transform:uppercase;border-radius:4px;cursor:pointer;transition:background 0.2s}
  .btn:hover{background:rgba(0,240,176,0.2)}
  .btn.danger{background:var(--danger-dim);border-color:rgba(255,58,92,0.4);color:var(--danger)}
  .btn.danger:hover{background:rgba(255,58,92,0.22)}
  .btn.sm{padding:7px 14px;font-size:9px}
  .inv-list{display:flex;flex-direction:column;gap:8px}
  .inv-item{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:14px 16px;display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
  .inv-item.active-session{border-color:rgba(0,240,176,0.3);background:rgba(0,240,176,0.04)}
  .inv-name{font-size:12px;color:var(--text);font-weight:700}
  .inv-meta{font-size:9px;color:var(--muted);letter-spacing:1px}
  .inv-status{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;padding:3px 10px;border-radius:3px;white-space:nowrap}
  .inv-status.pending{color:var(--warn);background:var(--warn-dim);border:1px solid rgba(255,184,48,0.3)}
  .inv-status.active{color:var(--accent);background:var(--accent-dim);border:1px solid rgba(0,240,176,0.3);animation:blinkB 2s ease-in-out infinite}
  @keyframes blinkB{0%,100%{border-color:rgba(0,240,176,0.3)}50%{border-color:rgba(0,240,176,0.8)}}
  .inv-status.used{color:var(--muted);background:transparent;border:1px solid var(--border)}
  .link-box{display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:7px 11px;margin-top:8px}
  .link-text{font-size:10px;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .copy-btn{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent);background:transparent;border:none;cursor:pointer;font-family:var(--mono);flex-shrink:0}
  .monitor-btn{padding:7px 14px;background:var(--purple-dim);border:1px solid rgba(180,143,255,0.4);color:var(--purple);font-family:var(--mono);font-size:9px;letter-spacing:1.5px;text-transform:uppercase;border-radius:4px;cursor:pointer;text-decoration:none;display:inline-block}
  .monitor-btn:hover{background:rgba(180,143,255,0.2)}
  .empty{font-size:10px;color:var(--muted);text-align:center;padding:24px;letter-spacing:1px}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--muted);display:inline-block;margin-right:5px;vertical-align:middle}
  .dot.green{background:var(--accent);box-shadow:0 0 5px var(--accent)}
  .toast{display:none;position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:var(--accent-dim);border:1px solid rgba(0,240,176,0.4);color:var(--accent);padding:10px 20px;border-radius:6px;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;z-index:100;white-space:nowrap}
  .toast.show{display:block}
  .refresh-note{font-size:9px;color:var(--muted);letter-spacing:1px;text-align:right;margin-bottom:10px}
</style>
</head>
<body>
<header>
  <div class="logo">Center<span>Gaze</span></div>
  <span class="badge">Sessions</span>
  <div class="ml-auto nav-links">
    <span class="badge purple">Dr. ${escapeHtml(doctor.name)}</span>
    <a href="/doctor" class="nav-link">Monitor</a>
    <a href="#" class="nav-link" onclick="doLogout()">Logout</a>
  </div>
</header>

<div class="wrap">
  <div class="stat-row">
    <div class="stat-box"><div class="stat-num accent">${pending.length}</div><div class="stat-lbl">Pending links</div></div>
    <div class="stat-box"><div class="stat-num" style="${active.length>0?'color:var(--accent)':''}">${active.length}</div><div class="stat-lbl">Active sessions</div></div>
    <div class="stat-box"><div class="stat-num">${invitations.filter(i=>i.status==='used').length}</div><div class="stat-lbl">Completed</div></div>
  </div>

  <div class="card">
    <div class="card-title">Invite a Patient</div>
    <div class="form-row">
      <div><label>Patient Name</label><input type="text" id="invName" placeholder="e.g. John Doe"></div>
      <div><label>Note (optional)</label><input type="text" id="invNote" placeholder="e.g. Follow-up visit"></div>
    </div>
    <button class="btn" onclick="createInvitation()">Generate Patient Link &#8594;</button>
  </div>

  <div class="card">
    <div class="card-title">Pending Invitations</div>
    <div class="inv-list">${pending.length===0?'<div class="empty">No pending invitations</div>':pending.map(invCard).join('')}</div>
  </div>

  <div class="card">
    <div class="card-title">Active Sessions</div>
    <div class="inv-list">${active.length===0?'<div class="empty">No active sessions</div>':active.map(activeCard).join('')}</div>
  </div>

  <div class="card">
    <div class="card-title">Recent Completed Sessions</div>
    <div class="inv-list">${used.length===0?'<div class="empty">No completed sessions yet</div>':used.map(usedCard).join('')}</div>
  </div>
</div>

<div class="toast" id="toast">Copied!</div>

<script>
async function createInvitation(){
  const name=document.getElementById('invName').value.trim();
  const note=document.getElementById('invNote').value.trim();
  if(!name){alert('Please enter a patient name');return;}
  const r=await fetch('/api/invitations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patientName:name,note})});
  const j=await r.json();
  if(j.ok) location.reload();
  else alert(j.error||'Error');
}
async function revokeInvitation(token){
  if(!confirm('Revoke this invitation? The patient link will stop working.')) return;
  const r=await fetch('/api/invitations/'+token,{method:'DELETE'});
  const j=await r.json();
  if(j.ok) location.reload();
}
async function doLogout(){
  await fetch('/api/logout',{method:'POST'});
  location.href='/login';
}
function copyLink(text){
  navigator.clipboard.writeText(text).then(()=>{
    const t=document.getElementById('toast');t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2000);
  });
}
setTimeout(()=>location.reload(),8000);
</script>
</body>
</html>`;
}

// ── Patient landing page ───────────────────────────────────────────────────────
function buildPatientLandingHTML(inv, doctor) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CenterGaze &mdash; Patient Session</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#07080d;--surface:#0e0f18;--border:rgba(255,255,255,0.07);--accent:#00f0b0;--accent-dim:rgba(0,240,176,0.10);--danger:#ff3a5c;--warn:#ffb830;--text:#dde0f0;--muted:#555a78;--mono:'Space Mono',monospace;--sans:'Syne',sans-serif}
  body{background:var(--bg);color:var(--text);font-family:var(--mono);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background-image:radial-gradient(ellipse at 20% 0%,rgba(0,240,176,0.04) 0%,transparent 60%)}
  .card{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:36px 32px;text-align:center}
  .logo{font-family:var(--sans);font-size:22px;font-weight:800;color:#fff;margin-bottom:4px}.logo span{color:var(--accent)}
  .sub{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:28px}
  .greeting{font-size:15px;color:var(--text);margin-bottom:6px}
  .greeting strong{color:var(--accent)}
  .doctor-info{font-size:11px;color:var(--muted);margin-bottom:24px;line-height:2}
  .note-box{background:rgba(255,184,48,0.07);border:1px solid rgba(255,184,48,0.2);border-radius:6px;padding:12px 16px;font-size:10px;color:rgba(255,184,48,0.8);letter-spacing:1px;text-transform:uppercase;margin-bottom:28px;line-height:1.9}
  .btn{width:100%;padding:14px;background:var(--accent-dim);border:1px solid rgba(0,240,176,0.4);color:var(--accent);font-family:var(--mono);font-size:11px;letter-spacing:2px;text-transform:uppercase;border-radius:5px;cursor:pointer;transition:background 0.2s}
  .btn:hover{background:rgba(0,240,176,0.2)}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Center<span>Gaze</span></div>
  <div class="sub">Patient Session</div>
  <div class="greeting">Hello, <strong>${escapeHtml(inv.patientName)}</strong></div>
  <div class="doctor-info">You have been invited by<br><strong style="color:var(--text)">${escapeHtml(doctor.name)}</strong><br>to complete a gaze tracking session.</div>
  ${inv.note ? `<div class="note-box">&#128203; ${escapeHtml(inv.note)}</div>` : ''}
  <button class="btn" onclick="location.href='/patient/${escapeHtml(inv.token)}/start'">Begin Session &#8594;</button>
</div>
</body>
</html>`;
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>CenterGaze</title>
  <style>body{background:#07080d;color:#dde0f0;font-family:'Space Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}.card{background:#0e0f18;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:40px 32px;max-width:400px}.logo{font-family:Syne,sans-serif;font-size:22px;font-weight:800;color:#fff;margin-bottom:20px}.logo span{color:#00f0b0}.msg{font-size:12px;color:#555a78;line-height:2}</style></head>
  <body><div class="card"><div class="logo">Center<span>Gaze</span></div><div class="msg">${escapeHtml(msg)}</div></div></body></html>`;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 50000) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
    req.on('error', reject);
  });
}
function sendJSON(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
function sendHTML(res, html, status = 200) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url     = req.url.split('?')[0];
  const cookies = parseCookies(req);
  const doctor  = await getSessionDoctor(cookies['cg_session']);

  try {
    // ── API ───────────────────────────────────────────────────────────────────

    if (url === '/api/signup' && req.method === 'POST') {
      const { name, email, password } = await readBody(req);
      if (!name || !email || !password) return sendJSON(res, 400, { error: 'All fields required' });
      if (password.length < 8) return sendJSON(res, 400, { error: 'Password must be at least 8 characters' });
      const existing = await query('SELECT id FROM doctors WHERE email = $1', [email.toLowerCase()]);
      if (existing.rows.length) return sendJSON(res, 400, { error: 'Email already registered' });
      const id = generateId();
      await query(
        'INSERT INTO doctors (id, email, password_hash, name, created_at) VALUES ($1,$2,$3,$4,$5)',
        [id, email.toLowerCase(), hashPassword(password), name, Date.now()]
      );
      const sid = createSession(id);
      res.setHeader('Set-Cookie', `cg_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
      return sendJSON(res, 200, { ok: true });
    }

    if (url === '/api/login' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const r = await query('SELECT * FROM doctors WHERE email = $1', [(email||'').toLowerCase()]);
      const d = r.rows[0] ? rowToDoctor(r.rows[0]) : null;
      if (!d || d.passwordHash !== hashPassword(password))
        return sendJSON(res, 401, { error: 'Invalid email or password' });
      const sid = createSession(d.id);
      res.setHeader('Set-Cookie', `cg_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
      return sendJSON(res, 200, { ok: true });
    }

    if (url === '/api/logout' && req.method === 'POST') {
      if (cookies['cg_session']) delete sessions[cookies['cg_session']];
      res.setHeader('Set-Cookie', 'cg_session=; Path=/; Max-Age=0');
      return sendJSON(res, 200, { ok: true });
    }

    if (url === '/api/invitations' && req.method === 'POST') {
      if (!doctor) return sendJSON(res, 401, { error: 'Not authenticated' });
      const { patientName, note } = await readBody(req);
      if (!patientName) return sendJSON(res, 400, { error: 'Patient name required' });
      const token = generateToken();
      await query(
        'INSERT INTO invitations (token, doctor_id, patient_name, note, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [token, doctor.id, patientName, note || '', 'pending', Date.now()]
      );
      return sendJSON(res, 200, { ok: true, token });
    }

    if (url.startsWith('/api/invitations/') && req.method === 'DELETE') {
      if (!doctor) return sendJSON(res, 401, { error: 'Not authenticated' });
      const token = url.replace('/api/invitations/', '');
      const r = await query('SELECT doctor_id FROM invitations WHERE token = $1', [token]);
      if (!r.rows.length || r.rows[0].doctor_id !== doctor.id)
        return sendJSON(res, 404, { error: 'Not found' });
      await query('DELETE FROM invitations WHERE token = $1', [token]);
      return sendJSON(res, 200, { ok: true });
    }

    // ── Pages ─────────────────────────────────────────────────────────────────

    if (url === '/login') {
      if (doctor) { res.writeHead(302, { Location: '/sessions' }); res.end(); return; }
      return sendHTML(res, LOGIN_HTML);
    }

    if (url === '/') {
      if (!doctor) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      res.writeHead(302, { Location: '/sessions' }); res.end(); return;
    }

    if (url === '/sessions') {
      if (!doctor) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      const proto  = req.headers['x-forwarded-proto'] || 'http';
      const host   = req.headers.host || `localhost:${PORT}`;
      const origin = `${proto}://${host}`;
      const r = await query(
        'SELECT * FROM invitations WHERE doctor_id = $1 ORDER BY created_at DESC',
        [doctor.id]
      );
      const myInvs = r.rows.map(rowToInv);
      return sendHTML(res, buildDashboardHTML(doctor, myInvs, origin));
    }

    if (url === '/doctor') {
      if (!doctor) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      if (!STATIC.doctor) { res.writeHead(503); res.end('doctor.html not loaded'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': STATIC.doctor.length, 'Cache-Control': 'no-store' });
      res.end(STATIC.doctor);
      return;
    }

    // Patient landing: /patient/:token
    const patMatch = url.match(/^\/patient\/([a-f0-9]{40})$/);
    if (patMatch) {
      const r = await query('SELECT * FROM invitations WHERE token = $1', [patMatch[1]]);
      const inv = r.rows[0] ? rowToInv(r.rows[0]) : null;
      if (!inv || inv.status === 'expired') return sendHTML(res, errorPage('This invitation link has expired or is invalid.'), 404);
      if (inv.status === 'used') return sendHTML(res, errorPage('This session has already been completed. Please ask your doctor for a new link.'), 410);
      const dr = await query('SELECT * FROM doctors WHERE id = $1', [inv.doctorId]);
      const doc = dr.rows[0] ? rowToDoctor(dr.rows[0]) : null;
      return sendHTML(res, buildPatientLandingHTML(inv, doc));
    }

    // Patient session start: /patient/:token/start
    const patStart = url.match(/^\/patient\/([a-f0-9]{40})\/start$/);
    if (patStart) {
      const r = await query('SELECT * FROM invitations WHERE token = $1', [patStart[1]]);
      const inv = r.rows[0] ? rowToInv(r.rows[0]) : null;
      if (!inv || inv.status === 'expired') return sendHTML(res, errorPage('This invitation link has expired or is invalid.'), 404);
      if (inv.status === 'used') return sendHTML(res, errorPage('This session has already been completed.'), 410);
      if (inv.status === 'pending') {
        await query('UPDATE invitations SET status=$1, used_at=$2 WHERE token=$3', ['active', Date.now(), patStart[1]]);
      }
      if (!STATIC.patient) { res.writeHead(503); res.end('patient.html not loaded'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': STATIC.patient.length, 'Cache-Control': 'no-store' });
      res.end(STATIC.patient);
      return;
    }

    // Fallback
    res.writeHead(302, { Location: '/login' }); res.end();

  } catch(err) {
    console.error('[HTTP] error:', err);
    res.writeHead(500); res.end('Internal Server Error');
  }
});

// ── WebSocket relay ────────────────────────────────────────────────────────────
// Each doctor has their own room. Only their authorised patient can join.
// rooms[doctorId] = { doctors: Set<ws>, patient: ws|null, invToken: string|null }
const rooms = {};
function getRoom(doctorId) {
  if (!rooms[doctorId]) rooms[doctorId] = { doctors: new Set(), patient: null, invToken: null };
  return rooms[doctorId];
}

if (WebSocketServer) {
  const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', async (ws, req) => {
    const wsPath = (req.url||'').split('?')[0];
    if (wsPath !== '/ws') { ws.close(1008, 'Invalid path'); return; }
    const params = new URLSearchParams((req.url||'').split('?')[1]||'');
    const role   = params.get('role') || 'patient';
    const token  = params.get('token') || '';

    // ── Doctor WebSocket ────────────────────────────────────────────────────
    if (role === 'doctor') {
      const upgCookies = {};
      (req.headers.cookie||'').split(';').forEach(p=>{const[k,...v]=p.trim().split('=');if(k)upgCookies[k.trim()]=v.join('=');});
      const d = await getSessionDoctor(upgCookies['cg_session']);
      if (!d) { ws.close(1008, 'Unauthorized'); return; }

      const room = getRoom(d.id);
      if (room.doctors.size >= 5) { ws.close(1008, 'Limit'); return; }
      room.doctors.add(ws);
      console.log(`[WS] +doctor(${d.name}) room=${d.id} docs=${room.doctors.size}`);

      ws.on('close', () => { room.doctors.delete(ws); console.log(`[WS] -doctor(${d.name})`); });
      ws.on('error', err => { console.error('[WS] doctor error:', err.message); room.doctors.delete(ws); });
      ws.on('message', () => {});
      return;
    }

    // ── Patient WebSocket ───────────────────────────────────────────────────
    if (role === 'patient') {
      const r = await query('SELECT * FROM invitations WHERE token = $1', [token]);
      const inv = r.rows[0] ? rowToInv(r.rows[0]) : null;
      if (!inv || (inv.status !== 'active' && inv.status !== 'pending')) {
        ws.close(1008, 'Invalid or expired token'); return;
      }

      const room = getRoom(inv.doctorId);
      if (room.patient && room.patient.readyState === 1) {
        ws.close(1008, 'Session busy — another patient is already connected'); return;
      }

      if (inv.status === 'pending') {
        await query('UPDATE invitations SET status=$1, used_at=$2 WHERE token=$3', ['active', Date.now(), token]);
        inv.status = 'active';
      }

      room.patient  = ws;
      room.invToken = token;
      console.log(`[WS] +patient(${inv.patientName}) room=${inv.doctorId} docs=${room.doctors.size}`);

      ws.on('message', (raw, isBinary) => {
        const payload = isBinary ? raw : raw.toString('utf8');
        for (const doc of room.doctors) {
          if (doc.readyState !== 1) continue;
          if (doc.bufferedAmount > MAX_MESSAGE_BYTES * 3) continue;
          doc.send(payload, { binary: isBinary });
        }
      });

      ws.on('close', async () => {
        if (room.patient === ws) {
          room.patient  = null;
          room.invToken = null;
          if (inv.status === 'active') {
            await query('UPDATE invitations SET status=$1 WHERE token=$2', ['used', token]);
            inv.status = 'used';
          }
          console.log(`[WS] -patient(${inv.patientName}) room=${inv.doctorId}`);
        }
      });

      ws.on('error', err => {
        console.error('[WS] patient error:', err.message);
        if (room.patient === ws) { room.patient = null; room.invToken = null; }
      });
      return;
    }

    ws.close(1008, 'Unknown role');
  });
}

// ── Start ──────────────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`CenterGaze v3 (postgres) on :${PORT}`);
    console.log(`  Login    -> http://localhost:${PORT}/login`);
    console.log(`  Sessions -> http://localhost:${PORT}/sessions`);
    console.log(`  Monitor  -> http://localhost:${PORT}/doctor`);

    setInterval(() => {
      const mem = process.memoryUsage();
      console.log(`[health] rss=${(mem.rss/1e6).toFixed(1)}MB heap=${(mem.heapUsed/1e6).toFixed(1)}/${(mem.heapTotal/1e6).toFixed(1)}MB rooms=${Object.keys(rooms).length} patients=${Object.values(rooms).filter(r=>r.patient).length}`);
    }, 60_000);
  });
}).catch(err => {
  console.error('[FATAL] DB init failed:', err);
  process.exit(1);
});