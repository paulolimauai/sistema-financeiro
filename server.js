const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const net = require('net');
const tls = require('tls');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

// ==================== Conexão com o PostgreSQL ====================
const pool = process.env.DATABASE_URL
  ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  })
  : new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '86266049',
    database: process.env.DB_NAME || 'FINANCEIRO',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

// Usuário admin padrão, inserido no banco na primeira execução
const DEFAULT_ADMIN = {
  name: 'Paulo Lima',
  email: 'admin@nexusfinanceiro.com',
  password: '86266049',
  role: 'Administrador',
  active: true
};

// Disparo real de e-mail via Socket SMTP Nativo (compatível com Gmail sem pacotes externos)
function sendPasswordEmail(toEmail, userName, userPassword) {
  return new Promise((resolve) => {
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = parseInt(process.env.SMTP_PORT || '465');
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!user || !pass) {
      console.log(`[AVISO] Credenciais SMTP ausentes no Render. E-mail não enviado para ${toEmail}`);
      return resolve(false);
    }

    const socket = tls.connect(port, host, { rejectUnauthorized: false }, () => {
      let step = 0;

      const send = (cmd) => {
        try { socket.write(cmd + '\r\n'); } catch (e) { }
      };

      socket.on('data', (data) => {
        try {
          const response = data.toString();

          if (step === 0 && response.startsWith('220')) {
            step++;
            send(`EHLO ${host}`);
          } else if (step === 1 && response.startsWith('250')) {
            step++;
            send('AUTH LOGIN');
          } else if (step === 2 && response.startsWith('334')) {
            step++;
            send(Buffer.from(user).toString('base64'));
          } else if (step === 3 && response.startsWith('334')) {
            step++;
            send(Buffer.from(pass).toString('base64'));
          } else if (step === 4 && response.startsWith('235')) {
            step++;
            send(`MAIL FROM:<${user}>`);
          } else if (step === 5 && response.startsWith('250')) {
            step++;
            send(`RCPT TO:<${toEmail}>`);
          } else if (step === 6 && response.startsWith('250')) {
            step++;
            send('DATA');
          } else if (step === 7 && response.startsWith('354')) {
            step++;
            const body = [
              `From: "Nexus Financeiro" <${user}>`,
              `To: <${toEmail}>`,
              `Subject: Recuperacao de Senha - Nexus Financeiro`,
              'MIME-Version: 1.0',
              'Content-Type: text/html; charset=UTF-8',
              '',
              '<div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #1f2530; border-radius: 10px; background-color: #0b0e12; color: #e9edf3;">',
              '  <h2 style="color: #e8b04b; text-align: center;">Nexus Financeiro Hub</h2>',
              `  <p>Olá, <strong>${userName}</strong>!</p>`,
              '  <p>Você solicitou o envio da sua senha de acesso ao sistema Nexus Financeiro.</p>',
              '  <p>Sua senha cadastrada é:</p>',
              '  <div style="text-align: center; margin: 25px 0;">',
              `    <span style="font-size: 24px; font-weight: bold; color: #e8b04b; background: #141821; padding: 10px 20px; border-radius: 8px; border: 1px solid #1f2530;">${userPassword}</span>`,
              '  </div>',
              '  <p style="font-size: 12px; color: #8a93a3;">Se você não solicitou este e-mail, recomendamos alterar sua senha após realizar o login.</p>',
              '</div>',
              '.'
            ].join('\r\n');
            send(body);
          } else if (step === 8 && response.startsWith('250')) {
            step++;
            send('QUIT');
            resolve(true);
          }
        } catch (err) {
          resolve(false);
        }
      });
    });

    socket.on('error', (err) => {
      console.error('Erro na conexão SMTP:', err);
      resolve(false);
    });
  });
}

