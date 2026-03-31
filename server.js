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
      used_at      BIGINT,
      started_at   BIGINT
    )
  `);
  // Add started_at column if it doesn't exist yet (migration for existing DBs)
  try {
    await query(`ALTER TABLE invitations ADD COLUMN IF NOT EXISTS started_at BIGINT`);
  } catch(e) { /* column already exists */ }

  await query(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      token         TEXT PRIMARY KEY REFERENCES invitations(token) ON DELETE CASCADE,
      doctor_id     TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      patient_name  TEXT NOT NULL,
      note          TEXT NOT NULL DEFAULT '',
      completed_at  BIGINT NOT NULL,
      gaze_stats    JSONB,
      vft_data      JSONB
    )
  `);

  // FIX 7: On restart, any invitation still 'active' means the server crashed
  // mid-session. Reset them back to 'pending' so the patient can reconnect.
  const stale = await query(
    `UPDATE invitations SET status='pending', started_at=NULL WHERE status='active' RETURNING token`
  );
  if (stale.rows.length > 0) {
    console.log(`[db] Reset ${stale.rows.length} stale active session(s) to pending on startup`);
  }
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
           status: r.status, createdAt: Number(r.created_at),
           usedAt: r.used_at ? Number(r.used_at) : null,
           startedAt: r.started_at ? Number(r.started_at) : null };
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
  document.getElementById('loginForm').style.display=t==='login'?'block':'none';
  document.getElementById('signupForm').style.display=t==='signup'?'block':'none';
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
function buildDashboardHTML(doctor, invitations, origin, summaries) {
  const pending = invitations.filter(i => i.status === 'pending');
  const active  = invitations.filter(i => i.status === 'active');
  const used    = invitations.filter(i => i.status === 'used').slice(-10).reverse();
  const revoked = invitations.filter(i => i.status === 'revoked').slice(-5).reverse();

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
        <span class="inv-status pending" id="status_${inv.token}" data-status="pending">Pending</span>
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
        <span class="inv-status active" id="status_${inv.token}" data-status="active">&#9679; Live</span>
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
      <span class="inv-status used" id="status_${inv.token}" data-status="used">Done</span>
    </div>`;
  }

  function revokedCard(inv) {
    return `<div class="inv-item">
      <div style="flex:1;min-width:0">
        <div class="inv-name">${escapeHtml(inv.patientName)}</div>
        ${inv.note ? `<div class="inv-meta" style="margin-top:2px">${escapeHtml(inv.note)}</div>` : ''}
        <div class="inv-meta" style="margin-top:2px">Revoked ${timeAgo(inv.createdAt)}</div>
      </div>
      <span class="inv-status" style="color:var(--muted);background:transparent;border:1px solid var(--border)" id="status_${inv.token}" data-status="revoked">Revoked</span>
    </div>`;
  }

  function summaryCard(s) {
    const date = new Date(Number(s.completed_at));
    const dateStr = date.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
    const timeStr = date.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
    return `<div class="inv-item">
      <div style="flex:1;min-width:0">
        <div class="inv-name">${escapeHtml(s.patient_name)}</div>
        ${s.note ? `<div class="inv-meta" style="margin-top:2px">${escapeHtml(s.note)}</div>` : ''}
        <div class="inv-meta" style="margin-top:2px">${dateStr} at ${timeStr}</div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          ${s.has_gaze ? '<span class="data-chip gaze">Gaze stats</span>' : ''}
          ${s.has_vft  ? '<span class="data-chip vft">VFT data</span>'  : ''}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0">
        <button class="btn sm" onclick="viewSummary('${escapeHtml(s.token)}')">View &#8594;</button>
        ${s.has_vft ? `<button class="btn sm" onclick="downloadSummaryCSV('${escapeHtml(s.token)}')">CSV &#8595;</button>` : ''}
      </div>
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
  .data-chip{font-size:8px;letter-spacing:1.5px;text-transform:uppercase;padding:2px 8px;border-radius:2px;display:inline-block}
  .data-chip.gaze{color:var(--accent);background:var(--accent-dim);border:1px solid rgba(0,240,176,0.25)}
  .data-chip.vft{color:var(--purple);background:var(--purple-dim);border:1px solid rgba(180,143,255,0.25)}
  /* Summary modal */
  .modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:200;align-items:center;justify-content:center;padding:16px}
  .modal-backdrop.open{display:flex}
  .modal{background:var(--surface);border:1px solid var(--border);border-radius:10px;width:100%;max-width:700px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
  .modal-header{padding:18px 22px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  .modal-title{font-family:var(--sans);font-size:16px;font-weight:700;color:#fff;flex:1}
  .modal-close{background:transparent;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1;padding:0 4px}
  .modal-close:hover{color:var(--text)}
  .modal-body{padding:18px 22px;overflow-y:auto;flex:1}
  .modal-section{margin-bottom:20px}
  .modal-section-title{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)}
  .stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
  .stat-mini{background:var(--surface2);border-radius:5px;padding:10px 12px}
  .stat-mini-num{font-family:var(--sans);font-size:20px;font-weight:700;color:var(--accent);line-height:1}
  .stat-mini-lbl{font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-top:4px}
  .quad-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;max-width:280px}
  .quad-cell{background:var(--surface2);border-radius:4px;padding:10px 12px;text-align:center}
  .quad-cell-pos{font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
  .quad-cell-val{font-family:var(--sans);font-size:22px;font-weight:700;color:var(--purple)}
  .quad-cell-lbl{font-size:8px;color:var(--muted);margin-top:2px}
  .quad-eye-label{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
  .modal-footer{padding:14px 22px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:flex-end}
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

  ${revoked.length > 0 ? `<div class="card">
    <div class="card-title">Recently Revoked</div>
    <div class="inv-list">${revoked.map(revokedCard).join('')}</div>
  </div>` : ''}

  <div class="card">
    <div class="card-title">Stored Session Summaries</div>
    <div class="inv-list" id="summariesList">
      ${(summaries && summaries.length > 0)
        ? summaries.map(summaryCard).join('')
        : '<div class="empty">No stored summaries yet — summaries are saved automatically when a session completes</div>'}
    </div>
  </div>
</div>

<!-- Summary Detail Modal -->
<div class="modal-backdrop" id="summaryModal">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title" id="modalPatientName">—</div>
      <button class="modal-close" onclick="closeModal()">&#10005;</button>
    </div>
    <div class="modal-body" id="modalBody">
      <div class="empty">Loading…</div>
    </div>
    <div class="modal-footer">
      <button class="btn sm" id="modalCsvBtn" style="display:none" onclick="downloadModalCSV()">Download CSV &#8595;</button>
      <button class="btn sm danger" onclick="closeModal()">Close</button>
    </div>
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

// Poll for status changes every 5s and update badges in-place (no full reload)
const STATUS_LABELS = { pending:'Pending', active:'&#9679; Live', used:'Done', revoked:'Revoked' };
const STATUS_CLASSES = { pending:'pending', active:'active', used:'used', revoked:'revoked' };
async function pollStatuses() {
  try {
    const r = await fetch('/api/invitations/statuses');
    if (!r.ok) return;
    const { statuses } = await r.json();
    let needsReload = false;
    Object.entries(statuses).forEach(([token, status]) => {
      const badge = document.getElementById('status_' + token);
      if (!badge) return;
      const prev = badge.dataset.status;
      if (prev === status) return;
      // FIX 5: Only reload for transitions that require the card to move sections:
      //   pending → active  (patient joined — move card to Active Sessions)
      //   active  → used    (test completed — move card to Completed)
      //   active  → pending (patient dropped mid-test — card stays in place, just rebadge)
      // Do NOT reload for 'revoked' — the doctor triggered that themselves so
      // the card is already hidden/gone. Reloading caused a false "Done" flash.
      if (status === 'used' || (prev === 'pending' && status === 'active')) {
        needsReload = true;
      } else if (prev === 'active' && status === 'pending') {
        // Patient dropped — update badge in-place without full reload
        badge.className = 'inv-status pending';
        badge.dataset.status = 'pending';
        badge.textContent = 'Dropped';
      }
    });
    if (needsReload) location.reload();
  } catch(e) {}
}
setInterval(pollStatuses, 5000);

// ── Session summary viewer ─────────────────────────────────────────────────────
let _modalVftData = null;
let _modalPatientName = '';

function closeModal() {
  document.getElementById('summaryModal').classList.remove('open');
  _modalVftData = null;
}
document.getElementById('summaryModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

function sensitivityLabel(val) {
  if (val === null || val === undefined) return '—';
  if (val <= 60)  return 'Excellent';
  if (val <= 120) return 'Normal';
  if (val <= 180) return 'Reduced';
  return 'Very low';
}
function sensitivityColor(val) {
  if (val === null || val === undefined) return 'var(--muted)';
  if (val <= 60)  return 'var(--accent)';
  if (val <= 120) return '#7adcff';
  if (val <= 180) return 'var(--warn)';
  return 'var(--danger)';
}

async function viewSummary(token) {
  document.getElementById('modalPatientName').textContent = '…';
  document.getElementById('modalBody').innerHTML = '<div class="empty">Loading…</div>';
  document.getElementById('modalCsvBtn').style.display = 'none';
  document.getElementById('summaryModal').classList.add('open');
  try {
    const r = await fetch('/api/sessions/' + token + '/summary');
    if (!r.ok) { document.getElementById('modalBody').innerHTML = '<div class="empty">Could not load summary.</div>'; return; }
    const s = await r.json();
    _modalVftData = s.vftData;
    _modalPatientName = s.patientName;
    const date = new Date(s.completedAt);
    const dateStr = date.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
    const timeStr = date.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
    document.getElementById('modalPatientName').textContent = s.patientName;

    let html = '<div class="modal-section"><div class="modal-section-title">Session Info</div>';
    html += '<div style="font-size:11px;color:var(--muted);line-height:2">';
    if (s.note) html += '<div>Note: <span style="color:var(--text)">' + escHtml(s.note) + '</span></div>';
    html += '<div>Completed: <span style="color:var(--text)">' + dateStr + ' at ' + timeStr + '</span></div>';
    html += '</div></div>';

    // Gaze stats
    if (s.gazeStats) {
      const g = s.gazeStats;
      html += '<div class="modal-section"><div class="modal-section-title">Gaze Tracking</div>';
      html += '<div class="stat-grid">';
      html += statMini(g.focusPct !== undefined ? g.focusPct + '%' : '—', 'Focus time', 'var(--accent)');
      html += statMini(g.awayPct  !== undefined ? g.awayPct  + '%' : '—', 'Off-centre', 'var(--danger)');
      html += statMini(g.alerts   !== undefined ? g.alerts         : '—', 'Alert events', 'var(--warn)');
      html += '</div></div>';
    }

    // VFT data
    if (s.vftData) {
      const v = s.vftData;
      document.getElementById('modalCsvBtn').style.display = 'inline-flex';

      const eyes = Object.keys(v.eyeThresholds || {});
      if (eyes.length > 0) {
        html += '<div class="modal-section"><div class="modal-section-title">VFT — Quadrant Thresholds (0–255 · lower = better)</div>';
        eyes.forEach(eye => {
          const th = v.eyeThresholds[eye];
          const quadVals = { TL:[], TR:[], BL:[], BR:[] };
          const QUAD_MAP = { R1C1:'TL',R1C2:'TL',R2C1:'TL',R2C2:'TL', R1C3:'TR',R1C4:'TR',R2C3:'TR',R2C4:'TR', R3C1:'BL',R3C2:'BL',R4C1:'BL',R4C2:'BL', R3C3:'BR',R3C4:'BR',R4C3:'BR',R4C4:'BR' };
          Object.entries(th).forEach(([posId, val]) => { const q=QUAD_MAP[posId]; if(q && val!==null && val!==undefined) quadVals[q].push(val); });
          const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
          const tl=avg(quadVals.TL), tr=avg(quadVals.TR), bl=avg(quadVals.BL), br=avg(quadVals.BR);
          html += '<div class="quad-eye-label">' + eye.charAt(0).toUpperCase()+eye.slice(1) + ' Eye</div>';
          html += '<div class="quad-grid" style="margin-bottom:14px">';
          html += quadCell('Upper-Left',  tl);
          html += quadCell('Upper-Right', tr);
          html += quadCell('Lower-Left',  bl);
          html += quadCell('Lower-Right', br);
          html += '</div>';
        });
        html += '</div>';
      }

      if (v.totalTrials !== undefined) {
        html += '<div class="modal-section"><div class="modal-section-title">VFT Stats</div>';
        html += '<div class="stat-grid">';
        html += statMini(v.totalTrials, 'Total trials', 'var(--purple)');
        const eyes2 = Object.keys(v.eyeThresholds || {});
        html += statMini(eyes2.length === 2 ? 'Both' : (eyes2[0] || '—'), 'Eyes tested', 'var(--text)');
        html += statMini(v.trialLog ? v.trialLog.filter(t=>t.seen).length : '—', 'Seen stimuli', 'var(--accent)');
        html += '</div></div>';
      }
    }

    if (!s.gazeStats && !s.vftData) {
      html += '<div class="empty" style="margin-top:0">No detailed data was captured for this session.</div>';
    }

    document.getElementById('modalBody').innerHTML = html;
  } catch(e) {
    document.getElementById('modalBody').innerHTML = '<div class="empty">Error loading summary.</div>';
  }
}

function statMini(val, lbl, color) {
  return '<div class="stat-mini"><div class="stat-mini-num" style="color:'+color+'">'+escHtml(String(val))+'</div><div class="stat-mini-lbl">'+escHtml(lbl)+'</div></div>';
}
function quadCell(pos, val) {
  const color = sensitivityColor(val);
  const lbl = sensitivityLabel(val);
  return '<div class="quad-cell"><div class="quad-cell-pos">'+pos+'</div><div class="quad-cell-val" style="color:'+color+'">'+(val !== null && val !== undefined ? val : '—')+'</div><div class="quad-cell-lbl">'+lbl+'</div></div>';
}
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── CSV Download from stored summary ──────────────────────────────────────────
function downloadModalCSV() {
  if (!_modalVftData) { alert('No VFT data available.'); return; }
  const vft = _modalVftData;
  const log = vft.trialLog || [];
  if (!log.length) { alert('No trial log in this session.'); return; }
  buildAndDownloadCSV(log, vft.eyeThresholds || {}, _modalPatientName);
}

async function downloadSummaryCSV(token) {
  try {
    const r = await fetch('/api/sessions/' + token + '/summary');
    if (!r.ok) { alert('Could not load summary.'); return; }
    const s = await r.json();
    if (!s.vftData || !s.vftData.trialLog || !s.vftData.trialLog.length) { alert('No VFT trial data for this session.'); return; }
    buildAndDownloadCSV(s.vftData.trialLog, s.vftData.eyeThresholds || {}, s.patientName);
  } catch(e) { alert('Download failed.'); }
}

function buildAndDownloadCSV(log, eyeThresholds, patientName) {
  const escape = v => { const s=String(v===null||v===undefined?'':v); return s.includes(',')||s.includes('"')||s.includes('\\n') ? '"'+s.replace(/"/g,'""')+'"' : s; };
  const row = cols => cols.map(escape).join(',');
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'});
  const timeStr = now.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});

  function fieldLocation(dx, dy) {
    const h = dx < -0.15 ? 'Left' : dx > 0.15 ? 'Right' : 'Central';
    const v = dy < -0.15 ? 'Upper': dy > 0.15 ? 'Lower' : 'Central';
    if (v==='Central' && h==='Central') return 'Centre';
    if (v==='Central') return h; if (h==='Central') return v;
    return v+'-'+h;
  }
  function sensLbl(val) {
    if (val===null||val===undefined) return 'Not tested';
    if (val<=60) return 'High (excellent)'; if (val<=120) return 'Normal';
    if (val<=180) return 'Reduced'; return 'Very low';
  }
  const QUAD_MAP = { R1C1:'TL',R1C2:'TL',R2C1:'TL',R2C2:'TL', R1C3:'TR',R1C4:'TR',R2C3:'TR',R2C4:'TR', R3C1:'BL',R3C2:'BL',R4C1:'BL',R4C2:'BL', R3C3:'BR',R3C4:'BR',R4C3:'BR',R4C4:'BR' };

  const lines = [
    '# CenterGaze — Visual Field Test Report (Stored Summary)',
    '# Patient : ' + patientName,
    '# Date    : ' + dateStr + '  ' + timeStr,
    '# Trials  : ' + log.length,
    '',
  ];

  // Quadrant summaries per eye
  Object.entries(eyeThresholds).forEach(([eye, th]) => {
    const qv = {TL:[],TR:[],BL:[],BR:[]};
    Object.entries(th).forEach(([posId,val])=>{ const q=QUAD_MAP[posId]; if(q&&val!==null&&val!==undefined) qv[q].push(val); });
    const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
    const tl=avg(qv.TL),tr=avg(qv.TR),bl=avg(qv.BL),br=avg(qv.BR);
    const fmt = v => v!==null ? String(v).padStart(3) : ' — ';
    lines.push('# Quadrant Summary — ' + eye.toUpperCase() + ' EYE  (0-255 · lower = better)');
    lines.push('#               LEFT FIELD    |    RIGHT FIELD');
    lines.push('#  UPPER  :    ' + fmt(tl) + '           |         ' + fmt(tr));
    lines.push('#  LOWER  :    ' + fmt(bl) + '           |         ' + fmt(br));
    lines.push('');
  });

  // Position threshold table per eye
  const posOrder = ['R1C1','R1C2','R1C3','R1C4','R2C1','R2C2','R2C3','R2C4','R3C1','R3C2','R3C3','R3C4','R4C1','R4C2','R4C3','R4C4'];
  Object.entries(eyeThresholds).forEach(([eye, th]) => {
    lines.push('# Position Thresholds — ' + eye.toUpperCase() + ' EYE');
    lines.push(row(['Location','Position ID','Eye','Threshold (0-255)','Sensitivity']));
    posOrder.forEach(posId => {
      const val = th[posId]; if(val===null||val===undefined) return;
      const trial = log.find(t => t.position_id === posId && (t.eye===eye||!t.eye));
      const loc = trial ? fieldLocation(trial.dx, trial.dy) : posId;
      lines.push(row([loc, posId, eye, val, sensLbl(val)]));
    });
    lines.push('');
  });

  // Trial log
  lines.push('# Trial Log');
  lines.push(row(['Trial #','Eye','Field Location','Position ID','Luminance','Result','Reaction Time (ms)','Time into Session (s)']));
  const t0 = log.length > 0 ? log[0].timestamp_ms : 0;
  log.forEach(r => {
    const elapsed = r.timestamp_ms && t0 ? Math.round((r.timestamp_ms - t0)/1000) : '';
    lines.push(row([r.trial_number, r.eye ? r.eye.charAt(0).toUpperCase()+r.eye.slice(1):'—', fieldLocation(r.dx, r.dy), r.position_id, r.luminance, r.seen?'SEEN':'MISSED', r.seen&&r.rt_ms?r.rt_ms:'—', elapsed]));
  });

  const csv = lines.join('\\r\\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = now.toISOString().replace(/[:.]/g,'-').slice(0,16);
  a.href = url; a.download = 'centergaze_' + patientName.replace(/[^a-z0-9]/gi,'_') + '_' + ts + '.csv';
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}</script>
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
      // FIX 6: Limit pending invitations per doctor to prevent spam/runaway links
      const pendingCount = await query(
        `SELECT COUNT(*) FROM invitations WHERE doctor_id=$1 AND status='pending'`,
        [doctor.id]
      );
      if (parseInt(pendingCount.rows[0].count, 10) >= 20) {
        return sendJSON(res, 429, { error: 'Too many pending invitations (max 20). Revoke unused links first.' });
      }
      const token = generateToken();
      await query(
        'INSERT INTO invitations (token, doctor_id, patient_name, note, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [token, doctor.id, patientName, note || '', 'pending', Date.now()]
      );
      return sendJSON(res, 200, { ok: true, token });
    }

    if (url === '/api/invitations/statuses' && req.method === 'GET') {
      if (!doctor) return sendJSON(res, 401, { error: 'Not authenticated' });
      const r = await query(
        'SELECT token, status FROM invitations WHERE doctor_id = $1',
        [doctor.id]
      );
      const statuses = {};
      r.rows.forEach(row => { statuses[row.token] = row.status; });
      return sendJSON(res, 200, { statuses });
    }

    if (url.startsWith('/api/invitations/') && req.method === 'DELETE') {
      if (!doctor) return sendJSON(res, 401, { error: 'Not authenticated' });
      const token = url.replace('/api/invitations/', '');
      const r = await query('SELECT doctor_id, status FROM invitations WHERE token = $1', [token]);
      if (!r.rows.length || r.rows[0].doctor_id !== doctor.id)
        return sendJSON(res, 404, { error: 'Not found' });
      // FIX 5: Soft-delete by marking 'revoked' instead of hard DELETE.
      // This preserves audit history and prevents false "completed" status on the dashboard.
      // Only pending/active sessions can be revoked — used/revoked ones are already closed.
      const status = r.rows[0].status;
      if (status === 'used' || status === 'revoked') {
        return sendJSON(res, 400, { error: 'Cannot revoke a session that is already completed or revoked.' });
      }
      await query(`UPDATE invitations SET status='revoked' WHERE token=$1`, [token]);
      return sendJSON(res, 200, { ok: true });
    }

    // ── Session Summary API ───────────────────────────────────────────────────

    // POST /api/sessions/:token/summary  — doctor monitor pushes summary on completion
    const summaryPost = url.match(/^\/api\/sessions\/([a-f0-9]{40})\/summary$/);
    if (summaryPost && req.method === 'POST') {
      if (!doctor) return sendJSON(res, 401, { error: 'Not authenticated' });
      const token = summaryPost[1];
      const r = await query('SELECT * FROM invitations WHERE token=$1', [token]);
      const inv = r.rows[0] ? rowToInv(r.rows[0]) : null;
      if (!inv || inv.doctorId !== doctor.id) return sendJSON(res, 404, { error: 'Not found' });
      const body = await readBody(req);
      const { gazeStats, vftData } = body;
      await query(`
        INSERT INTO session_summaries (token, doctor_id, patient_name, note, completed_at, gaze_stats, vft_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (token) DO UPDATE
          SET gaze_stats=$6, vft_data=$7, completed_at=$5
      `, [token, doctor.id, inv.patientName, inv.note, Date.now(),
          JSON.stringify(gazeStats || null), JSON.stringify(vftData || null)]);
      console.log(`[summary] saved for token=${token} patient=${inv.patientName}`);
      return sendJSON(res, 200, { ok: true });
    }

    // GET /api/sessions/history  — list all completed summaries for this doctor
    if (url === '/api/sessions/history' && req.method === 'GET') {
      if (!doctor) return sendJSON(res, 401, { error: 'Not authenticated' });
      const r = await query(`
        SELECT token, patient_name, note, completed_at,
               gaze_stats IS NOT NULL  AS has_gaze,
               vft_data   IS NOT NULL  AS has_vft
        FROM session_summaries
        WHERE doctor_id=$1
        ORDER BY completed_at DESC
        LIMIT 100
      `, [doctor.id]);
      return sendJSON(res, 200, { sessions: r.rows });
    }

    // GET /api/sessions/:token/summary  — full data for one session
    const summaryGet = url.match(/^\/api\/sessions\/([a-f0-9]{40})\/summary$/);
    if (summaryGet && req.method === 'GET') {
      if (!doctor) return sendJSON(res, 401, { error: 'Not authenticated' });
      const token = summaryGet[1];
      const r = await query(
        'SELECT * FROM session_summaries WHERE token=$1 AND doctor_id=$2',
        [token, doctor.id]
      );
      if (!r.rows.length) return sendJSON(res, 404, { error: 'Not found' });
      const row = r.rows[0];
      return sendJSON(res, 200, {
        token: row.token,
        patientName: row.patient_name,
        note: row.note,
        completedAt: Number(row.completed_at),
        gazeStats: row.gaze_stats,
        vftData:   row.vft_data,
      });
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
      const rs = await query(
        `SELECT token, patient_name, note, completed_at,
                gaze_stats IS NOT NULL AS has_gaze,
                vft_data   IS NOT NULL AS has_vft
         FROM session_summaries WHERE doctor_id=$1 ORDER BY completed_at DESC LIMIT 100`,
        [doctor.id]
      );
      return sendHTML(res, buildDashboardHTML(doctor, myInvs, origin, rs.rows));
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
      if (!inv || inv.status === 'expired' || inv.status === 'revoked')
        return sendHTML(res, errorPage('This invitation link has been revoked or is invalid.'), 404);
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
      if (!inv || inv.status === 'expired' || inv.status === 'revoked')
        return sendHTML(res, errorPage('This invitation link has been revoked or is invalid.'), 404);
      if (inv.status === 'used') return sendHTML(res, errorPage('This session has already been completed.'), 410);
      // FIX 1 & 2: Track 'started_at' the moment the patient clicks Begin,
      // but don't mark 'active' here — the WS connection is the true signal.
      // This avoids the race where HTTP sets 'active' but the WS never opens.
      if (inv.status === 'pending') {
        await query('UPDATE invitations SET started_at=$1 WHERE token=$2', [Date.now(), patStart[1]]);
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
// rooms[doctorId] = {
//   doctors:  Set<ws>,
//   patient:  ws|null,
//   invToken: string|null,
//   buffer:   Array<string>   ← session buffer: replayed to any doctor that connects late
// }
const rooms = {};
function getRoom(doctorId) {
  if (!rooms[doctorId]) rooms[doctorId] = { doctors: new Set(), patient: null, invToken: null, buffer: [] };
  return rooms[doctorId];
}

// Message types worth buffering (not high-frequency gaze noise).
// A doctor opening the monitor late will receive all of these in order,
// reconstructing the full test state as if they had been watching from the start.
const BUFFER_TYPES = new Set([
  'session_start', 'screen_metrics',
  'baseline_start', 'baseline_created', 'baseline_reused',
  'eye_selected',
  'vft_start', 'vft_stim', 'vft_response', 'vft_complete', 'vft_both_complete', 'vft_aborted',
  'stats',
  'patient_disconnected'
]);
// Hard cap so a very long test can't grow the buffer unboundedly.
const BUFFER_MAX = 2000;

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
      console.log(`[WS] +doctor(${d.name}) room=${d.id} docs=${room.doctors.size} buf=${room.buffer.length}`);

      // ── Replay buffered session data ──────────────────────────────────────
      // If the patient is already mid-test (or the test already finished) when
      // the doctor opens the monitor, flush the entire buffer in order so the
      // doctor UI can reconstruct exactly what happened so far.
      if (room.buffer.length > 0) {
        // Prepend a synthetic marker so doctor.js can show a "catch-up replay" notice
        const catchupHeader = JSON.stringify({ type: '_replay_start', count: room.buffer.length, ts: Date.now() });
        if (ws.readyState === 1) ws.send(catchupHeader);
        for (const msg of room.buffer) {
          if (ws.readyState !== 1) break;
          ws.send(msg);
        }
        const catchupFooter = JSON.stringify({ type: '_replay_end', ts: Date.now() });
        if (ws.readyState === 1) ws.send(catchupFooter);
        console.log(`[WS] replayed ${room.buffer.length} buffered messages to doctor(${d.name})`);
      }

      ws.on('close', () => { room.doctors.delete(ws); console.log(`[WS] -doctor(${d.name})`); });
      ws.on('error', err => { console.error('[WS] doctor error:', err.message); room.doctors.delete(ws); });
      ws.on('message', () => {});
      return;
    }

    // ── Patient WebSocket ───────────────────────────────────────────────────
    if (role === 'patient') {
      const r = await query('SELECT * FROM invitations WHERE token = $1', [token]);
      const inv = r.rows[0] ? rowToInv(r.rows[0]) : null;
      // FIX 3: Allow reconnect — accept 'pending' OR 'active' (patient refresh mid-session)
      if (!inv || (inv.status !== 'active' && inv.status !== 'pending')) {
        ws.close(1008, 'Invalid or expired token'); return;
      }

      const room = getRoom(inv.doctorId);
      if (room.patient && room.patient.readyState === 1) {
        ws.close(1008, 'Session busy — another patient is already connected'); return;
      }

      // FIX 2 & 3: Mark 'active' only on WS open (not on HTTP /start).
      // used_at is set when the test truly completes, not on disconnect.
      await query('UPDATE invitations SET status=$1, used_at=$2 WHERE token=$3', ['active', Date.now(), token]);
      inv.status = 'active';

      // Clear any buffer from a previous session so a reconnecting patient
      // or a new patient for the same doctor starts with a clean slate.
      room.buffer = [];

      // Track whether the test completed during this WS session
      let testCompleted = false;

      room.patient  = ws;
      room.invToken = token;
      console.log(`[WS] +patient(${inv.patientName}) room=${inv.doctorId} docs=${room.doctors.size}`);

      ws.on('message', (raw, isBinary) => {
        const payload = isBinary ? raw : raw.toString('utf8');

        // FIX 2: Listen for the completion signal so we know the test truly finished
        // Also buffer important messages so a doctor joining late gets full replay
        try {
          const msg = JSON.parse(isBinary ? raw.toString('utf8') : raw.toString('utf8'));
          if (msg.type === 'vft_both_complete') {
            testCompleted = true;
          }
          // Augment session_start with the invitation token so the doctor UI can
          // reference the correct session when saving summaries.
          if (msg.type === 'session_start') {
            msg.token = token;
            const augmented = JSON.stringify(msg);
            if (BUFFER_TYPES.has(msg.type) && room.buffer.length < BUFFER_MAX) {
              room.buffer.push(augmented);
            }
            for (const doc of room.doctors) {
              if (doc.readyState !== 1) continue;
              if (doc.bufferedAmount > MAX_MESSAGE_BYTES * 3) continue;
              doc.send(augmented);
            }
            return;
          }
          // Buffer this message if it's a meaningful test event (not noisy gaze frames)
          if (BUFFER_TYPES.has(msg.type)) {
            if (room.buffer.length < BUFFER_MAX) {
              room.buffer.push(typeof payload === 'string' ? payload : payload.toString('utf8'));
            }
          }
        } catch(e) { /* non-JSON frames are fine */ }

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

          if (testCompleted) {
            // Test finished normally — seal the session as 'used'
            await query('UPDATE invitations SET status=$1 WHERE token=$2', ['used', token]);
            inv.status = 'used';
            // Keep buffer intact: doctor may still open the monitor after the
            // session ends to review exactly what happened.
            console.log(`[WS] -patient(${inv.patientName}) — session completed`);
          } else {
            // FIX 2: Patient disconnected mid-test (refresh, crash, closed tab).
            // Reset to 'pending' so the link stays valid and the patient can reconnect.
            await query('UPDATE invitations SET status=$1 WHERE token=$2', ['pending', token]);
            inv.status = 'pending';
            console.log(`[WS] -patient(${inv.patientName}) — disconnected before completion, reset to pending`);
            // Notify doctor that patient dropped so they're not left staring at a frozen screen.
            // Also push to buffer so a doctor who wasn't watching sees the drop event on connect.
            const dropMsg = JSON.stringify({ type: 'patient_disconnected', ts: Date.now() });
            room.buffer.push(dropMsg);
            for (const doc of room.doctors) {
              if (doc.readyState === 1) doc.send(dropMsg);
            }
          }
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