// Cria as tabelas (se não existirem) e garante o admin padrão
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'Usuário',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dados_financeiros (
      id SERIAL PRIMARY KEY,
      email VARCHAR(150) UNIQUE NOT NULL REFERENCES usuarios(email) ON DELETE CASCADE ON UPDATE CASCADE,
      dados JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMP NOT NULL DEFAULT now(),
      user_name VARCHAR(150),
      user_email VARCHAR(150),
      action VARCHAR(50) NOT NULL,
      entity VARCHAR(50) NOT NULL,
      details TEXT NOT NULL
    );
  `);

  await pool.query(
    `INSERT INTO usuarios (name, email, password, role, active)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING;`,
    [DEFAULT_ADMIN.name, DEFAULT_ADMIN.email, DEFAULT_ADMIN.password, DEFAULT_ADMIN.role, DEFAULT_ADMIN.active]
  );
}

// Conteúdo HTML/JS/CSS da aplicação centralizada com isolamento por usuário
const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0b0e12" id="metaThemeColor">
<script>
(function() {
  try {
    var t = localStorage.getItem('nexus_theme');
    if (t === 'light') {
      document.documentElement.classList.add('light');
    }
    var cu = localStorage.getItem('nexus_cached_user');
    var s = localStorage.getItem('nexus_session');
    if (s || cu) {
      document.documentElement.classList.add('user-logged-in');
      var uObj = cu ? JSON.parse(cu) : null;
      if (uObj && uObj.role === 'Administrador') {
        document.documentElement.classList.add('is-admin');
      }
    }
  } catch(e){}
})();
</script>
<style>
html.user-logged-in #authPage { display: none !important; }
html.user-logged-in #appMain { display: block !important; }

html.is-admin nav.menu button:not(#menuUsuariosBtn):not(#menuLogsBtn):not(#menuFuncoesBtn),
html.is-admin nav.mobile-drawer-nav button:not(#mobileDrawerUsuariosBtn):not(#mobileDrawerLogsBtn):not(#mobileDrawerFuncoesBtn) {
  display: none !important;
}

html.is-admin #menuUsuariosBtn,
html.is-admin #menuLogsBtn,
html.is-admin #menuFuncoesBtn,
html.is-admin #mobileDrawerUsuariosBtn,
html.is-admin #mobileDrawerLogsBtn,
html.is-admin #mobileDrawerFuncoesBtn {
  display: flex !important;
}

:root{
  --bg:#070b16; --sidebar:#0a101d; --card:#0f172a; --card-border:rgba(232,176,75,0.22);
  --text:#f3f4f6; --text-dim:#9ca3af; --text-faint:#6b7280;
  --green:#fbbf24; --green-soft:rgba(251,191,36,.15);
  --emerald:#10b981; --emerald-soft:rgba(16,185,129,.15);
  --red:#f43f5e; --red-soft:rgba(244,63,94,.15);
  --blue:#38bdf8; --purple:#a855f7; --orange:#f59e0b; --teal:#14b8a6; --pink:#ec4899;
  --hover:rgba(232,176,75,.09);
  --radius:16px;
  --shadow:0 12px 32px rgba(0,0,0,.55), 0 0 20px rgba(232,176,75,0.08);
}
body.light, html.light body{
  --bg:#f4f6f9; --sidebar:#ffffff; --card:#ffffff; --card-border:#e6e9ef;
  --text:#1b2028; --text-dim:#6b7280; --text-faint:#9aa2b1;
  --hover:#eef1f6;
  --shadow:0 6px 18px rgba(20,30,60,.08);
}
*{box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent;}
html, body{overflow-x:hidden; width:100%;}
body{
  font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Arial,sans-serif;
  background:var(--bg); color:var(--text); min-height:100vh; transition:background .25s,color .25s;
}
button, input, select{font-family:inherit; color:inherit;}
code{background:var(--hover); padding:1px 6px; border-radius:5px; font-size:11.5px;}

/* Prevenção de Piscamento/Flicker */
#pageContent {
  contain: content;
  will-change: auto;
}

/* ==================== Tela de Auth (Dourado/Âmbar Executivo 4K) ==================== */
.auth-container{
  --auth-accent:#fbbf24; --auth-accent-2:#d97706; --auth-accent-3:#fef08a;
  --auth-accent-soft:rgba(251,191,36,.18); --auth-text-on:#0b0f19;
  position:relative; overflow:hidden;
  display:none; align-items:center; justify-content:center; flex-direction:column; min-height:100vh; padding:20px;
  background:
    radial-gradient(circle at 20% 15%, rgba(232,176,75,0.18), transparent 45%),
    radial-gradient(circle at 85% 85%, rgba(99,102,241,0.15), transparent 50%),
    radial-gradient(circle at 50% 50%, rgba(16,185,129,0.08), transparent 65%),
    linear-gradient(135deg, #040711 0%, #080e21 40%, #0c142e 70%, #060b18 100%);
}
.auth-container.show { display: flex; }
.auth-grid{
  position:absolute; inset:0; z-index:0; pointer-events:none;
  background-image:
    linear-gradient(rgba(232,176,75,.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(232,176,75,.07) 1px, transparent 1px);
  background-size:54px 54px;
  -webkit-mask-image:radial-gradient(circle at 50% 42%, #000 0%, transparent 72%);
  mask-image:radial-gradient(circle at 50% 42%, #000 0%, transparent 72%);
}
.auth-chart{
  position:absolute; inset:0; width:100%; height:100%; z-index:0; pointer-events:none; opacity:.38;
  -webkit-mask-image:linear-gradient(to bottom, transparent, #000 22%, #000 92%, transparent);
  mask-image:radial-gradient(circle at 50% 42%, #000 0%, transparent 72%);
}
.auth-chart .chart-area{animation:chartBreathe 7s ease-in-out infinite;}
.auth-chart .chart-line{
  stroke-dasharray:2600; stroke-dashoffset:2600;
  animation:chartDraw 3.2s ease-out forwards, chartGlow 4s ease-in-out 3.2s infinite;
}
.auth-chart .chart-candles{animation:candlesFade 1.4s ease-out .6s backwards;}
@keyframes chartDraw{to{stroke-dashoffset:0;}}
@keyframes chartBreathe{0%,100%{opacity:1;} 50%{opacity:.65;}}
@keyframes chartGlow{0%,100%{filter:drop-shadow(0 0 0px var(--auth-accent));} 50%{filter:drop-shadow(0 0 6px var(--auth-accent));}}
@keyframes candlesFade{from{opacity:0;} to{opacity:.8;}}
body.light .auth-grid{opacity:.5;}
body.light .auth-chart{opacity:.3;}
.auth-blob{position:absolute; border-radius:50%; filter:blur(70px); opacity:.28; pointer-events:none; will-change:transform;}
.auth-blob.b1{width:360px; height:360px; background:var(--auth-accent); top:-110px; left:-100px; animation:blobFloat 24s ease-in-out infinite;}
.auth-blob.b2{width:320px; height:320px; background:var(--auth-accent-2); bottom:-130px; right:-90px; animation:blobFloat 28s ease-in-out infinite; animation-delay:-8s;}
body.light .auth-blob{opacity:.16;}
@keyframes blobFloat{
  0%,100%{transform:translate(0,0) scale(1);}
  33%{transform:translate(35px,-40px) scale(1.1);}
  66%{transform:translate(-30px,28px) scale(.92);}
}

@keyframes authIn{
  from{opacity:0; transform:translateY(26px) scale(.96);}
  to{opacity:1; transform:translateY(0) scale(1);}
}
@keyframes fieldIn{
  from{opacity:0; transform:translateY(10px);}
  to{opacity:1; transform:translateY(0);}
}
.auth-box{
  position:relative; z-index:1;
  background:rgba(10,15,29,0.88); border:1.5px solid rgba(232,176,75,0.38); border-radius:24px;
  padding:36px; width:100%; max-width:420px;
  box-shadow:0 30px 70px rgba(0,0,0,0.85), 0 0 45px rgba(232,176,75,0.2), inset 0 1px 1px rgba(255,255,255,0.2);
  backdrop-filter:blur(32px); -webkit-backdrop-filter:blur(32px);
  animation:authIn .55s cubic-bezier(.16,1,.3,1);
}
.auth-box .brand{display:flex; justify-content:center; margin-bottom:24px; padding:0;}
.auth-box .brand .logo{
  background:linear-gradient(135deg,var(--auth-accent),var(--auth-accent-2)) !important; color:var(--auth-text-on) !important;
  animation:logoPulse 3s ease-in-out infinite; box-shadow:0 0 20px rgba(232,176,75,0.4);
}
@keyframes logoPulse{
  0%,100%{box-shadow:0 0 0 0 rgba(232,176,75,.45);}
  50%{box-shadow:0 0 0 9px rgba(232,176,75,0);}
}
.auth-box h2{font-size:22px; font-weight:800; margin-bottom:6px; text-align:center; color:#fff; letter-spacing:-0.01em;}
.auth-box p.sub{font-size:13px; color:var(--text-dim); text-align:center; margin-bottom:24px; transition:color .2s;}
.auth-box .field{margin-bottom:16px; animation:fieldIn .45s ease backwards;}
.auth-box .field:nth-of-type(1){animation-delay:.05s;}
.auth-box .field:nth-of-type(2){animation-delay:.1s;}
.auth-box .field input{
  background:rgba(8,12,22,0.85); border:1px solid rgba(232,176,75,0.25); border-radius:12px;
  padding:12px 14px; color:#fff; transition:border-color .25s, box-shadow .25s, transform .15s;
}
.auth-box .field input:focus, .auth-box .field select:focus{
  border-color:#fbbf24; box-shadow:0 0 25px rgba(232,176,75,0.35); transform:translateY(-1px);
}
.auth-forgot{display:block; text-align:right; font-size:12px; color:var(--text-dim); margin-top:8px; cursor:pointer; transition:color .15s;}
.auth-forgot:hover{color:#fbbf24; text-decoration:underline;}
.auth-box .btn-auth{
  position:relative; overflow:hidden;
  width:100%; padding:13.5px; background:linear-gradient(135deg, #fbbf24 0%, #f59e0b 50%, #d97706 100%); color:#0b0f19; border:none;
  border-radius:12px; font-weight:800; font-size:14.5px; letter-spacing:0.04em; text-transform:uppercase; cursor:pointer; margin-top:10px;
  box-shadow:0 10px 28px -4px rgba(245,158,11,0.48), 0 0 20px rgba(232,176,75,0.25);
  transition:all .25s cubic-bezier(0.16, 1, 0.3, 1);
}
.auth-box .btn-auth::after{
  content:''; position:absolute; top:0; left:-75%; width:45%; height:100%;
  background:linear-gradient(120deg, transparent, rgba(255,255,255,.55), transparent);
  transform:skewX(-20deg);
}
.auth-box .btn-auth:hover{filter:brightness(1.08); transform:translateY(-2px); box-shadow:0 14px 34px -4px rgba(245,158,11,0.6);}
.auth-box .btn-auth:hover::after{animation:shimmer .9s ease;}
.auth-box .btn-auth:active{transform:translateY(0) scale(.98);}
@keyframes shimmer{from{left:-75%;} to{left:130%;}}
.auth-toggle{text-align:center; font-size:13px; color:var(--text-dim); margin-top:22px; padding-top:18px; border-top:1px solid var(--card-border);}
.auth-toggle a{color:var(--auth-accent); text-decoration:none; font-weight:600; cursor:pointer;}
.auth-toggle a:hover{text-decoration:underline;}

/* ==================== App principal Centralizado ==================== */
.app{
  display:none; min-height:100vh; position:relative; flex-direction:column;
  background:
    radial-gradient(circle at 12% 0%, rgba(232,176,75,.10), transparent 40%),
    radial-gradient(circle at 88% 18%, rgba(201,134,42,.08), transparent 45%),
    radial-gradient(circle at 50% 100%, rgba(232,176,75,.05), transparent 55%),
    var(--bg);
}
.app.show{display:flex;}
body.light .app{
  background:
    radial-gradient(circle at 12% 0%, rgba(232,176,75,.08), transparent 40%),
    radial-gradient(circle at 88% 18%, rgba(201,134,42,.06), transparent 45%),
    var(--bg);
}

.app-bg-scene{position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden;}
.app-bg-grid{
  position:absolute; inset:0;
  background-image:
    linear-gradient(rgba(232,176,75,.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(232,176,75,.06) 1px, transparent 1px);
  background-size:54px 54px;
  -webkit-mask-image:radial-gradient(circle at 20% 0%, #000 0%, transparent 65%);
  mask-image:radial-gradient(circle at 20% 0%, #000 0%, transparent 65%);
}
.app-bg-chart{position:absolute; inset:0; width:100%; height:100%; opacity:.16;}
.app-blob{position:absolute; border-radius:50%; filter:blur(90px); opacity:.16; will-change:transform;}
.app-blob.a1{width:420px; height:420px; background:var(--green); top:-140px; right:-120px; animation:blobFloat 30s ease-in-out infinite;}
.app-blob.a2{width:360px; height:360px; background:#c9862a; bottom:-150px; left:20%; animation:blobFloat 34s ease-in-out infinite; animation-delay:-10s;}
.app-blob.a3{width:300px; height:300px; background:var(--teal); opacity:.08; top:38%; left:-100px; animation:blobFloat 38s ease-in-out infinite; animation-delay:-18s;}
body.light .app-bg-grid{opacity:.6;}
body.light .app-bg-chart{opacity:.08;}
body.light .app-blob{opacity:.08;}
body.light .app-blob.a3{opacity:.05;}

/* ==================== Cabeçalho superior (nav horizontal & drawer mobile) ==================== */
.topheader{
  position:sticky; top:0; z-index:50; background:var(--sidebar); border-bottom:1px solid var(--card-border);
  backdrop-filter:blur(10px); padding-top:env(safe-area-inset-top);
}
.topheader-row{
  display:flex; align-items:center; gap:20px; padding:15px 28px; max-width:1440px; margin:0 auto;
}
.mobile-menu-btn {
  display:none; width:40px; height:40px; border-radius:11px;
  background:var(--card); border:1px solid var(--card-border);
  align-items:center; justify-content:center; cursor:pointer;
  color:var(--text); flex-shrink:0; transition:background .15s;
}
.mobile-menu-btn:hover { background:var(--hover); }

/* Drawer Mobile Slide-out */
.mobile-drawer-overlay {
  position:fixed; inset:0; background:rgba(0,0,0,0.65);
  backdrop-filter:blur(4px); z-index:990; display:none; opacity:0;
  transition:opacity 0.25s ease;
}
.mobile-drawer-overlay.show { display:block; opacity:1; }

.mobile-drawer {
  position:fixed; top:0; left:0; bottom:0; width:290px; max-width:84vw;
  background:var(--sidebar); border-right:1px solid var(--card-border);
  z-index:995; display:flex; flex-direction:column; padding:20px 16px;
  transform:translateX(-100%); transition:transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow:10px 0 30px rgba(0,0,0,0.5); overflow-y:auto;
}
.mobile-drawer.open { transform:translateX(0); }
.mobile-drawer-head {
  display:flex; align-items:center; justify-content:space-between;
  padding-bottom:16px; margin-bottom:16px; border-bottom:1px solid var(--card-border);
}
.mobile-drawer-nav { display:flex; flex-direction:column; gap:6px; flex:1; }
.mobile-drawer-nav button {
  position:relative; display:flex; align-items:center; gap:10px; padding:11px 16px;
  border-radius:12px; background:transparent; border:1px solid transparent; color:#94a3b8;
  font-size:14px; font-weight:600; cursor:pointer; text-align:left;
  transition:all 0.25s cubic-bezier(0.16, 1, 0.3, 1); white-space:nowrap;
}
.mobile-drawer-nav button:hover {
  background:rgba(232,176,75,0.09); color:#f8fafc; border-color:rgba(232,176,75,0.22);
}
.mobile-drawer-nav button.active {
  background:linear-gradient(135deg, rgba(232,176,75,0.26) 0%, rgba(180,115,30,0.32) 100%);
  color:#fbbf24; font-weight:700; border-color:rgba(245,197,102,0.65);
  box-shadow:0 0 20px rgba(232,176,75,0.25);
}
.mobile-drawer-nav button .ic {
  width:26px; height:26px; border-radius:8px; background:rgba(255,255,255,0.04);
  display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; transition:all 0.25s ease;
}
.mobile-drawer-nav button.active .ic {
  background:linear-gradient(135deg, rgba(251,191,36,0.35), rgba(217,119,6,0.25)); color:#fbbf24;
}
.mobile-drawer-nav button .ic svg { width:18px; height:18px; display:block; stroke-width:2.2px; }
.brand{display:flex; align-items:center; gap:11px; flex-shrink:0;}
.brand .logo{
  width:42px; height:42px; border-radius:11px; background:linear-gradient(135deg,var(--green),#c9862a);
  display:flex; align-items:center; justify-content:center; font-weight:800; color:#08130c; font-size:18px; flex-shrink:0;
}
.brand .name{font-weight:700; font-size:16px; line-height:1.25; white-space:nowrap;}
.brand .name span{display:block; color:var(--green); font-size:11px; letter-spacing:.06em; font-weight:700;}

nav.menu{
  display:flex; align-items:center; flex-wrap:nowrap; gap:6px; width:100%;
  padding:6px 12px; max-width:1440px; margin:0 auto 12px;
  overflow-x:auto; scrollbar-width:thin;
  background:linear-gradient(180deg, rgba(14,20,32,0.88) 0%, rgba(9,13,22,0.95) 100%);
  border:1px solid rgba(232,176,75,0.25);
  border-radius:18px;
  box-shadow:0 10px 30px -5px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.08), 0 0 20px rgba(232,176,75,0.06);
  backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
}
nav.menu::-webkit-scrollbar{height:4px;}
nav.menu::-webkit-scrollbar-track{background:rgba(0,0,0,0.2); border-radius:10px;}
nav.menu::-webkit-scrollbar-thumb{background:rgba(232,176,75,0.35); border-radius:10px;}
nav.menu::-webkit-scrollbar-thumb:hover{background:rgba(232,176,75,0.6);}

.menu button{
  position:relative; display:flex; align-items:center; gap:8px; text-align:left; background:transparent; border:1px solid transparent;
  color:#94a3b8; padding:8px 14px; border-radius:12px; font-size:13.5px; font-weight:600; letter-spacing:0.015em; cursor:pointer;
  white-space:nowrap; flex-shrink:0; transition:all 0.25s cubic-bezier(0.16, 1, 0.3, 1); user-select:none;
}
.menu button:hover{
  background:rgba(232,176,75,0.09); color:#f8fafc; border-color:rgba(232,176,75,0.25);
  transform:translateY(-1px); box-shadow:0 4px 14px rgba(0,0,0,0.35);
}
.menu button.active{
  background:linear-gradient(135deg, rgba(232,176,75,0.28) 0%, rgba(180,115,30,0.32) 100%);
  color:#fbbf24; font-weight:700; border:1px solid rgba(245,197,102,0.65);
  box-shadow:0 0 24px rgba(232,176,75,0.32), inset 0 1px 1px rgba(255,255,255,0.25); transform:translateY(-1px);
}
.menu button.active::after{
  content:''; position:absolute; bottom:-2px; left:20%; right:20%; height:2.5px;
  background:linear-gradient(90deg, transparent, #fbbf24, transparent); border-radius:999px; box-shadow:0 0 10px #fbbf24;
}
.menu button .ic{
  width:24px; height:24px; border-radius:8px; background:rgba(255,255,255,0.04);
  display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; transition:all 0.25s ease;
}
.menu button:hover .ic{background:rgba(232,176,75,0.16); color:#fde68a;}
.menu button.active .ic{
  background:linear-gradient(135deg, rgba(251,191,36,0.35), rgba(217,119,6,0.25)); color:#fbbf24; box-shadow:0 0 12px rgba(232,176,75,0.4);
}
.menu button .ic svg, .icon-btn svg{width:17px; height:17px; display:block; stroke-width:2.2px;}
.menu button.active .ic svg{filter:drop-shadow(0 0 5px rgba(251,191,36,0.8));}

body.light nav.menu{background:linear-gradient(180deg, #ffffff 0%, #f8fafc 100%); border-color:#cbd5e1; box-shadow:0 8px 25px rgba(15,23,42,0.06);}
body.light .menu button{color:#475569;}
body.light .menu button:hover{background:rgba(217,119,6,0.08); color:#0f172a; border-color:rgba(217,119,6,0.25);}
body.light .menu button.active{background:linear-gradient(135deg, rgba(217,119,6,0.15) 0%, rgba(245,158,11,0.2) 100%); color:#b45309; border-color:#f59e0b; box-shadow:0 4px 14px rgba(245,158,11,0.2);}

/* ==================== Logo / Crédito de Desenvolvimento ==================== */
.auth-dev-credit{
  margin-top:24px; z-index:10;
  display:flex; justify-content:center; pointer-events:auto;
}
.app-dev-credit{
  position:fixed; left:0; right:0; bottom:0; z-index:100;
  display:flex; justify-content:center; padding:8px 16px calc(8px + env(safe-area-inset-bottom));
  background:rgba(11,14,18,0.95); border-top:1px solid var(--card-border); backdrop-filter:blur(10px);
}
.dev-chip{
  position:relative;
  pointer-events:auto; display:inline-flex; align-items:center; gap:10px;
  background:linear-gradient(135deg, rgba(38,26,10,0.95), rgba(16,13,8,0.96));
  border:1.5px solid rgba(232,176,75,.6);
  border-radius:999px;
  padding:7px 22px 7px 8px;
  box-shadow:0 0 25px rgba(232,176,75,.3), inset 0 1px 1px rgba(255,255,255,.2);
  transition: transform .25s ease, box-shadow .25s ease;
}
.dev-chip:hover{
  transform:scale(1.05);
  box-shadow:0 0 35px rgba(232,176,75,.5);
}
.dev-chip .dev-avatar{
  width:28px; height:28px; border-radius:50%; flex-shrink:0;
  background:linear-gradient(135deg, #f6d999, #e8b04b, #c9862a);
  display:flex; align-items:center; justify-content:center;
  font-size:11px; font-weight:800; color:#08130c; letter-spacing:0;
  box-shadow:0 0 10px rgba(232,176,75,.5);
}
.dev-chip .dev-text{display:flex; align-items:baseline; gap:6px; line-height:1;}
.dev-chip .dev-text small{font-size:11px; color:#f6d999; letter-spacing:.08em; font-weight:700; text-transform:uppercase;}
.dev-chip .dev-text strong{
  font-size:14px; font-weight:800; letter-spacing:.04em; color:#fff;
  text-shadow:0 0 12px rgba(232,176,75,.9);
}

.cfg-divider{display:flex; align-items:center; gap:10px; margin:22px 0 14px;}
.cfg-divider span{font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--text-faint); white-space:nowrap;}
.cfg-divider::before, .cfg-divider::after{content:''; flex:1; height:1px; background:var(--card-border);}

/* Centralização do conteúdo principal */
.main{
  flex:1; min-width:0; padding:22px 28px 80px;
  max-width:1440px; margin:0 auto; width:100%;
}
.right{display:flex; align-items:center; gap:16px; flex-shrink:0;}
.icon-btn{
  width:40px; height:40px; border-radius:11px; background:var(--card); border:1px solid var(--card-border);
  display:flex; align-items:center; justify-content:center; cursor:pointer; position:relative; font-size:16px; flex-shrink:0;
}
.icon-btn .dot{position:absolute; top:8px; right:8px; width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 0 2px var(--sidebar);}
.user{display:flex; align-items:center; gap:10px; cursor:pointer; min-width:0;}
.avatar{width:42px; height:42px; border-radius:50%; background:linear-gradient(135deg,#f0a63a,#d85bb0); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; color:#1b1200; flex-shrink:0;}
.user .uname{font-size:15.5px; font-weight:700; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:260px;}
.user .urole{font-size:12px; color:var(--text-faint); white-space:nowrap;}
.topheader-row .btn-ghost{padding:10px 18px; font-size:13px; flex-shrink:0;}

/* Suporte de Tema Claro para Cards de Resumo */
.cards-summary-panel, .tx-footer-summary {
  background: var(--card);
  box-shadow: var(--shadow);
  border: 1px solid rgba(232,176,75,0.3);
}
body.light .cards-summary-panel, body.light .tx-footer-summary {
  background: #ffffff !important;
  border-color: #cbd5e1 !important;
  box-shadow: 0 4px 15px rgba(20,30,60,0.06) !important;
  color: #1e293b !important;
}
body.light .cards-summary-panel h3, body.light .cards-summary-panel div, body.light .tx-footer-summary div {
  color: #1e293b !important;
}
body.light .cards-summary-panel .kpi, body.light .tx-footer-summary .kpi {
  background: #f8fafc !important;
  border-color: #e2e8f0 !important;
}
body.light .cards-summary-panel .kpi .row1, body.light .cards-summary-panel .kpi .sub {
  color: #64748b !important;
}
body.light .due-bills-panel {
  background: #ffffff !important;
  box-shadow: 0 4px 15px rgba(20,30,60,0.06) !important;
}
body.light .due-bill-row {
  background: #f8fafc !important;
}

/* Alinhamento Multidispositivo de Painéis e Cards */
.due-bills-panel {
  width: 100%;
  margin-bottom: 22px;
  box-sizing: border-box;
}
.due-bill-row {
  width: 100%;
  box-sizing: border-box;
}

.page-head{display:flex; align-items:center; justify-content:space-between; margin-bottom:22px; flex-wrap:wrap; gap:14px;}
.page-head h1{font-size:23px; font-weight:700;}
.page-head p{color:var(--text-dim); font-size:13px; margin-top:3px;}
.head-actions{display:flex; align-items:center; gap:10px; flex-wrap:wrap;}
.period-wrap{position:relative;}
.period{
  display:flex; align-items:center; gap:9px; background:var(--card); border:1px solid var(--card-border);
  padding:6px 14px 6px 6px; border-radius:12px; font-size:13px; cursor:pointer; white-space:nowrap;
  transition:border-color .18s ease, box-shadow .18s ease, transform .15s ease;
}
.period:hover{border-color:var(--green); box-shadow:0 4px 16px rgba(232,176,75,.16); transform:translateY(-1px);}
.period:active{transform:translateY(0);}
.period-ic{
  width:32px; height:32px; border-radius:9px; flex-shrink:0; display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg,var(--green),#c9862a); color:#1f1400;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.3);
}
.period-ic svg{width:16px; height:16px;}
.period-text{display:flex; align-items:baseline; gap:4px; font-weight:700; color:var(--text);}
.period-text .period-year{font-weight:500; color:var(--text-dim);}
.period-chevron{width:9px; height:9px; color:var(--text-faint); flex-shrink:0; transition:transform .25s ease;}
.period.open .period-chevron{transform:rotate(180deg); color:var(--green);}
.period-panel{
  display:none; position:absolute; top:calc(100% + 10px); right:0; background:var(--card); border:1px solid var(--card-border);
  border-radius:14px; padding:16px; z-index:60; width:236px; box-shadow:var(--shadow); transform-origin:top right;
}
.period-panel.show{display:block; animation:periodPanelIn .22s cubic-bezier(.16,1,.3,1);}
@keyframes periodPanelIn{
  from{opacity:0; transform:translateY(-8px) scale(.95);}
  to{opacity:1; transform:translateY(0) scale(1);}
}
.period-today-btn{
  display:block; width:100%; text-align:center; background:var(--green-soft); color:var(--green); border:none;
  padding:8px; border-radius:9px; font-size:12px; font-weight:700; cursor:pointer; margin-bottom:12px;
  transition:filter .15s, transform .12s;
}
.period-today-btn:hover{filter:brightness(1.1);}
.period-today-btn:active{transform:scale(.97);}

.notif-wrap{position:relative;}
.notif-panel{
  display:none; position:absolute; top:calc(100% + 10px); right:0; background:var(--card); border:1px solid var(--card-border);
  border-radius:14px; z-index:70; width:340px; max-width:88vw; box-shadow:var(--shadow); overflow:hidden;
}
.notif-panel.show{display:block;}
.notif-panel-head{display:flex; align-items:center; justify-content:space-between; gap:10px; padding:14px 16px; border-bottom:1px solid var(--card-border);}
.notif-panel-head h4{font-size:13.5px; font-weight:700;}
.notif-markall{background:none; border:none; color:var(--green); font-size:11.5px; font-weight:600; cursor:pointer; white-space:nowrap;}
.notif-markall:hover{text-decoration:underline;}
.notif-list{max-height:360px; overflow-y:auto; padding:6px;}
.notif-item{display:flex; align-items:flex-start; gap:11px; padding:10px 10px; border-radius:10px; cursor:default;}
.notif-item:hover{background:var(--hover);}
.notif-item .ic{
  width:34px; height:34px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center;
  font-size:15px; background:var(--green-soft);
}
.notif-item .body{flex:1; min-width:0;}
.notif-item .txt{font-size:12.5px; color:var(--text); line-height:1.4;}
.notif-item .time{font-size:11px; color:var(--text-faint); margin-top:2px;}
.notif-item.unread{background:var(--green-soft);}
.notif-item .unread-dot{width:8px; height:8px; border-radius:50%; background:var(--green); flex-shrink:0; margin-top:5px;}
.notif-empty{padding:32px 16px; text-align:center; color:var(--text-faint); font-size:12.5px;}
.btn-primary{
  position:relative; overflow:hidden;
  background:linear-gradient(135deg,var(--green),#c9862a); color:#1f1400; border:none; padding:10px 18px; border-radius:10px;
  font-weight:700; font-size:13.5px; cursor:pointer; display:flex; align-items:center; gap:7px;
  box-shadow:0 4px 14px rgba(232,176,75,.28), inset 0 1px 0 rgba(255,255,255,.25);
  transition:filter .2s, transform .15s, box-shadow .2s;
}
.btn-primary::after{
  content:''; position:absolute; top:0; left:-75%; width:45%; height:100%;
  background:linear-gradient(120deg, transparent, rgba(255,255,255,.4), transparent);
  transform:skewX(-20deg);
}
.btn-primary:hover{filter:brightness(1.08); transform:translateY(-1px); box-shadow:0 6px 18px rgba(232,176,75,.36), inset 0 1px 0 rgba(255,255,255,.25);}
.btn-primary:hover::after{animation:shimmer .9s ease;}
.btn-primary:active{transform:translateY(0) scale(.98);}
.btn-ghost{
  background:var(--card); color:var(--text); border:1px solid var(--card-border); padding:10px 16px;
  border-radius:10px; font-size:13px; cursor:pointer;
}
.btn-ghost:hover{background:var(--hover);}

.kpis{display:grid; grid-template-columns:repeat(5,1fr); gap:16px; margin-bottom:20px;}
.kpi{
  background:var(--card); border:1px solid var(--card-border); border-radius:var(--radius); padding:18px;
}
.kpi .row1{display:flex; align-items:center; justify-content:space-between; color:var(--text-dim); font-size:12.5px; margin-bottom:12px;}
.kpi .ic{width:38px; height:38px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:17px; flex-shrink:0; box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);}
.kpi .val{font-size:22px; font-weight:700; margin-bottom:5px;}
.kpi .sub{font-size:11.5px; color:var(--text-faint);}
.kpi .sub.up{color:var(--green);}

.grid3{display:grid; grid-template-columns:1fr 1fr .82fr; gap:16px; margin-bottom:20px; align-items:start;}
.panel{background:var(--card); border:1px solid var(--card-border); border-radius:var(--radius); padding:20px;}
.panel-head{display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; gap:10px; flex-wrap:wrap;}
.panel-head h3{font-size:14.5px; font-weight:700;}
.panel-head .tag{font-size:12px; color:var(--text-dim); background:var(--hover); padding:5px 10px; border-radius:8px; cursor:pointer; border:none;}

.cfg-grid{display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; margin-bottom:20px;}
.cfg-grid .panel{height:100%;}
.cfg-hint{color:var(--text-faint); font-size:12px; margin:-6px 0 14px; line-height:1.4;}
.cfg-save-bar{display:flex; justify-content:flex-end; margin-bottom:24px;}
.pass-field{position:relative;}
.pass-field input{width:100%; padding-right:42px;}
.pass-toggle{
  position:absolute; top:50%; right:6px; transform:translateY(-50%);
  width:30px; height:30px; display:flex; align-items:center; justify-content:center;
  background:none; border:none; color:var(--text-faint); cursor:pointer; border-radius:8px; padding:0;
  transition:color .15s, background .15s;
}
.pass-toggle:hover{color:var(--text); background:var(--hover);}
.pass-toggle svg{width:16px; height:16px;}
@media(max-width:820px){
  .cfg-grid{grid-template-columns:1fr;}
}

.donut-wrap{display:flex; align-items:center; justify-content:center; gap:20px;}
.donut-side{font-size:12px; color:var(--text-dim);}
.donut-side b{display:block; font-size:15px; margin-top:2px;}
.donut-side.r{text-align:right;}
.donut-canvas{position:relative; width:150px; height:150px; margin: 0 auto;}
.donut-center{position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;}
.donut-center span{font-size:11px; color:var(--text-faint);}
.donut-center b{font-size:14.5px; margin-top:2px;}
.bar-split{height:8px; border-radius:5px; background:var(--red); overflow:hidden; margin-top:16px; display:flex;}
.bar-split .g{background:var(--green); height:100%;}
.split-labels{display:flex; justify-content:space-between; font-size:11.5px; margin-top:6px; color:var(--text-dim);}

.cat-wrap{display:flex; gap:16px; align-items:center; justify-content:center;}
.cat-legend{flex:1; display:flex; flex-direction:column; gap:9px;}
.cat-row{display:flex; align-items:center; justify-content:space-between; font-size:12px;}
.cat-row .lbl{display:flex; align-items:center; gap:7px; color:var(--text-dim);}
.cat-row .dot{width:8px; height:8px; border-radius:50%; flex-shrink:0;}
.cat-row .amt{color:var(--text); font-weight:600; margin-right:6px;}
.cat-row .pct{color:var(--text-faint);}

.accounts-list{display:flex; flex-direction:column; gap:10px; margin-bottom:14px;}
.acc-row{display:flex; align-items:center; gap:10px; padding:8px 4px; border-radius:10px;}
.acc-row:hover{background:var(--hover);}
.acc-row:hover .acc-edit{opacity:1;}
.acc-ic{width:44px; height:44px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:14px; flex-shrink:0; color:#fff; box-shadow:0 2px 6px rgba(0,0,0,.25);}
.acc-info{flex:1; min-width:0;}
.acc-info .n{font-size:12.8px; font-weight:600;}
.acc-info .t{font-size:11px; color:var(--text-faint);}
.acc-val{font-size:12.8px; font-weight:700; white-space:nowrap;}
.acc-val.neg{color:var(--red);}
.acc-edit{opacity:0; transition:opacity .15s; background:none; border:none; color:var(--text-faint); cursor:pointer; font-size:12px; padding:4px;}

.table-panel{background:var(--card); border:1px solid var(--card-border); border-radius:var(--radius); padding:20px; overflow-x:auto;}
table{width:100%; border-collapse:collapse;}
th{text-align:left; font-size:11.5px; color:var(--text-faint); font-weight:600; padding:0 10px 12px; text-transform:uppercase; letter-spacing:.03em;}
td{padding:12px 10px; font-size:13px; border-top:1px solid var(--card-border);}
tr.trow:hover td{background:var(--hover);}
.pill{padding:4px 10px; border-radius:7px; font-size:11.5px; font-weight:600; display:inline-block;}
.status-pago{background:var(--green-soft); color:var(--green);}
.status-recebido{background:rgba(74,144,226,.14); color:var(--blue);}
.status-pendente{background:rgba(240,166,58,.14); color:var(--orange);}
.val-in{color:var(--green); font-weight:700;}
.val-out{color:var(--red); font-weight:700;}
.type-ic.in{color:var(--green); font-weight:700;}
.type-ic.out{color:var(--red); font-weight:700;}
.row-actions{display:flex; gap:6px;}
.row-actions button{background:none; border:1px solid var(--card-border); color:var(--text-dim); width:28px; height:28px; border-radius:8px; cursor:pointer; font-size:12.5px; flex-shrink:0;}
.row-actions button:hover{background:var(--hover); color:var(--text); border-color:var(--text-faint);}

.icon-picker{display:flex; gap:6px; flex-wrap:wrap;}
.icon-picker button{width:32px; height:32px; border-radius:8px; border:1px solid var(--card-border); background:var(--bg); font-size:15px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:border-color .15s, background .15s;}
.icon-picker button:hover{border-color:var(--green); background:var(--green-soft);}
.icon-picker button.sel{border-color:var(--green); background:var(--green-soft);}
.cat-manage-tabs{display:flex; gap:8px;}
.cat-manage-tabs .cat-tab{flex:1; padding:9px; border-radius:9px; border:1px solid var(--card-border); background:var(--bg); color:var(--text-dim); font-size:12.5px; font-weight:600; cursor:pointer; font-family:inherit;}
.cat-manage-tabs .cat-tab.active{background:var(--green-soft); color:var(--green); border-color:var(--green);}
.cat-manage-row{display:flex; align-items:center; gap:10px;}
.cat-manage-row .cat-badge{font-size:16px;}
.cat-manage-row .info{min-width:0; flex:1;}
.cat-manage-row .n{font-size:13px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.cat-manage-row .u{font-size:11px; color:var(--text-faint);}
.filters{display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap;}
.filters input, .filters select{
  background:var(--bg); border:1px solid var(--card-border); border-radius:9px; padding:8px 12px; font-size:12.5px; outline:none;
}
.filters input{flex:1; min-width:180px;}

.placeholder{padding:60px 20px; text-align:center; color:var(--text-dim);}
.placeholder .big{font-size:38px; margin-bottom:10px;}
.placeholder h3{color:var(--text); font-size:16px; margin-bottom:6px;}

.cat-cards{display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:16px; justify-content:center;}
.cat-card{background:var(--card); border:1px solid var(--card-border); border-radius:12px; padding:16px; display:flex; flex-direction:column;}
.cat-card .top{display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; gap:10px;}
.cat-card .id-group{display:flex; align-items:center; gap:10px; min-width:0;}
.cat-card .dot{width:20px; height:20px; border-radius:6px; flex-shrink:0; box-shadow:0 0 0 3px rgba(255,255,255,.06), 0 2px 5px rgba(0,0,0,.3);}
.cat-card h4{font-size:13.5px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.cat-card .amt{font-size:17px; font-weight:700;}
.cat-card .row-actions{flex-shrink:0;}
.cat-badge{
  width:34px; height:34px; border-radius:10px; flex-shrink:0; display:flex; align-items:center; justify-content:center;
  font-size:12px; font-weight:800;
}
.cat-card-stats{display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-top:auto;}
.cat-card-stats .amt{font-size:17px; font-weight:700;}
.cat-count{color:var(--text-faint); font-size:11.5px; white-space:nowrap;}
.cat-card{transition:border-color .15s, transform .15s;}
.cat-card:hover{border-color:var(--green);}
.cat-card-add{
  border:1.5px dashed var(--card-border); background:transparent; cursor:pointer;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;
  color:var(--text-dim); font-size:13px; font-weight:600; min-height:96px; font-family:inherit;
  transition:border-color .15s, color .15s, background .15s;
}
.cat-card-add:hover{border-color:var(--green); color:var(--green); background:var(--green-soft);}
.cat-card-add .plus{font-size:22px; line-height:1; font-weight:400;}

/* ==================== Admin: Usuários Cadastrados ==================== */
.user-admin-list{display:flex; flex-direction:column; gap:8px;}
.user-row{
  display:flex; align-items:center; gap:12px; padding:11px 12px; border:1px solid var(--card-border);
  border-radius:12px; background:var(--bg); transition:border-color .15s;
}
.user-row:hover{border-color:var(--green);}
.user-row.inactive{opacity:.6;}
.user-row.inactive .user-ic{filter:grayscale(1);}
.user-ic{
  width:36px; height:36px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg,var(--green),#c9862a); color:#08130c; font-weight:800; font-size:13px;
}
.user-info{flex:1; min-width:0;}
.user-info .n{font-size:13.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.user-info .e{font-size:11.5px; color:var(--text-faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.user-info .stats{font-size:11px; color:var(--text-faint); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.role-badge{
  font-size:11px; font-weight:700; padding:4px 10px; border-radius:20px; flex-shrink:0; white-space:nowrap;
}
.role-badge.admin{background:var(--green-soft); color:var(--green);}
.role-badge.user{background:rgba(138,147,163,.14); color:var(--text-dim);}
.role-badge.inactive{background:var(--red-soft); color:var(--red);}
.funcoes-badge{
  display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; padding:5px 12px; border-radius:8px; white-space:nowrap;
}
.funcoes-badge.full{background:rgba(16,185,129,0.15); color:#10b981; border:1px solid rgba(16,185,129,0.3);}
.funcoes-badge.read{background:rgba(59,130,246,0.15); color:#60a5fa; border:1px solid rgba(59,130,246,0.3);}
.funcoes-badge.lock{background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);}
.row-edit{
  flex-shrink:0; background:none; border:1px solid var(--card-border); color:var(--text-dim); width:30px; height:30px;
  border-radius:8px; cursor:pointer; font-size:13px; transition:background .15s,color .15s;
}
.row-edit:hover{background:var(--hover); color:var(--text);}
.row-view{
  flex-shrink:0; background:none; border:1px solid var(--card-border); color:var(--text-dim); width:30px; height:30px;
  border-radius:8px; cursor:pointer; font-size:13px; transition:background .15s,color .15s;
}
.row-view:hover{background:var(--green-soft); color:var(--green); border-color:var(--green);}
.row-toggle{
  flex-shrink:0; background:none; border:1px solid var(--card-border); color:var(--text-dim); width:30px; height:30px;
  border-radius:8px; cursor:pointer; font-size:13px; transition:background .15s,color .15s;
}
.row-toggle:hover{background:var(--red-soft); color:var(--red); border-color:var(--red);}

/* ==================== Banner: Modo Visualização (Admin) ==================== */
.view-mode-banner{
  display:none; align-items:center; justify-content:center; gap:10px; flex-wrap:wrap;
  padding:9px 16px; background:linear-gradient(135deg, rgba(232,176,75,.16), rgba(232,176,75,.08));
  border-bottom:1.5px solid var(--green); font-size:13px; color:var(--text); text-align:center;
}
.view-mode-banner.show{display:flex;}
.view-mode-banner strong{color:var(--green);}
.view-mode-banner button{
  background:var(--green); color:#08130c; border:none; font-weight:700; font-size:12.5px;
  padding:6px 14px; border-radius:8px; cursor:pointer; flex-shrink:0;
}
.view-mode-banner button:hover{filter:brightness(1.08);}

.acc-card{background:var(--card); border:1px solid var(--card-border); border-radius:var(--radius); padding:18px; display:flex; flex-direction:column;}
.acc-card .top{display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; gap:10px;}
.acc-card .row-actions{flex-shrink:0;}

.overlay{position:fixed; inset:0; background:rgba(0,0,0,.65); backdrop-filter:blur(4px); display:none; align-items:center; justify-content:center; z-index:1000; padding:20px;}
.overlay.show{display:flex;}
#overlayCatManage{z-index:1100 !important;}
#overlayCategory{z-index:1200 !important;}
.modal{background:var(--card); border:1px solid var(--card-border); border-radius:16px; padding:24px; width:100%; max-width:440px; box-shadow:var(--shadow); position:relative; max-height:88vh; overflow-y:auto;}
.modal h2{font-size:17px; margin-bottom:18px;}
.field{margin-bottom:14px;}
.field label{display:block; font-size:12px; color:var(--text-dim); margin-bottom:6px;}
.field input, .field select{
  width:100%; background:var(--bg); border:1px solid var(--card-border); border-radius:9px; padding:10px 12px; font-size:13.5px; outline:none;
}
.field input[type=color]{padding:3px; height:38px; cursor:pointer;}
.field input[type=file]{padding:8px;}
.field-row{display:flex; gap:10px;}
.field-row .field{flex:1;}
.toggle-type{display:flex; gap:8px; margin-bottom:14px;}
.toggle-type button{
  flex:1; padding:10px; border-radius:9px; border:1px solid var(--card-border); background:var(--bg); cursor:pointer; font-size:13px; font-weight:600; color:var(--text-dim);
}
.toggle-type button.sel-in{background:var(--green-soft); color:var(--green); border-color:var(--green);}
.toggle-type button.sel-out{background:var(--red-soft); color:var(--red); border-color:var(--red);}
.modal-actions{display:flex; gap:10px; margin-top:18px;}
.modal-actions button{flex:1; padding:11px; border-radius:10px; font-size:13.5px; cursor:pointer; border:1px solid var(--card-border); background:var(--bg); color:var(--text);}
.modal-actions .save{background:var(--green); border:none; color:#08130c; font-weight:700;}
.close-x{position:absolute; top:16px; right:18px; background:none; border:none; color:var(--text-dim); font-size:18px; cursor:pointer;}

.toast{
  position:fixed; bottom:24px; right:24px; background:var(--card); border:1px solid var(--green); color:var(--text);
  padding:12px 18px; border-radius:10px; font-size:13px; box-shadow:var(--shadow); z-index:200; display:none; align-items:center; gap:8px; max-width:320px;
}
.toast.show{display:flex;}
.toast .d{width:8px; height:8px; border-radius:50%; background:var(--green); flex-shrink:0;}

/* ==================== Popup de login bem-sucedido ==================== */
.login-success-overlay{
  position:fixed; inset:0; background:rgba(4,6,10,.6); backdrop-filter:blur(3px);
  display:none; align-items:center; justify-content:center; z-index:300; padding:20px; opacity:0;
  transition:opacity .25s ease;
}
.login-success-overlay.show{display:flex;}
.login-success-overlay.in{opacity:1;}
.login-success-box{
  background:var(--card); border:1px solid var(--card-border); border-radius:18px;
  padding:36px 32px; width:100%; max-width:340px; text-align:center; box-shadow:var(--shadow);
  transform:translateY(14px) scale(.96); opacity:0; transition:transform .3s cubic-bezier(.16,1,.3,1), opacity .3s ease;
}
.login-success-overlay.in .login-success-box{transform:translateY(0) scale(1); opacity:1;}
.login-success-check{
  width:64px; height:64px; margin:0 auto 18px; border-radius:50%;
  background:var(--green-soft); display:flex; align-items:center; justify-content:center;
}
.login-success-check svg{width:34px; height:34px;}
.login-success-check circle{stroke:var(--green); stroke-width:2.5; opacity:.35;}
.login-success-check path{
  stroke:var(--green); stroke-width:4; stroke-linecap:round; stroke-linejoin:round;
  stroke-dasharray:40; stroke-dashoffset:40; animation:loginCheckDraw .45s ease .15s forwards;
}
@keyframes loginCheckDraw{to{stroke-dashoffset:0;}}
.login-success-box h3{font-size:16.5px; margin-bottom:6px;}
.login-success-box p{color:var(--text-dim); font-size:13px;}

/* ==================== Popup de conta desativada ==================== */
.account-disabled-icon{
  width:64px; height:64px; margin:0 auto 18px; border-radius:50%;
  background:var(--red-soft); display:flex; align-items:center; justify-content:center;
}
.account-disabled-icon svg{width:30px; height:30px;}
.account-disabled-icon path, .account-disabled-icon circle{stroke:var(--red); stroke-width:2.5; fill:none; stroke-linecap:round; stroke-linejoin:round;}
.login-success-box .account-disabled-btn{
  margin-top:20px; width:100%; background:var(--red); color:#fff; border:none; font-weight:700;
  font-size:13.5px; padding:11px; border-radius:10px; cursor:pointer; transition:filter .15s;
}
.login-success-box .account-disabled-btn:hover{filter:brightness(1.08);}

/* ==================== Popup de Logout (Sessão Encerrada) ==================== */
.logout-success-icon {
  width: 68px; height: 68px; margin: 0 auto 18px; border-radius: 50%;
  background: rgba(6, 214, 160, 0.15); border: 1px solid rgba(6, 214, 160, 0.35);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 0 25px rgba(6, 214, 160, 0.25);
}
.logout-success-icon svg {
  width: 32px; height: 32px; stroke: #06D6A0;
}
.logout-box h3 {
  font-size: 19px; font-weight: 800; color: #ffffff; margin-bottom: 8px; tracking-tight;
}
.logout-box p {
  color: #9ca3af; font-size: 13.5px; line-height: 1.5; margin-bottom: 20px;
}
.logout-btn-action {
  width: 100%; padding: 12px 16px; border-radius: 12px; font-weight: 700; font-size: 13.5px;
  background: linear-gradient(135deg, #06D6A0, #00E5FF); color: #060B18; border: none;
  cursor: pointer; box-shadow: 0 4px 14px rgba(6, 214, 160, 0.3);
  transition: transform 0.2s ease, filter 0.2s ease;
}
.logout-btn-action:hover {
  transform: translateY(-1px); filter: brightness(1.08);
}

@media(min-width:1700px){
  .brand .name{font-size:17px;}
}
@media(max-width:1200px){
  .kpis{grid-template-columns:repeat(3,1fr);}
}
@media(max-width:992px){
  .grid3{grid-template-columns:1fr;}
}
@media(max-width:768px){
  .mobile-menu-btn{display:flex;}
  .kpis{grid-template-columns:repeat(2,1fr); gap:12px;}
  .topheader-row{padding:12px 16px; gap:10px;}
  nav.menu{padding:0 16px 10px;}
  .menu button{font-size:13.5px; padding:9px 11px;}
  .brand .name{font-size:14px;}
  .user .uname, .user .urole{max-width:100px;}
  .donut-wrap{flex-direction:column; text-align:center; gap:14px;}
  .donut-side.r{text-align:center;}
  .cat-cards{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));}
  .main{padding:18px 16px 90px;}
}
@media(max-width:480px){
  .main{padding:14px 12px 90px;}
  .kpis{grid-template-columns:repeat(2,1fr); gap:8px;}
  .kpi{padding:14px 12px;}
  .kpi .val{font-size:17px;}
  .page-head h1{font-size:18px;}
  .brand .name span{display:none;}
  .user .uname, .user .urole{display:none;}
  .topheader-row .btn-ghost{padding:8px 12px; font-size:12px;}

  /* Cadastro/edição em modal mais fácil de usar no celular */
  .overlay{align-items:flex-end; padding:0;}
  .modal{max-width:100%; width:100%; border-radius:24px 24px 0 0; max-height:88vh; padding:20px 16px calc(24px + env(safe-area-inset-bottom));}
  .field-row{flex-direction:column; gap:0;}
  .field-row .field{margin-bottom:14px;}
  .field{margin-bottom:16px;}
  .field label{font-size:12.5px; margin-bottom:7px;}
  .field input, .field select{font-size:16px; padding:12px 13px;}
  .toggle-type button{padding:12px; font-size:13.5px;}
  .modal-actions{position:sticky; bottom:0; background:var(--card); padding-top:10px; margin-top:14px; border-top:1px solid var(--card-border);}
  .modal-actions button{padding:13px; font-size:14px;}
  .close-x{top:14px; right:14px; font-size:20px; padding:6px;}

  /* Tabelas: rolagem horizontal limpa */
  .table-panel{padding:12px 10px;}
  table{min-width:580px;}
  .filters{flex-direction:column;}
  .filters input, .filters select{width:100%; font-size:16px; padding:10px 12px;}
  .cat-cards{grid-template-columns:1fr 1fr; gap:10px;}
}
@media(max-width:360px){
  .kpis{grid-template-columns:1fr;}
  .cat-cards{grid-template-columns:1fr;}
}
</style>
</head>
<body>

<!-- TELA DE LOGIN / CADASTRO -->
<div class="auth-container show" id="authPage">
  <div class="auth-grid" aria-hidden="true"></div>
  <svg class="auth-chart" viewBox="0 0 1600 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--auth-accent)" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="var(--auth-accent)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path class="chart-area" d="M 0.0,380 L 27.1,385.0 L 54.2,400.1 L 81.4,386.1 L 108.5,405.7 L 135.6,398.4 L 162.7,401.0 L 189.8,421.5 L 216.9,415.8 L 244.1,437.5 L 271.2,436.1 L 298.3,455.8 L 325.4,474.4 L 352.5,473.6 L 379.7,449.4 L 406.8,466.0 L 433.9,476.9 L 461.0,464.3 L 488.1,433.1 L 515.3,423.4 L 542.4,424.2 L 569.5,391.4 L 596.6,412.5 L 623.7,386.5 L 650.8,393.5 L 678.0,409.0 L 705.1,425.9 L 732.2,431.8 L 759.3,408.3 L 786.4,421.6 L 813.6,411.7 L 840.7,398.4 L 867.8,400.6 L 894.9,392.7 L 922.0,412.8 L 949.2,433.2 L 976.3,445.0 L 1003.4,429.4 L 1030.5,428.4 L 1057.6,433.9 L 1084.7,423.8 L 1111.9,421.3 L 1139.0,427.7 L 1166.1,405.4 L 1193.2,388.7 L 1220.3,398.3 L 1247.5,388.8 L 1274.6,382.1 L 1301.7,355.2 L 1328.8,336.7 L 1355.9,343.8 L 1383.1,310.7 L 1410.2,327.7 L 1437.3,327.2 L 1464.4,307.1 L 1491.5,322.1 L 1518.6,317.5 L 1545.8,339.1 L 1572.9,324.1 L 1600.0,303.6 L 1600.0,800 L 0.0,800 Z" fill="url(#chartFill)" stroke="none"/>
    <path class="chart-line" d="M 0.0,380 L 27.1,385.0 L 54.2,400.1 L 81.4,386.1 L 108.5,405.7 L 135.6,398.4 L 162.7,401.0 L 189.8,421.5 L 216.9,415.8 L 244.1,437.5 L 271.2,436.1 L 298.3,455.8 L 325.4,474.4 L 352.5,473.6 L 379.7,449.4 L 406.8,466.0 L 433.9,476.9 L 461.0,464.3 L 488.1,433.1 L 515.3,423.4 L 542.4,424.2 L 569.5,391.4 L 596.6,412.5 L 623.7,386.5 L 650.8,393.5 L 678.0,409.0 L 705.1,425.9 L 732.2,431.8 L 759.3,408.3 L 786.4,421.6 L 813.6,411.7 L 840.7,398.4 L 867.8,400.6 L 894.9,392.7 L 922.0,412.8 L 949.2,433.2 L 976.3,445.0 L 1003.4,429.4 L 1030.5,428.4 L 1057.6,433.9 L 1084.7,423.8 L 1111.9,421.3 L 1139.0,427.7 L 1166.1,405.4 L 1193.2,388.7 L 1220.3,398.3 L 1247.5,388.8 L 1274.6,382.1 L 1301.7,355.2 L 1328.8,336.7 L 1355.9,343.8 L 1383.1,310.7 L 1410.2,327.7 L 1437.3,327.2 L 1464.4,307.1 L 1491.5,322.1 L 1518.6,317.5 L 1545.8,339.1 L 1572.9,324.1 L 1600.0,303.6" fill="none" stroke="var(--auth-accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>

  <div class="auth-blob b1"></div>
  <div class="auth-blob b2"></div>

  <!-- Login -->
  <div class="auth-box" id="loginBox">
    <div class="brand">
      <div class="logo">N</div>
      <div class="name">NEXUS<span>FINANCEIRO HUB</span></div>
    </div>
    <h2>Acessar Conta</h2>
    <p class="sub">Informe suas credenciais para continuar</p>
    <form id="loginForm">
      <div class="field">
        <label>E-mail</label>
        <input type="email" id="loginEmail" placeholder="seu.email@exemplo.com" required autocomplete="username">
      </div>
      <div class="field">
        <label>Senha</label>
        <div class="pass-field">
          <input type="password" id="loginPassword" placeholder="••••••••" required autocomplete="current-password">
          <button type="button" class="pass-toggle" id="loginPasswordToggle" tabindex="-1" aria-label="Mostrar senha"></button>
        </div>
        <a class="auth-forgot" id="goForgot">Esqueceu a senha?</a>
      </div>
      <button type="submit" class="btn-auth">Entrar no Sistema</button>
    </form>
    <div class="auth-toggle">
      Não tem uma conta? <a id="goRegister">Cadastrar-se</a>
    </div>
  </div>

  <!-- Recuperar Senha -->
  <div class="auth-box" id="forgotBox" style="display:none;">
    <div class="brand">
      <div class="logo">N</div>
      <div class="name">NEXUS<span>FINANCEIRO HUB</span></div>
    </div>
    <h2>Recuperar Senha</h2>
    <p class="sub" id="forgotSub">Informe seu e-mail para enviarmos sua senha</p>

    <form id="forgotStep1">
      <div class="field">
        <label>E-mail</label>
        <input type="email" id="forgotEmail" placeholder="seu.email@exemplo.com" required>
      </div>
      <button type="submit" class="btn-auth" id="btnSendPassword">Enviar Senha por E-mail</button>
    </form>

    <div class="auth-toggle">
      Lembrou a senha? <a id="goLoginFromForgot">Fazer Login</a>
    </div>
  </div>

  <!-- Cadastro -->
  <div class="auth-box" id="registerBox" style="display:none;">
    <div class="brand">
      <div class="logo">N</div>
      <div class="name">NEXUS<span>FINANCEIRO HUB</span></div>
    </div>
    <h2>Criar Conta</h2>
    <p class="sub">Preencha seus dados para começar</p>
    <form id="registerForm">
      <div class="field">
        <label>Nome Completo</label>
        <input type="text" id="regName" placeholder="Ex: Maria Silva" required>
      </div>
      <div class="field">
        <label>E-mail</label>
        <input type="email" id="regEmail" placeholder="seu.email@exemplo.com" required>
      </div>
      <div class="field">
        <label>Senha</label>
        <input type="password" id="regPassword" placeholder="••••••••" required minlength="6">
      </div>
      <button type="submit" class="btn-auth">Cadastrar Conta</button>
    </form>
    <div class="auth-toggle">
      Já tem uma conta? <a id="goLogin">Fazer Login</a>
    </div>
  </div>
  <div class="auth-dev-credit">
    <div class="dev-chip">
      <span class="dev-avatar">PL</span>
      <span class="dev-text"><small>DESENVOLVEDOR</small><strong>PAULO LIMA</strong></span>
    </div>
  </div>
</div>

<!-- APLICAÇÃO PRINCIPAL -->
<div class="app" id="appMain">
  <div class="view-mode-banner" id="viewModeBanner">
    <span>👁 Visualizando dados de <strong id="viewModeUserName"></strong> (modo administrador)</span>
    <button id="viewModeExitBtn">Voltar para minha conta</button>
  </div>
  <div class="app-bg-scene" aria-hidden="true">
    <div class="app-bg-grid"></div>
    <svg class="app-bg-chart" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
      <path d="M 0.0,380 L 32.7,355.4 L 65.3,329.5 L 98.0,306.5 L 130.6,323.9 L 163.3,315.9 L 195.9,316.3 L 228.6,311.4 L 261.2,326.5 L 293.9,338.5 L 326.5,337.9 L 359.2,348.4 L 391.8,347.3 L 424.5,367.6 L 457.1,385.0 L 489.8,371.1 L 522.4,371.6 L 555.1,367.6 L 587.8,352.5 L 620.4,356.1 L 653.1,374.8 L 685.7,357.3 L 718.4,349.4 L 751.0,338.1 L 783.7,328.7 L 816.3,301.7 L 849.0,305.2 L 881.6,288.8 L 914.3,292.0 L 946.9,285.0 L 979.6,273.5 L 1012.2,279.4 L 1044.9,296.7 L 1077.6,294.6 L 1110.2,280.3 L 1142.9,272.4 L 1175.5,271.6 L 1208.2,261.1 L 1240.8,273.6 L 1273.5,286.3 L 1306.1,291.7 L 1338.8,272.5 L 1371.4,284.3 L 1404.1,300.2 L 1436.7,316.9 L 1469.4,336.5 L 1502.0,344.4 L 1534.7,337.3 L 1567.3,317.9 L 1600.0,323.0" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="app-blob a1"></div>
    <div class="app-blob a2"></div>
    <div class="app-blob a3"></div>
  </div>
  <div class="topheader">
    <div class="topheader-row">
      <button class="mobile-menu-btn" id="mobileMenuToggle" title="Abrir Menu">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
      <div class="brand">
        <div class="logo">N</div>
        <div class="name">NEXUS<span>FINANCEIRO HUB</span></div>
      </div>
      <div class="right" style="margin-left:auto;">
        <div class="notif-wrap">
          <div class="icon-btn" id="notifBtn" title="Notificações"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span class="dot" id="notifDot" style="display:none;"></span></div>
          <div class="notif-panel" id="notifPanel">
            <div class="notif-panel-head">
              <h4>Notificações</h4>
              <button class="notif-markall" id="notifMarkAllBtn">Marcar todas como lidas</button>
            </div>
            <div class="notif-list" id="notifList"></div>
          </div>
        </div>
        <div class="icon-btn" id="miniThemeBtn" title="Alternar Tema"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 0 1 1-9-9Z"/></svg></div>
        <div class="user" id="userMenu" data-nav="config">
          <div class="avatar" id="headerAvatar">--</div>
          <div><div class="uname" id="headerName">...</div><div class="urole" id="headerRole">...</div></div>
        </div>
        <button class="btn-ghost" id="logoutBtn">Sair</button>
      </div>
    </div>
    <nav class="menu" id="menu">
      <button data-page="dashboard"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg></span> Dashboard</button>
      <button data-page="transacoes"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg></span> Transações</button>
      <button data-page="cartoes"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg></span> Cartões</button>
      <button data-page="orcamentos"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg></span> Orçamentos</button>
      <button data-page="metas"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg></span> Metas</button>
      <button data-page="relatorios"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="8" rx="1"/><rect x="12" y="5" width="3" height="13" rx="1"/><rect x="17" y="13" width="3" height="5" rx="1"/></svg></span> Relatórios</button>
      <button data-page="recorrentes"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg></span> Recorrentes</button>
      <button data-page="importar"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 12v6"/><path d="m15 15-3-3-3 3"/></svg></span> Importar</button>
      <button data-page="anexos"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57a4 4 0 1 1 5.66 5.66l-8.59 8.58a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span> Anexos</button>
      <button data-page="config"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></span> Configurações</button>
      <button data-page="funcoes" id="menuFuncoesBtn" style="display:none;"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg></span> Funções & Permissões</button>
      <button data-page="usuarios" id="menuUsuariosBtn" style="display:none;"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span> Usuários Cadastrados</button>
      <button data-page="logs" id="menuLogsBtn" style="display:none;"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span> Logs do Sistema</button>
    </nav>
  </div>

  <!-- Drawer Mobile Slide-out -->
  <div class="mobile-drawer-overlay" id="mobileDrawerOverlay"></div>
  <div class="mobile-drawer" id="mobileDrawer">
    <div class="mobile-drawer-head">
      <div class="brand">
        <div class="logo">N</div>
        <div class="name">NEXUS<span>FINANCEIRO HUB</span></div>
      </div>
      <button class="close-x" id="closeMobileDrawer" style="position:static; padding:4px;">✕</button>
    </div>
    <nav class="mobile-drawer-nav" id="mobileDrawerMenu">
      <button data-page="dashboard"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg></span> Dashboard</button>
      <button data-page="transacoes"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg></span> Transações</button>
      <button data-page="cartoes"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg></span> Cartões</button>
      <button data-page="orcamentos"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg></span> Orçamentos</button>
      <button data-page="metas"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg></span> Metas</button>
      <button data-page="relatorios"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="8" rx="1"/><rect x="12" y="5" width="3" height="13" rx="1"/><rect x="17" y="13" width="3" height="5" rx="1"/></svg></span> Relatórios</button>
      <button data-page="recorrentes"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg></span> Recorrentes</button>
      <button data-page="importar"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 12v6"/><path d="m15 15-3-3-3 3"/></svg></span> Importar</button>
      <button data-page="anexos"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57a4 4 0 1 1 5.66 5.66l-8.59 8.58a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span> Anexos</button>
      <button data-page="config"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></span> Configurações</button>
      <button data-page="funcoes" id="mobileDrawerFuncoesBtn" style="display:none;"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg></span> Funções & Permissões</button>
      <button data-page="usuarios" id="mobileDrawerUsuariosBtn" style="display:none;"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span> Usuários Cadastrados</button>
      <button data-page="logs" id="mobileDrawerLogsBtn" style="display:none;"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span> Logs do Sistema</button>
    </nav>
  </div>

  <main class="main">
    <div id="pageContent"></div>
  </main>
  <div class="app-dev-credit">
    <div class="dev-chip">
      <span class="dev-avatar">PL</span>
      <span class="dev-text"><small>Desenvolvedor</small><strong>Paulo Lima</strong></span>
    </div>
  </div>
</div>

<!-- Modal Transação -->
<div class="overlay" id="overlay">
  <div class="modal">
    <button class="close-x" id="closeModal">✕</button>
    <h2 id="modalTitle">Nova Transação</h2>
    <div class="toggle-type">
      <button type="button" id="typeInBtn">↓ Receita</button>
      <button type="button" id="typeOutBtn">↑ Despesa</button>
    </div>
    <div class="field"><label>Descrição</label><input id="fDesc" placeholder="Ex: Supermercado"></div>
    <div class="field-row">
      <div class="field"><label>Valor (R$)</label><input id="fValor" type="number" step="0.01" placeholder="0,00"></div>
      <div class="field"><label>Data</label><input id="fData" type="date"></div>
    </div>
    <div class="field"><label>Categoria</label>
      <div style="display:flex; gap:6px;">
        <select id="fCategoria" style="flex:1;"></select>
        <button type="button" id="fCategoriaAddBtn" title="Nova categoria" style="flex-shrink:0; width:40px; border:1px solid var(--card-border); background:var(--card); border-radius:10px; font-size:16px; font-weight:700; cursor:pointer; color:var(--text);">+</button>
      </div>
    </div>
    <div class="field"><label>Conta / Cartão</label>
      <select id="fConta"></select>
      <div id="cardLimitHint" style="display:none;margin-top:6px;font-size:12px;padding:8px 12px;border-radius:8px;background:var(--green-soft);color:var(--green);font-weight:600;align-items:center;gap:6px;"></div>
    </div>
    <div class="field"><label>Status</label>
      <select id="fStatus"><option>Pago</option><option>Recebido</option><option>Pendente</option></select>
    </div>
    <div class="modal-actions">
      <button id="cancelBtn">Cancelar</button>
      <button class="save" id="saveBtn">Salvar Transação</button>
    </div>
  </div>
</div>

<!-- Modal Conta -->
<div class="overlay" id="overlayAccount">
  <div class="modal">
    <button class="close-x" id="closeAccModal">✕</button>
    <h2 id="accModalTitle">Nova Conta</h2>
    <div class="field"><label>Nome</label><input id="accName" placeholder="Ex: Nubank"></div>
    <div class="field"><label>Tipo</label>
      <select id="accType"><option>Conta Corrente</option><option>Conta Poupança</option><option>Cartão de Crédito</option><option>Investimento</option></select>
    </div>
    <div class="field-row">
      <div class="field"><label id="accBalanceLabel">Saldo (R$)</label><input id="accBalance" type="number" step="0.01" placeholder="0,00"></div>
      <div class="field"><label>Cor</label><input id="accColor" type="color" value="#e8b04b"></div>
    </div>
    <div class="modal-actions">
      <button id="accCancelBtn">Cancelar</button>
      <button class="save" id="accSaveBtn">Salvar Conta</button>
    </div>
  </div>
</div>

<!-- Modal Categoria -->
<div class="overlay" id="overlayCategory">
  <div class="modal">
    <button class="close-x" id="closeCatModal">✕</button>
    <h2 id="catModalTitle">Nova Categoria</h2>
    <div class="field"><label>Nome</label><input id="catName" placeholder="Ex: Educação"></div>
    <div class="field"><label>Tipo</label>
      <select id="catTipo"><option value="despesa">Despesa</option><option value="receita">Receita</option></select>
    </div>
    <div class="field-row">
      <div class="field"><label>Ícone</label><input id="catIconInput" placeholder="📁" maxlength="4" style="text-align:center;font-size:17px;"></div>
      <div class="field"><label>Cor</label><input id="catColor" type="color" value="#e8b04b"></div>
    </div>
    <div class="field"><label>Sugestões</label><div id="catIconPicker" class="icon-picker"></div></div>
    <div class="modal-actions">
      <button id="catCancelBtn">Cancelar</button>
      <button class="save" id="catSaveBtn">Salvar Categoria</button>
    </div>
  </div>
</div>

<!-- Modal Gerenciar Categorias -->
<div class="overlay" id="overlayCatManage">
  <div class="modal" style="max-width:600px;">
    <button class="close-x" id="closeCatManageModal">✕</button>
    <h2>Gerenciar Categorias</h2>
    <div class="cat-manage-tabs">
      <button type="button" class="cat-tab" data-cattab="despesa">↓ Despesas</button>
      <button type="button" class="cat-tab" data-cattab="receita">↑ Receitas</button>
    </div>
    <div id="catManageList" class="cat-cards" style="margin-top:14px;"></div>
    <div class="modal-actions">
      <button id="catManageCloseBtn">Fechar</button>
      <button class="save" id="catManageAddBtn">+ Nova Categoria</button>
    </div>
  </div>
</div>

<!-- Modal Orçamento -->
<div class="overlay" id="overlayBudget">
  <div class="modal">
    <button class="close-x" id="closeOrcModal">✕</button>
    <h2 id="orcModalTitle">Novo Orçamento</h2>
    <div class="field"><label>Categoria</label><select id="orcCategoria"></select></div>
    <div class="field"><label>Limite mensal (R$)</label><input id="orcLimite" type="number" step="0.01" placeholder="0,00"></div>
    <div class="modal-actions">
      <button id="orcCancelBtn">Cancelar</button>
      <button class="save" id="orcSaveBtn">Salvar Orçamento</button>
    </div>
  </div>
</div>

<!-- Modal Meta -->
<div class="overlay" id="overlayGoal">
  <div class="modal">
    <button class="close-x" id="closeGoalModal">✕</button>
    <h2 id="goalModalTitle">Nova Meta</h2>
    <div class="field"><label>Nome da meta</label><input id="goalName" placeholder="Ex: Reserva de Emergência"></div>
    <div class="field-row">
      <div class="field"><label>Valor Alvo (R$)</label><input id="goalTarget" type="number" step="0.01"></div>
      <div class="field"><label>Valor Atual (R$)</label><input id="goalCurrent" type="number" step="0.01"></div>
    </div>
    <div class="field"><label>Prazo</label><input id="goalDeadline" type="date"></div>
    <div class="modal-actions">
      <button id="goalCancelBtn">Cancelar</button>
      <button class="save" id="goalSaveBtn">Salvar Meta</button>
    </div>
  </div>
</div>

<!-- Modal Recorrente -->
<div class="overlay" id="overlayRecurring">
  <div class="modal">
    <button class="close-x" id="closeRecModal">✕</button>
    <h2 id="recModalTitle">Novo Lançamento Recorrente</h2>
    <div class="toggle-type">
      <button type="button" id="recTypeInBtn">↓ Receita</button>
      <button type="button" id="recTypeOutBtn">↑ Despesa</button>
    </div>
    <div class="field"><label>Descrição</label><input id="recDesc" placeholder="Ex: Internet"></div>
    <div class="field-row">
      <div class="field"><label>Valor (R$)</label><input id="recVal" type="number" step="0.01"></div>
      <div class="field"><label>Dia do mês</label><input id="recDay" type="number" min="1" max="31"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Categoria</label><select id="recCategoria"></select></div>
      <div class="field"><label>Conta</label><select id="recConta"></select></div>
    </div>
    <div class="field"><label>Frequência</label><select id="recFreq"><option>Mensal</option><option>Semanal</option><option>Anual</option></select></div>
    <div class="modal-actions">
      <button id="recCancelBtn">Cancelar</button>
      <button class="save" id="recSaveBtn">Salvar Recorrente</button>
    </div>
  </div>
</div>

<!-- Modal Alerta -->
<div class="overlay" id="overlayAlert">
  <div class="modal">
    <button class="close-x" id="closeAlertModal">✕</button>
    <h2 id="alertModalTitle">Novo Alerta</h2>
    <div class="field"><label>Categoria</label><select id="alertCategoria"></select></div>
    <div class="field"><label>Acionar ao atingir (%) do orçamento</label><input id="alertThreshold" type="number" min="1" max="200" value="90"></div>
    <div class="modal-actions">
      <button id="alertCancelBtn">Cancelar</button>
      <button class="save" id="alertSaveBtn">Salvar Alerta</button>
    </div>
  </div>
</div>

<!-- Modal Usuário (Admin) -->
<div class="overlay" id="overlayUserAdmin">
  <div class="modal">
    <button class="close-x" id="closeUserAdminModal">✕</button>
    <h2>Editar Usuário</h2>
    <div class="field"><label>Nome</label><input id="userAdminName"></div>
    <div class="field"><label>E-mail</label><input id="userAdminEmail" disabled style="opacity:0.6;"></div>
    <div class="field"><label>Perfil de acesso</label>
      <select id="userAdminRole"><option value="Usuário">Usuário</option><option value="Administrador">Administrador</option></select>
    </div>
    <div class="field">
      <label>Nova senha</label>
      <p class="cfg-hint" style="margin:-2px 0 8px;">Deixe em branco para manter a senha atual</p>
      <div class="pass-field">
        <input id="userAdminPassword" type="password" placeholder="••••••••">
        <button type="button" class="pass-toggle" id="userAdminPasswordToggle" tabindex="-1" aria-label="Mostrar senha"></button>
      </div>
    </div>
    <div class="modal-actions">
      <button id="userAdminCancelBtn">Cancelar</button>
      <button class="save" id="userAdminSaveBtn">Salvar Usuário</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"><span class="d"></span><span id="toastMsg">Salvo com sucesso!</span></div>

<div class="login-success-overlay" id="loginSuccessOverlay">
  <div class="login-success-box">
    <div class="login-success-check">
      <svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" fill="none"/><path fill="none" d="M14 27l7 7 17-17"/></svg>
    </div>
    <h3>Login efetuado com sucesso!</h3>
    <p id="loginSuccessMsg">Bem-vindo(a) de volta.</p>
  </div>
</div>

<div class="login-success-overlay" id="accountDisabledOverlay">
  <div class="login-success-box">
    <div class="account-disabled-icon">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 8l8 8M16 8l-8 8"/></svg>
    </div>
    <h3>Usuário desativado</h3>
    <p id="accountDisabledMsg">Seu usuário foi desativado pelo administrador. Entre em contato para mais informações.</p>
    <button type="button" class="account-disabled-btn" id="accountDisabledCloseBtn">Entendi</button>
  </div>
</div>

<div class="login-success-overlay" id="logoutSuccessOverlay">
  <div class="login-success-box logout-box">
    <div class="logout-success-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
        <polyline points="16 17 21 12 16 7"></polyline>
        <line x1="21" y1="12" x2="9" y2="12"></line>
      </svg>
    </div>
    <h3>Sessão Encerrada</h3>
    <p id="logoutSuccessMsg">Você saiu da sua conta com segurança. Suas informações estão salvas e protegidas.</p>
    <button type="button" class="logout-btn-action" id="logoutSuccessCloseBtn" onclick="hideLogoutPopup()">Fazer Login Novamente →</button>
  </div>
</div>

<script>
/* ==================== Gerenciamento de LocalStorage e Servidor ==================== */
function loadFromStorage(key, defaultVal) {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : defaultVal;
  } catch(e) {
    return defaultVal;
  }
}
function saveToStorage(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch(e) {
    console.warn('Aviso: Armazenamento local (localStorage) excedeu a cota máxima. Os dados são mantidos e salvos no PostgreSQL.', e);
  }
}

let registeredUsers = [];

async function syncUsersWithServer() {
  try {
    const res = await fetch(window.location.origin + '/api/users');
    if (res.ok) {
      registeredUsers = await res.json();
      saveToStorage('nexus_users', registeredUsers);
    }
  } catch(e) {
    registeredUsers = loadFromStorage('nexus_users', [
      { name: 'Paulo Lima', email: 'admin@nexusfinanceiro.com', password: '86266049', role: 'Administrador', active: true }
    ]);
  }
}

async function saveUsersToServer() {
  saveToStorage('nexus_users', registeredUsers);
  try {
    await fetch(window.location.origin + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registeredUsers)
    });
  } catch(e){}
}

let currentUser = null;
let isViewingOtherUser = false;
let adminOriginalUser = null;

// Formulários de Login/Cadastro
document.getElementById('goRegister').onclick = () => {
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('forgotBox').style.display = 'none';
  document.getElementById('registerBox').style.display = 'block';
};
document.getElementById('goLogin').onclick = () => {
  document.getElementById('registerBox').style.display = 'none';
  document.getElementById('forgotBox').style.display = 'none';
  document.getElementById('loginBox').style.display = 'block';
};

// Esqueceu a senha - Enviar por E-mail
document.getElementById('goForgot').onclick = async (e) => {
  e.preventDefault();
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('registerBox').style.display = 'none';
  document.getElementById('forgotBox').style.display = 'block';
  document.getElementById('forgotStep1').reset();
  document.getElementById('forgotSub').textContent = 'Informe seu e-mail para enviarmos sua senha';
};

document.getElementById('goLoginFromForgot').onclick = () => {
  document.getElementById('forgotBox').style.display = 'none';
  document.getElementById('loginBox').style.display = 'block';
};

document.getElementById('forgotStep1').onsubmit = async (e) => {
  e.preventDefault();
  const email = document.getElementById('forgotEmail').value.trim();
  const btn = document.getElementById('btnSendPassword');

  btn.disabled = true;
  btn.textContent = 'Enviando...';

  try {
    const res = await fetch(window.location.origin + '/api/send-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();

    if (!data.success) {
      alert(data.error || 'Não encontramos nenhuma conta com esse e-mail ou falha no envio.');
      return;
    }

    alert('Sua senha foi enviada para o seu e-mail com sucesso!');
    document.getElementById('loginEmail').value = email;
    document.getElementById('forgotBox').style.display = 'none';
    document.getElementById('loginBox').style.display = 'block';
  } catch(err) {
    alert('Erro ao processar solicitação de e-mail. Verifique suas credenciais SMTP no Render.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviar Senha por E-mail';
  }
};

// Login
document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  await syncUsersWithServer();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  const user = registeredUsers.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
  if (user) {
    if (user.active === false) {
      showAccountDisabledPopup('Seu usuário foi desativado pelo administrador. Entre em contato para mais informações.');
      return;
    }
    currentUser = user;
    saveToStorage('nexus_session', { email: user.email });
    saveToStorage('nexus_cached_user', user);
    saveToStorage('nexus_token', 'token_' + Date.now());
    document.documentElement.classList.add('user-logged-in');
    await loadUserData();
    if (user.role === 'Administrador' && !isViewingOtherUser) {
      currentPage = 'usuarios';
    } else {
      currentPage = 'dashboard';
    }
    document.getElementById('authPage').classList.remove('show');
    document.getElementById('appMain').classList.add('show');
    render();
    showLoginSuccessPopup('Bem-vindo(a) de volta, ' + user.name.split(' ')[0] + '!');
  } else {
    alert('E-mail ou senha incorretos!');
  }
};

function showLoginSuccessPopup(msg){
  const overlay = document.getElementById('loginSuccessOverlay');
  document.getElementById('loginSuccessMsg').textContent = msg;
  overlay.classList.add('show');
  requestAnimationFrame(()=> overlay.classList.add('in'));
  setTimeout(()=>{
    overlay.classList.remove('in');
    setTimeout(()=> overlay.classList.remove('show'), 250);
  }, 1800);
}

function showAccountDisabledPopup(msg){
  const overlay = document.getElementById('accountDisabledOverlay');
  if(msg) document.getElementById('accountDisabledMsg').textContent = msg;
  overlay.classList.add('show');
  requestAnimationFrame(()=> overlay.classList.add('in'));
}
function hideAccountDisabledPopup(){
  const overlay = document.getElementById('accountDisabledOverlay');
  overlay.classList.remove('in');
  setTimeout(()=> overlay.classList.remove('show'), 250);
}

let logoutTimer = null;
function showLogoutPopup(msg){
  const overlay = document.getElementById('logoutSuccessOverlay');
  if(!overlay) return;
  if(msg) document.getElementById('logoutSuccessMsg').textContent = msg;
  overlay.classList.add('show');
  requestAnimationFrame(()=> overlay.classList.add('in'));

  // Foco imediato no campo de email para permitir digitar sem travar
  setTimeout(() => {
    const loginEmailInput = document.getElementById('loginEmail');
    if (loginEmailInput) loginEmailInput.focus();
  }, 50);

  // Auto-dismiss em 1.8 segundos para NUNCA prender a tela do próximo login
  if (logoutTimer) clearTimeout(logoutTimer);
  logoutTimer = setTimeout(() => {
    hideLogoutPopup();
  }, 1800);
}

function hideLogoutPopup(){
  const overlay = document.getElementById('logoutSuccessOverlay');
  if(!overlay) return;
  overlay.classList.remove('in');
  setTimeout(()=> {
    overlay.classList.remove('show');
  }, 250);
}

// Cadastro absoluto com requisição direta para o Render
document.getElementById('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  await syncUsersWithServer();
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value.trim();

  if (registeredUsers.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    alert('Este e-mail já está cadastrado!');
    return;
  }

  const newUser = { name, email, password, role: 'Usuário', active: true };
  registeredUsers.push(newUser);

  try {
    const response = await fetch(window.location.origin + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registeredUsers)
    });
    
    if (!response.ok) {
      throw new Error('Falha ao comunicar com o servidor');
    }

    saveToStorage('nexus_users', registeredUsers);
    alert('Conta criada com sucesso! Faça login para continuar.');

    document.getElementById('regName').value = '';
    document.getElementById('regEmail').value = '';
    document.getElementById('regPassword').value = '';
    document.getElementById('loginEmail').value = email;
    document.getElementById('loginPassword').value = password;
    document.getElementById('goLogin').click();
  } catch (err) {
    registeredUsers.pop();
    alert('Erro ao registrar no servidor. Verifique sua conexão e tente novamente.');
  }
};

// Logout
document.getElementById('logoutBtn').onclick = async () => {
  try { await saveUserData(); } catch(e){}
  currentUser = null;
  isViewingOtherUser = false;
  adminOriginalUser = null;
  localStorage.removeItem('nexus_session');
  localStorage.removeItem('nexus_cached_user');
  localStorage.removeItem('nexus_token');
  localStorage.removeItem('nexus_viewing_user');
  document.documentElement.classList.remove('user-logged-in');
  document.getElementById('appMain').classList.remove('show');
  document.getElementById('authPage').classList.add('show');
  showLogoutPopup('Você saiu da sua conta com segurança. Suas informações estão salvas e protegidas.');
};

/* ==================== Isolamento de Dados por Usuário ==================== */
let categories = [];
let accounts = [];
let transactions = [];
let budgets = [];
let goals = [];
let recurringList = [];
let alerts = [];
let attachments = [];
let notifications = [];

let nextAccId = 1, nextTxId = 1, nextBudgetId = 1, nextGoalId = 1, nextRecId = 1, nextAlertId = 1, nextAttId = 1, nextNotifId = 1;

/* ==================== Migração: tipo de categoria ==================== */
const RECEITA_NAME_HINTS = ['salário','salario','renda','freela','freelance','bônus','bonus','valor extra','extra','13º','decimo terceiro','décimo terceiro','rendimento','dividendo','investimento','reembolso'];
const BASE_CATEGORIES = [
  {name:'Alimentação', color:'#e8974b', type:'despesa', icon:'🍔'},
  {name:'Supermercado', color:'#d8a34b', type:'despesa', icon:'🛒'},
  {name:'Moradia', color:'#c98a3f', type:'despesa', icon:'🏠'},
  {name:'Contas da Casa', color:'#f0a63a', type:'despesa', icon:'💡'},
  {name:'Transporte', color:'#ef5a5a', type:'despesa', icon:'🚗'},
  {name:'Saúde', color:'#5ac57e', type:'despesa', icon:'⚕️'},
  {name:'Educação', color:'#4a90e2', type:'despesa', icon:'📚'},
  {name:'Lazer', color:'#9b6bd8', type:'despesa', icon:'🎮'},
  {name:'Vestuário', color:'#d85bb0', type:'despesa', icon:'👕'},
  {name:'Assinaturas', color:'#6b7fd7', type:'despesa', icon:'📺'},
  {name:'Cartão de Crédito', color:'#e8b04b', type:'despesa', icon:'💳'},
  {name:'Pix Enviado', color:'#f0a63a', type:'despesa', icon:'📤'},
  {name:'Cuidados Pessoais', color:'#e07bb0', type:'despesa', icon:'💆'},
  {name:'Outros', color:'#8a93a3', type:'despesa', icon:'📦'},
  {name:'Salário', color:'#e8b04b', type:'receita', icon:'💼'},
  {name:'Freelance', color:'#4a90e2', type:'receita', icon:'💻'},
  {name:'Investimentos', color:'#5ac57e', type:'receita', icon:'📈'},
  {name:'Pix Recebido', color:'#3ec7c7', type:'receita', icon:'📥'},
  {name:'Reembolso', color:'#6bcf9e', type:'receita', icon:'💵'},
  {name:'Bônus / 13º', color:'#d8a34b', type:'receita', icon:'🎉'},
  {name:'Outras Receitas', color:'#8a93a3', type:'receita', icon:'💰'}
];
function migrateCategories(){
  let changed = false;
  categories.forEach(c=>{
    if(!c.type){
      const lower = c.name.toLowerCase();
      c.type = RECEITA_NAME_HINTS.some(h=>lower.includes(h)) ? 'receita' : 'despesa';
      changed = true;
    }
    if(!c.icon){
      c.icon = c.type==='receita' ? '💰' : '📁';
      changed = true;
    }
    if(typeof c.count !== 'number'){
      c.count = 0;
      changed = true;
    }
  });
  BASE_CATEGORIES.forEach(dc=>{
    if(!categories.some(c=>c.name.toLowerCase()===dc.name.toLowerCase())){
      categories.push({...dc, count:0});
      changed = true;
    }
  });
  if(changed) saveUserData();
}

function autoMigrateTransactionsAndAccounts() {
  if (!accounts || accounts.length === 0) return;
  let changed = false;

  transactions.forEach(t => {
    // 1. Se t.accId aponta para um ID de conta que não existe mais, reseta para relinkar
    if (t.accId != null && !accounts.some(a => String(a.id) === String(t.accId))) {
      t.accId = null;
      changed = true;
    }

    // 2. Se a transação não tem accId válido, encontra a conta correspondente
    if (t.accId == null) {
      const match = accounts.find(a => isTxForAccount(t, a));
      if (match) {
        t.accId = match.id;
        t.acc = match.name;
        changed = true;
      }
    }
  });

  if (changed && typeof saveUserData === 'function') {
    saveUserData();
  }
}

function applyDataPayload(data) {
  if (!data) return;
  
  if (Array.isArray(data.categories) && data.categories.length > 0) {
    categories = data.categories;
  } else if (!categories || categories.length === 0) {
    categories = BASE_CATEGORIES.map(c=>({...c, count:0}));
  }

  // Preserva dados existentes caso o payload recebido venha com arrays vazios por falha de resposta
  if (Array.isArray(data.accounts) && data.accounts.length > 0) {
    accounts = data.accounts;
  }
  if (Array.isArray(data.transactions) && data.transactions.length > 0) {
    transactions = data.transactions;
  }
  if (Array.isArray(data.budgets) && data.budgets.length > 0) budgets = data.budgets;
  if (Array.isArray(data.goals) && data.goals.length > 0) goals = data.goals;
  if (Array.isArray(data.recurringList) && data.recurringList.length > 0) recurringList = data.recurringList;
  if (Array.isArray(data.alerts) && data.alerts.length > 0) alerts = data.alerts;
  if (Array.isArray(data.attachments) && data.attachments.length > 0) attachments = data.attachments;
  if (Array.isArray(data.notifications) && data.notifications.length > 0) notifications = data.notifications;

  if (data.nextAccId) nextAccId = Math.max(nextAccId, data.nextAccId);
  if (data.nextTxId) nextTxId = Math.max(nextTxId, data.nextTxId);
  if (data.nextBudgetId) nextBudgetId = Math.max(nextBudgetId, data.nextBudgetId);
  if (data.nextGoalId) nextGoalId = Math.max(nextGoalId, data.nextGoalId);
  if (data.nextRecId) nextRecId = Math.max(nextRecId, data.nextRecId);
  if (data.nextAlertId) nextAlertId = Math.max(nextAlertId, data.nextAlertId);
  if (data.nextAttId) nextAttId = Math.max(nextAttId, data.nextAttId);
  if (data.nextNotifId) nextNotifId = Math.max(nextNotifId, data.nextNotifId);

  migrateCategories();
  autoMigrateTransactionsAndAccounts();
}

let isDataLoading = false;

async function loadUserData() {
  if (!currentUser) return;
  const cleanEmail = (currentUser.email || '').toLowerCase().trim();
  const userKey = 'nexus_data_' + cleanEmail;
  
  // 1. Carrega dados do cache local instantaneamente para garantir exibição imediata
  let localData = loadFromStorage(userKey, null);
  if (localData) {
    applyDataPayload(localData);
    isDataLoading = false;
    if (typeof render === 'function') render();
  } else {
    isDataLoading = true;
  }

  // 2. Sincroniza em segundo plano com o servidor PostgreSQL
  try {
    const res = await fetch(window.location.origin + '/api/data?email=' + encodeURIComponent(cleanEmail));
    if (res.ok) {
      const serverData = await res.json();
      if (serverData && typeof serverData === 'object' && Object.keys(serverData).length > 0) {
        applyDataPayload(serverData);
        saveToStorage(userKey, serverData);
      }
    }
  } catch(e) {
    console.warn('Aviso de conexão com o banco de dados:', e);
  } finally {
    isDataLoading = false;
  }
  if (typeof render === 'function' && document.getElementById('appMain') && document.getElementById('appMain').classList.contains('show')) {
    render();
  }
}

// Sincronização Automática entre Dispositivos ao alternar ou focar no app
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUser && !isViewingOtherUser) {
      loadUserData();
    }
  });
  window.addEventListener('focus', () => {
    if (currentUser && !isViewingOtherUser) {
      loadUserData();
    }
  });
}

async function saveUserData() {
  if (!currentUser) return;
  if (isViewingOtherUser) return;

  // Escudo contra exclusão acidental: impede salvar dados totalmente zerados se já existiam contas/transações no cache local
  const cleanEmail = (currentUser.email || '').toLowerCase().trim();
  const userKey = 'nexus_data_' + cleanEmail;

  if (accounts.length === 0 && transactions.length === 0) {
    const existingCache = loadFromStorage(userKey, null);
    if (existingCache && ((existingCache.accounts && existingCache.accounts.length > 0) || (existingCache.transactions && existingCache.transactions.length > 0))) {
      console.warn('Escudo ativado: impedindo sobrescrita do banco de dados com payload zerado.');
      applyDataPayload(existingCache);
      return;
    }
  }

  const payloadData = {
    categories, accounts, transactions, budgets, goals, recurringList, alerts, attachments, notifications,
    nextAccId, nextTxId, nextBudgetId, nextGoalId, nextRecId, nextAlertId, nextAttId, nextNotifId
  };
  
  saveToStorage(userKey, payloadData);

  try {
    await fetch(window.location.origin + '/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentUser.email, data: payloadData })
    });
  } catch(e) {}
}

/* ==================== Admin: Visualizar dados de outro usuário ==================== */
async function viewUserData(email){
  await syncUsersWithServer();
  if(!currentUser || currentUser.role !== 'Administrador') return;
  const target = registeredUsers.find(u => u.email.toLowerCase() === (email||'').toLowerCase());
  if(!target || target.email.toLowerCase() === currentUser.email.toLowerCase()) return;

  if(!isViewingOtherUser){
    await saveUserData();
    adminOriginalUser = currentUser;
  }
  currentUser = target;
  isViewingOtherUser = true;
  saveToStorage('nexus_viewing_user', target.email);
  await loadUserData();
  currentPage = 'dashboard';
  render();
  showToast('Visualizando dados de ' + target.name);
}

async function exitViewMode(){
  if(!isViewingOtherUser || !adminOriginalUser) return;
  currentUser = adminOriginalUser;
  adminOriginalUser = null;
  isViewingOtherUser = false;
  localStorage.removeItem('nexus_viewing_user');
  localStorage.setItem('nexus_current_page', 'usuarios');
  try {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, null, '#usuarios');
    } else {
      window.location.hash = 'usuarios';
    }
  } catch(e){}
  saveToStorage('nexus_session', { email: currentUser.email });
  saveToStorage('nexus_cached_user', currentUser);
  await loadUserData();
  currentPage = 'usuarios';
  render();
  showToast('Você voltou para sua conta de Administrador.');
}

/* ==================== Admin: Ativar/Desativar usuário ==================== */
async function toggleUserActive(email){
  await syncUsersWithServer();
  if(!currentUser || currentUser.role !== 'Administrador') return;
  const u = registeredUsers.find(x => x.email === email);
  if(!u || u.email === currentUser.email) return;

  const willDeactivate = u.active !== false;
  if(willDeactivate && u.role === 'Administrador' && registeredUsers.filter(x=>x.role==='Administrador' && x.active!==false).length <= 1){
    showToast('É necessário manter ao menos um administrador ativo');
    return;
  }

  u.active = willDeactivate ? false : true;
  await saveUsersToServer();
  showToast(willDeactivate ? 'Usuário desativado.' : 'Usuário ativado novamente.');
  logActivity('Edição', 'Usuário', 'Administrador ' + (willDeactivate ? 'desativou' : 'ativou') + ' o acesso do usuário ' + u.email + ' (' + u.name + ')');
  render();
}

/* ==================== Período ==================== */
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const YEARS = [2024,2025,2026,2027,2028,2029,2030];
const PERIOD_MIN = {year:2024, month:1};
const PERIOD_MAX = {year:2030, month:12};
const EYE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-3.22 4.44M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function bindPasswordToggle(inputId, btnId){
  const inp = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if(!inp || !btn) return;
  btn.innerHTML = EYE_ICON;
  btn.onclick = ()=>{
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.innerHTML = show ? EYE_OFF_ICON : EYE_ICON;
    btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  };
}
function getDefaultPeriod(){
  try {
    const saved = localStorage.getItem('fin_current_period');
    if (saved) {
      const p = JSON.parse(saved);
      if (p && typeof p.year === 'number' && typeof p.month === 'number') {
        if (p.year >= PERIOD_MIN.year && p.year <= PERIOD_MAX.year && p.month >= 1 && p.month <= 12) {
          return { year: p.year, month: p.month };
        }
      }
    }
  } catch(e) {}
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth()+1;
  if(y < PERIOD_MIN.year || (y===PERIOD_MIN.year && m < PERIOD_MIN.month)) return {year:PERIOD_MIN.year, month:PERIOD_MIN.month};
  if(y > PERIOD_MAX.year || (y===PERIOD_MAX.year && m > PERIOD_MAX.month)) return {year:PERIOD_MAX.year, month:PERIOD_MAX.month};
  return {year:y, month:m};
}
let currentPeriod = getDefaultPeriod();

function pdCustom(y,m,day){
  const lastDay = new Date(y, m, 0).getDate();
  const d = String(Math.min(day, lastDay)).padStart(2,'0');
  return y + '-' + String(m).padStart(2,'0') + '-' + d;
}
function pd(day){ return pdCustom(currentPeriod.year, currentPeriod.month, day); }

let editingId=null, editingAccId=null, editingCatName=null, editingBudgetId=null, editingGoalId=null, editingRecId=null, editingAlertId=null, editingUserEmail=null;
let catManageType = 'despesa';
let currentType='out', currentRecType='out';
let currentPage = (function getInitialPage() {
  try {
    const validPages = ['dashboard', 'transacoes', 'cartoes', 'orcamentos', 'metas', 'relatorios', 'recorrentes', 'importar', 'anexos', 'alertas', 'funcoes', 'usuarios', 'logs', 'config'];
    const hashPage = window.location.hash ? window.location.hash.replace('#', '') : null;
    const savedPage = localStorage.getItem('nexus_current_page');
    if (hashPage && validPages.includes(hashPage)) return hashPage;
    if (savedPage && validPages.includes(savedPage)) return savedPage;
  } catch(e){}
  return 'dashboard';
})();
let charts = {};

const fmt = v => 'R$ ' + (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2});
const catColor = name => (categories.find(c=>c.name===name)||{}).color || '#888';
const catIcon = name => { const c = categories.find(c=>c.name===name); return (c && c.icon) || '📁'; };

function catOptionsHTML(type, selected){
  let list = type ? categories.filter(c=>(c.type||'despesa')===type) : categories.slice();
  list = list.slice().sort((a,b)=> (b.count||0)-(a.count||0) || a.name.localeCompare(b.name,'pt-BR'));
  return list.map(c=>'<option value="'+c.name+'"'+(selected===c.name?' selected':'')+'>'+(c.icon||'📁')+' '+c.name+'</option>').join('');
}
const periodLabel = () => currentPeriod.month === 0 ? 'Todas as Datas (Geral)' : ((MONTHS[currentPeriod.month-1] || 'Mês ' + currentPeriod.month) + ' / ' + currentPeriod.year);

function formatDateBR(dateVal) {
  if (!dateVal) return '—';
  try {
    const str = String(dateVal).trim();
    if (str.includes('T')) {
      const parts = str.split('T')[0].split('-');
      if (parts.length === 3) return parts[2] + '/' + parts[1] + '/' + parts[0];
    }
    const parts = str.split('-');
    if (parts.length === 3) {
      return parts[2].padStart(2,'0') + '/' + parts[1].padStart(2,'0') + '/' + parts[0];
    }
    const d = new Date(dateVal);
    if (!isNaN(d.getTime())) return d.toLocaleDateString('pt-BR');
  } catch(e){}
  return String(dateVal);
}

const inPeriod = t => {
  if (!t || !t.date) return false;
  if (currentPeriod.month === 0) return true;
  
  const dParts = String(t.date).split('T')[0].split('-');
  if (dParts.length === 3) {
    const y = parseInt(dParts[0]);
    const m = parseInt(dParts[1]);
    return m === currentPeriod.month && y === currentPeriod.year;
  }
  const d = new Date(t.date);
  return (d.getMonth() + 1) === currentPeriod.month && d.getFullYear() === currentPeriod.year;
};


/* ==================== Cálculos de Cartões e Limites ==================== */
function isAccountCreditCard(account) {
  if (!account) return false;
  const accTypeLower = (account.type || '').toLowerCase().trim();

  // 1. Se o tipo for explicitamente Conta Corrente, Poupança, Investimentos, Débito, Dinheiro, etc., NUNCA é cartão de crédito
  if (
    accTypeLower.includes('corrente') || 
    accTypeLower.includes('poupança') || 
    accTypeLower.includes('poupanca') || 
    accTypeLower.includes('investimento') || 
    accTypeLower.includes('dinheiro') || 
    accTypeLower.includes('caixa') || 
    accTypeLower.includes('carteira') || 
    accTypeLower.includes('débito') || 
    accTypeLower.includes('debito')
  ) {
    return false;
  }

  // 2. Se o tipo for Cartão de Crédito ou Crédito ou Fatura
  if (
    accTypeLower.includes('cartão') ||
    accTypeLower.includes('cartao') ||
    accTypeLower.includes('crédito') ||
    accTypeLower.includes('credito') ||
    accTypeLower.includes('fatura')
  ) {
    return true;
  }

  // 3. Verificação por nome da conta para contas com tipo genérico ("Outros", "", etc.)
  const accNameLower = (account.name || '').toLowerCase().trim();
  return (
    accNameLower.includes('cartão de crédito') ||
    accNameLower.includes('cartao de credito') ||
    accNameLower.includes('cartão') ||
    accNameLower.includes('cartao') ||
    accNameLower.includes('fatura') ||
    accNameLower.includes('credicard') ||
    accNameLower.includes('amex') ||
    accNameLower.includes('hipercard') ||
    accNameLower.includes('mastercard') ||
    accNameLower.includes('visa')
  );
}

function normalizeAccName(str) {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/cartão de crédito|cartao de credito|cartão de débito|cartao de debito|cartão|cartao|conta corrente|conta poupança|conta poupanca|conta|banco|crédito|credito|débito|debito/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .trim();
}

function isTxForAccount(t, account) {
  if (!t || !account) return false;

  // 1. Prioridade máxima: ID da conta
  if (t.accId != null && account.id != null && String(t.accId) === String(account.id)) return true;

  const accNameLower = (account.name || '').toLowerCase().trim();
  if (!accNameLower) return false;

  const tAccLower = (t.acc || '').toLowerCase().trim();
  const tCardLower = (t.card || '').toLowerCase().trim();

  // 2. Correspondência exata do nome da conta ou do cartão
  if (tAccLower === accNameLower || tCardLower === accNameLower) return true;

  // 3. Correspondência normalizada (removendo "Cartão", "Conta", "Banco", etc.)
  const normAccName = normalizeAccName(account.name);
  const normTAcc = normalizeAccName(t.acc);
  const normTCard = normalizeAccName(t.card);

  if (normAccName.length >= 2) {
    if (normTAcc === normAccName || normTCard === normAccName) return true;
    if (normTAcc && (normTAcc.includes(normAccName) || normAccName.includes(normTAcc))) return true;
    if (normTCard && (normTCard.includes(normAccName) || normAccName.includes(normTCard))) return true;
  }

  // 4. Se a transação tem nome parcial do cartão/conta (ex: "Nubank" vs "Cartão Nubank")
  if (tAccLower && accNameLower.length >= 3) {
    if (tAccLower.includes(accNameLower) || accNameLower.includes(tAccLower)) return true;
  }

  // 5. Se a transação estiver como "Cartão de Crédito" ou "Cartão" e só houver 1 Cartão de Crédito cadastrado
  if (isAccountCreditCard(account)) {
    const allCreditCards = accounts.filter(a => isAccountCreditCard(a));
    if (allCreditCards.length === 1 && String(allCreditCards[0].id) === String(account.id)) {
      if (tAccLower === 'cartão de crédito' || tAccLower === 'cartao de credito' || tAccLower === 'cartão' || tAccLower === 'cartao') {
        return true;
      }
    }
  }

  // 6. Verificação de palavras-chave na descrição para transações com conta não especificada
  if (!tAccLower || tAccLower === 'sem conta' || tAccLower === 'boleto / outros' || tAccLower === 'dinheiro') {
    const descLower = (t.desc || '').toLowerCase().trim();
    if (descLower) {
      if (normAccName.length >= 3 && descLower.includes(normAccName)) return true;
      if (accNameLower.length >= 3 && descLower.includes(accNameLower)) return true;
    }
  }

  return false;
}

function getCardStats(account) {
  if (!account) return { spentPeriod: 0, spentTotal: 0, totalLimit: 0, availableLimit: 0, usagePct: 0, currentBalance: 0, initialBalance: 0, isCreditCard: false, txCount: 0, periodIn: 0, periodOut: 0 };
  
  const isCreditCard = isAccountCreditCard(account);
  const cardTx = transactions.filter(t => isTxForAccount(t, account));

  const totalDespesas = cardTx.filter(t => t.type === 'out').reduce((s, t) => s + (parseFloat(t.val) || 0), 0);
  const totalPagamentos = cardTx.filter(t => t.type === 'in').reduce((s, t) => s + (parseFloat(t.val) || 0), 0);
  
  const periodCardTx = cardTx.filter(inPeriod);
  const periodDespesas = periodCardTx.filter(t => t.type === 'out').reduce((s, t) => s + (parseFloat(t.val) || 0), 0);
  const periodPagamentos = periodCardTx.filter(t => t.type === 'in').reduce((s, t) => s + (parseFloat(t.val) || 0), 0);

  const initialBalance = parseFloat(account.balance) || 0;

  if (isCreditCard) {
    // Para Cartões de Crédito: initialBalance (account.balance) representa o Limite Total Aprovado
    const totalLimit = Math.max(0, initialBalance);
    const spentTotal = Math.max(0, totalDespesas - totalPagamentos);
    const spentPeriod = Math.max(0, periodDespesas - periodPagamentos);
    const availableLimit = Math.max(0, totalLimit - spentTotal);
    const usagePct = totalLimit > 0 ? Math.min(100, Math.max(0, Math.round((spentTotal / totalLimit) * 100))) : 0;
    const currentBalance = availableLimit;

    return {
      spentPeriod,
      spentTotal,
      totalLimit,
      availableLimit,
      usagePct,
      currentBalance,
      initialBalance,
      isCreditCard: true,
      txCount: cardTx.length,
      periodIn: periodPagamentos,
      periodOut: periodDespesas
    };
  } else {
    // Para Contas Bancárias (Conta Corrente, Poupança, Investimentos, etc.)
    const spentTotal = totalDespesas;
    const spentPeriod = periodDespesas;
    const currentBalance = initialBalance + totalPagamentos - totalDespesas;
    const availableLimit = currentBalance;
    const totalLimit = initialBalance;
    const usagePct = 0;

    return {
      spentPeriod,
      spentTotal,
      totalLimit,
      availableLimit,
      usagePct,
      currentBalance,
      initialBalance,
      isCreditCard: false,
      txCount: cardTx.length,
      periodIn: periodPagamentos,
      periodOut: periodDespesas
    };
  }
}

function computeCardSummary() {
  const creditCards = accounts.filter(a => isAccountCreditCard(a));

  let totalLimitGeral = 0;
  let spentTotalGeral = 0;
  let spentPeriodGeral = 0;
  let availableLimitGeral = 0;
  
  creditCards.forEach(card => {
    const stats = getCardStats(card);
    totalLimitGeral += stats.totalLimit;
    spentTotalGeral += stats.spentTotal;
    spentPeriodGeral += stats.spentPeriod;
    availableLimitGeral += stats.availableLimit;
  });
  
  const usagePctGeral = totalLimitGeral > 0 ? Math.min(100, Math.round((spentTotalGeral / totalLimitGeral) * 100)) : 0;
  return { creditCards, totalLimitGeral, spentTotalGeral, spentPeriodGeral, availableLimitGeral, usagePctGeral };
}

/* ==================== Cálculos ==================== */
function computeTotals(list=transactions){
  const receitas = list.filter(t=>t.type==='in').reduce((s,t)=>s+(parseFloat(t.val)||0),0);
  const despesas = list.filter(t=>t.type==='out').reduce((s,t)=>s+(parseFloat(t.val)||0),0);
  
  let saldoContasBancarias = 0;
  let faturasCartoesCredito = 0;

  accounts.forEach(a => {
    const stats = getCardStats(a);
    if (stats.isCreditCard) {
      faturasCartoesCredito += stats.spentTotal;
    } else {
      saldoContasBancarias += stats.currentBalance;
    }
  });

  const saldo = saldoContasBancarias - faturasCartoesCredito;
  return { receitas, despesas, saldo, saldoContasBancarias, faturasCartoesCredito };
}
function txStatsCardsHTML(list){
  const receitas = list.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0);
  const despesas = list.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0);
  const saldo = receitas - despesas;
  const saldoColor = saldo < 0 ? 'var(--red)' : 'var(--green)';
  let html = '';
  html += '<div class="kpi"><div class="row1">Receitas <span class="ic" style="background:var(--green-soft);color:var(--green)">↑</span></div><div class="val">' + fmt(receitas) + '</div><div class="sub">no filtro atual</div></div>';
  html += '<div class="kpi"><div class="row1">Despesas <span class="ic" style="background:var(--red-soft);color:var(--red)">↓</span></div><div class="val">' + fmt(despesas) + '</div><div class="sub">no filtro atual</div></div>';
  html += '<div class="kpi"><div class="row1">Saldo <span class="ic" style="background:rgba(74,144,226,.14);color:var(--blue)">⇄</span></div><div class="val" style="color:' + saldoColor + '">' + fmt(saldo) + '</div><div class="sub" style="color:' + saldoColor + '">receitas − despesas</div></div>';
  html += '<div class="kpi"><div class="row1">Transações <span class="ic" style="background:rgba(155,107,216,.14);color:var(--purple)">☰</span></div><div class="val">' + list.length + '</div><div class="sub">registros no filtro</div></div>';
  return html;
}
function despesasPorCategoria(list=transactions){
  const map = {};
  list.filter(t=>t.type==='out').forEach(t=>{ map[t.cat]=(map[t.cat]||0)+t.val; });
  return Object.entries(map).map(([name,val])=>({name,val,color:catColor(name)})).sort((a,b)=>b.val-a.val);
}
function budgetStatus(list=budgets){
  const periodTx = transactions.filter(inPeriod);
  return list.map(b=>{
    const spent = periodTx.filter(t=>t.cat===b.category && t.type==='out').reduce((s,t)=>s+t.val,0);
    const pct = b.limit>0 ? Math.round(spent/b.limit*100) : 0;
    return {...b, spent, pct};
  });
}

function showToast(msg){
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2400);
}

function timeAgo(ts){
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff/60000);
  if(min < 1) return 'agora mesmo';
  if(min < 60) return 'há ' + min + ' min';
  const hr = Math.floor(min/60);
  if(hr < 24) return 'há ' + hr + 'h';
  const day = Math.floor(hr/24);
  if(day < 7) return 'há ' + day + 'd';
  return new Date(ts).toLocaleDateString('pt-BR');
}
async function pushNotification(text, icon){
  notifications.unshift({id: nextNotifId++, text, icon: icon || '🔔', time: Date.now(), read:false});
  if(notifications.length > 40) notifications = notifications.slice(0,40);
  await saveUserData();
  renderNotifications();
}
function renderNotifications(){
  const dot = document.getElementById('notifDot');
  const list = document.getElementById('notifList');
  if(!dot || !list) return;
  const unread = notifications.filter(n=>!n.read).length;
  dot.style.display = unread > 0 ? 'block' : 'none';
  list.innerHTML = notifications.length ? notifications.map(n=>\`
    <div class="notif-item \${n.read?'':'unread'}">
      \${n.read? '' : '<span class="unread-dot"></span>'}
      <span class="ic">\${n.icon}</span>
      <div class="body"><div class="txt">\${n.text}</div><div class="time">\${timeAgo(n.time)}</div></div>
    </div>\`).join('') : \`<div class="notif-empty">Nenhuma notificação por aqui.</div>\`;
}

/* ==================== Atualização parcial da tabela de Transações (evita flicker) ==================== */
function refreshTxTable(){
  const search = document.getElementById('txSearch');
  const fTipo = document.getElementById('txFiltroTipo');
  const fCat = document.getElementById('txFiltroCat');
  const fStatus = document.getElementById('txFiltroStatus');
  const fConta = document.getElementById('txFiltroConta');
  const tableWrap = document.getElementById('txTableWrap');
  if(!search || !tableWrap) return false;

  // Proteção contra autofill do navegador preenchendo email/nome no campo de busca
  if (currentUser && search.value && (search.value.trim() === currentUser.email || search.value.trim() === currentUser.name)) {
    search.value = '';
  }

  let list = transactions.filter(inPeriod);
  const q = search.value.trim().toLowerCase();
  if(q) list = list.filter(t=>t.desc && t.desc.toLowerCase().includes(q));
  if(fTipo && fTipo.value) list = list.filter(t=>t.type===fTipo.value);
  if(fCat && fCat.value) list = list.filter(t=>t.cat===fCat.value);
  if(fStatus && fStatus.value) list = list.filter(t=>t.status===fStatus.value);
  if(fConta && fConta.value) {
    const targetAcc = accounts.find(a => a.name === fConta.value);
    if (targetAcc) {
      list = list.filter(t => isTxForAccount(t, targetAcc));
    } else {
      const qAcc = fConta.value.toLowerCase().trim();
      list = list.filter(t => (t.acc || '').toLowerCase().trim().includes(qAcc));
    }
  }

  list.sort((a,b)=>b.date.localeCompare(a.date));
  tableWrap.innerHTML = transactionsTable(list, true);
  const statsRow = document.getElementById('txStatsRow'); if(statsRow) statsRow.innerHTML = txStatsCardsHTML(list);
  document.querySelectorAll('[data-edit]').forEach(el=>el.onclick = ()=>openModal(parseInt(el.getAttribute('data-edit'))));
  document.querySelectorAll('[data-del]').forEach(el=>el.onclick = ()=>deleteTransaction(parseInt(el.getAttribute('data-del'))));
  return true;
}

/* ==================== Render Suave sem Flickering ==================== */
function render(){
  const el = document.getElementById('pageContent');
  if (!el) return;

  const isAdmin = currentUser && currentUser.role === 'Administrador';
  const isAdminView = isAdmin && !isViewingOtherUser;
  if (isAdminView && currentPage !== 'usuarios' && currentPage !== 'logs') {
    currentPage = 'usuarios';
  }

  let newHTML = '';
  if(currentPage==='usuarios') {
    newHTML = pageUsuarios();
    syncUsersWithServer().then(() => {
      const uEl = document.getElementById('pageContent');
      if (uEl && currentPage === 'usuarios') {
        const freshHTML = pageUsuarios();
        if (uEl.innerHTML !== freshHTML) uEl.innerHTML = freshHTML;
      }
    }).catch(() => {});
  }
  else if(currentPage==='logs') {
    newHTML = pageLogs();
    loadSystemLogs().then(() => {
      const lEl = document.getElementById('pageContent');
      if (lEl && currentPage === 'logs') {
        const freshHTML = pageLogs();
        if (lEl.innerHTML !== freshHTML) lEl.innerHTML = freshHTML;
      }
    }).catch(() => {});
  }
  else if(currentPage==='dashboard') newHTML = pageDashboard();
  else if(currentPage==='transacoes') newHTML = pageTransacoes();
  else if(currentPage==='cartoes') newHTML = pageContas();
  else if(currentPage==='orcamentos') newHTML = pageOrcamentos();
  else if(currentPage==='metas') newHTML = pageMetas();
  else if(currentPage==='relatorios') newHTML = pageRelatorios();
  else if(currentPage==='recorrentes') newHTML = pageRecorrentes();
  else if(currentPage==='importar') newHTML = pageImportar();
  else if(currentPage==='anexos') newHTML = pageAnexos();
  else if(currentPage==='alertas') newHTML = pageAlertas();
  else if(currentPage==='config') newHTML = pageConfig();
  else if(currentPage==='funcoes') newHTML = pageFuncoes();

  el.innerHTML = newHTML;
  attachPageEvents();
  updateHeaderUser();
  renderNotifications();
  updateViewModeBanner();
  updateAdminMenuVisibility();
  updateActiveMenu();
  if(currentPage==='dashboard') drawDashboardCharts();
}

function updateActiveMenu(){
  const validPages = ['dashboard', 'transacoes', 'cartoes', 'orcamentos', 'metas', 'relatorios', 'recorrentes', 'importar', 'anexos', 'alertas', 'funcoes', 'usuarios', 'logs', 'config'];
  const financialPages = ['dashboard', 'transacoes', 'cartoes', 'orcamentos', 'metas', 'relatorios', 'recorrentes', 'importar', 'anexos', 'alertas', 'config'];
  const isAdmin = currentUser && currentUser.role === 'Administrador';
  const isAdminView = isAdmin && !isViewingOtherUser;

  if (isAdminView) {
    if (!currentPage || financialPages.includes(currentPage) || !['usuarios', 'logs', 'funcoes'].includes(currentPage)) {
      currentPage = 'usuarios';
      try {
        localStorage.setItem('nexus_current_page', 'usuarios');
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, null, '#usuarios');
        } else {
          window.location.hash = 'usuarios';
        }
      } catch(e){}
    }
  } else {
    if (!currentPage || !financialPages.includes(currentPage) || ['usuarios', 'logs', 'funcoes'].includes(currentPage)) {
      const hashPage = window.location.hash ? window.location.hash.replace('#', '') : null;
      const savedPage = localStorage.getItem('nexus_current_page');
      if (hashPage && financialPages.includes(hashPage)) {
        currentPage = hashPage;
      } else if (savedPage && financialPages.includes(savedPage)) {
        currentPage = savedPage;
      } else {
        currentPage = 'dashboard';
      }
    }
  }

  const buttons = document.querySelectorAll('button[data-page]');
  buttons.forEach(b => {
    const isCurrent = (b.getAttribute('data-page') === currentPage);
    b.classList.toggle('active', isCurrent);
  });
}

function updateAdminMenuVisibility(){
  const isAdmin = currentUser && currentUser.role === 'Administrador';
  const isAdminView = isAdmin && !isViewingOtherUser;

  if (isAdminView) {
    document.documentElement.classList.add('is-admin');
  } else {
    document.documentElement.classList.remove('is-admin');
  }

  const financialPages = ['dashboard', 'transacoes', 'cartoes', 'orcamentos', 'metas', 'relatorios', 'recorrentes', 'importar', 'anexos', 'config'];
  financialPages.forEach(function(pg) {
    document.querySelectorAll('button[data-page="' + pg + '"]').forEach(function(btn) {
      btn.style.display = isAdminView ? 'none' : 'flex';
    });
  });

  const adminPages = ['usuarios', 'logs'];
  adminPages.forEach(function(pg) {
    document.querySelectorAll('button[data-page="' + pg + '"]').forEach(function(btn) {
      btn.style.display = isAdminView ? 'flex' : 'none';
    });
  });
}

function updateViewModeBanner(){
  const banner = document.getElementById('viewModeBanner');
  if(!banner) return;
  if(isViewingOtherUser && currentUser){
    document.getElementById('viewModeUserName').textContent = currentUser.name;
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

function updateHeaderUser(){
  if (!currentUser) return;
  const unameEl = document.getElementById('headerName');
  const avatarEl = document.getElementById('headerAvatar');
  const roleEl = document.getElementById('headerRole');

  if(unameEl) unameEl.textContent = currentUser.name;
  if(roleEl) roleEl.textContent = currentUser.role || 'Usuário';
  if(avatarEl) avatarEl.textContent = currentUser.name.trim().split(/\s+/).map(n=>n[0]).slice(0,2).join('').toUpperCase();
}

function periodPickerHTML(){
  const isAllDates = currentPeriod.month === 0;
  const labelText = isAllDates ? 'Todas as Datas (Geral)' : (MONTHS[currentPeriod.month-1] + ' / ' + currentPeriod.year);

  return \`
  <div class="period-wrap">
    <button type="button" class="period" id="periodBtn">
      <span class="period-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="3"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="8" y1="2.5" x2="8" y2="6.5"/><line x1="16" y1="2.5" x2="16" y2="6.5"/><circle cx="8" cy="14" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="14" r="1.1" fill="currentColor" stroke="none"/></svg></span>
      <span class="period-text">\${labelText}</span>
      <svg class="period-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="period-panel" id="periodPanel">
      <button type="button" class="period-today-btn" id="periodTodayBtn" style="margin-bottom:6px;">📍 Ir para o mês atual</button>
      <button type="button" class="period-today-btn" id="periodAllDatesBtn" style="background:rgba(74,144,226,0.15); color:var(--blue); margin-bottom:12px;">🌐 Ver Todas as Datas (Visão Geral)</button>
      <div class="field"><label>Ano</label><select id="periodYearSel"></select></div>
      <div class="field"><label>Mês</label><select id="periodMonthSel"></select></div>
      <button class="btn-primary" id="periodApplyBtn" style="width:100%;justify-content:center">Aplicar</button>
    </div>
  </div>\`;
}

/* ==================== Dashboard ==================== */
function getPendingBillsSummary() {
  const today = new Date();
  today.setHours(0,0,0,0);

  const pendingTxs = transactions.filter(t => {
    if (t.type !== 'out' || t.status === 'Pago' || t.status === 'Recebido') return false;
    const dParts = t.date ? t.date.split('-') : [];
    const d = dParts.length === 3 ? new Date(parseInt(dParts[0]), parseInt(dParts[1]) - 1, parseInt(dParts[2])) : new Date(t.date);
    d.setHours(0,0,0,0);
    const diffDays = Math.round((d - today) / (1000 * 60 * 60 * 24));
    // Mostrar apenas contas VENCIDAS (diffDays < 0) ou a vencer nos próximos 3 DIAS (diffDays <= 3)
    return diffDays <= 3;
  });

  const items = pendingTxs.map(t => {
    const dParts = t.date ? t.date.split('-') : [];
    const d = dParts.length === 3 ? new Date(parseInt(dParts[0]), parseInt(dParts[1]) - 1, parseInt(dParts[2])) : new Date(t.date);
    d.setHours(0,0,0,0);

    const diffDays = Math.round((d - today) / (1000 * 60 * 60 * 24));
    let statusType = 'soon';
    let statusText = '';
    let isUrgent = false;

    if (diffDays < 0) {
      statusType = 'overdue';
      statusText = \`VENCIDA (há \${Math.abs(diffDays)} dia\${Math.abs(diffDays) === 1 ? '' : 's'})\`;
      isUrgent = true;
    } else if (diffDays === 0) {
      statusType = 'today';
      statusText = 'VENCE HOJE';
      isUrgent = true;
    } else {
      statusType = 'soon';
      statusText = \`VENCE EM \${diffDays} DIA\${diffDays === 1 ? '' : 'S'}\`;
      isUrgent = true;
    }

    return {
      ...t,
      diffDays,
      statusType,
      statusText,
      isUrgent,
      formattedDate: dParts.length === 3 ? \`\${dParts[2]}/\${dParts[1]}/\${dParts[0]}\` : t.date
    };
  });

  items.sort((a,b) => a.diffDays - b.diffDays);

  const totalValue = items.reduce((acc, curr) => acc + (curr.val || 0), 0);
  const urgentCount = items.filter(i => i.isUrgent).length;
  const overdueCount = items.filter(i => i.statusType === 'overdue').length;

  return {
    items,
    totalValue,
    urgentCount,
    overdueCount
  };
}

async function markTransactionAsPaid(id) {
  const t = transactions.find(x => x.id === id);
  if (!t) return;
  t.status = 'Pago';
  showToast(\`✅ Conta "\${t.desc}" marcada como PAGA!\`);
  logActivity('Pagamento', 'Transação', \`Baixa realizada no pagamento de "\${t.desc}" (\${fmt(t.val)}).\`);
  await pushNotification(\`Pagamento realizado: \${t.desc} — \${fmt(t.val)}\`, '✅');
  await saveUserData();
  render();
}

function pageDashboard(){
  const periodTx = transactions.filter(inPeriod);
  const {receitas,despesas,saldo} = computeTotals(periodTx);
  const cats = despesasPorCategoria(periodTx);
  const totalDesp = cats.reduce((s,c)=>s+c.val,0)||1;
  const recPct = Math.round(receitas/(receitas+despesas||1)*100) || 0;
  const despPct = 100-recPct;
  const lastTx = periodTx.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  const cardSummary = computeCardSummary();
  const pendingSummary = getPendingBillsSummary();

  return \`
  <div class="page-head">
    <div><h1>Olá, \${currentUser ? currentUser.name.split(' ')[0] : 'Usuário'} 👋</h1><p>Aqui está o resumo da sua vida financeira</p></div>
    <div class="head-actions">
      \${periodPickerHTML()}
      <button class="btn-primary" id="btnNovaTransacao">+ Nova Transação</button>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="row1">Saldo Total <span>👁</span></div><div class="val" style="color:var(--green)">\${fmt(saldo)}</div><div class="sub">saldo atual de todas as contas</div></div>
    <div class="kpi"><div class="row1">Receitas <span class="ic" style="background:var(--green-soft);color:var(--green)">↑</span></div><div class="val">\${fmt(receitas)}</div><div class="sub up">\${periodLabel()}</div></div>
    <div class="kpi"><div class="row1">Despesas <span class="ic" style="background:var(--red-soft);color:var(--red)">↓</span></div><div class="val">\${fmt(despesas)}</div><div class="sub">\${periodLabel()}</div></div>
    <div class="kpi"><div class="row1">Saldo do Mês <span class="ic" style="background:rgba(74,144,226,.14);color:var(--blue)">⇄</span></div><div class="val" style="color:\${(receitas-despesas)<0?'var(--red)':'var(--green)'}">\${fmt(receitas-despesas)}</div><div class="sub" style="color:\${(receitas-despesas)<0?'var(--red)':'var(--green)'}">\${periodLabel()}</div></div>
    <div class="kpi"><div class="row1">Transações <span class="ic" style="background:rgba(155,107,216,.14);color:var(--purple)">☰</span></div><div class="val">\${periodTx.length}</div><div class="sub">registros no período</div></div>
  </div>

  \${cardSummary.creditCards.length > 0 ? \`
  <!-- Resumo de Limite de Cartões de Crédito no Dashboard -->
  <div class="panel cards-summary-panel" style="margin-bottom:20px; border:1px solid rgba(232,176,75,0.25);">
    <div class="panel-head" style="margin-bottom:12px;">
      <h3 style="display:flex;align-items:center;gap:8px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
        Cartões de Crédito — Limite & Faturas
      </h3>
      <span class="tag" data-nav="cartoes" style="cursor:pointer; background:var(--green-soft); color:var(--green);">Ver todos os cartões</span>
    </div>
    <div class="kpi-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:12px;">
      <div class="kpi" style="background:rgba(255,255,255,0.03); padding:12px 14px; border-radius:10px; border:1px solid var(--card-border);">
        <div class="row1" style="color:var(--text-dim); font-size:12px;">Limite Disponível Total</div>
        <div class="val" style="font-size:20px; font-weight:800; color:var(--green); margin-top:2px;">\${fmt(cardSummary.availableLimitGeral)}</div>
        <div class="sub" style="font-size:10.5px; color:var(--text-faint); margin-top:2px;">Para novas compras</div>
      </div>
      <div class="kpi" style="background:rgba(255,255,255,0.03); padding:12px 14px; border-radius:10px; border:1px solid var(--card-border);">
        <div class="row1" style="color:var(--text-dim); font-size:12px;">Fatura do Mês</div>
        <div class="val" style="font-size:20px; font-weight:800; color:var(--orange); margin-top:2px;">\${fmt(cardSummary.spentPeriodGeral)}</div>
        <div class="sub" style="font-size:10.5px; color:var(--text-faint); margin-top:2px;">\${periodLabel()}</div>
      </div>
      <div class="kpi" style="background:rgba(255,255,255,0.03); padding:12px 14px; border-radius:10px; border:1px solid var(--card-border);">
        <div class="row1" style="color:var(--text-dim); font-size:12px;">Fatura Acumulada em Aberto</div>
        <div class="val" style="font-size:20px; font-weight:800; color:var(--red); margin-top:2px;">\${fmt(cardSummary.spentTotalGeral)}</div>
        <div class="sub" style="font-size:10.5px; color:var(--text-faint); margin-top:2px;">Compras minus pagamentos</div>
      </div>
      <div class="kpi" style="background:rgba(255,255,255,0.03); padding:12px 14px; border-radius:10px; border:1px solid var(--card-border);">
        <div class="row1" style="color:var(--text-dim); font-size:12px;">Limite Aprovado Total</div>
        <div class="val" style="font-size:20px; font-weight:800; color:var(--blue); margin-top:2px;">\${fmt(cardSummary.totalLimitGeral)}</div>
        <div class="sub" style="font-size:10.5px; color:var(--text-faint); margin-top:2px;">Soma dos cartões</div>
      </div>
    </div>
    <div style="margin-top:10px;">
      <div style="display:flex; justify-content:space-between; font-size:11.5px; color:var(--text-dim); margin-bottom:4px;">
        <span>Comprometimento Global dos Cartões</span>
        <span style="font-weight:700; color:\${cardSummary.usagePctGeral>=90?'var(--red)':cardSummary.usagePctGeral>=70?'var(--orange)':'var(--green)'};">\${cardSummary.usagePctGeral}% comprometido</span>
      </div>
      <div class="bar-split" style="height:6px; background:var(--card-border); border-radius:4px; overflow:hidden;">
        <div class="g" style="width:\${cardSummary.usagePctGeral}%; height:100%; background:\${cardSummary.usagePctGeral>=90?'var(--red)':cardSummary.usagePctGeral>=70?'var(--orange)':'var(--green)'}; border-radius:4px;"></div>
      </div>
    </div>
  </div>
  \` : ''}

  <div class="grid3">
    <div class="panel">
      <div class="panel-head"><h3>Resumo Financeiro</h3><span class="tag">\${periodLabel()}</span></div>
      <div class="donut-wrap">
        <div class="donut-side">Receitas<b style="color:var(--green)">\${fmt(receitas)}</b></div>
        <div class="donut-canvas"><canvas id="chartResumo"></canvas>
          <div class="donut-center"><span>Saldo</span><b>\${fmt(saldo)}</b></div>
        </div>
        <div class="donut-side r">Despesas<b style="color:var(--red)">\${fmt(despesas)}</b></div>
      </div>
      <div class="bar-split"><div class="g" style="width:\${recPct}%"></div></div>
      <div class="split-labels"><span>🟢 \${recPct}% Receitas</span><span>Despesas \${despPct}%</span></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Despesas por Categoria</h3><span class="tag">\${periodLabel()}</span></div>
      <div class="cat-wrap">
        <div class="donut-canvas" style="width:130px;height:130px;"><canvas id="chartCategorias"></canvas></div>
        <div class="cat-legend">
          \${cats.length? cats.map(c=>\`<div class="cat-row"><span class="lbl"><span class="dot" style="background:\${c.color}"></span>\${c.name}</span><span><span class="amt">\${fmt(c.val)}</span><span class="pct">\${Math.round(c.val/totalDesp*100)}%</span></span></div>\`).join('') : \`<p style="color:var(--text-faint);font-size:12px">Sem despesas neste período.</p>\`}
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Contas e Cartões</h3><button class="tag" data-nav="cartoes">Editar</button></div>
      <div class="accounts-list">
        \${accounts.map(a=>{
          const stats = getCardStats(a);
          return \`
          <div class="acc-row" style="align-items:center;">
            <div class="acc-ic" style="background:\${a.color}">\${a.name.slice(0,2).toUpperCase()}</div>
            <div class="acc-info">
              <div class="n" style="font-weight:600;">\${a.name}</div>
              <div class="t" style="font-size:11px; color:var(--text-faint);">\${a.type}</div>
            </div>
            <div style="text-align:right;">
              \${stats.isCreditCard ? \`
                <div class="acc-val" style="color:\${stats.availableLimit < 200 ? 'var(--red)' : 'var(--green)'}; font-weight:700; font-size:12.5px;">Disp: \${fmt(stats.availableLimit)}</div>
                <div style="font-size:10px; color:var(--text-faint);">Fat: \${fmt(stats.spentTotal)}</div>
              \` : \`
                <div class="acc-val \${stats.currentBalance<0?'neg':''}" style="font-weight:700; font-size:12.5px; color:\${stats.currentBalance<0?'var(--red)':'var(--green)'};">\${fmt(stats.currentBalance)}</div>
                <div style="font-size:10px; color:var(--text-faint);">Saldo Atual</div>
              \`}
            </div>
            <button class="acc-edit" data-editacc="\${a.id}">✎</button>
          </div>\`;
        }).join('')}
      </div>
      <button class="btn-ghost" style="width:100%" data-nav="cartoes">Ver todas as contas</button>
    </div>
  </div>

  \${pendingSummary.items.length > 0 ? \`
  <!-- Mini Card Quadrado Compacto & Discreto (Posicionado com Organização Perfeita) -->
  <div class="panel due-bills-panel" style="margin-bottom:22px; padding:14px 18px; border:1px solid \${pendingSummary.overdueCount > 0 ? 'rgba(239,90,90,0.5)' : 'rgba(240,166,58,0.45)'}; background:\${pendingSummary.overdueCount > 0 ? 'rgba(239,90,90,0.08)' : 'rgba(240,166,58,0.06)'}; border-radius:16px; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
    
    <!-- Cabeçalho Discreto -->
    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid var(--card-border);">
      <div style="display:flex; align-items:center; gap:6px;">
        <span style="font-size:15px;">\${pendingSummary.overdueCount > 0 ? '🚨' : '⚠️'}</span>
        <h4 style="margin:0; font-size:12.5px; font-weight:800; letter-spacing:0.02em; color:\${pendingSummary.overdueCount > 0 ? 'var(--red)' : 'var(--orange)'}; text-transform:uppercase;">
          CONTAS A VENCER (\${pendingSummary.items.length})
        </h4>
      </div>
      <span style="font-size:11px; font-weight:700; color:var(--text-dim);">
        Total: <strong style="color:var(--red);">\${fmt(pendingSummary.totalValue)}</strong>
      </span>
    </div>

    <!-- Lista Enxuta Sem Cortes -->
    <div class="due-bills-list" style="display:flex; flex-direction:column; gap:6px;">
      \${pendingSummary.items.map(item => \`
        <div class="due-bill-row" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px 12px; padding:8px 12px; border-radius:8px; background:var(--card); border:1px solid \${item.statusType === 'overdue' ? 'rgba(239,90,90,0.4)' : item.statusType === 'today' ? 'rgba(240,166,58,0.4)' : 'var(--card-border)'}; font-size:12px;">
          
          <div style="display:flex; align-items:center; gap:8px; flex:1; min-width:180px;">
            <!-- Sinal de Emergência -->
            <span style="font-size:13px; flex-shrink:0;" title="\${item.statusText}">
              \${item.statusType === 'overdue' ? '🚨' : item.statusType === 'today' ? '⚡' : '⚠️'}
            </span>

            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px 8px;">
              <span style="font-weight:700; color:var(--text);">\${item.desc}</span>
              <!-- Vencimento na Frente -->
              <span style="font-size:11px; font-weight:700; color:\${item.statusType === 'overdue' ? 'var(--red)' : 'var(--orange)'}; background:\${item.statusType === 'overdue' ? 'var(--red-soft)' : 'rgba(240,166,58,0.15)'}; padding:1px 6px; border-radius:4px;">
                Vence: \${item.formattedDate}
              </span>
            </div>
          </div>

          <!-- Valor & Botão Pagar -->
          <div style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
            <span style="font-size:13px; font-weight:800; color:var(--red);">\${fmt(item.val)}</span>
            <button class="btn-primary" data-paytx="\${item.id}" title="Marcar como Pago" style="padding:3px 8px; font-size:10.5px; font-weight:700; background:linear-gradient(135deg, var(--green), #c9862a); border:none; border-radius:6px; cursor:pointer; color:#08130c; white-space:nowrap;">
              ✅ Pagar
            </button>
          </div>
        </div>
      \`).join('')}
    </div>

  </div>
  \` : ''}

  <div class="table-panel">
    <div class="panel-head"><h3>Últimas Transações</h3><span class="tag" data-nav="transacoes">Ver todas</span></div>
    \${transactionsTable(lastTx, false)}
  </div>
  \`;
}

function transactionsTable(list, showActions){
  if (typeof isDataLoading !== 'undefined' && isDataLoading && list.length === 0) {
    return \`<div class="placeholder" style="padding:40px 20px;"><div class="big" style="font-size:30px;margin-bottom:12px;">⏳</div><h3>Carregando suas transações...</h3><p>Sincronizando seus dados financeiros com o servidor.</p></div>\`;
  }
  if(list.length===0) return \`<div class="placeholder"><div class="big">🗂️</div><h3>Nenhuma transação encontrada</h3><p>Nenhuma transação registrada no período selecionado.</p></div>\`;

  const totalDespesas = list.filter(t=>t.type==='out').reduce((s,t)=>s+t.val, 0);
  const totalReceitas = list.filter(t=>t.type==='in').reduce((s,t)=>s+t.val, 0);
  const saldoPeriodo = totalReceitas - totalDespesas;
  const countDespesas = list.filter(t=>t.type==='out').length;
  const countReceitas = list.filter(t=>t.type==='in').length;

  return \`
  <table>
    <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Conta / Cartão</th><th>Tipo</th><th>Valor</th><th>Status</th>\${showActions?'<th></th>':''}</tr></thead>
    <tbody>
      \${list.map(t=>\`
        <tr class="trow">
          <td>\${formatDateBR(t.date)}</td>
          <td>\${t.desc}</td>
          <td><span class="pill" style="background:\${catColor(t.cat)}22; color:\${catColor(t.cat)}">\${catIcon(t.cat)} \${t.cat}</span></td>
          <td><span class="pill" style="background:rgba(255,255,255,0.05); color:var(--text-dim); font-weight:600;">\${t.acc || '—'}</span></td>
          <td><span class="type-ic \${t.type}">\${t.type==='in'?'↑':'↓'}</span></td>
          <td class="\${t.type==='in'?'val-in':'val-out'}">\${t.type==='in'?'+':'-'}\${fmt(t.val)}</td>
          <td><span class="pill status-\${t.status.toLowerCase()}">\${t.status}</span></td>
          \${showActions?\`<td><div class="row-actions"><button data-edit="\${t.id}">✎</button><button data-del="\${t.id}">🗑</button></div></td>\`:''}
        </tr>\`).join('')}
    </tbody>
    <tfoot>
      <tr style="background:var(--hover); font-weight:700; border-top:2px solid var(--card-border);">
        <td colspan="5" style="text-align:right; font-size:12.5px; color:var(--text-dim); letter-spacing:0.02em;">TOTAL DE GASTOS (\${countDespesas} despesa\${countDespesas===1?'':'s'}):</td>
        <td style="color:var(--red); font-size:14.5px; font-weight:800;">-\${fmt(totalDespesas)}</td>
        <td colspan="\${showActions?2:1}"></td>
      </tr>
    </tfoot>
  </table>

  <!-- Aba / Card com Cálculo Consolidado dos Gastos ao final -->
  <div class="tx-footer-summary" style="margin-top:20px; padding:18px 20px; border:1px solid rgba(232,176,75,0.25); border-radius:14px; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:16px;">
    <div style="display:flex; align-items:center; gap:12px; min-width:200px;">
      <div style="width:44px; height:44px; border-radius:12px; background:var(--red-soft); color:var(--red); display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:800; flex-shrink:0; box-shadow:0 2px 8px rgba(239,90,90,0.2);">↓</div>
      <div>
        <div style="font-size:11px; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.06em; font-weight:700;">Cálculo Total de Gastos</div>
        <div style="font-size:20px; font-weight:800; color:var(--red); margin-top:2px;">-\${fmt(totalDespesas)}</div>
        <div style="font-size:11px; color:var(--text-dim); margin-top:1px;">\${countDespesas} lançamento(s) de despesa</div>
      </div>
    </div>

    <div style="display:flex; align-items:center; gap:12px; min-width:200px;">
      <div style="width:44px; height:44px; border-radius:12px; background:var(--green-soft); color:var(--green); display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:800; flex-shrink:0; box-shadow:0 2px 8px rgba(232,176,75,0.2);">↑</div>
      <div>
        <div style="font-size:11px; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.06em; font-weight:700;">Total de Entradas (Receitas)</div>
        <div style="font-size:20px; font-weight:800; color:var(--green); margin-top:2px;">+\${fmt(totalReceitas)}</div>
        <div style="font-size:11px; color:var(--text-dim); margin-top:1px;">\${countReceitas} lançamento(s) de receita</div>
      </div>
    </div>

    <div style="display:flex; align-items:center; gap:12px; min-width:200px;">
      <div style="width:44px; height:44px; border-radius:12px; background:\${saldoPeriodo<0?'var(--red-soft)':'rgba(74,144,226,.14)'}; color:\${saldoPeriodo<0?'var(--red)':'var(--blue)'}; display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:800; flex-shrink:0;">⇄</div>
      <div>
        <div style="font-size:11px; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.06em; font-weight:700;">Balanço do Período</div>
        <div style="font-size:20px; font-weight:800; color:\${saldoPeriodo<0?'var(--red)':'var(--green)'}; margin-top:2px;">\${fmt(saldoPeriodo)}</div>
        <div style="font-size:11px; color:var(--text-dim); margin-top:1px;">\${list.length} registro(s) no filtro</div>
      </div>
    </div>
  </div>\`;
}

function pageTransacoes(){
  const periodTx = transactions.filter(inPeriod);
  const accOptsHTML = accounts.map(a => '<option value="' + a.name + '">' + a.name + ' (' + a.type + ')</option>').join('');
  return \`
  <div class="page-head">
    <div><h1>Transações — \${periodLabel()}</h1><p>Gerencie suas receitas e despesas do mês selecionado</p></div>
    <div class="head-actions">
      \${periodPickerHTML()}
      <button class="btn-ghost" id="btnGerenciarCategorias">🏷️ Categorias</button>
      <button class="btn-primary" id="btnNovaTransacao">+ Nova Transação</button>
    </div>
  </div>
  <div class="table-panel">
    <div class="filters">
      <input id="txSearch" placeholder="Buscar por descrição...">
      <select id="txFiltroConta"><option value="">Todas as Contas / Cartões</option>\${accOptsHTML}</select>
      <select id="txFiltroTipo"><option value="">Todos os tipos</option><option value="in">Receitas</option><option value="out">Despesas</option></select>
      <select id="txFiltroCat"><option value="">Todas categorias</option>\${catOptionsHTML(null)}</select>
      <select id="txFiltroStatus"><option value="">Todos status</option><option>Pago</option><option>Recebido</option><option>Pendente</option></select>
    </div>
    <div id="txTableWrap">\${transactionsTable(periodTx.slice().sort((a,b)=>b.date.localeCompare(a.date)), true)}</div>
  </div>\`;
}

function pageContas(){
  const list = accounts;
  const summary = computeCardSummary();
  
  return \`
  <div class="page-head">
    <div>
      <h1>Cartões e Contas</h1>
      <p>Acompanhe o limite disponível dos seus cartões de crédito e o saldo das suas contas</p>
    </div>
    <div class="head-actions">
      \${periodPickerHTML()}
      <button class="btn-primary" id="btnNovaConta">+ Novo Cartão/Conta</button>
    </div>
  </div>

  \${summary.creditCards.length > 0 ? \`
  <!-- Resumo Consolidado de Limite de Cartões -->
  <div class="panel cards-summary-panel" style="margin-bottom:20px; border:1px solid rgba(232,176,75,0.25);">
    <div class="panel-head" style="margin-bottom:14px;">
      <h3 style="display:flex;align-items:center;gap:8px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
        Visão Geral dos Cartões de Crédito
      </h3>
      <span class="tag" style="cursor:default; background:var(--green-soft); color:var(--green);">\${summary.creditCards.length} cartão(ões)</span>
    </div>
    <div class="kpi-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:14px;">
      <div class="kpi" style="background:rgba(255,255,255,0.03); padding:14px; border-radius:12px; border:1px solid var(--card-border);">
        <div class="row1" style="color:var(--text-dim); font-size:12px;">Limite Disponível Total</div>
        <div class="val" style="font-size:22px; font-weight:800; color:var(--green); margin-top:4px;">\${fmt(summary.availableLimitGeral)}</div>
        <div class="sub" style="font-size:11px; color:var(--text-faint); margin-top:2px;">Disponível para compras</div>
      </div>
      <div class="kpi" style="background:rgba(255,255,255,0.03); padding:14px; border-radius:12px; border:1px solid var(--card-border);">
        <div class="row1" style="color:var(--text-dim); font-size:12px;">Fatura do Mês (\${periodLabel()})</div>
        <div class="val" style="font-size:22px; font-weight:800; color:var(--orange); margin-top:4px;">\${fmt(summary.spentPeriodGeral)}</div>
        <div class="sub" style="font-size:11px; color:var(--text-faint); margin-top:2px;">Gastos no mês selecionado</div>
      </div>
      <div class="kpi" style="background:rgba(255,255,255,0.03); padding:14px; border-radius:12px; border:1px solid var(--card-border);">
        <div class="row1" style="color:var(--text-dim); font-size:12px;">Fatura Acumulada em Aberto</div>
        <div class="val" style="font-size:22px; font-weight:800; color:var(--red); margin-top:4px;">\${fmt(summary.spentTotalGeral)}</div>
        <div class="sub" style="font-size:11px; color:var(--text-faint); margin-top:2px;">Compras minus pagamentos</div>
      </div>
      <div class="kpi" style="background:rgba(255,255,255,0.03); padding:14px; border-radius:12px; border:1px solid var(--card-border);">
        <div class="row1" style="color:var(--text-dim); font-size:12px;">Limite Total Aprovado</div>
        <div class="val" style="font-size:22px; font-weight:800; color:var(--blue); margin-top:4px;">\${fmt(summary.totalLimitGeral)}</div>
        <div class="sub" style="font-size:11px; color:var(--text-faint); margin-top:2px;">Soma de todos os cartões</div>
      </div>
    </div>
    <div style="margin-top:14px;">
      <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-dim); margin-bottom:6px;">
        <span>Uso global do limite de crédito</span>
        <span style="font-weight:700; color:\${summary.usagePctGeral>=90?'var(--red)':summary.usagePctGeral>=70?'var(--orange)':'var(--green)'};">\${summary.usagePctGeral}% comprometido</span>
      </div>
      <div class="bar-split" style="height:8px; background:var(--card-border); border-radius:6px; overflow:hidden;">
        <div class="g" style="width:\${summary.usagePctGeral}%; height:100%; background:\${summary.usagePctGeral>=90?'var(--red)':summary.usagePctGeral>=70?'var(--orange)':'var(--green)'}; border-radius:6px; transition:width .3s ease;"></div>
      </div>
    </div>
  </div>
  \` : ''}

  <div class="grid3" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(310px, 1fr)); gap:16px; align-items:stretch;">
    \${list.length ? list.map(a => {
      const stats = getCardStats(a);
      return \`
      <div class="acc-card" style="position:relative; background:var(--card); border:1px solid var(--card-border); border-radius:14px; padding:18px; display:flex; flex-direction:column; justify-content:space-between; min-height:260px; box-sizing:border-box;">
        <div>
          <div class="top" style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px;">
            <div class="id-group" style="display:flex; align-items:center; gap:10px; min-width:0;">
              <span class="acc-ic" style="background:\${a.color}; width:40px; height:40px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-weight:800; color:#fff; font-size:14px; flex-shrink:0;">\${a.name.slice(0,2).toUpperCase()}</span>
              <div style="min-width:0;">
                <h3 style="font-size:15px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:2px; color:var(--text);">\${a.name}</h3>
                <span class="pill" style="font-size:10.5px; padding:2px 8px; border-radius:6px; background:\${stats.isCreditCard ? 'rgba(155,107,216,0.15)' : 'var(--green-soft)'}; color:\${stats.isCreditCard ? 'var(--purple)' : 'var(--green)'}; font-weight:600;">\${a.type}</span>
              </div>
            </div>
            <div class="row-actions" style="display:flex; gap:6px;"><button data-editacc="\${a.id}" title="Editar">✎</button><button data-delacc="\${a.id}" title="Excluir">🗑</button></div>
          </div>

          \${stats.isCreditCard ? \`
            <div style="background:rgba(255,255,255,0.02); border:1px solid var(--card-border); border-radius:10px; padding:12px; margin-top:4px;">
              <div style="font-size:11.5px; color:var(--text-faint); margin-bottom:2px;">Limite Disponível</div>
              <div class="val" style="font-size:22px; font-weight:800; color:\${stats.availableLimit < 200 ? 'var(--red)' : 'var(--green)'}">
                \${fmt(stats.availableLimit)}
              </div>
              <div style="display:flex; justify-content:space-between; font-size:11.5px; color:var(--text-dim); margin-top:8px; padding-top:8px; border-top:1px dashed var(--card-border);">
                <span>Fatura: <strong style="color:var(--orange);">\${fmt(stats.spentTotal)}</strong></span>
                <span>Limite Total: <strong style="color:var(--text);">\${fmt(stats.totalLimit)}</strong></span>
              </div>
              <div style="margin-top:8px;">
                <div class="bar-split" style="height:6px; background:var(--card-border); border-radius:4px; overflow:hidden;">
                  <div class="g" style="width:\${stats.usagePct}%; height:100%; background:\${stats.usagePct >= 90 ? 'var(--red)' : stats.usagePct >= 70 ? 'var(--orange)' : 'var(--green)'}; border-radius:4px;"></div>
                </div>
                <div style="text-align:right; font-size:10.5px; color:var(--text-faint); margin-top:4px;">\${stats.usagePct}% utilizado</div>
              </div>
            </div>
          \` : \`
            <div style="background:rgba(255,255,255,0.02); border:1px solid var(--card-border); border-radius:10px; padding:12px; margin-top:4px;">
              <div style="font-size:11.5px; color:var(--text-faint); margin-bottom:2px;">Saldo Atual da Conta</div>
              <div class="val" style="font-size:22px; font-weight:800; color:\${stats.currentBalance < 0 ? 'var(--red)' : 'var(--green)'}">
                \${fmt(stats.currentBalance)}
              </div>
              <div style="display:flex; justify-content:space-between; font-size:11.5px; color:var(--text-dim); margin-top:8px; padding-top:8px; border-top:1px dashed var(--card-border);">
                <span>Entradas: <strong style="color:var(--green);">\${fmt(stats.periodIn)}</strong></span>
                <span>Saídas: <strong style="color:var(--red);">\${fmt(stats.spentTotal)}</strong></span>
              </div>
              <div style="margin-top:8px; min-height:22px; display:flex; align-items:center; justify-content:flex-end;">
                <span style="font-size:10.5px; color:var(--text-faint);">Saldo inicial: \${fmt(stats.initialBalance)}</span>
              </div>
            </div>
          \`}
        </div>
        <button class="btn-ghost" data-viewcardtx="\${a.name}" style="padding:6px 12px; font-size:11.5px; margin-top:12px; width:100%; border-radius:8px; border:1px solid var(--card-border); background:rgba(255,255,255,0.03); color:var(--text-dim); display:flex; align-items:center; justify-content:center; gap:6px; cursor:pointer;">
          🔍 Ver lançamentos desta conta (\${stats.txCount})
        </button>
      </div>\`;
    }).join('') : \`<div class="placeholder"><div class="big">🏦</div><h3>Nenhuma conta cadastrada</h3></div>\`}
  </div>\`;
}

function pageOrcamentos(){
  const list = budgetStatus();
  return \`
  <div class="page-head">
    <div><h1>Orçamentos</h1><p>Limites de gastos por categoria — \${periodLabel()}</p></div>
    <div class="head-actions">\${periodPickerHTML()}<button class="btn-primary" id="btnNovoOrcamento">+ Novo Orçamento</button></div>
  </div>
  <div class="cat-cards">
    \${list.length? list.map(b=>{
      const color = b.pct>=100?'var(--red)': b.pct>=80?'var(--orange)':'var(--green)';
      return \`<div class="cat-card">
        <div class="top">
          <div class="id-group"><span class="dot" style="background:\${catColor(b.category)}"></span><h4>\${b.category}</h4></div>
          <div class="row-actions"><button data-editorc="\${b.id}" title="Editar">✎</button><button data-delorc="\${b.id}" title="Excluir">🗑</button></div>
        </div>
        <span style="color:\${color};font-size:11.5px;font-weight:600">\${b.pct}% usado</span>
        <div class="amt" style="margin-top:6px">\${fmt(b.spent)} <span style="color:var(--text-faint);font-size:12px;font-weight:400"> / \${fmt(b.limit)}</span></div>
        <div class="bar-split" style="background:var(--card-border)"><div class="g" style="width:\${Math.min(b.pct,100)}%; background:\${color}"></div></div>
      </div>\`;
    }).join('') : \`<div class="placeholder"><div class="big">◔</div><h3>Nenhum orçamento definido</h3><p>Crie limites de gastos por categoria para acompanhar seu mês.</p></div>\`}
  </div>\`;
}

function pageMetas(){
  return \`
  <div class="page-head">
    <div><h1>Metas</h1><p>Acompanhe seus objetivos financeiros</p></div>
    <div class="head-actions"><button class="btn-primary" id="btnNovaMeta">+ Nova Meta</button></div>
  </div>
  <div class="cat-cards">
    \${goals.length? goals.map(g=>{
      const pct = Math.min(100, Math.round(g.current/g.target*100));
      return \`<div class="acc-card">
        <div class="top">
          <h3 style="font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${g.name}</h3>
          <div class="row-actions"><button data-editmeta="\${g.id}" title="Editar">✎</button><button data-delmeta="\${g.id}" title="Excluir">🗑</button></div>
        </div>
        <p style="color:var(--text-faint);font-size:11.5px;margin-bottom:10px;">Prazo: \${formatDateBR(g.deadline)}</p>
        <div class="val" style="font-size:18px;">\${fmt(g.current)} <span style="color:var(--text-faint);font-size:12px;font-weight:400"> / \${fmt(g.target)}</span></div>
        <div class="bar-split" style="background:var(--card-border);margin-top:10px"><div class="g" style="width:\${pct}%"></div></div>
        <div class="split-labels" style="margin-top:6px"><span>\${pct}% concluído</span></div>
        <button class="btn-ghost" style="width:100%;margin-top:12px" data-addcontrib="\${g.id}">+ Adicionar valor</button>
      </div>\`;
    }).join('') : \`<div class="placeholder"><div class="big">◎</div><h3>Nenhuma meta cadastrada</h3></div>\`}
  </div>\`;
}

function pageRelatorios(){
  const list = transactions.filter(inPeriod);
  const allCats = despesasPorCategoria(list);
  const totalReceitas = list.filter(t=>t.type==='in').reduce((s,t)=>s+(parseFloat(t.val)||0),0);
  const totalDespesas = list.filter(t=>t.type==='out').reduce((s,t)=>s+(parseFloat(t.val)||0),0);
  const resultado = totalReceitas - totalDespesas;

  const totalReceitasGeral = transactions.filter(t=>t.type==='in').reduce((s,t)=>s+(parseFloat(t.val)||0),0);
  const totalDespesasGeral = transactions.filter(t=>t.type==='out').reduce((s,t)=>s+(parseFloat(t.val)||0),0);
  const resultadoGeral = totalReceitasGeral - totalDespesasGeral;

  const isAllDates = currentPeriod.month === 0;

  return \`
  <div class="page-head">
    <div>
      <h1>Relatórios Financeiros</h1>
      <p>Análise consolidada das suas transações — <strong>\${periodLabel()}</strong></p>
    </div>
    <div class="head-actions">
      \${periodPickerHTML()}
    </div>
  </div>

  <div class="kpis" style="grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:16px; margin-bottom:20px;">
    <div class="kpi">
      <div class="row1">Total de Receitas <span class="ic" style="background:var(--green-soft);color:var(--green)">↑</span></div>
      <div class="val" style="color:var(--green)">\${fmt(totalReceitas)}</div>
      <div class="sub">\${isAllDates ? 'Consolidado histórico geral' : periodLabel()}</div>
    </div>
    <div class="kpi">
      <div class="row1">Total de Despesas <span class="ic" style="background:var(--red-soft);color:var(--red)">↓</span></div>
      <div class="val" style="color:var(--red)">\${fmt(totalDespesas)}</div>
      <div class="sub">\${isAllDates ? 'Consolidado histórico geral' : periodLabel()}</div>
    </div>
    <div class="kpi">
      <div class="row1">Balanço do Período <span class="ic" style="background:rgba(74,144,226,.14);color:var(--blue)">⇄</span></div>
      <div class="val" style="color:\${resultado<0?'var(--red)':'var(--green)'}">\${fmt(resultado)}</div>
      <div class="sub">\${isAllDates ? 'Resultado acumulado geral' : 'Receitas menos Despesas do mês'}</div>
    </div>
  </div>

  \${!isAllDates ? \`
  <div class="panel" style="margin-bottom:20px; padding:14px 18px; background:rgba(255,255,255,0.02); border:1px solid var(--card-border); border-radius:12px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
    <div style="font-size:12.5px; color:var(--text-dim);">
      💡 <strong>Comparativo Geral Histórico (Todas as Datas):</strong> Receitas <strong>\${fmt(totalReceitasGeral)}</strong> | Despesas <strong>\${fmt(totalDespesasGeral)}</strong> | Saldo Acumulado <strong style="color:\${resultadoGeral<0?'var(--red)':'var(--green)'}">\${fmt(resultadoGeral)}</strong>
    </div>
    <button class="btn-ghost" onclick="currentPeriod={year:new Date().getFullYear(), month:0}; try{localStorage.setItem('fin_current_period', JSON.stringify(currentPeriod));}catch(e){} render();" style="font-size:11.5px; padding:4px 10px; border-radius:6px; cursor:pointer;">
      🌐 Ver Relatório Geral (Histórico Completo)
    </button>
  </div>
  \` : ''}

  <div class="table-panel">
    <div class="panel-head">
      <h3>Despesas por Categoria — \${periodLabel()}</h3>
      <span class="tag">\${list.filter(t=>t.type==='out').length} despesa(s) no período</span>
    </div>
    \${allCats.length ? \`
    <table>
      <thead>
        <tr>
          <th>Categoria</th>
          <th>Total Gasto</th>
          <th>% do Total de Despesas</th>
        </tr>
      </thead>
      <tbody>
        \${allCats.map(c=>\`
          <tr class="trow">
            <td><span class="pill" style="background:\${c.color}22;color:\${c.color}">\${catIcon(c.name)} \${c.name}</span></td>
            <td class="val-out">\${fmt(c.val)}</td>
            <td>
              <div style="display:flex; align-items:center; gap:10px;">
                <div class="bar-split" style="flex:1; max-width:120px; height:6px; background:var(--card-border); border-radius:4px; overflow:hidden;">
                  <div class="g" style="width:\${Math.round(c.val/(totalDespesas||1)*100)}%; height:100%; background:\${c.color}; border-radius:4px;"></div>
                </div>
                <span style="font-weight:700; font-size:12px; color:var(--text-dim);">\${Math.round(c.val/(totalDespesas||1)*100)}%</span>
              </div>
            </td>
          </tr>
        \`).join('')}
      </tbody>
      <tfoot>
        <tr style="background:var(--hover); font-weight:700; border-top:2px solid var(--card-border);">
          <td style="font-size:12.5px; color:var(--text-dim);">TOTAL DAS DESPESAS DO PERÍODO:</td>
          <td style="color:var(--red); font-size:14.5px; font-weight:800;">\${fmt(totalDespesas)}</td>
          <td>100%</td>
        </tr>
      </tfoot>
    </table>
    \` : \`
    <div class="placeholder"><div class="big">▥</div><h3>Nenhuma despesa no período</h3><p>Não foram encontradas despesas cadastradas para \${periodLabel()}.</p></div>
    \`}
  </div>\`;
}

function pageRecorrentes(){
  return \`
  <div class="page-head">
    <div><h1>Lançamentos Recorrentes</h1><p>Transações que se repetem automaticamente</p></div>
    <div class="head-actions"><button class="btn-primary" id="btnNovoRecorrente">+ Novo Recorrente</button></div>
  </div>
  <div class="table-panel">
    \${recurringList.length? \`<table><thead><tr><th>Descrição</th><th>Categoria</th><th>Conta</th><th>Frequência</th><th>Dia</th><th>Tipo</th><th>Valor</th><th></th></tr></thead>
    <tbody>\${recurringList.map(r=>\`<tr class="trow">
      <td>\${r.desc}</td>
      <td><span class="pill" style="background:\${catColor(r.cat)}22;color:\${catColor(r.cat)}">\${r.cat}</span></td>
      <td>\${r.acc}</td><td>\${r.freq}</td><td>Dia \${r.day}</td>
      <td><span class="type-ic \${r.type}">\${r.type==='in'?'↑':'↓'}</span></td>
      <td class="\${r.type==='in'?'val-in':'val-out'}">\${r.type==='in'?'+':'-'}\${fmt(r.val)}</td>
      <td><div class="row-actions"><button data-lancar="\${r.id}" title="Lançar agora">▶</button><button data-editrec="\${r.id}">✎</button><button data-delrec="\${r.id}">🗑</button></div></td>
    </tr>\`).join('')}</tbody></table>\` : \`<div class="placeholder"><div class="big">↻</div><h3>Nenhum lançamento recorrente</h3></div>\`}
  </div>\`;
}

function pageImportar(){
  return \`
  <div class="page-head"><div><h1>Importar OFX / CSV</h1><p>Importe extratos bancários em lote</p></div></div>
  <div class="panel">
    <p style="color:var(--text-dim);font-size:12.5px;margin-bottom:14px;">
      Formato CSV esperado: <code>data,descricao,valor</code>. Arquivos <b>.ofx</b> também são aceitos.
    </p>
    <div class="field-row">
      <div class="field"><label>Conta de destino</label><select id="impConta">\${accounts.map(a=>\`<option>\${a.name} — \${a.type}</option>\`).join('')}</select></div>
      <div class="field"><label>Categoria padrão</label><select id="impCategoria">\${categories.map(c=>\`<option>\${c.name}</option>\`).join('')}</select></div>
    </div>
    <div class="field"><label>Arquivo</label><input type="file" id="importFile" accept=".csv,.ofx,.txt"></div>
    <div id="importPreview"></div>
  </div>\`;
}

function pageAnexos(){
  const sortedTx = transactions.slice().sort((a,b)=>b.date.localeCompare(a.date));
  return \`
  <div class="page-head">
    <div>
      <h1>Anexos & Comprovantes</h1>
      <p>Cadastre novos comprovantes, vincule a transações e faça downloads dos arquivos</p>
    </div>
  </div>

  <div class="panel" style="margin-bottom:22px;">
    <div style="margin-bottom:14px;">
      <h3 style="font-size:15px; font-weight:700; display:flex; align-items:center; gap:8px; margin:0;">
        <span>📎</span> Cadastrar / Incluir Novos Anexos
      </h3>
      <p style="font-size:12px; color:var(--text-faint); margin-top:3px;">
        Selecione a transação vinculada e escolha um ou mais arquivos (imagens, recibos ou PDFs).
      </p>
    </div>

    <div class="field-row" style="align-items:flex-end; flex-wrap:wrap; gap:12px;">
      <div class="field" style="flex:1.5; min-width:240px; margin-bottom:0;">
        <label>Transação Vinculada</label>
        <select id="attTx" style="width:100%;">
          <option value="0">Nenhuma (Anexo Avulso / Recibo Padrão)</option>
          \${sortedTx.map(t=>\`<option value="\${t.id}">\${formatDateBR(t.date)} — \${t.desc} (\${fmt(t.val)})</option>\`).join('')}
        </select>
      </div>
      <div class="field" style="flex:1; min-width:200px; margin-bottom:0;">
        <label>Arquivo(s)</label>
        <input type="file" id="attFile" multiple accept="image/*,.pdf,.doc,.docx,.txt" style="width:100%;">
      </div>
      <div class="field" style="flex:0 0 auto; margin-bottom:0;">
        <button class="btn-primary" id="btnAddAnexo" style="padding:10px 20px; font-weight:700;">+ Incluir Anexo(s)</button>
      </div>
    </div>
  </div>

  <div style="margin-bottom:12px; display:flex; align-items:center; justify-content:space-between;">
    <h3 style="font-size:15px; font-weight:700;">Anexos Cadastrados (\${attachments.length})</h3>
  </div>

  <div class="cat-cards" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:16px;">
    \${attachments.length? attachments.map(a=>{
      const t = transactions.find(x=>x.id===a.txId);
      const isImage = (a.type && a.type.startsWith('image/')) || (a.dataUrl && a.dataUrl.startsWith('data:image/'));
      const isPdf = (a.type && a.type.includes('pdf')) || (a.dataUrl && a.dataUrl.startsWith('data:application/pdf')) || (a.name && a.name.toLowerCase().endsWith('.pdf'));

      return \`
      <div class="cat-card" style="display:flex; flex-direction:column; justify-content:space-between; padding:14px; border-radius:14px; border:1px solid var(--card-border); background:var(--card);">
        <div>
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
            <span class="pill" style="background:rgba(232,176,75,0.15); color:var(--green); font-weight:700; font-size:11px;">
              \${isPdf ? '📄 PDF' : isImage ? '🖼️ Imagem' : '📎 Documento'}
            </span>
            <div class="row-actions">
              <button data-delatt="\${a.id}" title="Excluir Anexo">🗑</button>
            </div>
          </div>

          <div style="cursor:pointer; text-align:center; margin-bottom:10px;" data-previewatt="\${a.id}" title="Clique para Visualizar">
            \${isImage && a.dataUrl ? \`
              <img src="\${a.dataUrl}" style="width:100%; height:110px; object-fit:cover; border-radius:10px; border:1px solid var(--card-border);">
            \` : \`
              <div style="width:100%; height:90px; background:var(--hover); border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:34px; color:var(--green);">
                \${isPdf ? '📄' : '📎'}
              </div>
            \`}
          </div>

          <h4 style="font-size:13px; font-weight:700; margin-bottom:4px; word-break:break-word; color:var(--text);">\${a.name}</h4>
          
          <!-- Dropdown para alterar/vincular transação ("para não vincular nada errado") -->
          <div style="margin-top:10px;">
            <label style="display:block; font-size:10.5px; color:var(--text-faint); margin-bottom:3px; font-weight:600;">Transação Vinculada:</label>
            <select data-relinkatt="\${a.id}" style="width:100%; font-size:11.5px; padding:5px 8px; border-radius:6px; background:var(--bg); border:1px solid var(--card-border); color:var(--text);">
              <option value="0" \${!a.txId ? 'selected' : ''}>Sem vincular (Anexo Avulso)</option>
              \${sortedTx.map(tx => \`<option value="\${tx.id}" \${tx.id === a.txId ? 'selected' : ''}>\${formatDateBR(tx.date)} — \${tx.desc}</option>\`).join('')}
            </select>
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:8px; margin-top:14px; padding-top:10px; border-top:1px solid var(--card-border);">
          \${a.dataUrl ? \`
            <a href="\${a.dataUrl}" download="\${a.name || 'comprovante'}" class="btn-primary" style="flex:1; padding:6px 10px; font-size:11.5px; font-weight:700; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; gap:4px;" title="Baixar Arquivo">
              📥 Baixar
            </a>
            <button data-previewatt="\${a.id}" class="btn-ghost" style="padding:6px 12px; font-size:11.5px; font-weight:600;" title="Visualizar">
              👁️ Ver
            </button>
          \` : \`
            <span style="font-size:11px; color:var(--text-faint);">Sem arquivo salvo</span>
          \`}
        </div>
      </div>
      \`;
    }).join('') : \`
      <div class="placeholder" style="grid-column:1/-1; padding:40px 20px;">
        <div class="big">📎</div>
        <h3>Nenhum anexo cadastrado</h3>
        <p>Utilize o formulário acima para enviar comprovantes ou recibos das suas transações.</p>
      </div>
    \`}
  </div>\`;
}

function pageAlertas(){
  const bstat = budgetStatus();
  return \`
  <div class="page-head">
    <div><h1>Alertas</h1><p>Avisos automáticos de orçamento — \${periodLabel()}</p></div>
    <div class="head-actions"><button class="btn-primary" id="btnNovoAlerta">+ Novo Alerta</button></div>
  </div>
  <div class="cat-cards">
    \${alerts.length? alerts.map(al=>{
      const b = bstat.find(x=>x.category===al.category);
      const pct = b? b.pct : null;
      const triggered = pct!==null && pct>=al.threshold;
      return \`<div class="cat-card">
        <div class="top">
          <div class="id-group"><span class="dot" style="background:\${triggered?'var(--red)':'var(--green)'}"></span><h4>\${al.category}</h4></div>
          <div class="row-actions"><button data-editalert="\${al.id}" title="Editar">✎</button><button data-delalert="\${al.id}" title="Excluir">🗑</button></div>
        </div>
        <span class="pill" style="background:\${triggered?'var(--red-soft)':'var(--green-soft)'};color:\${triggered?'var(--red)':'var(--green)'}">\${triggered?'⚠ Alerta ativo':'OK'}</span>
        <p style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">Aciona em \${al.threshold}% do orçamento</p>
        <div class="amt" style="font-size:14px;margin-top:4px;">\${b? \`\${pct}% usado (\${fmt(b.spent)} / \${fmt(b.limit)})\` : 'Sem orçamento definido para esta categoria'}</div>
      </div>\`;
    }).join('') : \`<div class="placeholder"><div class="big">🔔</div><h3>Nenhum alerta configurado</h3><p>Crie alertas para ser avisado quando o gasto de uma categoria se aproximar do limite.</p></div>\`}
  </div>\`;
}

function pageConfig(){
  return \`
  <div class="page-head"><div><h1>Configurações</h1><p>Preferências da conta e do sistema</p></div></div>
  \${isViewingOtherUser ? \`
  <div class="panel" style="margin-bottom:18px;">
    <p class="cfg-hint" style="margin:0;">Você está em modo de visualização (somente leitura) dos dados de <strong style="color:var(--green);">\${currentUser.name}</strong>. Edições de conta ficam disponíveis apenas na sua própria conta.</p>
  </div>\` : \`
  <div class="cfg-grid">
    <div class="panel">
      <div class="panel-head"><h3>Minha Conta</h3></div>
      <div class="field"><label>Nome</label><input id="cfgName" value="\${currentUser ? currentUser.name : ''}" placeholder="Seu nome completo" autocomplete="name"></div>
      <div class="field"><label>E-mail</label><input id="cfgEmail" type="text" value="\${currentUser ? currentUser.email : ''}" placeholder="seu.email@exemplo.com" autocomplete="email"></div>
      <div class="field" style="margin-bottom:0;"><label>Tema</label>
        <select id="cfgTheme"><option value="dark">Escuro 🌙</option><option value="light">Claro ☀️</option></select>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Alterar Senha</h3></div>
      <p class="cfg-hint">Preencha apenas se quiser alterar sua senha de acesso</p>
      <div class="field">
        <label>Nova Senha <span style="color:var(--text-faint); font-size:11px;">(opcional)</span></label>
        <div class="pass-field">
          <input id="cfgPassword" type="password" placeholder="••••••••" minlength="6" autocomplete="new-password">
          <button type="button" class="pass-toggle" id="cfgPasswordToggle" tabindex="-1" aria-label="Mostrar senha">\${EYE_ICON}</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Confirmar Nova Senha <span style="color:var(--text-faint); font-size:11px;">(opcional)</span></label>
        <div class="pass-field">
          <input id="cfgPasswordConfirm" type="password" placeholder="••••••••" minlength="6" autocomplete="new-password">
          <button type="button" class="pass-toggle" id="cfgPasswordConfirmToggle" tabindex="-1" aria-label="Mostrar senha">\${EYE_ICON}</button>
        </div>
      </div>
    </div>
  </div>
  <div class="cfg-save-bar"><button class="btn-primary" id="btnSalvarConfig">Salvar Alterações</button></div>\`}\`;
}

/* ==================== Aba 4K: Central de Funções & Permissões ==================== */
function pageFuncoes(){
  const isAdmin = currentUser && currentUser.role === 'Administrador';
  if(!isAdmin || isViewingOtherUser){
    return \`<div class="placeholder"><div class="big">🔒</div><h3>Acesso restrito</h3><p>Esta área de Gestão de Funções é exclusiva para administradores.</p></div>\`;
  }
  const userRole = (currentUser && currentUser.role) || 'Usuário';
  const totalUsers = registeredUsers ? registeredUsers.length : 1;
  const adminCount = registeredUsers ? registeredUsers.filter(u => u.role === 'Administrador').length : 1;
  const standardCount = totalUsers - adminCount;

  return \`
  <div class="page-head">
    <div>
      <h1 style="display:flex; align-items:center; gap:10px;">
        <span style="display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg, rgba(232,176,75,0.25), rgba(201,134,42,0.15)); border:1px solid rgba(232,176,75,0.4); color:#fbbf24; font-size:18px;">🛡️</span>
        Central de Funções & Permissões
      </h1>
      <p>Gerencie papéis de usuários, matriz de controle de acessos, privilégios e rotinas funcionais do sistema em 4K</p>
    </div>
    <div style="display:flex; gap:10px; align-items:center;">
      <span class="tag" style="background:rgba(232,176,75,0.15); color:#fbbf24; border:1px solid rgba(232,176,75,0.3); font-weight:700; padding:6px 12px; border-radius:20px; font-size:12px;">
        ⚡ Modo \${userRole}
      </span>
    </div>
  </div>

  <!-- Cards de Resumo Executivo das Funções 4K -->
  <div class="kpis" style="margin-bottom:20px;">
    <div class="kpi" style="border:1px solid rgba(232,176,75,0.25); background:linear-gradient(135deg, rgba(20,24,33,0.9), rgba(12,16,24,0.95)); shadow:0 10px 30px rgba(0,0,0,0.5);">
      <div class="kpi-head"><span class="lbl">Sua Função Atual</span><span class="ic" style="background:rgba(232,176,75,0.2); color:#fbbf24;">👑</span></div>
      <div class="val" style="color:#fbbf24; font-size:22px;">\${userRole}</div>
      <div class="sub" style="color:var(--text-dim); margin-top:4px;">Nível de Privilégio: \${isAdmin ? 'Acesso Total (Nível 1)' : 'Acesso Padrão (Nível 2)'}</div>
    </div>
    <div class="kpi" style="border:1px solid rgba(16,185,129,0.25); background:linear-gradient(135deg, rgba(20,24,33,0.9), rgba(12,16,24,0.95));">
      <div class="kpi-head"><span class="lbl">Usuários & Administradores</span><span class="ic" style="background:rgba(16,185,129,0.2); color:#10b981;">👥</span></div>
      <div class="val" style="color:#10b981; font-size:22px;">\${totalUsers} Cadastrado\${totalUsers===1?'':'s'}</div>
      <div class="sub" style="color:var(--text-dim); margin-top:4px;">\${adminCount} Admins · \${standardCount} Operadores</div>
    </div>
    <div class="kpi" style="border:1px solid rgba(59,130,246,0.25); background:linear-gradient(135deg, rgba(20,24,33,0.9), rgba(12,16,24,0.95));">
      <div class="kpi-head"><span class="lbl">Módulos & Capacidades</span><span class="ic" style="background:rgba(59,130,246,0.2); color:#3b82f6;">⚙️</span></div>
      <div class="val" style="color:#3b82f6; font-size:22px;">12 Módulos Ativos</div>
      <div class="sub" style="color:var(--text-dim); margin-top:4px;">Proteção Criptografada SSL / JWT</div>
    </div>
  </div>

  <!-- Matriz de Funções & Controle de Acessos 4K -->
  <div class="panel" style="margin-bottom:20px; border:1px solid rgba(232,176,75,0.25); background:var(--card);">
    <div class="panel-head">
      <h3>Matriz de Permissões por Função do Sistema</h3>
      <span class="tag" style="cursor:default; background:rgba(232,176,75,0.12); color:#fbbf24; border-color:rgba(232,176,75,0.3);">Visão 4K HD</span>
    </div>
    <p class="cfg-hint" style="margin-bottom:16px;">Tabela detalhada de acessos, privilégios de edição e permissões ativas para cada nível de usuário.</p>
    
    <div class="table-panel" style="padding:0; border:none; background:transparent;">
      <table style="width:100%; border-collapse:collapse; text-align:left;">
        <thead>
          <tr style="border-bottom:1px solid var(--card-border); background:rgba(0,0,0,0.25);">
            <th style="padding:14px 16px; color:var(--text-dim); font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">Módulo do Sistema</th>
            <th style="padding:14px 16px; color:#fbbf24; font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">👑 Administrador</th>
            <th style="padding:14px 16px; color:#34d399; font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">💼 Gerente Financeiro</th>
            <th style="padding:14px 16px; color:#60a5fa; font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">👤 Usuário / Operador</th>
            <th style="padding:14px 16px; color:#c084fc; font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">🔍 Auditor (Leitura)</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
            <td style="padding:14px 16px; font-weight:600; color:var(--text);"><span style="margin-right:8px;">📊</span> Dashboard Executivo</td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Total (Criar/Editar/Excluir)</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Total</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Total Próprio</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge read">👁️ Somente Leitura</span></td>
          </tr>
          <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
            <td style="padding:14px 16px; font-weight:600; color:var(--text);"><span style="margin-right:8px;">💳</span> Gestão de Transações & Cartões</td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Total (Qualquer Usuário)</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Total Próprio</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Total Próprio</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge read">👁️ Somente Leitura</span></td>
          </tr>
          <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
            <td style="padding:14px 16px; font-weight:600; color:var(--text);"><span style="margin-right:8px;">🎯</span> Orçamentos, Metas & Relatórios</td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Total + Exportação 4K</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Total + Exportação</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Total Próprio</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge read">👁️ Exportação CSV/PDF</span></td>
          </tr>
          <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
            <td style="padding:14px 16px; font-weight:600; color:var(--text);"><span style="margin-right:8px;">👥</span> Gerenciamento de Usuários & Contas</td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Controle Total + Modo Espelho 👁️</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge lock">🔒 Sem Acesso</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge lock">🔒 Sem Acesso</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge read">👁️ Lista de Contas</span></td>
          </tr>
          <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
            <td style="padding:14px 16px; font-weight:600; color:var(--text);"><span style="margin-right:8px;">📜</span> Logs de Auditoria & Segurança</td>
            <td style="padding:14px 16px;"><span class="funcoes-badge full">✅ Auditoria Geral + Filtro IP/Email</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge read">👁️ Logs Próprios</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge lock">🔒 Sem Acesso</span></td>
            <td style="padding:14px 16px;"><span class="funcoes-badge read">👁️ Leitura de Eventos</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Central de Rotinas & Automação Funcional 4K -->
  <div class="cfg-grid" style="margin-bottom:20px;">
    <div class="panel" style="border:1px solid rgba(232,176,75,0.2); background:var(--card);">
      <div class="panel-head"><h3>⚡ Status das Rotinas Funcionais</h3></div>
      <div style="display:flex; flex-direction:column; gap:12px; margin-top:8px;">
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:rgba(0,0,0,0.25); border-radius:10px; border:1px solid var(--card-border);">
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="width:10px; height:10px; border-radius:50%; background:#10b981; box-shadow:0 0 10px #10b981;"></span>
            <div><strong style="font-size:13.5px; color:var(--text);">Persistência PostgreSQL</strong><div style="font-size:11px; color:var(--text-faint);">Sincronização em tempo real</div></div>
          </div>
          <span style="font-size:11px; font-weight:700; color:#10b981; background:rgba(16,185,129,0.15); padding:3px 8px; border-radius:6px;">Online</span>
        </div>
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:rgba(0,0,0,0.25); border-radius:10px; border:1px solid var(--card-border);">
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="width:10px; height:10px; border-radius:50%; background:#3b82f6; box-shadow:0 0 10px #3b82f6;"></span>
            <div><strong style="font-size:13.5px; color:var(--text);">Engine de Cálculos 4K</strong><div style="font-size:11px; color:var(--text-faint);">Saldos, faturas & projeções</div></div>
          </div>
          <span style="font-size:11px; font-weight:700; color:#3b82f6; background:rgba(59,130,246,0.15); padding:3px 8px; border-radius:6px;">Ativo</span>
        </div>
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:rgba(0,0,0,0.25); border-radius:10px; border:1px solid var(--card-border);">
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="width:10px; height:10px; border-radius:50%; background:#f59e0b; box-shadow:0 0 10px #f59e0b;"></span>
            <div><strong style="font-size:13.5px; color:var(--text);">Auditoria beacon & API Logs</strong><div style="font-size:11px; color:var(--text-faint);">Rastreamento de ações do sistema</div></div>
          </div>
          <span style="font-size:11px; font-weight:700; color:#f59e0b; background:rgba(245,158,11,0.15); padding:3px 8px; border-radius:6px;">Gravando</span>
        </div>
      </div>
    </div>

    <div class="panel" style="border:1px solid rgba(232,176,75,0.2); background:var(--card);">
      <div class="panel-head"><h3>🛠️ Ferramentas & Teste de Função</h3></div>
      <p class="cfg-hint" style="margin-bottom:14px;">Utilize as ferramentas abaixo para validar o estado e o recálculo imediato de todas as funções ativas.</p>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <button class="btn-primary" onclick="if(typeof recalculateAllBalances==='function') recalculateAllBalances(); showLoginSuccessPopup('Saldos e funções reprocessados com sucesso!');" style="display:flex; align-items:center; justify-content:center; gap:8px;">
          <span>🔄</span> Recalcular Saldos & Projeções
        </button>
        <button class="btn-ghost" onclick="syncUsersWithServer().then(()=>showLoginSuccessPopup('Funções de usuários atualizadas!'));" style="display:flex; align-items:center; justify-content:center; gap:8px; border-color:rgba(232,176,75,0.3); color:#fbbf24;">
          <span>⚡</span> Sincronizar Tabela de Funções & Usuários
        </button>
      </div>
    </div>
  </div>
  \`;
}

/* ==================== Admin: Usuários Cadastrados ==================== */
function getUserActivitySummary(email){
  const data = loadFromStorage('nexus_data_' + email, null);
  if(!data) return { hasData:false, txCount:0, accCount:0, budCount:0, goalCount:0, lastDate:null };
  const txs = data.transactions || [];
  let lastDate = null;
  txs.forEach(t=>{ if(t.date && (!lastDate || t.date > lastDate)) lastDate = t.date; });
  return {
    hasData:true,
    txCount: txs.length,
    accCount: (data.accounts||[]).length,
    budCount: (data.budgets||[]).length,
    goalCount: (data.goals||[]).length,
    lastDate
  };
}

function pageUsuarios(){
  const isAdmin = currentUser && currentUser.role === 'Administrador';
  if(!isAdmin || isViewingOtherUser){
    return \`<div class="placeholder"><div class="big">🔒</div><h3>Acesso restrito</h3><p>Esta área é exclusiva para administradores.</p></div>\`;
  }
  return \`
  <div class="page-head"><div><h1>Usuários Cadastrados</h1><p>Administre as contas do sistema e acompanhe a atividade de cada usuário</p></div></div>
  <div class="panel" style="margin-bottom:0;">
    <div class="panel-head"><h3>Todos os usuários</h3><span class="tag" style="cursor:default;">\${registeredUsers.length} usuário\${registeredUsers.length===1?'':'s'}</span></div>
    <p class="cfg-hint" style="margin-bottom:14px;">Clique no ícone 👁 para entrar na conta de um usuário em modo de visualização e ver tudo que ele cadastrou (transações, cartões, orçamentos, metas, relatórios, anexos etc.).</p>
    <div class="user-admin-list">
      \${registeredUsers.map(u=>{
        const stats = getUserActivitySummary(u.email);
        return \`
        <div class="user-row \${u.active===false?'inactive':''}">
          <div class="user-ic">\${u.name.slice(0,2).toUpperCase()}</div>
          <div class="user-info">
            <div class="n">\${u.name}</div>
            <div class="e">\${u.email}</div>
            <div class="stats">\${stats.hasData ? \`\${stats.txCount} transaç\${stats.txCount===1?'ão':'ões'} · \${stats.accCount} conta\${stats.accCount===1?'':'s'} · \${stats.budCount} orçamento\${stats.budCount===1?'':'s'} · \${stats.goalCount} meta\${stats.goalCount===1?'':'s'}\${stats.lastDate ? \` · última mov. em \${formatDateBR(stats.lastDate)}\` : ''}\` : 'Ainda sem atividade registrada'}</div>
          </div>
          <span class="role-badge \${u.role==='Administrador'?'admin':'user'}">\${u.role}</span>
          \${u.active===false ? '<span class="role-badge inactive">Desativado</span>' : ''}
          \${u.email!==currentUser.email ? \`<button class="row-view" data-viewuser="\${u.email}" title="Visualizar tudo que este usuário fez">👁</button>\` : ''}
          \${u.email!==currentUser.email ? \`<button class="row-toggle" data-toggleuser="\${u.email}" title="\${u.active===false?'Ativar usuário':'Desativar usuário'}">\${u.active===false?'✅':'🚫'}</button>\` : ''}
          <button class="row-edit" data-edituser="\${u.email}" title="Editar usuário">✎</button>
        </div>\`;
      }).join('')}
    </div>
  </div>\`;
}

/* ==================== Logs de Auditoria do Sistema ==================== */
let systemLogs = [];

async function logActivity(action, entity, details) {
  if (!currentUser) return;
  const logEntry = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    user_name: currentUser.name || 'Usuário',
    user_email: currentUser.email || '',
    action: action,
    entity: entity,
    details: details
  };

  systemLogs.unshift(logEntry);
  try {
    saveToStorage('nexus_system_logs', systemLogs.slice(0, 500));
  } catch(e){}

  try {
    const payload = JSON.stringify({
      userName: currentUser.name,
      userEmail: currentUser.email,
      action: action,
      entity: entity,
      details: details
    });

    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(window.location.origin + '/api/logs', blob);
    } else {
      fetch(window.location.origin + '/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
      }).catch(() => {});
    }
  } catch(e) {}
}

async function loadSystemLogs() {
  try {
    const res = await fetch(window.location.origin + '/api/logs');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        systemLogs = data.filter(l => !l.details || !l.details.includes('salvou e sincronizou suas alterações'));
        saveToStorage('nexus_system_logs', systemLogs.slice(0, 500));
        return systemLogs;
      }
    }
  } catch(e) {}

  const cached = loadFromStorage('nexus_system_logs', null);
  if (Array.isArray(cached) && cached.length > 0) {
    systemLogs = cached.filter(l => !l.details || !l.details.includes('salvou e sincronizou suas alterações'));
  }
  return systemLogs;
}

function renderLogsTable(list) {
  if (!list || list.length === 0) {
    return '<div class="placeholder"><div class="big">📜</div><h3>Nenhum registro de log encontrado</h3><p>As ações e alterações dos usuários serão registradas aqui em tempo real.</p></div>';
  }

  let rowsHtml = list.map(function(l) {
    const dateStr = l.timestamp ? new Date(l.timestamp).toLocaleString('pt-BR') : '—';
    let actionBadgeClass = 'var(--purple)';
    let actionBg = 'rgba(155,107,216,0.15)';
    const actLower = (l.action || '').toLowerCase();
    if (actLower.includes('cria') || actLower.includes('novo') || actLower.includes('adiç')) {
      actionBadgeClass = 'var(--green)';
      actionBg = 'var(--green-soft)';
    } else if (actLower.includes('ediç') || actLower.includes('alter')) {
      actionBadgeClass = 'var(--orange)';
      actionBg = 'rgba(232,176,75,0.15)';
    } else if (actLower.includes('excl') || actLower.includes('remov') || actLower.includes('desativ')) {
      actionBadgeClass = 'var(--red)';
      actionBg = 'var(--red-soft)';
    } else if (actLower.includes('login') || actLower.includes('acesso')) {
      actionBadgeClass = 'var(--blue)';
      actionBg = 'rgba(74,144,226,0.15)';
    }

    let formattedDetails = (l.details || '');
    if (formattedDetails.includes('➔')) {
      const parts = formattedDetails.split(' | ');
      formattedDetails = parts.map(function(part) {
        if (part.includes('➔')) {
          const colonIdx = part.indexOf(': ');
          let fieldName = '';
          let valsStr = part;
          if (colonIdx !== -1) {
            fieldName = part.substring(0, colonIdx);
            valsStr = part.substring(colonIdx + 2);
          }
          const arrowIdx = valsStr.indexOf('➔');
          const oldV = arrowIdx !== -1 ? valsStr.substring(0, arrowIdx).trim() : '';
          const newV = arrowIdx !== -1 ? valsStr.substring(arrowIdx + 1).trim() : '';

          return '<span style="display:inline-flex; align-items:center; margin:2px 4px 2px 0; padding:4px 9px; background:rgba(255,255,255,0.04); border-radius:8px; border:1px solid rgba(255,255,255,0.08); font-size:12px;">'
            + (fieldName ? '<strong style="color:var(--text-dim); margin-right:5px;">' + fieldName + ':</strong> ' : '')
            + '<span style="color:#ef5a5a; text-decoration:line-through; margin-right:4px; opacity:0.85;">' + oldV + '</span>'
            + '<span style="color:#e8b04b; font-weight:bold; margin:0 5px;">➔</span>'
            + '<span style="color:#3ec7c7; font-weight:700;">' + newV + '</span>'
            + '</span>';
        }
        return '<span style="display:inline-block; margin:2px 0;">' + part + '</span>';
      }).join(' ');
    }

    return '<tr class="trow">'
      + '<td style="font-size:12px; color:var(--text-dim); white-space:nowrap;">' + dateStr + '</td>'
      + '<td><div style="display:flex; flex-direction:column;"><strong style="font-size:12.5px;">' + (l.user_name || 'Usuário') + '</strong><span style="font-size:11px; color:var(--text-faint);">' + (l.user_email || '—') + '</span></div></td>'
      + '<td><span class="pill" style="background:' + actionBg + '; color:' + actionBadgeClass + '; font-weight:700;">' + l.action + '</span></td>'
      + '<td><span class="pill" style="background:rgba(255,255,255,0.05); color:var(--text-dim); font-weight:600;">' + l.entity + '</span></td>'
      + '<td style="font-size:12.5px; line-height:1.5;">' + formattedDetails + '</td>'
      + '</tr>';
  }).join('');

  return '<table id="logsTable"><thead><tr><th style="width:160px;">Data e Hora</th><th style="width:200px;">Usuário (Login)</th><th style="width:130px;">Ação</th><th style="width:150px;">Módulo / Entidade</th><th>Informações Alteradas / Detalhes</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>';
}

function filterLogsTable() {
  const query = (document.getElementById('logSearch') ? document.getElementById('logSearch').value : '').toLowerCase().trim();
  const actSel = (document.getElementById('logFilterAction') ? document.getElementById('logFilterAction').value : '').toLowerCase().trim();
  const entSel = (document.getElementById('logFilterEntity') ? document.getElementById('logFilterEntity').value : '').toLowerCase().trim();

  const filtered = systemLogs.filter(l => {
    const textStr = ((l.user_name||'') + ' ' + (l.user_email||'') + ' ' + (l.action||'') + ' ' + (l.entity||'') + ' ' + (l.details||'')).toLowerCase();
    const matchSearch = !query || textStr.includes(query);
    const matchAct = !actSel || (l.action || '').toLowerCase().includes(actSel);
    const matchEnt = !entSel || (l.entity || '').toLowerCase().includes(entSel);
    return matchSearch && matchAct && matchEnt;
  });

  const wrap = document.getElementById('logTableWrap');
  if (wrap) wrap.innerHTML = renderLogsTable(filtered);
}

function pageLogs(){
  const isAdmin = currentUser && currentUser.role === 'Administrador';
  if(!isAdmin || isViewingOtherUser){
    return \`<div class="placeholder"><div class="big">🔒</div><h3>Acesso restrito</h3><p>Esta área de logs é exclusiva para administradores.</p></div>\`;
  }

  const logs = systemLogs;
  const countTotal = logs.length;
  const countCriacao = logs.filter(l => (l.action||'').toLowerCase().includes('cria') || (l.action||'').toLowerCase().includes('novo')).length;
  const countEdicao = logs.filter(l => (l.action||'').toLowerCase().includes('ediç') || (l.action||'').toLowerCase().includes('altera')).length;
  const countExclusao = logs.filter(l => (l.action||'').toLowerCase().includes('excl') || (l.action||'').toLowerCase().includes('remov')).length;

  return \`
  <div class="page-head">
    <div>
      <h1>Logs do Sistema</h1>
      <p>Histórico completo de auditoria com dados de login e alterações de dados em tempo real</p>
    </div>
    <div class="head-actions">
      <button class="btn-ghost" onclick="loadSystemLogs().then(render)">🔄 Atualizar Logs</button>
    </div>
  </div>

  <div class="kpis" style="grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); margin-bottom:20px;">
    <div class="kpi">
      <div class="row1">Total de Registros <span class="ic" style="background:rgba(74,144,226,.14);color:var(--blue)">📋</span></div>
      <div class="val">\${countTotal}</div>
      <div class="sub">eventos de auditoria</div>
    </div>
    <div class="kpi">
      <div class="row1">Criações <span class="ic" style="background:var(--green-soft);color:var(--green)">➕</span></div>
      <div class="val" style="color:var(--green)">\${countCriacao}</div>
      <div class="sub">novos dados cadastrados</div>
    </div>
    <div class="kpi">
      <div class="row1">Edições <span class="ic" style="background:rgba(232,176,75,0.15);color:var(--orange)">✎</span></div>
      <div class="val" style="color:var(--orange)">\${countEdicao}</div>
      <div class="sub">registros alterados</div>
    </div>
    <div class="kpi">
      <div class="row1">Exclusões <span class="ic" style="background:var(--red-soft);color:var(--red)">🗑</span></div>
      <div class="val" style="color:var(--red)">\${countExclusao}</div>
      <div class="sub">registros removidos</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head" style="margin-bottom:14px;">
      <h3>Filtros de Log</h3>
    </div>
    <div class="filters" style="margin-bottom:16px;">
      <input id="logSearch" placeholder="Buscar por usuário, e-mail, ação ou detalhe..." onkeyup="filterLogsTable()">
      <select id="logFilterAction" onchange="filterLogsTable()">
        <option value="">Todas as ações</option>
        <option value="cria">Criação</option>
        <option value="ediç">Edição</option>
        <option value="excl">Exclusão</option>
        <option value="login">Login / Acesso</option>
      </select>
      <select id="logFilterEntity" onchange="filterLogsTable()">
        <option value="">Todas as entidades</option>
        <option value="transa">Transação</option>
        <option value="conta">Conta / Cartão</option>
        <option value="categor">Categoria</option>
        <option value="orçament">Orçamento</option>
        <option value="meta">Meta</option>
        <option value="usuár">Usuário</option>
      </select>
    </div>

    <div id="logTableWrap">
      \${renderLogsTable(logs)}
    </div>
  </div>
  \`;
}

/* ==================== Charts ==================== */
function drawDashboardCharts(){
  const periodTx = transactions.filter(inPeriod);
  const {receitas,despesas} = computeTotals(periodTx);
  Object.values(charts).forEach(c=>c && c.destroy && c.destroy());
  const ctx1 = document.getElementById('chartResumo');
  if(ctx1) charts.resumo = new Chart(ctx1, {
    type:'doughnut',
    data:{ datasets:[{data:[receitas||0.0001,despesas||0.0001], backgroundColor:['#e8b04b','#ef5a5a'], borderWidth:0}] },
    options:{cutout:'72%', plugins:{legend:{display:false}}}
  });
  const cats = despesasPorCategoria(periodTx);
  const ctx2 = document.getElementById('chartCategorias');
  if(ctx2) charts.categorias = new Chart(ctx2, {
    type:'doughnut',
    data:{ labels:cats.map(c=>c.name), datasets:[{data: cats.length?cats.map(c=>c.val):[1], backgroundColor: cats.length?cats.map(c=>c.color):['#2a2f3a'], borderWidth:0}] },
    options:{cutout:'62%', plugins:{legend:{display:false}}}
  });
}

function populateAccountOptions(selectedAcc) {
  const fConta = document.getElementById('fConta');
  if(!fConta) return;

  // 1. Mapeia todas as contas e cartões cadastrados pelo usuário
  let htmlOptions = accounts.map(a => {
    const stats = getCardStats(a);
    const label = stats.isCreditCard 
      ? (a.name + ' (Disp: ' + fmt(stats.availableLimit) + (currentType === 'in' ? ' — Pgto Fatura/Estorno' : '') + ')') 
      : (a.name + ' (Saldo: ' + fmt(stats.currentBalance) + ')');
    return '<option value="' + a.name + '"' + (selectedAcc === a.name ? ' selected' : '') + '>' + label + '</option>';
  }).join('');

  // 2. Opções adicionais de pagamento / recebimento padrão
  const extraOptions = [
    { value: 'Cartão de Crédito', label: '💳 Cartão de Crédito' },
    { value: 'Dinheiro em Espécie', label: '💵 Dinheiro em Espécie' },
    { value: 'Boleto / Pix / Outros', label: '📄 Boleto / Pix / Outros' }
  ];

  extraOptions.forEach(opt => {
    const existsInAccounts = accounts.some(a => {
      const aName = (a.name || '').toLowerCase().trim();
      const oVal = opt.value.toLowerCase().trim();
      return aName === oVal;
    });

    if (!existsInAccounts) {
      htmlOptions += '<option value="' + opt.value + '"' + (selectedAcc === opt.value ? ' selected' : '') + '>' + opt.label + '</option>';
    }
  });

  if(!htmlOptions) {
    fConta.innerHTML = '<option value="Cartão de Crédito">💳 Cartão de Crédito</option><option value="Dinheiro em Espécie">💵 Dinheiro em Espécie</option><option value="Boleto / Pix / Outros">📄 Boleto / Pix / Outros</option>';
    updateCardLimitHint();
    return;
  }

  fConta.innerHTML = htmlOptions;

  // Se a categoria selecionada for 'Cartão de Crédito' e selectedAcc não for especificado, seleciona o primeiro cartão de crédito
  const fCat = document.getElementById('fCategoria');
  if(fCat && (fCat.value || '').toLowerCase().includes('cartão') && !selectedAcc) {
    const firstCard = accounts.find(a => isAccountCreditCard(a));
    if(firstCard) {
      fConta.value = firstCard.name;
    } else {
      fConta.value = 'Cartão de Crédito';
    }
  }

  updateCardLimitHint();
}

function updateCardLimitHint() {
  const fConta = document.getElementById('fConta');
  const hintEl = document.getElementById('cardLimitHint');
  if(!fConta || !hintEl) return;

  const accName = fConta.value;
  const acc = accounts.find(a => a.name === accName);

  if(!acc) {
    if ((accName || '').toLowerCase().includes('cartão') || (accName || '').toLowerCase().includes('cartao')) {
      hintEl.style.display = 'flex';
      hintEl.style.background = 'rgba(232,176,75,0.15)';
      hintEl.style.color = 'var(--orange)';
      hintEl.innerHTML = '💳 <span><strong>Cartão de Crédito:</strong> Lançamento como despesa de cartão de crédito</span>';
    } else {
      hintEl.style.display = 'none';
    }
    return;
  }

  const stats = getCardStats(acc);

  if(stats.isCreditCard) {
    if(currentType === 'in') {
      hintEl.style.display = 'flex';
      hintEl.style.background = 'var(--green-soft)';
      hintEl.style.color = 'var(--green)';
      hintEl.innerHTML = '💳 <span><strong>Pagamento de Fatura / Estorno:</strong> Limite disp. atual ' + fmt(stats.availableLimit) + ' (Fatura em aberto: ' + fmt(stats.spentTotal) + ')</span>';
    } else {
      hintEl.style.display = 'flex';
      hintEl.style.background = stats.availableLimit < 200 ? 'var(--red-soft)' : 'var(--green-soft)';
      hintEl.style.color = stats.availableLimit < 200 ? 'var(--red)' : 'var(--green)';
      hintEl.innerHTML = '💳 <span><strong>Limite disponível:</strong> ' + fmt(stats.availableLimit) + ' de ' + fmt(stats.totalLimit) + ' (Fatura em aberto: ' + fmt(stats.spentTotal) + ')</span>';
    }
  } else {
    hintEl.style.display = 'flex';
    hintEl.style.background = stats.currentBalance < 0 ? 'var(--red-soft)' : 'rgba(74,144,226,0.15)';
    hintEl.style.color = stats.currentBalance < 0 ? 'var(--red)' : 'var(--blue)';
    hintEl.innerHTML = '🏦 <span><strong>Saldo Atual da Conta:</strong> ' + fmt(stats.currentBalance) + '</span>';
  }
}

function updateAccBalanceLabel() {
  const typeEl = document.getElementById('accType');
  const lbl = document.getElementById('accBalanceLabel');
  const inp = document.getElementById('accBalance');
  if(!typeEl || !lbl || !inp) return;
  if(typeEl.value === 'Cartão de Crédito') {
    lbl.textContent = 'Limite Total do Cartão (R$)';
    inp.placeholder = 'Ex: 5000,00';
  } else {
    lbl.textContent = 'Saldo (R$)';
    inp.placeholder = '0,00';
  }
}

/* ==================== Modais e Ações de Dados ==================== */
function openModal(id){
  if(categories.length===0){ showToast('Cadastre uma categoria antes de lançar uma transação'); return; }
  editingId = id || null;
  document.getElementById('overlay').classList.add('show');
  let selectedAcc = accounts[0] ? accounts[0].name : '';
  if(id){
    const t = transactions.find(x=>x.id===id);
    document.getElementById('modalTitle').textContent = 'Editar Transação';
    document.getElementById('fDesc').value = t.desc;
    document.getElementById('fValor').value = t.val;
    document.getElementById('fData').value = t.date;
    setType(t.type);
    document.getElementById('fCategoria').value = t.cat;
    document.getElementById('fStatus').value = t.status;
    if(t.acc) selectedAcc = t.acc;
  } else {
    document.getElementById('modalTitle').textContent = 'Nova Transação';
    document.getElementById('fDesc').value = '';
    document.getElementById('fValor').value = '';
    
    const now = new Date();
    let defaultDate = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
    if (currentPeriod.year !== now.getFullYear() || currentPeriod.month !== (now.getMonth() + 1)) {
      const targetDay = Math.min(now.getDate(), new Date(currentPeriod.year, currentPeriod.month, 0).getDate());
      defaultDate = pd(targetDay);
    }
    document.getElementById('fData').value = defaultDate;
    document.getElementById('fStatus').value = 'Pago';
    setType('out');
  }
  populateAccountOptions(selectedAcc);
  const fContaEl = document.getElementById('fConta');
  if(fContaEl) fContaEl.onchange = updateCardLimitHint;
  const fCatEl = document.getElementById('fCategoria');
  if(fCatEl) {
    fCatEl.onchange = () => {
      const fc = document.getElementById('fConta');
      if((fCatEl.value || '').toLowerCase().includes('cartão') || (fCatEl.value || '').toLowerCase().includes('cartao')) {
        const firstCard = accounts.find(a => isAccountCreditCard(a));
        populateAccountOptions(firstCard ? firstCard.name : 'Cartão de Crédito');
      }
    };
  }
}
function closeModal(){ document.getElementById('overlay').classList.remove('show'); }
function parseInputValue(valStr) {
  if (typeof valStr === 'number') return isNaN(valStr) ? 0 : valStr;
  if (!valStr) return 0;
  let cleaned = String(valStr).replace(/[^0-9.,-]/g, '').trim();
  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.indexOf('.') < cleaned.indexOf(',')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(',', '.');
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function populateCategoriaOptions(type){
  const fCat = document.getElementById('fCategoria');
  if(!fCat) return;
  const wantType = type==='in' ? 'receita' : 'despesa';
  const hasOfType = categories.some(c => (c.type||'despesa') === wantType);
  const prev = fCat.value;
  fCat.innerHTML = hasOfType ? catOptionsHTML(wantType) : catOptionsHTML(null);
  const list = hasOfType ? categories.filter(c => (c.type||'despesa') === wantType) : categories;
  if(list.some(c=>c.name===prev)) fCat.value = prev;
}

function setType(t){
  currentType = t;
  const inBtn = document.getElementById('typeInBtn');
  const outBtn = document.getElementById('typeOutBtn');
  if(inBtn) inBtn.className = t==='in' ? 'sel-in' : '';
  if(outBtn) outBtn.className = t==='out' ? 'sel-out' : '';
  populateCategoriaOptions(t);
  const fStatusEl = document.getElementById('fStatus');
  if(fStatusEl && !editingId) {
    fStatusEl.value = t==='in' ? 'Recebido' : 'Pago';
  }
  const fContaEl = document.getElementById('fConta');
  if(fContaEl) {
    populateAccountOptions(fContaEl.value);
  }
}

async function saveTransaction(){
  const descEl = document.getElementById('fDesc');
  const valorEl = document.getElementById('fValor');
  const dateEl = document.getElementById('fData');
  const catEl = document.getElementById('fCategoria');
  const statusEl = document.getElementById('fStatus');
  const accEl = document.getElementById('fConta');

  const desc = descEl ? descEl.value.trim() : '';
  const val = parseInputValue(valorEl ? valorEl.value : '');
  const date = dateEl ? dateEl.value : '';
  const cat = catEl ? catEl.value : '';
  const status = statusEl ? statusEl.value : 'Pago';
  const accSel = accEl ? accEl.value : '';

  if(!desc) {
    showToast('⚠️ Por favor, informe a descrição da transação.');
    if(descEl) descEl.focus();
    return;
  }
  if(isNaN(val) || val <= 0) {
    showToast('⚠️ Por favor, informe um valor válido maior que zero (Ex: 100,50).');
    if(valorEl) valorEl.focus();
    return;
  }
  if(!date) {
    showToast('⚠️ Por favor, selecione a data da transação.');
    if(dateEl) dateEl.focus();
    return;
  }
  if(!cat) {
    showToast('⚠️ Por favor, selecione uma categoria.');
    if(catEl) catEl.focus();
    return;
  }

  const targetAcc = accounts.find(a => a.name === accSel);
  const accId = targetAcc ? targetAcc.id : null;

  if(editingId){
    const t = transactions.find(x=>x.id===editingId);
    const oldDesc = t.desc;
    const oldVal = t.val;
    const oldCat = t.cat;
    const oldAcc = t.acc;
    const oldDate = t.date;
    const oldStatus = t.status;
    const oldType = t.type;

    if(t.cat !== cat){
      const newCatObj = categories.find(c=>c.name===cat);
      if(newCatObj) newCatObj.count = (newCatObj.count||0)+1;
    }
    Object.assign(t, {desc, val, date, cat, status, type:currentType, acc:accSel, accId});
    showToast('Transação atualizada!');

    const changes = [];
    if (oldDesc !== desc) changes.push('Descrição: "' + oldDesc + '" ➔ "' + desc + '"');
    if (oldVal !== val) changes.push('Valor: ' + fmt(oldVal) + ' ➔ ' + fmt(val));
    if (oldCat !== cat) changes.push('Categoria: "' + oldCat + '" ➔ "' + cat + '"');
    if (oldAcc !== accSel) changes.push('Conta: "' + (oldAcc||'Sem conta') + '" ➔ "' + (accSel||'Sem conta') + '"');
    if (oldDate !== date) changes.push('Data: ' + oldDate + ' ➔ ' + date);
    if (oldStatus !== status) changes.push('Status: ' + oldStatus + ' ➔ ' + status);
    if (oldType !== currentType) changes.push('Tipo: ' + (oldType==='in'?'Receita':'Despesa') + ' ➔ ' + (currentType==='in'?'Receita':'Despesa'));

    const diffText = changes.length > 0 ? changes.join(' | ') : ('Editou transação "' + desc + '" (' + fmt(val) + ')');
    logActivity('Edição', 'Transação', diffText);
  } else {
    transactions.push({id: nextTxId++, desc, val, date, cat, status, type: currentType, acc:accSel, accId});
    const catObj = categories.find(c=>c.name===cat);
    if(catObj) catObj.count = (catObj.count||0)+1;
    showToast('Transação adicionada!');
    await pushNotification(\`Nova transação cadastrada: \${desc} — \${fmt(val)}\`, currentType==='in' ? '💰' : '💸');
  }
  await saveUserData();
  closeModal();
  if(currentPage!=='transacoes' || !refreshTxTable()) render();
}
async function deleteTransaction(id){
  if(!confirm('Excluir esta transação?')) return;
  transactions = transactions.filter(t=>t.id!==id);
  await saveUserData();
  showToast('Transação removida');
  if(currentPage!=='transacoes' || !refreshTxTable()) render();
}

/* ==================== Mapeamento Inteligente de Cores de Bancos e Cartões ==================== */
const BANK_COLOR_MAP = [
  { keywords: ['nubank', 'nu ', 'nu', 'roxinho'], color: '#820ad1', type: 'Cartão de Crédito' },
  { keywords: ['inter', 'banco inter'], color: '#ff7a00', type: 'Conta Corrente' },
  { keywords: ['itau', 'itaú', 'iti'], color: '#ec7000', type: 'Conta Corrente' },
  { keywords: ['bradesco', 'next'], color: '#cc092f', type: 'Conta Corrente' },
  { keywords: ['c6', 'c6bank', 'c6 bank'], color: '#242424', type: 'Conta Corrente' },
  { keywords: ['santander'], color: '#ea1d2c', type: 'Conta Corrente' },
  { keywords: ['caixa', 'caixa economica', 'cef'], color: '#005ca9', type: 'Conta Poupança' },
  { keywords: ['bb', 'banco do brasil'], color: '#fcf800', type: 'Conta Corrente' },
  { keywords: ['xp', 'xp investimentos'], color: '#111111', type: 'Investimento' },
  { keywords: ['btg', 'btg pactual'], color: '#001e62', type: 'Investimento' },
  { keywords: ['picpay', 'pic pay'], color: '#11c76f', type: 'Conta Corrente' },
  { keywords: ['neon'], color: '#00e5ff', type: 'Conta Corrente' },
  { keywords: ['pagbank', 'pagseguro', 'pag bank'], color: '#00b140', type: 'Conta Corrente' },
  { keywords: ['mercadopago', 'mercado pago'], color: '#009ee3', type: 'Conta Corrente' },
  { keywords: ['original', 'banco original'], color: '#00a859', type: 'Conta Corrente' },
  { keywords: ['nomad'], color: '#ffda00', type: 'Conta Corrente' },
  { keywords: ['wise'], color: '#2570eb', type: 'Conta Corrente' },
  { keywords: ['rico'], color: '#ff4500', type: 'Investimento' },
  { keywords: ['nuinvest', 'easynvest'], color: '#7b1fa2', type: 'Investimento' },
  { keywords: ['sicoob'], color: '#003641', type: 'Conta Corrente' },
  { keywords: ['sicredi'], color: '#315f26', type: 'Conta Corrente' },
  { keywords: ['banrisul'], color: '#005695', type: 'Conta Corrente' },
  { keywords: ['stone'], color: '#00a86b', type: 'Conta Corrente' },
  { keywords: ['pan', 'banco pan'], color: '#00a5f0', type: 'Cartão de Crédito' },
  { keywords: ['porto', 'porto seguro'], color: '#0070c0', type: 'Cartão de Crédito' },
  { keywords: ['credicard'], color: '#0a1f44', type: 'Cartão de Crédito' },
  { keywords: ['digio'], color: '#1b2d4f', type: 'Cartão de Crédito' },
  { keywords: ['will', 'will bank'], color: '#ffff00', type: 'Cartão de Crédito' }
];

function autoDetectBankColor(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  for (const b of BANK_COLOR_MAP) {
    if (b.keywords.some(k => lower.includes(k))) {
      return b;
    }
  }
  return null;
}

function openAccountModal(id){
  editingAccId = id || null;
  document.getElementById('overlayAccount').classList.add('show');
  if(id){
    const a = accounts.find(x=>x.id===id);
    document.getElementById('accModalTitle').textContent = 'Editar Conta';
    document.getElementById('accName').value = a.name;
    document.getElementById('accType').value = a.type;
    document.getElementById('accBalance').value = a.balance;
    document.getElementById('accColor').value = a.color;
  } else {
    document.getElementById('accModalTitle').textContent = 'Nova Conta';
    document.getElementById('accName').value = '';
    document.getElementById('accType').value = 'Conta Corrente';
    document.getElementById('accBalance').value = '';
    document.getElementById('accColor').value = '#e8b04b';
  }
  updateAccBalanceLabel();
  const accTypeEl = document.getElementById('accType');
  if(accTypeEl) accTypeEl.onchange = updateAccBalanceLabel;
}
function closeAccountModal(){ document.getElementById('overlayAccount').classList.remove('show'); }
async function saveAccount(){
  const name = document.getElementById('accName').value.trim();
  const type = document.getElementById('accType').value;
  const balance = parseFloat(document.getElementById('accBalance').value);
  const color = document.getElementById('accColor').value;
  if(!name || isNaN(balance)){ showToast('Preencha nome e saldo corretamente'); return; }
  if(editingAccId){
    const a = accounts.find(x=>x.id===editingAccId);
    const oldName = a.name;
    Object.assign(a, {name, type, balance, color});
    if(oldName!==name) transactions.forEach(t=>{ if(t.acc===oldName) t.acc = name; });
    showToast('Conta atualizada!');
    logActivity('Edição', 'Conta / Cartão', 'Editou conta/cartão "' + name + '" (' + type + ') com limite/saldo inicial ' + fmt(balance));
  } else {
    accounts.push({id: nextAccId++, name, type, balance, color});
    showToast('Conta adicionada!');
    await pushNotification('Nova conta/cartão cadastrado: ' + name + ' (' + type + ')', '🏦');
    logActivity('Criação', 'Conta / Cartão', 'Cadastrou nova conta/cartão "' + name + '" (' + type + ') com limite/saldo inicial ' + fmt(balance));
  }
  await saveUserData();
  closeAccountModal();
  render();
}
async function deleteAccount(id){
  if(!confirm('Excluir esta conta/cartão?')) return;
  accounts = accounts.filter(a=>a.id!==id);
  await saveUserData();
  showToast('Conta removida');
  render();
}

const ICON_SUGGESTIONS = ['🍔','🛒','🏠','💡','🚗','⚕️','📚','🎮','👕','📺','💳','📤','💆','📦','💼','💻','📈','📥','💵','🎉','💰','🐾','🎁','🏛️','✈️','☕','🍕','⛽','🧾','📱','🎵','🏋️','📁'];
function renderCatIconPicker(selected){
  const wrap = document.getElementById('catIconPicker');
  if(!wrap) return;
  wrap.innerHTML = ICON_SUGGESTIONS.map(ic=>'<button type="button" data-icon="'+ic+'" class="'+(ic===selected?'sel':'')+'">'+ic+'</button>').join('');
  wrap.querySelectorAll('button').forEach(btn=>{
    btn.onclick = ()=>{
      document.getElementById('catIconInput').value = btn.getAttribute('data-icon');
      wrap.querySelectorAll('button').forEach(b=>b.classList.remove('sel'));
      btn.classList.add('sel');
    };
  });
}
function openCategoryModal(name, defaultType){
  editingCatName = name || null;
  document.getElementById('overlayCategory').classList.add('show');
  if(name){
    const c = categories.find(x=>x.name===name);
    document.getElementById('catModalTitle').textContent = 'Editar Categoria';
    document.getElementById('catName').value = c.name;
    document.getElementById('catTipo').value = c.type || 'despesa';
    document.getElementById('catColor').value = c.color;
    document.getElementById('catIconInput').value = c.icon || '📁';
    renderCatIconPicker(c.icon || '📁');
  } else {
    document.getElementById('catModalTitle').textContent = 'Nova Categoria';
    document.getElementById('catName').value = '';
    document.getElementById('catTipo').value = defaultType==='in' ? 'receita' : 'despesa';
    document.getElementById('catColor').value = '#e8b04b';
    const defaultIcon = defaultType==='in' ? '💰' : '📁';
    document.getElementById('catIconInput').value = defaultIcon;
    renderCatIconPicker(defaultIcon);
  }
  setTimeout(() => {
    const input = document.getElementById('catName');
    if(input) input.focus();
  }, 50);
}
function closeCategoryModal(){ document.getElementById('overlayCategory').classList.remove('show'); }
async function saveCategory(){
  const name = document.getElementById('catName').value.trim();
  const type = document.getElementById('catTipo').value;
  const color = document.getElementById('catColor').value;
  const icon = document.getElementById('catIconInput').value.trim() || (type==='receita' ? '💰' : '📁');
  if(!name){ showToast('Informe um nome para a categoria'); return; }
  let isNew = false;
  if(editingCatName){
    const c = categories.find(x=>x.name===editingCatName);
    const oldName = c.name;
    if(oldName!==name && categories.some(x=>x.name===name)){ showToast('Já existe uma categoria com esse nome'); return; }
    c.name = name; c.color = color; c.type = type; c.icon = icon;
    if(oldName!==name){
      transactions.forEach(t=>{ if(t.cat===oldName) t.cat = name; });
      budgets.forEach(b=>{ if(b.category===oldName) b.category = name; });
      alerts.forEach(a=>{ if(a.category===oldName) a.category = name; });
      recurringList.forEach(r=>{ if(r.cat===oldName) r.cat = name; });
    }
    showToast('Categoria atualizada!');
    logActivity('Edição', 'Categoria', 'Editou categoria "' + name + '" (' + type + ')');
  } else {
    if(categories.some(x=>x.name===name)){ showToast('Já existe uma categoria com esse nome'); return; }
    categories.push({name, color, type, icon, count:0});
    showToast('Categoria adicionada!');
    logActivity('Criação', 'Categoria', 'Cadastrou nova categoria "' + name + '" (' + type + ')');
    isNew = true;
  }
  await saveUserData();
  closeCategoryModal();
  const txOverlay = document.getElementById('overlay');
  if(txOverlay && txOverlay.classList.contains('show')){
    populateCategoriaOptions(currentType);
    if(isNew) document.getElementById('fCategoria').value = name;
  }
  const catManageOverlay = document.getElementById('overlayCatManage');
  if(catManageOverlay && catManageOverlay.classList.contains('show')) renderCatManageList(catManageType);
  render();
}
async function deleteCategory(name){
  if(!confirm('Excluir esta categoria? Transações vinculadas serão movidas para a categoria padrão.')) return;
  const removed = categories.find(c=>c.name===name);
  const isReceita = removed && removed.type==='receita';
  const fallbackName = isReceita ? 'Outras Receitas' : 'Outros';
  categories = categories.filter(c=>c.name!==name);
  if(!categories.some(c=>c.name===fallbackName)){
    categories.push(isReceita ? {name:'Outras Receitas', color:'#3ec7c7', type:'receita', icon:'💰', count:0} : {name:'Outros', color:'#3ec7c7', type:'despesa', icon:'📦', count:0});
  }
  transactions.forEach(t=>{ if(t.cat===name) t.cat = fallbackName; });
  budgets = budgets.filter(b=>b.category!==name);
  alerts = alerts.filter(a=>a.category!==name);
  await saveUserData();
  showToast('Categoria removida');
  logActivity('Exclusão', 'Categoria', 'Excluiu categoria "' + name + '"');
  const catManageOverlay = document.getElementById('overlayCatManage');
  if(catManageOverlay && catManageOverlay.classList.contains('show')) renderCatManageList(catManageType);
  render();
}

function renderCatManageList(type){
  catManageType = type;
  document.querySelectorAll('.cat-manage-tabs .cat-tab').forEach(b=>b.classList.toggle('active', b.getAttribute('data-cattab')===type));
  const list = categories.filter(c=>(c.type||'despesa')===type).slice().sort((a,b)=>(b.count||0)-(a.count||0) || a.name.localeCompare(b.name,'pt-BR'));
  const wrap = document.getElementById('catManageList');
  if(!wrap) return;
  let html = list.map(c=>
    '<div class="cat-card"><div class="cat-manage-row">'
    + '<span class="cat-badge" style="background:'+c.color+'22;color:'+c.color+'">'+(c.icon||'📁')+'</span>'
    + '<div class="info"><div class="n">'+c.name+'</div><div class="u">'+(c.count||0)+' uso'+((c.count||0)===1?'':'s')+'</div></div>'
    + '<div class="row-actions"><button data-mgedit="'+c.name+'" title="Editar">✎</button><button data-mgdel="'+c.name+'" title="Excluir">🗑</button></div>'
    + '</div></div>'
  ).join('');
  html += '<button type="button" class="cat-card cat-card-add" id="catManageAddInline"><span class="plus">+</span>Nova categoria</button>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('[data-mgedit]').forEach(el=>el.onclick = ()=>openCategoryModal(el.getAttribute('data-mgedit')));
  wrap.querySelectorAll('[data-mgdel]').forEach(el=>el.onclick = ()=>deleteCategory(el.getAttribute('data-mgdel')));
  const addInline = document.getElementById('catManageAddInline');
  if(addInline) addInline.onclick = ()=>openCategoryModal(null, type==='receita' ? 'in' : 'out');
}
function openCatManageModal(){
  document.getElementById('overlayCatManage').classList.add('show');
  renderCatManageList(catManageType || 'despesa');
}
function closeCatManageModal(){ document.getElementById('overlayCatManage').classList.remove('show'); }

function openBudgetModal(id){
  if(categories.length===0){ showToast('Cadastre uma categoria antes de criar um orçamento'); return; }
  editingBudgetId = id || null;
  document.getElementById('overlayBudget').classList.add('show');
  const sel = document.getElementById('orcCategoria');
  const used = budgets.filter(b=>b.id!==id).map(b=>b.category);
  const opts = categories.filter(c=>!used.includes(c.name));
  sel.innerHTML = (opts.length?opts:categories).map(c=>'<option>'+c.name+'</option>').join('');
  if(id){
    const b = budgets.find(x=>x.id===id);
    document.getElementById('orcModalTitle').textContent = 'Editar Orçamento';
    sel.value = b.category;
    document.getElementById('orcLimite').value = b.limit;
  } else {
    document.getElementById('orcModalTitle').textContent = 'Novo Orçamento';
    document.getElementById('orcLimite').value = '';
  }
}
function closeBudgetModal(){ document.getElementById('overlayBudget').classList.remove('show'); }
async function saveBudget(){
  const category = document.getElementById('orcCategoria').value;
  const limit = parseFloat(document.getElementById('orcLimite').value);
  if(!category || isNaN(limit) || limit<=0){ showToast('Informe categoria e limite válidos'); return; }
  if(editingBudgetId){
    Object.assign(budgets.find(b=>b.id===editingBudgetId), {category, limit});
    showToast('Orçamento atualizado!');
    logActivity('Edição', 'Orçamento', 'Atualizou orçamento para a categoria "' + category + '" (Limite: ' + fmt(limit) + ')');
  } else {
    budgets.push({id: nextBudgetId++, category, limit});
    showToast('Orçamento criado!');
    logActivity('Criação', 'Orçamento', 'Criou orçamento para a categoria "' + category + '" (Limite: ' + fmt(limit) + ')');
  }
  await saveUserData();
  closeBudgetModal();
  render();
}
async function deleteBudget(id){
  if(!confirm('Excluir este orçamento?')) return;
  const targetBudget = budgets.find(b=>b.id===id);
  if(targetBudget){
    logActivity('Exclusão', 'Orçamento', 'Excluiu orçamento da categoria "' + targetBudget.category + '"');
  }
  budgets = budgets.filter(b=>b.id!==id);
  await saveUserData();
  showToast('Orçamento removido');
  render();
}

function openGoalModal(id){
  editingGoalId = id || null;
  document.getElementById('overlayGoal').classList.add('show');
  if(id){
    const g = goals.find(x=>x.id===id);
    document.getElementById('goalModalTitle').textContent = 'Editar Meta';
    document.getElementById('goalName').value = g.name;
    document.getElementById('goalTarget').value = g.target;
    document.getElementById('goalCurrent').value = g.current;
    document.getElementById('goalDeadline').value = g.deadline;
  } else {
    document.getElementById('goalModalTitle').textContent = 'Nova Meta';
    document.getElementById('goalName').value = '';
    document.getElementById('goalTarget').value = '';
    document.getElementById('goalCurrent').value = '0';
    document.getElementById('goalDeadline').value = '2026-12-31';
  }
}
function closeGoalModal(){ document.getElementById('overlayGoal').classList.remove('show'); }
async function saveGoal(){
  const name = document.getElementById('goalName').value.trim();
  const target = parseFloat(document.getElementById('goalTarget').value);
  const current = parseFloat(document.getElementById('goalCurrent').value) || 0;
  const deadline = document.getElementById('goalDeadline').value;
  if(!name || isNaN(target) || target<=0 || !deadline){ showToast('Preencha os campos da meta corretamente'); return; }
  if(editingGoalId){
    Object.assign(goals.find(g=>g.id===editingGoalId), {name,target,current,deadline});
    showToast('Meta atualizada!');
    logActivity('Edição', 'Meta', 'Atualizou meta "' + name + '" (Objetivo: ' + fmt(target) + ')');
  } else {
    goals.push({id: nextGoalId++, name,target,current,deadline});
    showToast('Meta criada!');
    logActivity('Criação', 'Meta', 'Criou nova meta "' + name + '" (Objetivo: ' + fmt(target) + ')');
  }
  await saveUserData();
  closeGoalModal();
  render();
}
async function deleteGoal(id){
  if(!confirm('Excluir esta meta?')) return;
  const targetGoal = goals.find(g=>g.id===id);
  if(targetGoal){
    logActivity('Exclusão', 'Meta', 'Excluiu meta "' + targetGoal.name + '"');
  }
  goals = goals.filter(g=>g.id!==id);
  await saveUserData();
  showToast('Meta removida');
  render();
}
async function addContribution(id){
  const g = goals.find(x=>x.id===id);
  const v = prompt('Adicionar quanto à meta "' + g.name + '"? (R$)');
  if(v===null) return;
  const val = parseFloat(v.replace(',','.'));
  if(isNaN(val) || val<=0){ showToast('Valor inválido'); return; }
  g.current += val;
  await saveUserData();
  showToast('Valor adicionado à meta!');
  logActivity('Edição', 'Meta', 'Adicionou contribuição de ' + fmt(val) + ' à meta "' + g.name + '" (Atual: ' + fmt(g.current) + ')');
  render();
}

function populateRecAccountOptions(selectedAcc) {
  const aSel = document.getElementById('recConta');
  if(!aSel) return;

  const filteredAccounts = currentRecType === 'in' 
    ? accounts.filter(a => a.type !== 'Cartão de Crédito')
    : accounts;

  let optionsArr = filteredAccounts.map(a => ({
    value: a.name,
    label: a.name + ' — ' + a.type
  }));

  const extraOptions = [
    { value: 'Boleto / Outros', label: '📄 Boleto / Pix / Outros' },
    { value: 'Dinheiro', label: '💵 Dinheiro em Espécie' }
  ];

  extraOptions.forEach(opt => {
    if (!accounts.some(a => a.name.toLowerCase().trim() === opt.value.toLowerCase().trim())) {
      optionsArr.push(opt);
    }
  });

  aSel.innerHTML = optionsArr.map(opt => {
    return '<option value="' + opt.value + '"' + (selectedAcc === opt.value ? ' selected' : '') + '>' + opt.label + '</option>';
  }).join('');
}

function openRecurringModal(id){
  if(categories.length===0){ showToast('Cadastre uma categoria antes de criar um recorrente'); return; }
  editingRecId = id || null;
  document.getElementById('overlayRecurring').classList.add('show');
  
  let selectedAcc = accounts[0] ? accounts[0].name : 'Boleto / Outros';

  if(id){
    const r = recurringList.find(x=>x.id===id);
    document.getElementById('recModalTitle').textContent = 'Editar Recorrente';
    document.getElementById('recDesc').value = r.desc;
    document.getElementById('recVal').value = r.val;
    document.getElementById('recDay').value = r.day;
    document.getElementById('recFreq').value = r.freq;
    if(r.acc) selectedAcc = r.acc;
    setRecType(r.type);
    const cSel = document.getElementById('recCategoria');
    if(cSel) cSel.value = r.cat;
  } else {
    document.getElementById('recModalTitle').textContent = 'Novo Lançamento Recorrente';
    document.getElementById('recDesc').value = '';
    document.getElementById('recVal').value = '';
    document.getElementById('recDay').value = '5';
    document.getElementById('recFreq').value = 'Mensal';
    setRecType('out');
  }
  populateRecAccountOptions(selectedAcc);
}

function closeRecurringModal(){ document.getElementById('overlayRecurring').classList.remove('show'); }

function populateRecCategoriaOptions(type){
  const fCat = document.getElementById('recCategoria');
  if(!fCat) return;
  const wantType = type==='in' ? 'receita' : 'despesa';
  const hasOfType = categories.some(c => (c.type||'despesa') === wantType);
  const prev = fCat.value;
  fCat.innerHTML = hasOfType ? catOptionsHTML(wantType) : catOptionsHTML(null);
  const list = hasOfType ? categories.filter(c => (c.type||'despesa') === wantType) : categories;
  if(list.some(c=>c.name===prev)) fCat.value = prev;
}

function setRecType(t){
  currentRecType = t;
  document.getElementById('recTypeInBtn').className = t==='in' ? 'sel-in' : '';
  document.getElementById('recTypeOutBtn').className = t==='out' ? 'sel-out' : '';
  populateRecCategoriaOptions(t);
  const aSel = document.getElementById('recConta');
  if(aSel) {
    populateRecAccountOptions(aSel.value);
  }
}

async function saveRecurring(){
  const desc = document.getElementById('recDesc').value.trim();
  const val = parseFloat(document.getElementById('recVal').value);
  const day = parseInt(document.getElementById('recDay').value);
  const cat = document.getElementById('recCategoria').value;
  const accSel = document.getElementById('recConta') ? document.getElementById('recConta').value : '';
  const freq = document.getElementById('recFreq').value;
  if(!desc || isNaN(val) || val<=0 || isNaN(day) || day<1 || day>31){ showToast('Preencha os campos corretamente'); return; }
  if(editingRecId){
    Object.assign(recurringList.find(r=>r.id===editingRecId), {desc,val,day,cat,acc:accSel,freq,type:currentRecType});
    showToast('Recorrente atualizado!');
    logActivity('Edição', 'Recorrente', 'Editou lançamento recorrente "' + desc + '" (' + fmt(val) + ')');
  } else {
    recurringList.push({id: nextRecId++, desc,val,day,cat,acc:accSel,freq,type:currentRecType});
    showToast('Recorrente criado!');
    logActivity('Criação', 'Recorrente', 'Cadastrou lançamento recorrente "' + desc + '" (' + fmt(val) + ')');
  }
  await saveUserData();
  closeRecurringModal();
  render();
}
async function deleteRecurring(id){
  if(!confirm('Excluir este lançamento recorrente?')) return;
  recurringList = recurringList.filter(r=>r.id!==id);
  await saveUserData();
  showToast('Recorrente removido');
  render();
}
async function lancarRecorrente(id){
  const r = recurringList.find(x=>x.id===id);
  const date = pdCustom(currentPeriod.year, currentPeriod.month, r.day);
  transactions.push({id: nextTxId++, desc:r.desc, val:r.val, date, cat:r.cat, acc:r.acc, status: r.type==='in'?'Recebido':'Pago', type:r.type});
  await saveUserData();
  showToast(\`Lançamento gerado em \${periodLabel()}!\`);
  render();
}

function openAlertModal(id){
  if(categories.length===0){ showToast('Cadastre uma categoria antes de criar um alerta'); return; }
  editingAlertId = id || null;
  document.getElementById('overlayAlert').classList.add('show');
  const sel = document.getElementById('alertCategoria');
  sel.innerHTML = categories.map(c=>\`<option>\${c.name}</option>\`).join('');
  if(id){
    const al = alerts.find(x=>x.id===id);
    document.getElementById('alertModalTitle').textContent = 'Editar Alerta';
    sel.value = al.category;
    document.getElementById('alertThreshold').value = al.threshold;
  } else {
    document.getElementById('alertModalTitle').textContent = 'Novo Alerta';
    document.getElementById('alertThreshold').value = '90';
  }
}
function closeAlertModal(){ document.getElementById('overlayAlert').classList.remove('show'); }
async function saveAlert(){
  const category = document.getElementById('alertCategoria').value;
  const threshold = parseInt(document.getElementById('alertThreshold').value);
  if(!category || isNaN(threshold) || threshold<=0){ showToast('Preencha os campos corretamente'); return; }
  if(editingAlertId){
    Object.assign(alerts.find(a=>a.id===editingAlertId), {category, threshold});
    showToast('Alerta atualizado!');
  } else {
    alerts.push({id: nextAlertId++, category, threshold});
    showToast('Alerta criado!');
  }
  await saveUserData();
  closeAlertModal();
  render();
}
async function deleteAlert(id){
  if(!confirm('Excluir este alerta?')) return;
  alerts = alerts.filter(a=>a.id!==id);
  await saveUserData();
  showToast('Alerta removido');
  render();
}

async function openUserAdminModal(email){
  await syncUsersWithServer();
  if(!currentUser || currentUser.role !== 'Administrador') return;
  const u = registeredUsers.find(x=>x.email===email);
  if(!u) return;
  editingUserEmail = email;
  document.getElementById('userAdminName').value = u.name;
  document.getElementById('userAdminEmail').value = u.email;
  document.getElementById('userAdminRole').value = u.role;
  document.getElementById('userAdminPassword').value = '';
  document.getElementById('userAdminPassword').type = 'password';
  bindPasswordToggle('userAdminPassword', 'userAdminPasswordToggle');
  document.getElementById('overlayUserAdmin').classList.add('show');
}
function closeUserAdminModal(){ document.getElementById('overlayUserAdmin').classList.remove('show'); editingUserEmail = null; }
async function saveUserAdmin(){
  if(!editingUserEmail) return;
  await syncUsersWithServer();
  const u = registeredUsers.find(x=>x.email===editingUserEmail);
  if(!u) return;
  const name = document.getElementById('userAdminName').value.trim();
  const role = document.getElementById('userAdminRole').value;
  const newPass = document.getElementById('userAdminPassword').value.trim();
  if(!name){ showToast('Informe um nome para o usuário'); return; }
  if(u.role === 'Administrador' && role !== 'Administrador' && registeredUsers.filter(x=>x.role==='Administrador').length <= 1){
    showToast('É necessário manter ao menos um administrador');
    return;
  }
  u.name = name;
  u.role = role;
  if(newPass) u.password = newPass;
  await saveUsersToServer();
  if(currentUser && currentUser.email === u.email){
    currentUser.name = u.name;
    currentUser.role = u.role;
  }
  showToast('Usuário atualizado!');
  logActivity('Edição', 'Usuário', 'Administrador alterou dados do usuário ' + u.email + ' (Nome: ' + name + ', Função: ' + role + (newPass ? ', Senha alterada' : '') + ')');
  closeUserAdminModal();
  render();
}

function handleImportFile(e){
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    const text = reader.result;
    let rows = [];
    if(/\\.ofx$/i.test(file.name)){
      const re = /<STMTTRN>([\\s\\S]*?)<\\/STMTTRN>/gi;
      let m;
      while((m = re.exec(text))){
        const block = m[1];
        const amt = (block.match(/<TRNAMT>([-\\d.,]+)/i)||[])[1];
        const dtRaw = (block.match(/<DTPOSTED>(\\d{8})/i)||[])[1];
        const memo = ((block.match(/<MEMO>([^\\n<]*)/i)||[])[1] || (block.match(/<NAME>([^\\n<]*)/i)||[])[1] || 'Importado').trim();
        if(amt && dtRaw){
          const date = \`\${dtRaw.slice(0,4)}-\${dtRaw.slice(4,6)}-\${dtRaw.slice(6,8)}\`;
          rows.push({date, desc:memo, val:parseFloat(amt.replace(',','.'))});
        }
      }
    } else {
      const lines = text.split(/\\r?\\n/).filter(l=>l.trim());
      lines.forEach(line=>{
        const parts = line.split(',');
        if(parts.length<3) return;
        const [d,desc,val] = parts;
        const dt = (d||'').trim();
        const v = parseFloat((val||'').replace(',','.'));
        if(!dt || isNaN(v) || /data/i.test(dt)) return;
        rows.push({date:dt, desc:(desc||'').trim(), val:v});
      });
    }
    pendingImport = rows;
    renderImportPreview();
  };
  reader.readAsText(file);
}
function renderImportPreview(){
  const el = document.getElementById('importPreview');
  if(!el) return;
  if(pendingImport.length===0){ el.innerHTML = '<p style="color:var(--text-faint);font-size:12.5px;margin-top:12px;">Nenhuma transação reconhecida no arquivo.</p>'; return; }
  el.innerHTML = \`
    <p style="font-size:12.5px;color:var(--text-dim);margin:14px 0 8px;">\${pendingImport.length} transações encontradas:</p>
    <table><thead><tr><th>Data</th><th>Descrição</th><th>Valor</th></tr></thead><tbody>
    \${pendingImport.slice(0,50).map(r=>\`<tr class="trow"><td>\${r.date}</td><td>\${r.desc}</td><td class="\${r.val>=0?'val-in':'val-out'}">\${fmt(Math.abs(r.val))}</td></tr>\`).join('')}
    </tbody></table>
    <button class="btn-primary" id="btnConfirmarImport" style="margin-top:14px">Confirmar Importação (\${pendingImport.length})</button>\`;
  document.getElementById('btnConfirmarImport').onclick = confirmImport;
}
async function confirmImport(){
  const accSel = document.getElementById('impConta').value.split(' — ')[0];
  const cat = document.getElementById('impCategoria').value;
  let added = 0;
  pendingImport.forEach(r=>{
    let date = r.date;
    transactions.push({ id: nextTxId++, date, desc:r.desc||'Importado', cat, acc:accSel, type: r.val>=0?'in':'out', val: Math.abs(r.val), status: r.val>=0?'Recebido':'Pago' });
    added++;
  });
  pendingImport = [];
  await saveUserData();
  showToast(\`\${added} transações importadas!\`);
  navigate('transacoes');
}

async function compressImageIfNeeded(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX_WIDTH = 1280;
        const MAX_HEIGHT = 1280;
        let width = img.width;
        let height = img.height;

        if (width > MAX_WIDTH || height > MAX_HEIGHT) {
          if (width > height) {
            height = Math.round((height * MAX_WIDTH) / width);
            width = MAX_WIDTH;
          } else {
            width = Math.round((width * MAX_HEIGHT) / height);
            height = MAX_HEIGHT;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.82);
        resolve(compressedDataUrl);
      };
      img.onerror = () => resolve(e.target.result);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function addAttachment(){
  const attTxEl = document.getElementById('attTx');
  const txId = attTxEl ? (parseInt(attTxEl.value) || null) : null;
  const fileInput = document.getElementById('attFile');
  const files = Array.from(fileInput ? fileInput.files : []);
  if(files.length === 0){ showToast('Selecione ao menos um arquivo'); return; }

  let addedCount = 0;
  showToast('Processando anexo(s)...');

  for (const file of files) {
    try {
      let dataUrl = null;
      if (file.type && file.type.startsWith('image/')) {
        dataUrl = await compressImageIfNeeded(file);
      }
      if (!dataUrl) {
        dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        });
      }

      if (dataUrl) {
        attachments.push({
          id: nextAttId++,
          txId: txId,
          name: file.name,
          type: file.type || 'application/octet-stream',
          dataUrl: dataUrl,
          createdAt: new Date().toISOString()
        });
        addedCount++;
      }
    } catch(e) {
      console.error('Erro ao processar anexo:', e);
    }
  }

  if (addedCount > 0) {
    await saveUserData();
    showToast(\`\${addedCount} anexo(s) incluído(s) com sucesso!\`);
    render();
  } else {
    showToast('Erro ao ler os arquivos selecionados');
  }
}

async function relinkAttachment(id, newTxId){
  const att = attachments.find(a => a.id === id);
  if (!att) return;
  att.txId = newTxId ? parseInt(newTxId) : null;
  await saveUserData();
  showToast('Vínculo da transação atualizado!');
  render();
}

function previewAttachment(id){
  const att = attachments.find(a => a.id === id);
  if (!att || !att.dataUrl) { showToast('Não foi possível carregar a visualização'); return; }
  const isImage = (att.type && att.type.startsWith('image/')) || (att.dataUrl && att.dataUrl.startsWith('data:image/'));
  const isPdf = (att.type && att.type.includes('pdf')) || (att.dataUrl && att.dataUrl.startsWith('data:application/pdf')) || (att.name && att.name.toLowerCase().endsWith('.pdf'));

  let contentHtml = '';
  if (isImage) {
    contentHtml = \`<img src="\${att.dataUrl}" style="max-width:100%; max-height:75vh; object-fit:contain; border-radius:10px; display:block; margin:0 auto;">\`;
  } else if (isPdf) {
    contentHtml = \`<iframe src="\${att.dataUrl}" style="width:100%; height:75vh; border:none; border-radius:10px;"></iframe>\`;
  } else {
    contentHtml = \`<div style="text-align:center; padding:40px 20px;"><div style="font-size:48px; margin-bottom:12px;">📄</div><h4>\${att.name}</h4><p style="color:var(--text-dim); margin-top:8px;">Arquivo disponível para download</p><a href="\${att.dataUrl}" download="\${att.name}" class="btn-primary" style="display:inline-flex; align-items:center; gap:6px; margin-top:16px; text-decoration:none; padding:8px 18px;">📥 Baixar Arquivo Agora</a></div>\`;
  }

  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'overlay show';
  modalOverlay.style.zIndex = '3000';
  modalOverlay.innerHTML = \`
    <div class="modal" style="max-width:850px; width:92vw;">
      <button class="close-x" onclick="this.closest('.overlay').remove()">✕</button>
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid var(--card-border);">
        <h3 style="font-size:15px; font-weight:700; margin:0; display:flex; align-items:center; gap:8px;">
          <span>📎</span> \${att.name}
        </h3>
        <a href="\${att.dataUrl}" download="\${att.name || 'comprovante'}" class="btn-primary" style="padding:6px 14px; font-size:12px; font-weight:700; text-decoration:none; display:inline-flex; align-items:center; gap:6px;">
          📥 Baixar Arquivo
        </a>
      </div>
      <div style="background:var(--bg); padding:12px; border-radius:12px; border:1px solid var(--card-border);">
        \${contentHtml}
      </div>
    </div>
  \`;
  document.body.appendChild(modalOverlay);
}

async function deleteAttachment(id){
  if(!confirm('Remover este anexo?')) return;
  attachments = attachments.filter(a=>a.id!==id);
  await saveUserData();
  showToast('Anexo removido');
  render();
}

/* ==================== Eventos de página ==================== */
function attachPageEvents(){
  document.querySelectorAll('[data-nav]').forEach(el=>el.onclick = ()=>{ navigate(el.getAttribute('data-nav')); });

  const nova = document.getElementById('btnNovaTransacao'); if(nova) nova.onclick = ()=>openModal(null);
  const gerCat = document.getElementById('btnGerenciarCategorias'); if(gerCat) gerCat.onclick = openCatManageModal;
  document.querySelectorAll('[data-edit]').forEach(el=>el.onclick = ()=>openModal(parseInt(el.getAttribute('data-edit'))));
  document.querySelectorAll('[data-del]').forEach(el=>el.onclick = ()=>deleteTransaction(parseInt(el.getAttribute('data-del'))));
  document.querySelectorAll('[data-paytx]').forEach(el=>el.onclick = ()=>markTransactionAsPaid(parseInt(el.getAttribute('data-paytx'))));

  const novaConta = document.getElementById('btnNovaConta'); if(novaConta) novaConta.onclick = ()=>openAccountModal(null);
  document.querySelectorAll('[data-editacc]').forEach(el=>el.onclick = ()=>openAccountModal(parseInt(el.getAttribute('data-editacc'))));
  document.querySelectorAll('[data-delacc]').forEach(el=>el.onclick = ()=>deleteAccount(parseInt(el.getAttribute('data-delacc'))));

  const novaCat = document.getElementById('btnNovaCategoria'); if(novaCat) novaCat.onclick = ()=>openCategoryModal(null);
  document.querySelectorAll('[data-editcat]').forEach(el=>el.onclick = ()=>openCategoryModal(el.getAttribute('data-editcat')));
  document.querySelectorAll('[data-delcat]').forEach(el=>el.onclick = ()=>deleteCategory(el.getAttribute('data-delcat')));

  const novoOrc = document.getElementById('btnNovoOrcamento'); if(novoOrc) novoOrc.onclick = ()=>openBudgetModal(null);
  document.querySelectorAll('[data-editorc]').forEach(el=>el.onclick = ()=>openBudgetModal(parseInt(el.getAttribute('data-editorc'))));
  document.querySelectorAll('[data-delorc]').forEach(el=>el.onclick = ()=>deleteBudget(parseInt(el.getAttribute('data-delorc'))));

  const novaMeta = document.getElementById('btnNovaMeta'); if(novaMeta) novaMeta.onclick = ()=>openGoalModal(null);
  document.querySelectorAll('[data-editmeta]').forEach(el=>el.onclick = ()=>openGoalModal(parseInt(el.getAttribute('data-editmeta'))));
  document.querySelectorAll('[data-delmeta]').forEach(el=>el.onclick = ()=>deleteGoal(parseInt(el.getAttribute('data-delmeta'))));
  document.querySelectorAll('[data-addcontrib]').forEach(el=>el.onclick = ()=>addContribution(parseInt(el.getAttribute('data-addcontrib'))));

  const novoRec = document.getElementById('btnNovoRecorrente'); if(novoRec) novoRec.onclick = ()=>openRecurringModal(null);
  document.querySelectorAll('[data-editrec]').forEach(el=>el.onclick = ()=>openRecurringModal(parseInt(el.getAttribute('data-editrec'))));
  document.querySelectorAll('[data-delrec]').forEach(el=>el.onclick = ()=>deleteRecurring(parseInt(el.getAttribute('data-delrec'))));
  document.querySelectorAll('[data-lancar]').forEach(el=>el.onclick = ()=>lancarRecorrente(parseInt(el.getAttribute('data-lancar'))));

  const novoAlerta = document.getElementById('btnNovoAlerta'); if(novoAlerta) novoAlerta.onclick = ()=>openAlertModal(null);
  document.querySelectorAll('[data-editalert]').forEach(el=>el.onclick = ()=>openAlertModal(parseInt(el.getAttribute('data-editalert'))));
  document.querySelectorAll('[data-delalert]').forEach(el=>el.onclick = ()=>deleteAlert(parseInt(el.getAttribute('data-delalert'))));

  document.querySelectorAll('[data-edituser]').forEach(el=>el.onclick = ()=>openUserAdminModal(el.getAttribute('data-edituser')));
  document.querySelectorAll('[data-viewuser]').forEach(el=>el.onclick = ()=>viewUserData(el.getAttribute('data-viewuser')));
  document.querySelectorAll('[data-toggleuser]').forEach(el=>el.onclick = ()=>toggleUserActive(el.getAttribute('data-toggleuser')));

  const importFile = document.getElementById('importFile'); if(importFile) importFile.onchange = handleImportFile;

  const addAtt = document.getElementById('btnAddAnexo'); if(addAtt) addAtt.onclick = addAttachment;
  document.querySelectorAll('[data-delatt]').forEach(el=>el.onclick = ()=>deleteAttachment(parseInt(el.getAttribute('data-delatt'))));
  document.querySelectorAll('[data-relinkatt]').forEach(el=>el.onchange = (e)=>relinkAttachment(parseInt(el.getAttribute('data-relinkatt')), e.target.value));
  document.querySelectorAll('[data-previewatt]').forEach(el=>el.onclick = ()=>previewAttachment(parseInt(el.getAttribute('data-previewatt'))));

  const saveCfg = document.getElementById('btnSalvarConfig');
  if(saveCfg){
    bindPasswordToggle('cfgPassword', 'cfgPasswordToggle');
    bindPasswordToggle('cfgPasswordConfirm', 'cfgPasswordConfirmToggle');
    document.getElementById('cfgTheme').value = document.body.classList.contains('light') ? 'light' : 'dark';
    saveCfg.onclick = async ()=>{
      if (currentUser) {
        await syncUsersWithServer();
        const newName = document.getElementById('cfgName').value.trim();
        const newEmail = document.getElementById('cfgEmail').value.trim();
        const newPass = document.getElementById('cfgPassword').value.trim();
        const newPassConfirm = document.getElementById('cfgPasswordConfirm').value.trim();

        if(!newName){ showToast('Informe um nome válido'); return; }
        if(!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)){ showToast('Informe um e-mail válido'); return; }
        const emailTaken = registeredUsers.some(u => u.email.toLowerCase()===newEmail.toLowerCase() && u.email.toLowerCase()!==currentUser.email.toLowerCase());
        if(emailTaken){ showToast('Este e-mail já está em uso por outro usuário'); return; }
        
        // Atualiza a senha SOMENTE se AMBOS os campos de senha foram preenchidos propositalmente
        let passwordChanged = false;
        if(newPass && newPassConfirm){
          if(newPass.length < 6){ showToast('A nova senha deve ter ao menos 6 caracteres'); return; }
          if(newPass !== newPassConfirm){ showToast('As senhas de confirmação não coincidem'); return; }
          passwordChanged = true;
        }

        const oldEmail = currentUser.email;
        const u = registeredUsers.find(x => x.email.toLowerCase() === oldEmail.toLowerCase());
        if (u) {
          u.name = newName;
          u.email = newEmail;
          if(passwordChanged) u.password = newPass;
        }
        await saveUsersToServer();

        if(newEmail.toLowerCase() !== oldEmail.toLowerCase()){
          const oldKey = 'nexus_data_' + oldEmail;
          const dataBackup = loadFromStorage(oldKey, null);
          currentUser.email = newEmail;
          if(dataBackup) saveToStorage('nexus_data_' + newEmail, dataBackup);
          localStorage.removeItem(oldKey);
        }
        currentUser.name = newName;
        await saveUserData();

        document.getElementById('cfgPassword').value = '';
        document.getElementById('cfgPasswordConfirm').value = '';
      }
      const wantLight = document.getElementById('cfgTheme').value === 'light';
      const isLight = document.body.classList.contains('light');
      if(wantLight !== isLight) toggleTheme();
      showToast('Configurações salvas!');
      render();
    };
  }

  const periodBtn = document.getElementById('periodBtn');
  if(periodBtn){
    periodBtn.onclick = (e)=>{
      e.stopPropagation();
      const willShow = !document.getElementById('periodPanel').classList.contains('show');
      document.getElementById('periodPanel').classList.toggle('show', willShow);
      periodBtn.classList.toggle('open', willShow);
    };
    const yearSel = document.getElementById('periodYearSel');
    yearSel.innerHTML = YEARS.map(y=>\`<option value="\${y}">\${y}</option>\`).join('');
    yearSel.value = currentPeriod.year;
    const buildMonths = ()=>{
      const y = parseInt(yearSel.value);
      let start=1, end=12;
      if(y===PERIOD_MIN.year) start = PERIOD_MIN.month;
      if(y===PERIOD_MAX.year) end = PERIOD_MAX.month;
      const monthSel = document.getElementById('periodMonthSel');
      const opts = [];
      for(let m=start; m<=end; m++) opts.push(m);
      monthSel.innerHTML = opts.map(m=>\`<option value="\${m}">\${MONTHS[m-1]}</option>\`).join('');
      monthSel.value = (opts.includes(currentPeriod.month) && y===currentPeriod.year) ? currentPeriod.month : opts[0];
    };
    buildMonths();
    yearSel.onchange = buildMonths;
    document.getElementById('periodApplyBtn').onclick = ()=>{
      currentPeriod = { year: parseInt(yearSel.value), month: parseInt(document.getElementById('periodMonthSel').value) };
      try { localStorage.setItem('fin_current_period', JSON.stringify(currentPeriod)); } catch(e){}
      document.getElementById('periodPanel').classList.remove('show');
      periodBtn.classList.remove('open');
      render();
    };
    document.getElementById('periodTodayBtn').onclick = ()=>{
      const now = new Date();
      currentPeriod = { year: now.getFullYear(), month: now.getMonth() + 1 };
      try { localStorage.setItem('fin_current_period', JSON.stringify(currentPeriod)); } catch(e){}
      document.getElementById('periodPanel').classList.remove('show');
      periodBtn.classList.remove('open');
      render();
    };
    const allDatesBtn = document.getElementById('periodAllDatesBtn');
    if (allDatesBtn) {
      allDatesBtn.onclick = () => {
        const now = new Date();
        currentPeriod = { year: now.getFullYear(), month: 0 };
        try { localStorage.setItem('fin_current_period', JSON.stringify(currentPeriod)); } catch(e){}
        document.getElementById('periodPanel').classList.remove('show');
        periodBtn.classList.remove('open');
        render();
      };
    }
  }

  const search = document.getElementById('txSearch');
  const fTipo = document.getElementById('txFiltroTipo');
  const fCat = document.getElementById('txFiltroCat');
  const fStatus = document.getElementById('txFiltroStatus');
  const fConta = document.getElementById('txFiltroConta');
  if(search){
    [search,fTipo,fCat,fStatus,fConta].forEach(el=>{
      if(el) {
        el.addEventListener('input', refreshTxTable);
        el.addEventListener('change', refreshTxTable);
      }
    });
    refreshTxTable();
  }

  document.querySelectorAll('[data-viewcardtx]').forEach(btn => {
    btn.onclick = () => {
      const cardName = btn.getAttribute('data-viewcardtx');
      currentPage = 'transacoes';
      render();
      setTimeout(() => {
        const fc = document.getElementById('txFiltroConta');
        if (fc) {
          fc.value = cardName;
          refreshTxTable();
        }
      }, 50);
    };
  });
}

function navigate(page){
  if(!page) page = 'dashboard';
  currentPage = page;
  try {
    localStorage.setItem('nexus_current_page', page);
    if(window.history && window.history.replaceState){
      window.history.replaceState(null, null, '#' + page);
    } else {
      window.location.hash = page;
    }
  } catch(e){}

  document.querySelectorAll('.menu button').forEach(b=>b.classList.toggle('active', b.dataset.page===page));
  render();
}

window.addEventListener('hashchange', ()=>{
  const validPages = ['dashboard', 'transacoes', 'cartoes', 'orcamentos', 'metas', 'relatorios', 'recorrentes', 'importar', 'anexos', 'alertas', 'funcoes', 'usuarios', 'logs', 'config'];
  const hashPage = window.location.hash ? window.location.hash.replace('#', '') : null;
  if(hashPage && validPages.includes(hashPage) && hashPage !== currentPage){
    navigate(hashPage);
  }
});

/* ==================== Eventos Globais ==================== */
function toggleMobileDrawer(open){
  const drawer = document.getElementById('mobileDrawer');
  const overlay = document.getElementById('mobileDrawerOverlay');
  if(!drawer || !overlay) return;
  if(open === undefined) open = !drawer.classList.contains('open');
  if(open){
    overlay.classList.add('show');
    drawer.classList.add('open');
  } else {
    overlay.classList.remove('show');
    drawer.classList.remove('open');
  }
}
const mobileToggle = document.getElementById('mobileMenuToggle');
if(mobileToggle) mobileToggle.onclick = ()=> toggleMobileDrawer(true);
const closeDrawer = document.getElementById('closeMobileDrawer');
if(closeDrawer) closeDrawer.onclick = ()=> toggleMobileDrawer(false);
const overlayDrawer = document.getElementById('mobileDrawerOverlay');
if(overlayDrawer) overlayDrawer.onclick = ()=> toggleMobileDrawer(false);

const mobileDrawerMenu = document.getElementById('mobileDrawerMenu');
if(mobileDrawerMenu){
  mobileDrawerMenu.addEventListener('click', e=>{
    const targetEl = e.target.nodeType === 3 ? e.target.parentElement : e.target;
    const btn = targetEl ? targetEl.closest('button[data-page]') : null;
    if(btn && btn.dataset.page){
      navigate(btn.dataset.page);
      toggleMobileDrawer(false);
    }
  });
}

document.getElementById('menu').addEventListener('click', e=>{
  const targetEl = e.target.nodeType === 3 ? e.target.parentElement : e.target;
  const btn = targetEl ? targetEl.closest('button[data-page]') : null;
  if(btn && btn.dataset.page) navigate(btn.dataset.page);
});
document.addEventListener('click', e=>{
  const targetEl = e.target.nodeType === 3 ? e.target.parentElement : e.target;
  const panel = document.getElementById('periodPanel');
  if(panel && panel.classList.contains('show') && targetEl && !targetEl.closest('.period-wrap')){
    panel.classList.remove('show');
    const pBtn = document.getElementById('periodBtn'); if(pBtn) pBtn.classList.remove('open');
  }
  const notifPanel = document.getElementById('notifPanel');
  if(notifPanel && notifPanel.classList.contains('show') && targetEl && !targetEl.closest('.notif-wrap')) notifPanel.classList.remove('show');
});

document.getElementById('notifBtn').onclick = async (e)=>{
  e.stopPropagation();
  const panel = document.getElementById('notifPanel');
  panel.classList.toggle('show');
  if(panel.classList.contains('show') && notifications.some(n=>!n.read)){
    notifications.forEach(n=>n.read=true);
    await saveUserData();
    renderNotifications();
  }
};
document.getElementById('notifMarkAllBtn').onclick = async (e)=>{
  e.stopPropagation();
  notifications.forEach(n=>n.read=true);
  await saveUserData();
  renderNotifications();
};

document.getElementById('closeAccModal').onclick = closeAccountModal;
document.getElementById('accCancelBtn').onclick = closeAccountModal;
document.getElementById('accSaveBtn').onclick = saveAccount;
document.getElementById('overlayAccount').addEventListener('click', e=>{ if(e.target.id==='overlayAccount') closeAccountModal(); });

const accNameInput = document.getElementById('accName');
if (accNameInput) {
  accNameInput.addEventListener('input', (e) => {
    const detected = autoDetectBankColor(e.target.value);
    if (detected) {
      document.getElementById('accColor').value = detected.color;
      if (detected.type && !editingAccId) {
        document.getElementById('accType').value = detected.type;
      }
    }
  });
}

document.getElementById('closeModal').onclick = closeModal;
document.getElementById('cancelBtn').onclick = closeModal;
document.getElementById('saveBtn').onclick = saveTransaction;
document.getElementById('overlay').addEventListener('click', e=>{ if(e.target.id==='overlay') closeModal(); });
document.getElementById('typeInBtn').onclick = ()=>setType('in');
document.getElementById('typeOutBtn').onclick = ()=>setType('out');
document.getElementById('fCategoriaAddBtn').onclick = ()=>openCategoryModal(null, currentType);

document.getElementById('closeAccModal').onclick = closeAccountModal;
document.getElementById('accCancelBtn').onclick = closeAccountModal;
document.getElementById('accSaveBtn').onclick = saveAccount;
document.getElementById('overlayAccount').addEventListener('click', e=>{ if(e.target.id==='overlayAccount') closeAccountModal(); });

document.getElementById('closeCatModal').onclick = closeCategoryModal;
document.getElementById('catCancelBtn').onclick = closeCategoryModal;
document.getElementById('catSaveBtn').onclick = saveCategory;
document.getElementById('overlayCategory').addEventListener('click', e=>{ if(e.target.id==='overlayCategory') closeCategoryModal(); });

document.getElementById('closeCatManageModal').onclick = closeCatManageModal;
document.getElementById('catManageCloseBtn').onclick = closeCatManageModal;
document.getElementById('catManageAddBtn').onclick = ()=>openCategoryModal(null, catManageType==='receita' ? 'in' : 'out');
document.getElementById('overlayCatManage').addEventListener('click', e=>{ if(e.target.id==='overlayCatManage') closeCatManageModal(); });
document.querySelectorAll('.cat-manage-tabs .cat-tab').forEach(btn=>{
  btn.onclick = ()=>{ catManageType = btn.getAttribute('data-cattab'); renderCatManageList(catManageType); };
});


document.getElementById('closeOrcModal').onclick = closeBudgetModal;
document.getElementById('orcCancelBtn').onclick = closeBudgetModal;
document.getElementById('orcSaveBtn').onclick = saveBudget;
document.getElementById('overlayBudget').addEventListener('click', e=>{ if(e.target.id==='overlayBudget') closeBudgetModal(); });

document.getElementById('closeGoalModal').onclick = closeGoalModal;
document.getElementById('goalCancelBtn').onclick = closeGoalModal;
document.getElementById('goalSaveBtn').onclick = saveGoal;
document.getElementById('overlayGoal').addEventListener('click', e=>{ if(e.target.id==='overlayGoal') closeGoalModal(); });

document.getElementById('closeRecModal').onclick = closeRecurringModal;
document.getElementById('recCancelBtn').onclick = closeRecurringModal;
document.getElementById('recSaveBtn').onclick = saveRecurring;
document.getElementById('overlayRecurring').addEventListener('click', e=>{ if(e.target.id==='overlayRecurring') closeRecurringModal(); });
document.getElementById('recTypeInBtn').onclick = ()=>setRecType('in');
document.getElementById('recTypeOutBtn').onclick = ()=>setRecType('out');

function toggleTheme(){
  const isCurrentlyLight = document.body.classList.contains('light') || document.documentElement.classList.contains('light');
  const nextIsLight = !isCurrentlyLight;

  document.body.classList.toggle('light', nextIsLight);
  document.documentElement.classList.toggle('light', nextIsLight);
  localStorage.setItem('nexus_theme', nextIsLight ? 'light' : 'dark');

  const btn = document.getElementById('miniThemeBtn');
  const moonSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 0 1 1-9-9Z"/></svg>';
  const sunSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M22 12h-2"/><path d="m4.93 19.07 1.41-1.41"/><path d="m17.66 6.34 1.41-1.41"/></svg>';
  if(btn) btn.innerHTML = nextIsLight ? sunSvg : moonSvg;
  if(currentPage==='dashboard') drawDashboardCharts();
}
document.getElementById('miniThemeBtn').onclick = toggleTheme;

(function initThemeState() {
  try {
    const savedTheme = localStorage.getItem('nexus_theme');
    const isLight = savedTheme === 'light';
    document.body.classList.toggle('light', isLight);
    document.documentElement.classList.toggle('light', isLight);
    const btn = document.getElementById('miniThemeBtn');
    const moonSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
    const sunSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M22 12h-2"/><path d="m4.93 19.07 1.41-1.41"/><path d="m17.66 6.34 1.41-1.41"/></svg>';
    if (btn) btn.innerHTML = isLight ? sunSvg : moonSvg;
  } catch(e){}
})();

document.getElementById('closeAlertModal').onclick = closeAlertModal;
document.getElementById('alertCancelBtn').onclick = closeAlertModal;
document.getElementById('alertSaveBtn').onclick = saveAlert;
document.getElementById('overlayAlert').addEventListener('click', e=>{ if(e.target.id==='overlayAlert') closeAlertModal(); });

document.getElementById('closeUserAdminModal').onclick = closeUserAdminModal;
document.getElementById('userAdminCancelBtn').onclick = closeUserAdminModal;
document.getElementById('userAdminSaveBtn').onclick = saveUserAdmin;
document.getElementById('overlayUserAdmin').addEventListener('click', e=>{ if(e.target.id==='overlayUserAdmin') closeUserAdminModal(); });
document.getElementById('viewModeExitBtn').onclick = exitViewMode;
document.getElementById('accountDisabledCloseBtn').onclick = hideAccountDisabledPopup;
bindPasswordToggle('loginPassword', 'loginPasswordToggle');

/* ==================== Restaurar sessão ao atualizar a página sem flicker ==================== */
(function initSessionStateImmediate() {
  try {
    const session = loadFromStorage('nexus_session', null);
    const cachedUser = loadFromStorage('nexus_cached_user', null);
    if ((session && session.email) || (cachedUser && cachedUser.email)) {
      document.documentElement.classList.add('user-logged-in');
      document.getElementById('authPage').classList.remove('show');
      document.getElementById('appMain').classList.add('show');
      if (cachedUser) {
        currentUser = cachedUser;
        if (currentUser.role === 'Administrador') {
          document.documentElement.classList.add('is-admin');
          const hashPage = window.location.hash ? window.location.hash.replace('#', '') : null;
          const savedPage = localStorage.getItem('nexus_current_page');
          const pageTarget = hashPage || savedPage;
          if (pageTarget === 'logs') {
            currentPage = 'logs';
          } else {
            currentPage = 'usuarios';
          }
        } else {
          document.documentElement.classList.remove('is-admin');
        }
        if (typeof updateHeaderUser === 'function') updateHeaderUser();
        if (typeof updateAdminMenuVisibility === 'function') updateAdminMenuVisibility();
      }
    }
  } catch(e){}
})();

(async function restoreSession(){
  const session = loadFromStorage('nexus_session', null);
  const cachedUser = loadFromStorage('nexus_cached_user', null);
  const viewingEmail = loadFromStorage('nexus_viewing_user', null);
  const sessionEmail = session ? session.email : (cachedUser ? cachedUser.email : null);

  if (!sessionEmail && !cachedUser) {
    document.documentElement.classList.remove('user-logged-in');
    document.getElementById('appMain').classList.remove('show');
    document.getElementById('authPage').classList.add('show');
    return;
  }

  // Tenta sincronizar a lista de usuários do servidor antes de desenhar a tela
  try {
    await syncUsersWithServer();
  } catch(e) {}

  const serverUser = registeredUsers.find(u => u.email.toLowerCase() === (sessionEmail || '').toLowerCase());
  const realUser = serverUser || cachedUser || { email: sessionEmail, name: sessionEmail.split('@')[0], role: 'Usuário' };

  if (realUser && realUser.active === false) {
    localStorage.removeItem('nexus_session');
    localStorage.removeItem('nexus_cached_user');
    localStorage.removeItem('nexus_token');
    localStorage.removeItem('nexus_viewing_user');
    document.documentElement.classList.remove('user-logged-in');
    document.getElementById('appMain').classList.remove('show');
    document.getElementById('authPage').classList.add('show');
    showAccountDisabledPopup('Seu usuário foi desativado pelo administrador. Entre em contato para mais informações.');
    return;
  }

  // Mantém os dados da conta autenticada real
  saveToStorage('nexus_session', { email: realUser.email });
  saveToStorage('nexus_cached_user', realUser);

  document.documentElement.classList.add('user-logged-in');
  document.getElementById('authPage').classList.remove('show');
  document.getElementById('appMain').classList.add('show');

  // Se o Administrador estava inspecionando outro usuário antes do F5
  if (realUser.role === 'Administrador' && viewingEmail) {
    const target = registeredUsers.find(u => u.email.toLowerCase() === viewingEmail.toLowerCase());
    if (target && target.email.toLowerCase() !== realUser.email.toLowerCase()) {
      adminOriginalUser = realUser;
      currentUser = target;
      isViewingOtherUser = true;
      currentPage = 'dashboard';
      await loadUserData();
      if (typeof render === 'function') render();
      return;
    }
  }

  // Restaura a conta real sem alterar para a conta de outro usuário
  currentUser = realUser;
  adminOriginalUser = null;
  isViewingOtherUser = false;
  localStorage.removeItem('nexus_viewing_user');

  if (currentUser.role === 'Administrador') {
    const hashPage = window.location.hash ? window.location.hash.replace('#', '') : null;
    const savedPage = localStorage.getItem('nexus_current_page');
    const pageTarget = hashPage || savedPage || currentPage;
    if (pageTarget === 'logs') {
      currentPage = 'logs';
    } else {
      currentPage = 'usuarios';
    }
  }

  await loadUserData();
  if (typeof render === 'function') render();
})();
</script>
</body>
</html>`;

// Persistência resiliente de Logs em Arquivo Local + Banco de Dados
const LOGS_FILE_PATH = path.join(__dirname, 'system_logs.json');
const LOCAL_DATA_PATH = path.join(__dirname, 'local_database_data.json');
const LOCAL_USERS_PATH = path.join(__dirname, 'local_users.json');

function getFileLogs() {
  try {
    if (fs.existsSync(LOGS_FILE_PATH)) {
      const data = fs.readFileSync(LOGS_FILE_PATH, 'utf8');
      return JSON.parse(data) || [];
    }
  } catch (e) {
    console.error('Erro ao ler system_logs.json:', e);
  }
  return [];
}

function saveFileLogEntry(entry) {
  try {
    const list = getFileLogs();
    list.unshift(entry);
    if (list.length > 1000) list.pop();
    fs.writeFileSync(LOGS_FILE_PATH, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Erro ao escrever system_logs.json:', e);
  }
}

function recordSystemLog(userName, userEmail, action, entity, details) {
  const logObj = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    user_name: userName || 'Sistema',
    user_email: userEmail || 'sistema@nexus.com',
    action: action || 'Ação',
    entity: entity || 'Sistema',
    details: details || 'Alteração registrada no sistema'
  };

  saveFileLogEntry(logObj);

  pool.query(
    `INSERT INTO system_logs (timestamp, user_name, user_email, action, entity, details)
     VALUES (now(), $1, $2, $3, $4, $5)`,
    [logObj.user_name, logObj.user_email, logObj.action, logObj.entity, logObj.details]
  ).catch(err => {
    // Gravado no arquivo system_logs.json caso o banco falhe
  });
}

function getLocalUsers() {
  try {
    if (fs.existsSync(LOCAL_USERS_PATH)) {
      const content = fs.readFileSync(LOCAL_USERS_PATH, 'utf8');
      return JSON.parse(content) || [];
    }
  } catch (e) {}
  return [DEFAULT_ADMIN];
}

function saveLocalUsers(users) {
  try {
    fs.writeFileSync(LOCAL_USERS_PATH, JSON.stringify(users, null, 2), 'utf8');
  } catch (e) {}
}

function getLocalData(email) {
  try {
    if (fs.existsSync(LOCAL_DATA_PATH)) {
      const allData = JSON.parse(fs.readFileSync(LOCAL_DATA_PATH, 'utf8')) || {};
      return allData[email.toLowerCase().trim()] || null;
    }
  } catch (e) {}
  return null;
}

function saveLocalData(email, data) {
  try {
    let allData = {};
    if (fs.existsSync(LOCAL_DATA_PATH)) {
      allData = JSON.parse(fs.readFileSync(LOCAL_DATA_PATH, 'utf8')) || {};
    }
    allData[email.toLowerCase().trim()] = data;
    fs.writeFileSync(LOCAL_DATA_PATH, JSON.stringify(allData, null, 2), 'utf8');
  } catch (e) {}
}

// Servidor HTTP de Alta Performance e Resiliência
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Cabeçalhos globais de CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  // Rota POST para Login de Usuário
  if (req.method === 'POST' && parsedUrl.pathname === '/api/login') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { email, password } = JSON.parse(body);
        if (!email || !password) {
          res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'E-mail e senha são obrigatórios' }));
        }

        let user = null;
        try {
          const result = await pool.query(
            'SELECT id, name, email, password, role, active FROM usuarios WHERE LOWER(email) = LOWER($1)',
            [email]
          );
          if (result.rows.length > 0) user = result.rows[0];
        } catch (dbErr) {
          console.warn('[AVISO BD] Falha ao consultar PostgreSQL. Usando banco local.');
          const localUsers = getLocalUsers();
          user = localUsers.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
        }

        if (!user || user.password !== password) {
          res.writeHead(401, { ...corsHeaders, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'E-mail ou senha incorretos!' }));
        }

        if (user.active === false) {
          res.writeHead(403, { ...corsHeaders, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Seu usuário foi desativado pelo administrador.' }));
        }

        recordSystemLog(user.name, user.email, 'Login', 'Autenticação', 'Usuário realizou login com sucesso no sistema');

        const token = 'token_' + Date.now() + '_' + Math.random().toString(36).substring(2);
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          token: token,
          user: { id: user.id || Date.now(), name: user.name, email: user.email, role: user.role }
        }));
      } catch (err) {
        console.error('Erro no endpoint de login:', err);
        res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Falha no servidor durante a autenticação.' }));
      }
    });
    return;
  }

  // Rota POST para Cadastro de Usuário
  if (req.method === 'POST' && parsedUrl.pathname === '/api/register') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { name, email, password } = JSON.parse(body);
        if (!name || !email || !password) {
          res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Todos os campos são obrigatórios' }));
        }

        const cleanEmail = email.toLowerCase().trim();
        let isExisting = false;
        try {
          const existing = await pool.query(
            'SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1)',
            [cleanEmail]
          );
          if (existing.rows.length > 0) isExisting = true;
        } catch (dbErr) {
          const localUsers = getLocalUsers();
          if (localUsers.some(u => u.email.toLowerCase() === cleanEmail)) isExisting = true;
        }

        if (isExisting) {
          res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Este e-mail já está cadastrado!' }));
        }

        try {
          await pool.query(
            'INSERT INTO usuarios (name, email, password, role, active) VALUES ($1, $2, $3, $4, $5)',
            [name, cleanEmail, password, 'Usuário', true]
          );
        } catch (e) {}

        const localUsers = getLocalUsers();
        localUsers.push({ id: Date.now(), name, email: cleanEmail, password, role: 'Usuário', active: true });
        saveLocalUsers(localUsers);

        recordSystemLog(name, cleanEmail, 'Cadastro', 'Autenticação', 'Novo usuário cadastrou-se no sistema');

        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, message: 'Conta criada com sucesso!' }));
      } catch (err) {
        console.error('Erro no endpoint de cadastro:', err);
        res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Falha no servidor durante o cadastro.' }));
      }
    });
    return;
  }

  // Rota POST para Enviar a Senha por E-mail
  if (req.method === 'POST' && parsedUrl.pathname === '/api/send-password') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { email } = JSON.parse(body);
        if (!email) {
          res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'E-mail é obrigatório' }));
        }

        let user = null;
        try {
          const result = await pool.query(
            'SELECT id, name, email, password FROM usuarios WHERE LOWER(email) = LOWER($1)',
            [email]
          );
          if (result.rows.length > 0) user = result.rows[0];
        } catch(e) {
          const localUsers = getLocalUsers();
          user = localUsers.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
        }

        if (!user) {
          res.writeHead(404, { ...corsHeaders, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'E-mail não cadastrado.' }));
        }

        let sendPassword = user.password;
        if (!sendPassword || sendPassword.length > 30 || sendPassword.includes(':')) {
          sendPassword = Math.floor(100000 + Math.random() * 900000).toString();
          pool.query('UPDATE usuarios SET password = $1 WHERE email = $2', [sendPassword, user.email]).catch(()=>{});
          const localUsers = getLocalUsers();
          const lu = localUsers.find(u => u.email.toLowerCase() === user.email.toLowerCase());
          if (lu) { lu.password = sendPassword; saveLocalUsers(localUsers); }
        }

        recordSystemLog(user.name, user.email, 'Recuperação', 'Autenticação', 'Solicitou recuperação de senha');

        const emailSent = await sendPasswordEmail(user.email, user.name, sendPassword);

        if (emailSent) {
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, mode: 'email' }));
        } else {
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ 
            success: true, 
            mode: 'direct', 
            tempPassword: sendPassword 
          }));
        }
      } catch (err) {
        console.error('Erro ao processar recuperação de senha:', err);
        res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Falha ao processar solicitação de senha.' }));
      }
    });
    return;
  }

  // Rota GET de Usuários
  if (req.method === 'GET' && parsedUrl.pathname === '/api/users') {
    pool.query('SELECT name, email, password, role, active FROM usuarios ORDER BY id ASC')
      .then(result => {
        saveLocalUsers(result.rows);
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.rows));
      })
      .catch(err => {
        console.warn('Usando lista de usuários do backup local:', err.message);
        const localUsers = getLocalUsers();
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(localUsers));
      });
    return;
  }

  // Rota POST de Usuários (Sincronização do Administrador)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/users') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const users = JSON.parse(body);
        if (!Array.isArray(users)) throw new Error('Formato inválido');

        saveLocalUsers(users);
        recordSystemLog('Administrador', 'admin@nexusfinanceiro.com', 'Sincronização', 'Usuários', 'Administrador atualizou a lista de usuários');

        try {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const emails = users.map(u => u.email);
            await client.query(
              `DELETE FROM usuarios WHERE email <> ALL($1::text[])`,
              [emails.length ? emails : ['__nunca__']]
            );

            for (const u of users) {
              await client.query(
                `INSERT INTO usuarios (name, email, password, role, active)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (email) DO UPDATE
                 SET name = EXCLUDED.name,
                     password = EXCLUDED.password,
                     role = EXCLUDED.role,
                     active = EXCLUDED.active;`,
                [u.name, u.email, u.password, u.role, u.active !== false]
              );
            }
            await client.query('COMMIT');
          } catch(e) {
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
        } catch(dbErr) {}

        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        console.error('Erro ao salvar usuários:', e);
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  // Rota GET de Logs de Auditoria
  if (req.method === 'GET' && parsedUrl.pathname === '/api/logs') {
    pool.query('SELECT id, timestamp, user_name, user_email, action, entity, details FROM system_logs ORDER BY id DESC LIMIT 500')
      .then(result => {
        const dbLogs = result.rows || [];
        const fileLogs = getFileLogs();
        const combinedMap = new Map();
        [...fileLogs, ...dbLogs].forEach(l => {
          const key = (l.user_email || '') + '_' + (l.action || '') + '_' + (l.entity || '') + '_' + (l.details || '');
          if (!combinedMap.has(key)) combinedMap.set(key, l);
        });
        const finalLogs = Array.from(combinedMap.values());
        finalLogs.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalLogs));
      })
      .catch(err => {
        const fileLogs = getFileLogs();
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fileLogs));
      });
    return;
  }

  // Rota POST de Logs de Auditoria
  if (req.method === 'POST' && parsedUrl.pathname === '/api/logs') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch(e) {
          try {
            parsed = url.parse('?' + body, true).query;
          } catch(e2){}
        }

        const action = parsed.action || parsed.act || 'Edição';
        const entity = parsed.entity || parsed.ent || 'Sistema';
        const details = parsed.details || parsed.desc || parsed.msg || body || 'Alteração efetuada no sistema';
        const userName = parsed.userName || parsed.user_name || parsed.name || 'Usuário';
        const userEmail = parsed.userEmail || parsed.user_email || parsed.email || '';

        recordSystemLog(userName, userEmail, action, entity, details);

        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      }
    });
    return;
  }

  // Rota GET para buscar dados financeiros do Usuário no banco
  if (req.method === 'GET' && parsedUrl.pathname === '/api/data') {
    const email = (parsedUrl.query.email || '').toLowerCase().trim();
    pool.query('SELECT dados FROM dados_financeiros WHERE LOWER(email) = LOWER($1)', [email])
      .then(result => {
        const serverData = result.rows[0] ? result.rows[0].dados : null;
        if (serverData) saveLocalData(email, serverData);
        const finalData = serverData || getLocalData(email);
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalData));
      })
      .catch(err => {
        const localData = getLocalData(email);
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(localData));
      });
    return;
  }

  // Rota POST para salvar dados financeiros do Usuário no banco
  if (req.method === 'POST' && parsedUrl.pathname === '/api/data') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false }));
      }
      if (!payload.email || !payload.data) {
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false }));
      }
      const cleanEmail = (payload.email || '').toLowerCase().trim();

      saveLocalData(cleanEmail, payload.data);
      recordSystemLog(cleanEmail, cleanEmail, 'Salvamento', 'Dados Financeiros', 'Atualizou dados financeiros no sistema');

      pool.query(
        `INSERT INTO dados_financeiros (email, dados, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (email) DO UPDATE
         SET dados = EXCLUDED.dados, updated_at = now();`,
        [cleanEmail, payload.data]
      ).catch(err => {
        console.warn('[AVISO BD] Falha ao salvar no PostgreSQL. Dados salvos com resiliência local.', err.message);
      });

      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // Suporte a arquivos estáticos (Imagens, Favicon, CSS, JS)
  const pathname = parsedUrl.pathname;
  if (pathname === '/favicon.ico') {
    const faviconPath = path.join(__dirname, 'favicon.ico');
    if (fs.existsSync(faviconPath)) {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'image/x-icon' });
      return fs.createReadStream(faviconPath).pipe(res);
    }
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  if (pathname.startsWith('/images/') || pathname.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|json)$/i)) {
    const safePath = path.normalize(path.join(__dirname, pathname)).replace(/^(\.\.[\/\\])+/, '');
    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath).toLowerCase();
      const mimeTypes = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json'
      };
      res.writeHead(200, { ...corsHeaders, 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      return fs.createReadStream(safePath).pipe(res);
    }
  }

  res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlContent);
});

initDatabase()
  .then(() => {
    console.log(`[BANCO] Conectado com sucesso ao PostgreSQL (banco: ${process.env.DB_NAME || 'FINANCEIRO'})`);
  })
  .catch(err => {
    console.warn(`[BANCO AVISO] PostgreSQL indisponível. O sistema funcionará com alta resiliência e fallback JSON local: ${err.message}`);
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`==================================================`);
      console.log(`🚀 Servidor Nexus Financeiro Hub rodando na porta ${PORT}`);
      console.log(`📋 Logs do banco disponíveis em tempo real no VS Code: system_logs.json`);
      console.log(`==================================================`);
    });
  });

