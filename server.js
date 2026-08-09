require('dotenv').config();
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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script>
(function() {
  try {
    var s = localStorage.getItem('nexus_session') || localStorage.getItem('nexus_cached_user');
    if (s) {
      document.documentElement.classList.add('user-logged-in');
    }
  } catch(e){}
})();
</script>
<style>
html.user-logged-in #authPage { display: none !important; }
html.user-logged-in #appMain { display: block !important; }

:root{
  --bg:#0b0e12; --sidebar:#0e1116; --card:#141821; --card-border:#1f2530;
  --text:#e9edf3; --text-dim:#8a93a3; --text-faint:#5b6472;
  --green:#e8b04b; --green-soft:rgba(232,176,75,.14);
  --red:#ef5a5a; --red-soft:rgba(239,90,90,.12);
  --blue:#4a90e2; --purple:#9b6bd8; --orange:#f0a63a; --teal:#3ec7c7; --pink:#d85bb0;
  --hover:#1a1f29;
  --radius:14px;
  --shadow:0 8px 24px rgba(0,0,0,.35);
}
body.light{
  --bg:#f4f6f9; --sidebar:#ffffff; --card:#ffffff; --card-border:#e6e9ef;
  --text:#1b2028; --text-dim:#6b7280; --text-faint:#9aa2b1;
  --hover:#eef1f6;
  --shadow:0 6px 18px rgba(20,30,60,.08);
}
*{box-sizing:border-box; margin:0; padding:0;}
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

/* ==================== Tela de Auth (Dourado/Âmbar) ==================== */
.auth-container{
  --auth-accent:#e8b04b; --auth-accent-2:#c9862a; --auth-accent-3:#f6d999;
  --auth-accent-soft:rgba(232,176,75,.16); --auth-text-on:#1f1400;
  position:relative; overflow:hidden;
  display:none; align-items:center; justify-content:center; min-height:100vh; padding:20px;
  background:
    radial-gradient(circle at top right, rgba(232,176,75,0.12), transparent 42%),
    radial-gradient(circle at bottom left, rgba(201,134,42,0.10), transparent 48%),
    linear-gradient(165deg, #090b10 0%, #0d1016 45%, #14100a 100%);
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
  background:var(--card); border:1px solid var(--card-border); border-radius:18px;
  padding:36px; width:100%; max-width:400px;
  box-shadow:var(--shadow), 0 0 0 1px rgba(232,176,75,.06);
  animation:authIn .55s cubic-bezier(.16,1,.3,1);
}
.auth-box .brand{display:flex; justify-content:center; margin-bottom:24px; padding:0;}
.auth-box .brand .logo{
  background:linear-gradient(135deg,var(--auth-accent),var(--auth-accent-2)) !important; color:var(--auth-text-on) !important;
  animation:logoPulse 3s ease-in-out infinite;
}
@keyframes logoPulse{
  0%,100%{box-shadow:0 0 0 0 rgba(232,176,75,.45);}
  50%{box-shadow:0 0 0 9px rgba(232,176,75,0);}
}
.auth-box h2{font-size:20px; font-weight:700; margin-bottom:6px; text-align:center;}
.auth-box p.sub{font-size:13px; color:var(--text-dim); text-align:center; margin-bottom:24px; transition:color .2s;}
.auth-box .field{margin-bottom:16px; animation:fieldIn .45s ease backwards;}
.auth-box .field:nth-of-type(1){animation-delay:.05s;}
.auth-box .field:nth-of-type(2){animation-delay:.1s;}
.auth-box .field input:focus, .auth-box .field select:focus{
  border-color:var(--auth-accent); box-shadow:0 0 0 3px var(--auth-accent-soft); transform:translateY(-1px);
}
.auth-box .field input{transition:border-color .2s, box-shadow .2s, transform .15s;}
.auth-forgot{display:block; text-align:right; font-size:12px; color:var(--text-dim); margin-top:8px; cursor:pointer; transition:color .15s;}
.auth-forgot:hover{color:var(--auth-accent); text-decoration:underline;}
.auth-box .btn-auth{
  position:relative; overflow:hidden;
  width:100%; padding:12px; background:linear-gradient(135deg,var(--auth-accent),var(--auth-accent-2)); color:var(--auth-text-on); border:none;
  border-radius:10px; font-weight:700; font-size:14px; cursor:pointer; margin-top:8px;
  transition:filter .2s, transform .15s;
}
.auth-box .btn-auth::after{
  content:''; position:absolute; top:0; left:-75%; width:45%; height:100%;
  background:linear-gradient(120deg, transparent, rgba(255,255,255,.45), transparent);
  transform:skewX(-20deg);
}
.auth-box .btn-auth:hover{filter:brightness(1.08); transform:translateY(-1px);}
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

/* ==================== Cabeçalho superior (nav horizontal) ==================== */
.topheader{
  position:sticky; top:0; z-index:50; background:var(--sidebar); border-bottom:1px solid var(--card-border);
  backdrop-filter:blur(10px);
}
.topheader-row{
  display:flex; align-items:center; gap:20px; padding:15px 28px; max-width:1440px; margin:0 auto;
}
.brand{display:flex; align-items:center; gap:11px; flex-shrink:0;}
.brand .logo{
  width:42px; height:42px; border-radius:11px; background:linear-gradient(135deg,var(--green),#c9862a);
  display:flex; align-items:center; justify-content:center; font-weight:800; color:#08130c; font-size:18px; flex-shrink:0;
}
.brand .name{font-weight:700; font-size:16px; line-height:1.25; white-space:nowrap;}
.brand .name span{display:block; color:var(--green); font-size:11px; letter-spacing:.06em; font-weight:700;}

nav.menu{
  display:flex; align-items:center; flex-wrap:nowrap; gap:4px; width:100%;
  padding:0 16px 10px; max-width:1440px; margin:0 auto;
  overflow-x:auto; scrollbar-width:thin;
}
nav.menu::-webkit-scrollbar{height:5px;}
nav.menu::-webkit-scrollbar-thumb{background:var(--card-border); border-radius:10px;}
.menu button{
  display:flex; align-items:center; gap:7px; text-align:left; background:none; border:none;
  color:var(--text-dim); padding:11px 12px; border-radius:10px; font-size:14.5px; font-weight:600; cursor:pointer;
  transition:background .15s,color .15s; white-space:nowrap; flex-shrink:0;
}
.menu button:hover{background:var(--hover); color:var(--text);}
.menu button.active{background:var(--green-soft); color:var(--green); font-weight:700;}
.menu button .ic{width:18px; text-align:center; font-size:15.5px; flex-shrink:0;}

/* ==================== Logo / Crédito de Desenvolvimento ==================== */
.auth-dev-credit{
  position:absolute; left:0; right:0; bottom:18px; z-index:10;
  display:flex; justify-content:center; pointer-events:none;
}
.app-dev-credit{
  position:fixed; left:0; right:0; bottom:0; z-index:100;
  display:flex; justify-content:center; padding:8px 16px;
  background:rgba(11,14,18,0.95); border-top:1px solid var(--card-border); backdrop-filter:blur(10px);
}
.dev-chip{
  position:relative;
  pointer-events:auto; display:inline-flex; align-items:center; gap:8px;
  background:linear-gradient(135deg, rgba(24,20,12,0.9), rgba(12,11,8,0.92));
  border:1px solid rgba(232,176,75,.35);
  border-radius:999px;
  padding:5px 16px 5px 5px; box-shadow:0 2px 10px rgba(0,0,0,.25);
}
.app-dev-credit .dev-chip{background:linear-gradient(135deg, rgba(24,20,12,0.92), rgba(12,11,8,0.94));}
.dev-chip .dev-avatar{
  width:24px; height:24px; border-radius:50%; flex-shrink:0;
  background:linear-gradient(135deg, #f6d999, #e8b04b, #c9862a);
  display:flex; align-items:center; justify-content:center;
  font-size:9.5px; font-weight:800; color:#08130c; letter-spacing:0;
}
.dev-chip .dev-text{display:flex; align-items:baseline; gap:5px; line-height:1;}
.dev-chip .dev-text small{font-size:9.5px; color:var(--text-faint); letter-spacing:.05em; font-weight:600;}
.dev-chip .dev-text strong{
  font-size:12.5px; font-weight:700; letter-spacing:.01em; color:var(--green);
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
.user .uname{font-size:15.5px; font-weight:700; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:170px;}
.user .urole{font-size:12px; color:var(--text-faint); white-space:nowrap;}
.topheader-row .btn-ghost{padding:10px 18px; font-size:13px; flex-shrink:0;}

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

.overlay{position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; align-items:center; justify-content:center; z-index:100; padding:20px;}
.overlay.show{display:flex;}
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
@media(max-width:1150px){
  .grid3{grid-template-columns:1fr 1fr;}
  .grid3 > :nth-child(3){grid-column:1/-1;}
  .kpis{grid-template-columns:repeat(3,1fr);}
}
@media(max-width:820px){
  .kpis{grid-template-columns:repeat(2,1fr);}
  .grid3{grid-template-columns:1fr;}
  .topheader-row{padding:10px 16px; gap:12px;}
  nav.menu{padding:0 16px 10px;}
  .menu button{font-size:14px; padding:10px 12px;}
  .brand .name{font-size:14px;}
}
@media(max-width:480px){
  .main{padding:16px 14px 60px;}
  .kpis{grid-template-columns:1fr 1fr;}
  .topbar{gap:8px;}
  .page-head h1{font-size:19px;}
  .brand .name span{display:none;}

  /* Cadastro/edição em modal mais fácil de usar no celular */
  .overlay{align-items:flex-end; padding:0;}
  .modal{max-width:100%; width:100%; border-radius:20px 20px 0 0; max-height:94vh; padding:20px 16px 22px;}
  .field-row{flex-direction:column; gap:0;}
  .field-row .field{margin-bottom:14px;}
  .field{margin-bottom:16px;}
  .field label{font-size:12.5px; margin-bottom:7px;}
  .field input, .field select{font-size:16px; padding:12px 13px;}
  .toggle-type button{padding:12px; font-size:13.5px;}
  .modal-actions{position:sticky; bottom:-1px; background:var(--card); padding-top:6px; margin-top:14px;}
  .modal-actions button{padding:13px; font-size:14px;}
  .close-x{top:14px; right:14px; font-size:20px; padding:4px 6px;}

  /* Tabelas: rolagem horizontal em vez de espremer as colunas */
  .table-panel{padding:14px 12px;}
  table{min-width:640px;}
  .filters input, .filters select{font-size:16px; padding:10px 12px;}
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
      <span class="dev-text"><small>Desenvolvedor</small><strong>Paulo Lima</strong></span>
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
      <div class="brand">
        <div class="logo">N</div>
        <div class="name">NEXUS<span>FINANCEIRO HUB</span></div>
      </div>
      <div class="right" style="margin-left:auto;">
        <div class="notif-wrap">
          <div class="icon-btn" id="notifBtn">🔔<span class="dot" id="notifDot" style="display:none;"></span></div>
          <div class="notif-panel" id="notifPanel">
            <div class="notif-panel-head">
              <h4>Notificações</h4>
              <button class="notif-markall" id="notifMarkAllBtn">Marcar todas como lidas</button>
            </div>
            <div class="notif-list" id="notifList"></div>
          </div>
        </div>
        <div class="icon-btn" id="miniThemeBtn">🌙</div>
        <div class="user" id="userMenu" data-nav="config">
          <div class="avatar" id="headerAvatar">PL</div>
          <div><div class="uname" id="headerName">Paulo Lima</div><div class="urole" id="headerRole">Usuário</div></div>
        </div>
        <button class="btn-ghost" id="logoutBtn">Sair</button>
      </div>
    </div>
    <nav class="menu" id="menu">
      <button data-page="dashboard" class="active"><span class="ic">▦</span> Dashboard</button>
      <button data-page="transacoes"><span class="ic">⇄</span> Transações</button>
      <button data-page="cartoes"><span class="ic">▭</span> Cartões</button>
      <button data-page="orcamentos"><span class="ic">◔</span> Orçamentos</button>
      <button data-page="metas"><span class="ic">◎</span> Metas</button>
      <button data-page="relatorios"><span class="ic">▥</span> Relatórios</button>
      <button data-page="recorrentes"><span class="ic">↻</span> Recorrentes</button>
      <button data-page="importar"><span class="ic">⇥</span> Importar</button>
      <button data-page="anexos"><span class="ic">📎</span> Anexos</button>
      <button data-page="config"><span class="ic">⚙</span> Configurações</button>
      <button data-page="usuarios" id="menuUsuariosBtn" style="display:none;"><span class="ic">👥</span> Usuários Cadastrados</button>
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
      <div class="field"><label>Saldo (R$)</label><input id="accBalance" type="number" step="0.01" placeholder="0,00"></div>
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
  const data = localStorage.getItem(key);
  return data ? JSON.parse(data) : defaultVal;
}
function saveToStorage(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
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

function applyDataPayload(data) {
  if (!data) return;
  categories = data.categories || [];
  accounts = data.accounts || [];
  transactions = data.transactions || [];
  budgets = data.budgets || [];
  goals = data.goals || [];
  recurringList = data.recurringList || [];
  alerts = data.alerts || [];
  attachments = data.attachments || [];
  notifications = data.notifications || [];
  nextAccId = data.nextAccId || 10;
  nextTxId = data.nextTxId || 10;
  nextBudgetId = data.nextBudgetId || 10;
  nextGoalId = data.nextGoalId || 10;
  nextRecId = data.nextRecId || 10;
  nextAlertId = data.nextAlertId || 10;
  nextAttId = data.nextAttId || 10;
  nextNotifId = data.nextNotifId || 10;
  migrateCategories();
}

let isDataLoading = false;

async function loadUserData() {
  if (!currentUser) return;
  const userKey = 'nexus_data_' + currentUser.email;
  
  // 1. Carrega dados do cache local instantaneamente se disponíveis
  let localData = loadFromStorage(userKey, null);
  if (localData) {
    applyDataPayload(localData);
    isDataLoading = false;
    if (typeof render === 'function') render();
  } else {
    isDataLoading = true;
  }

  // 2. Sincroniza em segundo plano com o servidor
  try {
    const res = await fetch(window.location.origin + '/api/data?email=' + encodeURIComponent(currentUser.email));
    if (res.ok) {
      const serverData = await res.json();
      if (serverData) {
        applyDataPayload(serverData);
        saveToStorage(userKey, serverData);
      }
    } else if (!localData) {
      categories = BASE_CATEGORIES.map(c=>({...c, count:0}));
      accounts = [];
      transactions = [];
      budgets = [];
      goals = [];
      recurringList = [];
      alerts = [];
      attachments = [];
      notifications = [];
      nextAccId = 1; nextTxId = 1; nextBudgetId = 1; nextGoalId = 1; nextRecId = 1; nextAlertId = 1; nextAttId = 1; nextNotifId = 1;
      await saveUserData();
    }
  } catch(e) {
    if (!localData) {
      categories = BASE_CATEGORIES.map(c=>({...c, count:0}));
      accounts = [];
      transactions = [];
      budgets = [];
      goals = [];
      recurringList = [];
      alerts = [];
      attachments = [];
      notifications = [];
      nextAccId = 1; nextTxId = 1; nextBudgetId = 1; nextGoalId = 1; nextRecId = 1; nextAlertId = 1; nextAttId = 1; nextNotifId = 1;
      await saveUserData();
    }
  } finally {
    isDataLoading = false;
  }
  if (typeof render === 'function' && document.getElementById('appMain') && document.getElementById('appMain').classList.contains('show')) {
    render();
  }
}

async function saveUserData() {
  if (!currentUser) return;
  if (isViewingOtherUser) return;
  const payloadData = {
    categories, accounts, transactions, budgets, goals, recurringList, alerts, attachments, notifications,
    nextAccId, nextTxId, nextBudgetId, nextGoalId, nextRecId, nextAlertId, nextAttId, nextNotifId
  };
  
  const userKey = 'nexus_data_' + currentUser.email;
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
  const target = registeredUsers.find(u => u.email === email);
  if(!target || target.email === currentUser.email) return;

  if(!isViewingOtherUser){
    await saveUserData();
    adminOriginalUser = currentUser;
  }
  currentUser = target;
  isViewingOtherUser = true;
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
  await loadUserData();
  currentPage = 'usuarios';
  render();
  showToast('Você voltou para sua conta.');
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
  render();
}

/* ==================== Período ==================== */
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const YEARS = [2026,2027,2028,2029];
const PERIOD_MIN = {year:2026, month:1};
const PERIOD_MAX = {year:2029, month:12};
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
let currentPage='dashboard';
let charts = {};

const fmt = v => 'R$ ' + (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2});
const catColor = name => (categories.find(c=>c.name===name)||{}).color || '#888';
const catIcon = name => { const c = categories.find(c=>c.name===name); return (c && c.icon) || '📁'; };
function catOptionsHTML(type, selected){
  let list = type ? categories.filter(c=>(c.type||'despesa')===type) : categories.slice();
  list = list.slice().sort((a,b)=> (b.count||0)-(a.count||0) || a.name.localeCompare(b.name,'pt-BR'));
  return list.map(c=>'<option value="'+c.name+'"'+(selected===c.name?' selected':'')+'>'+(c.icon||'📁')+' '+c.name+'</option>').join('');
}
const periodLabel = ()=> MONTHS[currentPeriod.month-1] + ' / ' + currentPeriod.year;
const inPeriod = t => { const d=new Date(t.date+'T00:00'); return (d.getMonth()+1)===currentPeriod.month && d.getFullYear()===currentPeriod.year; };

/* ==================== Cálculos ==================== */
function computeTotals(list=transactions){
  const receitas = list.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0);
  const despesas = list.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0);
  const saldo = accounts.reduce((s,a)=>s+a.balance,0);
  return {receitas, despesas, saldo};
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
  const tableWrap = document.getElementById('txTableWrap');
  if(!search || !tableWrap) return false;
  let list = transactions.slice();
  const q = search.value.toLowerCase();
  if(q) list = list.filter(t=>t.desc.toLowerCase().includes(q));
  if(fTipo.value) list = list.filter(t=>t.type===fTipo.value);
  if(fCat.value) list = list.filter(t=>t.cat===fCat.value);
  if(fStatus.value) list = list.filter(t=>t.status===fStatus.value);
  list.sort((a,b)=>b.date.localeCompare(a.date));
  tableWrap.innerHTML = transactionsTable(list, true);
  const statsRow = document.getElementById('txStatsRow'); if(statsRow) statsRow.innerHTML = txStatsCardsHTML(list);
  document.querySelectorAll('[data-edit]').forEach(el=>el.onclick = ()=>openModal(parseInt(el.getAttribute('data-edit'))));
  document.querySelectorAll('[data-del]').forEach(el=>el.onclick = ()=>deleteTransaction(parseInt(el.getAttribute('data-del'))));
  return true;
}

/* ==================== Render Suave sem Flickering ==================== */
async function render(){
  const el = document.getElementById('pageContent');
  if (!el) return;

  let newHTML = '';
  if(currentPage==='usuarios') {
    await syncUsersWithServer();
    newHTML = pageUsuarios();
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

  requestAnimationFrame(() => {
    el.innerHTML = newHTML;
    attachPageEvents();
    updateHeaderUser();
    renderNotifications();
    updateViewModeBanner();
    updateAdminMenuVisibility();
    if(currentPage==='dashboard') drawDashboardCharts();
  });
}

function updateAdminMenuVisibility(){
  const btn = document.getElementById('menuUsuariosBtn');
  if(!btn) return;
  const isAdmin = currentUser && currentUser.role === 'Administrador';
  btn.style.display = (isAdmin && !isViewingOtherUser) ? '' : 'none';
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
  if(avatarEl) avatarEl.textContent = currentUser.name.trim().split(/\\s+/).map(n=>n[0]).slice(0,2).join('').toUpperCase();
}

function periodPickerHTML(){
  return \`
  <div class="period-wrap">
    <button type="button" class="period" id="periodBtn">
      <span class="period-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="3"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="8" y1="2.5" x2="8" y2="6.5"/><line x1="16" y1="2.5" x2="16" y2="6.5"/><circle cx="8" cy="14" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="14" r="1.1" fill="currentColor" stroke="none"/></svg></span>
      <span class="period-text">\${MONTHS[currentPeriod.month-1]} <span class="period-year">/ \${currentPeriod.year}</span></span>
      <svg class="period-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="period-panel" id="periodPanel">
      <button type="button" class="period-today-btn" id="periodTodayBtn">📍 Ir para o mês atual</button>
      <div class="field"><label>Ano</label><select id="periodYearSel"></select></div>
      <div class="field"><label>Mês</label><select id="periodMonthSel"></select></div>
      <button class="btn-primary" id="periodApplyBtn" style="width:100%;justify-content:center">Aplicar</button>
    </div>
  </div>\`;
}

/* ==================== Dashboard ==================== */
function pageDashboard(){
  const periodTx = transactions.filter(inPeriod);
  const {receitas,despesas,saldo} = computeTotals(periodTx);
  const cats = despesasPorCategoria(periodTx);
  const totalDesp = cats.reduce((s,c)=>s+c.val,0)||1;
  const recPct = Math.round(receitas/(receitas+despesas||1)*100) || 0;
  const despPct = 100-recPct;
  const lastTx = periodTx.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
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
        \${accounts.map(a=>\`
          <div class="acc-row">
            <div class="acc-ic" style="background:\${a.color}">\${a.name.slice(0,2).toUpperCase()}</div>
            <div class="acc-info"><div class="n">\${a.name}</div><div class="t">\${a.type}</div></div>
            <div class="acc-val \${a.balance<0?'neg':''}">\${a.balance<0?'-':''}\${fmt(Math.abs(a.balance))}</div>
            <button class="acc-edit" data-editacc="\${a.id}">✎</button>
          </div>\`).join('')}
      </div>
      <button class="btn-ghost" style="width:100%" data-nav="cartoes">Ver todas as contas</button>
    </div>
  </div>

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
  if(list.length===0) return \`<div class="placeholder"><div class="big">🗂️</div><h3>Nenhuma transação encontrada</h3><p>Tente ajustar os filtros, o período ou adicione uma nova transação.</p></div>\`;
  return \`
  <table>
    <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th>Valor</th><th>Status</th>\${showActions?'<th></th>':''}</tr></thead>
    <tbody>
      \${list.map(t=>\`
        <tr class="trow">
          <td>\${new Date(t.date+'T00:00').toLocaleDateString('pt-BR')}</td>
          <td>\${t.desc}</td>
          <td><span class="pill" style="background:\${catColor(t.cat)}22; color:\${catColor(t.cat)}">\${catIcon(t.cat)} \${t.cat}</span></td>
          <td><span class="type-ic \${t.type}">\${t.type==='in'?'↑':'↓'}</span></td>
          <td class="\${t.type==='in'?'val-in':'val-out'}">\${t.type==='in'?'+':'-'}\${fmt(t.val)}</td>
          <td><span class="pill status-\${t.status.toLowerCase()}">\${t.status}</span></td>
          \${showActions?\`<td><div class="row-actions"><button data-edit="\${t.id}">✎</button><button data-del="\${t.id}">🗑</button></div></td>\`:''}
        </tr>\`).join('')}
    </tbody>
  </table>\`;
}

function pageTransacoes(){
  return \`
  <div class="page-head">
    <div><h1>Transações</h1><p>Gerencie todas as suas receitas e despesas</p></div>
    <div class="head-actions">
      <button class="btn-ghost" id="btnGerenciarCategorias">🏷️ Categorias</button>
      <button class="btn-primary" id="btnNovaTransacao">+ Nova Transação</button>
    </div>
  </div>
  <div class="table-panel">
    <div class="filters">
      <input id="txSearch" placeholder="Buscar por descrição...">
      <select id="txFiltroTipo"><option value="">Todos os tipos</option><option value="in">Receitas</option><option value="out">Despesas</option></select>
      <select id="txFiltroCat"><option value="">Todas categorias</option>\${catOptionsHTML(null)}</select>
      <select id="txFiltroStatus"><option value="">Todos status</option><option>Pago</option><option>Recebido</option><option>Pendente</option></select>
    </div>
    <div id="txTableWrap">\${transactionsTable(transactions.slice().sort((a,b)=>b.date.localeCompare(a.date)), true)}</div>
  </div>\`;
}

function pageContas(){
  const list = accounts;
  return \`
  <div class="page-head">
    <div><h1>Cartões</h1><p>Cadastre suas contas e cartões — corrente, poupança, crédito, investimento</p></div>
    <div class="head-actions"><button class="btn-primary" id="btnNovaConta">+ Novo Cartão/Conta</button></div>
  </div>
  <div class="grid3" style="grid-template-columns:repeat(3,1fr);">
    \${list.length? list.map(a=>\`
      <div class="acc-card">
        <div class="top">
          <div class="id-group" style="display:flex;align-items:center;gap:10px;min-width:0;">
            <span class="acc-ic" style="background:\${a.color};">\${a.name.slice(0,2).toUpperCase()}</span>
            <h3 style="font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${a.name}</h3>
          </div>
          <div class="row-actions"><button data-editacc="\${a.id}" title="Editar">✎</button><button data-delacc="\${a.id}" title="Excluir">🗑</button></div>
        </div>
        <p style="color:var(--text-faint);font-size:12px;margin-bottom:8px;">\${a.type}</p>
        <div class="val" style="font-size:22px;font-weight:700;color:\${a.balance<0?'var(--red)':'var(--green)'}">\${a.balance<0?'-':''}\${fmt(Math.abs(a.balance))}</div>
      </div>\`).join('') : \`<div class="placeholder"><div class="big">🏦</div><h3>Nenhuma conta cadastrada</h3></div>\`}
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
        <p style="color:var(--text-faint);font-size:11.5px;margin-bottom:10px;">Prazo: \${new Date(g.deadline+'T00:00').toLocaleDateString('pt-BR')}</p>
        <div class="val" style="font-size:18px;">\${fmt(g.current)} <span style="color:var(--text-faint);font-size:12px;font-weight:400"> / \${fmt(g.target)}</span></div>
        <div class="bar-split" style="background:var(--card-border);margin-top:10px"><div class="g" style="width:\${pct}%"></div></div>
        <div class="split-labels" style="margin-top:6px"><span>\${pct}% concluído</span></div>
        <button class="btn-ghost" style="width:100%;margin-top:12px" data-addcontrib="\${g.id}">+ Adicionar valor</button>
      </div>\`;
    }).join('') : \`<div class="placeholder"><div class="big">◎</div><h3>Nenhuma meta cadastrada</h3></div>\`}
  </div>\`;
}

function pageRelatorios(){
  const allCats = despesasPorCategoria(transactions);
  const totalReceitas = transactions.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0);
  const totalDespesas = transactions.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0);
  return \`
  <div class="page-head"><div><h1>Relatórios</h1><p>Consolidado geral de todas as transações cadastradas</p></div></div>
  <div class="kpis" style="grid-template-columns:repeat(3,1fr);">
    <div class="kpi"><div class="row1">Total de Receitas</div><div class="val" style="color:var(--green)">\${fmt(totalReceitas)}</div></div>
    <div class="kpi"><div class="row1">Total de Despesas</div><div class="val" style="color:var(--red)">\${fmt(totalDespesas)}</div></div>
    <div class="kpi"><div class="row1">Resultado</div><div class="val" style="color:\${(totalReceitas-totalDespesas)<0?'var(--red)':'var(--green)'}">\${fmt(totalReceitas-totalDespesas)}</div></div>
  </div>
  <div class="table-panel">
    <div class="panel-head"><h3>Despesas por Categoria (geral)</h3></div>
    \${allCats.length? \`<table><thead><tr><th>Categoria</th><th>Total Gasto</th><th>% do Total</th></tr></thead>
    <tbody>\${allCats.map(c=>\`<tr class="trow"><td><span class="pill" style="background:\${c.color}22;color:\${c.color}">\${c.name}</span></td><td class="val-out">\${fmt(c.val)}</td><td>\${Math.round(c.val/(totalDespesas||1)*100)}%</td></tr>\`).join('')}</tbody></table>\`
    : \`<div class="placeholder"><div class="big">▥</div><h3>Nenhum dado disponível</h3></div>\`}
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
  <div class="page-head"><div><h1>Anexos</h1><p>Comprovantes e recibos vinculados às transações</p></div></div>
  <div class="panel">
    <div class="field-row">
      <div class="field"><label>Transação vinculada</label><select id="attTx">\${sortedTx.map(t=>\`<option value="\${t.id}">\${new Date(t.date+'T00:00').toLocaleDateString('pt-BR')} — \${t.desc}</option>\`).join('')}</select></div>
      <div class="field"><label>Arquivo</label><input type="file" id="attFile" accept="image/*,.pdf"></div>
    </div>
    <button class="btn-primary" id="btnAddAnexo">+ Anexar</button>
  </div>
  <div class="cat-cards" style="margin-top:16px;">
    \${attachments.length? attachments.map(a=>{
      const t = transactions.find(x=>x.id===a.txId);
      return \`<div class="cat-card">
        <div class="row-actions"><button data-delatt="\${a.id}">🗑</button></div>
        \${a.dataUrl ? \`<img src="\${a.dataUrl}" style="width:100%;height:90px;object-fit:cover;border-radius:8px;margin-bottom:8px;">\` : \`<div style="font-size:28px;margin-bottom:8px;">📎</div>\`}
        <h4 style="font-size:12.5px;">\${a.name}</h4>
        <p style="color:var(--text-faint);font-size:11px;margin-top:4px;">\${t? t.desc : 'Transação removida'}</p>
      </div>\`;
    }).join('') : \`<div class="placeholder"><div class="big">📎</div><h3>Nenhum anexo enviado</h3></div>\`}
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
      <div class="field"><label>Nome</label><input id="cfgName" value="\${currentUser ? currentUser.name : ''}" placeholder="Seu nome completo"></div>
      <div class="field"><label>E-mail</label><input id="cfgEmail" type="text" value="\${currentUser ? currentUser.email : ''}" placeholder="seu.email@exemplo.com"></div>
      <div class="field" style="margin-bottom:0;"><label>Tema</label>
        <select id="cfgTheme"><option value="dark">Escuro</option><option value="light">Claro</option></select>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Alterar Senha</h3></div>
      <p class="cfg-hint">Deixe em branco para manter a senha atual</p>
      <div class="field">
        <label>Nova Senha</label>
        <div class="pass-field">
          <input id="cfgPassword" type="password" placeholder="••••••••" minlength="6">
          <button type="button" class="pass-toggle" id="cfgPasswordToggle" tabindex="-1" aria-label="Mostrar senha">\${EYE_ICON}</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Confirmar Nova Senha</label>
        <div class="pass-field">
          <input id="cfgPasswordConfirm" type="password" placeholder="••••••••" minlength="6">
          <button type="button" class="pass-toggle" id="cfgPasswordConfirmToggle" tabindex="-1" aria-label="Mostrar senha">\${EYE_ICON}</button>
        </div>
      </div>
    </div>
  </div>
  <div class="cfg-save-bar"><button class="btn-primary" id="btnSalvarConfig">Salvar Alterações</button></div>\`}\`;
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
            <div class="stats">\${stats.hasData ? \`\${stats.txCount} transaç\${stats.txCount===1?'ão':'ões'} · \${stats.accCount} conta\${stats.accCount===1?'':'s'} · \${stats.budCount} orçamento\${stats.budCount===1?'':'s'} · \${stats.goalCount} meta\${stats.goalCount===1?'':'s'}\${stats.lastDate ? \` · última mov. em \${new Date(stats.lastDate+'T00:00').toLocaleDateString('pt-BR')}\` : ''}\` : 'Ainda sem atividade registrada'}</div>
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

/* ==================== Modais e Ações de Dados ==================== */
function openModal(id){
  if(categories.length===0){ showToast('Cadastre uma categoria antes de lançar uma transação'); return; }
  editingId = id || null;
  document.getElementById('overlay').classList.add('show');
  if(id){
    const t = transactions.find(x=>x.id===id);
    document.getElementById('modalTitle').textContent = 'Editar Transação';
    document.getElementById('fDesc').value = t.desc;
    document.getElementById('fValor').value = t.val;
    document.getElementById('fData').value = t.date;
    setType(t.type);
    document.getElementById('fCategoria').value = t.cat;
    document.getElementById('fStatus').value = t.status;
  } else {
    document.getElementById('modalTitle').textContent = 'Nova Transação';
    document.getElementById('fDesc').value = '';
    document.getElementById('fValor').value = '';
    
    const now = new Date();
    const todayStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
    document.getElementById('fData').value = todayStr;
    document.getElementById('fStatus').value = 'Pago';
    setType('out');
  }
}
function closeModal(){ document.getElementById('overlay').classList.remove('show'); }
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
  document.getElementById('typeInBtn').className = t==='in' ? 'sel-in' : '';
  document.getElementById('typeOutBtn').className = t==='out' ? 'sel-out' : '';
  populateCategoriaOptions(t);
}
async function saveTransaction(){
  const desc = document.getElementById('fDesc').value.trim();
  const val = parseFloat(document.getElementById('fValor').value);
  const date = document.getElementById('fData').value;
  const cat = document.getElementById('fCategoria').value;
  const status = document.getElementById('fStatus').value;
  if(!desc || isNaN(val) || val<=0 || !date){ showToast('Preencha todos os campos corretamente'); return; }

  if(editingId){
    const t = transactions.find(x=>x.id===editingId);
    if(t.cat !== cat){
      const newCatObj = categories.find(c=>c.name===cat);
      if(newCatObj) newCatObj.count = (newCatObj.count||0)+1;
    }
    Object.assign(t, {desc, val, date, cat, status, type:currentType});
    showToast('Transação atualizada!');
  } else {
    transactions.push({id: nextTxId++, desc, val, date, cat, status, type: currentType});
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
  } else {
    accounts.push({id: nextAccId++, name, type, balance, color});
    showToast('Conta adicionada!');
    await pushNotification(\`Nova conta/cartão cadastrado: \${name} (\${type})\`, '🏦');
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
  } else {
    if(categories.some(x=>x.name===name)){ showToast('Já existe uma categoria com esse nome'); return; }
    categories.push({name, color, type, icon, count:0});
    showToast('Categoria adicionada!');
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
  sel.innerHTML = (opts.length?opts:categories).map(c=>\`<option>\${c.name}</option>\`).join('');
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
  } else {
    budgets.push({id: nextBudgetId++, category, limit});
    showToast('Orçamento criado!');
  }
  await saveUserData();
  closeBudgetModal();
  render();
}
async function deleteBudget(id){
  if(!confirm('Excluir este orçamento?')) return;
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
  } else {
    goals.push({id: nextGoalId++, name,target,current,deadline});
    showToast('Meta criada!');
  }
  await saveUserData();
  closeGoalModal();
  render();
}
async function deleteGoal(id){
  if(!confirm('Excluir esta meta?')) return;
  goals = goals.filter(g=>g.id!==id);
  await saveUserData();
  showToast('Meta removida');
  render();
}
async function addContribution(id){
  const g = goals.find(x=>x.id===id);
  const v = prompt(\`Adicionar quanto à meta "\${g.name}"? (R$)\`);
  if(v===null) return;
  const val = parseFloat(v.replace(',','.'));
  if(isNaN(val) || val<=0){ showToast('Valor inválido'); return; }
  g.current += val;
  await saveUserData();
  showToast('Valor adicionado à meta!');
  render();
}

function openRecurringModal(id){
  if(categories.length===0){ showToast('Cadastre uma categoria antes de criar um recorrente'); return; }
  if(accounts.length===0){ showToast('Cadastre uma conta antes de criar um recorrente'); return; }
  editingRecId = id || null;
  document.getElementById('overlayRecurring').classList.add('show');
  const cSel = document.getElementById('recCategoria'); cSel.innerHTML = categories.map(c=>\`<option>\${c.name}</option>\`).join('');
  const aSel = document.getElementById('recConta'); aSel.innerHTML = accounts.map(a=>\`<option>\${a.name} — \${a.type}</option>\`).join('');
  if(id){
    const r = recurringList.find(x=>x.id===id);
    document.getElementById('recModalTitle').textContent = 'Editar Recorrente';
    document.getElementById('recDesc').value = r.desc;
    document.getElementById('recVal').value = r.val;
    document.getElementById('recDay').value = r.day;
    cSel.value = r.cat;
    const am = accounts.find(a=>a.name===r.acc);
    aSel.value = am ? \`\${r.acc} — \${am.type}\` : (aSel.options[0] ? aSel.options[0].value : '');
    document.getElementById('recFreq').value = r.freq;
    setRecType(r.type);
  } else {
    document.getElementById('recModalTitle').textContent = 'Novo Lançamento Recorrente';
    document.getElementById('recDesc').value = '';
    document.getElementById('recVal').value = '';
    document.getElementById('recDay').value = '5';
    document.getElementById('recFreq').value = 'Mensal';
    setRecType('out');
  }
}
function closeRecurringModal(){ document.getElementById('overlayRecurring').classList.remove('show'); }
function setRecType(t){
  currentRecType = t;
  document.getElementById('recTypeInBtn').className = t==='in'?'sel-in':'';
  document.getElementById('recTypeOutBtn').className = t==='out'?'sel-out':'';
}
async function saveRecurring(){
  const desc = document.getElementById('recDesc').value.trim();
  const val = parseFloat(document.getElementById('recVal').value);
  const day = parseInt(document.getElementById('recDay').value);
  const cat = document.getElementById('recCategoria').value;
  const accSel = document.getElementById('recConta').value.split(' — ')[0];
  const freq = document.getElementById('recFreq').value;
  if(!desc || isNaN(val) || val<=0 || isNaN(day) || day<1 || day>31){ showToast('Preencha os campos corretamente'); return; }
  if(editingRecId){
    Object.assign(recurringList.find(r=>r.id===editingRecId), {desc,val,day,cat,acc:accSel,freq,type:currentRecType});
    showToast('Recorrente atualizado!');
  } else {
    recurringList.push({id: nextRecId++, desc,val,day,cat,acc:accSel,freq,type:currentRecType});
    showToast('Recorrente criado!');
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

function addAttachment(){
  const txId = parseInt(document.getElementById('attTx').value);
  const fileInput = document.getElementById('attFile');
  const file = fileInput.files[0];
  if(!file){ showToast('Selecione um arquivo'); return; }
  const isImage = file.type.startsWith('image/');
  const finish = async (dataUrl)=>{
    attachments.push({id: nextAttId++, txId, name:file.name, dataUrl});
    await saveUserData();
    showToast('Anexo adicionado!');
    render();
  };
  if(isImage){
    const reader = new FileReader();
    reader.onload = ()=>finish(reader.result);
    reader.readAsDataURL(file);
  } else {
    finish(null);
  }
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
        const newPass = document.getElementById('cfgPassword').value;
        const newPassConfirm = document.getElementById('cfgPasswordConfirm').value;

        if(!newName){ showToast('Informe um nome válido'); return; }
        if(!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)){ showToast('Informe um e-mail válido'); return; }
        const emailTaken = registeredUsers.some(u => u.email.toLowerCase()===newEmail.toLowerCase() && u.email.toLowerCase()!==currentUser.email.toLowerCase());
        if(emailTaken){ showToast('Este e-mail já está em uso por outro usuário'); return; }
        if(newPass || newPassConfirm){
          if(newPass.length < 6){ showToast('A nova senha deve ter ao menos 6 caracteres'); return; }
          if(newPass !== newPassConfirm){ showToast('As senhas não coincidem'); return; }
        }

        const oldEmail = currentUser.email;
        const u = registeredUsers.find(x => x.email === oldEmail);
        if (u) {
          u.name = newName;
          u.email = newEmail;
          if(newPass) u.password = newPass;
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
      document.getElementById('periodPanel').classList.remove('show');
      periodBtn.classList.remove('open');
      render();
    };
    document.getElementById('periodTodayBtn').onclick = ()=>{
      const def = getDefaultPeriod();
      currentPeriod = { year: def.year, month: def.month };
      document.getElementById('periodPanel').classList.remove('show');
      periodBtn.classList.remove('open');
      render();
    };
  }

  const search = document.getElementById('txSearch');
  const fTipo = document.getElementById('txFiltroTipo');
  const fCat = document.getElementById('txFiltroCat');
  const fStatus = document.getElementById('txFiltroStatus');
  if(search){
    [search,fTipo,fCat,fStatus].forEach(el=>{
      if(el) {
        el.addEventListener('input', refreshTxTable);
        el.addEventListener('change', refreshTxTable);
      }
    });
    refreshTxTable();
  }
}

function navigate(page){
  currentPage = page;
  document.querySelectorAll('.menu button').forEach(b=>b.classList.toggle('active', b.dataset.page===page));
  render();
}

/* ==================== Eventos Globais ==================== */
document.getElementById('menu').addEventListener('click', e=>{
  const btn = e.target.closest('button[data-page]');
  if(btn) navigate(btn.dataset.page);
});
document.addEventListener('click', e=>{
  const panel = document.getElementById('periodPanel');
  if(panel && panel.classList.contains('show') && !e.target.closest('.period-wrap')){
    panel.classList.remove('show');
    const pBtn = document.getElementById('periodBtn'); if(pBtn) pBtn.classList.remove('open');
  }
  const notifPanel = document.getElementById('notifPanel');
  if(notifPanel && notifPanel.classList.contains('show') && !e.target.closest('.notif-wrap')) notifPanel.classList.remove('show');
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

document.getElementById('closeAlertModal').onclick = closeAlertModal;
document.getElementById('alertCancelBtn').onclick = closeAlertModal;
document.getElementById('alertSaveBtn').onclick = saveAlert;
document.getElementById('overlayAlert').addEventListener('click', e=>{ if(e.target.id==='overlayAlert') closeAlertModal(); });

document.getElementById('closeUserAdminModal').onclick = closeUserAdminModal;
document.getElementById('userAdminCancelBtn').onclick = closeUserAdminModal;
document.getElementById('userAdminSaveBtn').onclick = saveUserAdmin;
document.getElementById('overlayUserAdmin').addEventListener('click', e=>{ if(e.target.id==='overlayUserAdmin') closeUserAdminModal(); });

function toggleTheme(){
  document.body.classList.toggle('light');
  const isLight = document.body.classList.contains('light');
  document.getElementById('miniThemeBtn').textContent = isLight ? '☀️' : '🌙';
  if(currentPage==='dashboard') drawDashboardCharts();
}
document.getElementById('miniThemeBtn').onclick = toggleTheme;
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
      }
    }
  } catch(e){}
})();

(async function restoreSession(){
  const session = loadFromStorage('nexus_session', null);
  const cachedUser = loadFromStorage('nexus_cached_user', null);
  const sessionEmail = session ? session.email : (cachedUser ? cachedUser.email : null);

  if (!sessionEmail && !cachedUser) {
    document.documentElement.classList.remove('user-logged-in');
    document.getElementById('appMain').classList.remove('show');
    document.getElementById('authPage').classList.add('show');
    return;
  }

  // Garante a sessão imediatamente a partir do cache local
  currentUser = cachedUser || { email: sessionEmail, name: sessionEmail.split('@')[0], role: 'Usuário' };
  document.documentElement.classList.add('user-logged-in');
  document.getElementById('authPage').classList.remove('show');
  document.getElementById('appMain').classList.add('show');

  // Carrega os dados do usuário instantaneamente do cache/banco
  await loadUserData();
  if (typeof render === 'function') render();

  // Validação em segundo plano sem interromper a tela
  try {
    await syncUsersWithServer();
    const user = registeredUsers.find(u => u.email.toLowerCase() === sessionEmail.toLowerCase());
    
    if (user) {
      if (user.active === false) {
        localStorage.removeItem('nexus_session');
        localStorage.removeItem('nexus_cached_user');
        localStorage.removeItem('nexus_token');
        document.documentElement.classList.remove('user-logged-in');
        document.getElementById('appMain').classList.remove('show');
        document.getElementById('authPage').classList.add('show');
        showAccountDisabledPopup('Seu usuário foi desativado pelo administrador. Entre em contato para mais informações.');
        return;
      }
      currentUser = user;
      saveToStorage('nexus_session', { email: user.email });
      saveToStorage('nexus_cached_user', user);
    }
  } catch(e) {}
})();
</script>
</body>
</html>`;

// Servidor HTTP com suporte para cargas de dados pesadas (JSON), agora com PostgreSQL
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Rota POST para Login de Usuário
  if (req.method === 'POST' && parsedUrl.pathname === '/api/login') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { email, password } = JSON.parse(body);
        if (!email || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'E-mail e senha são obrigatórios' }));
        }

        const result = await pool.query(
          'SELECT id, name, email, password, role, active FROM usuarios WHERE LOWER(email) = LOWER($1)',
          [email]
        );

        if (result.rows.length === 0 || result.rows[0].password !== password) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'E-mail ou senha incorretos!' }));
        }

        const user = result.rows[0];
        if (user.active === false) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Seu usuário foi desativado pelo administrador.' }));
        }

        const token = 'token_' + Date.now() + '_' + Math.random().toString(36).substring(2);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          token: token,
          user: { id: user.id, name: user.name, email: user.email, role: user.role }
        }));
      } catch (err) {
        console.error('Erro no endpoint de login:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
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
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Todos os campos são obrigatórios' }));
        }

        const existing = await pool.query(
          'SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1)',
          [email]
        );

        if (existing.rows.length > 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Este e-mail já está cadastrado!' }));
        }

        await pool.query(
          'INSERT INTO usuarios (name, email, password, role, active) VALUES ($1, $2, $3, $4, $5)',
          [name, email, password, 'Usuário', true]
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, message: 'Conta criada com sucesso!' }));
      } catch (err) {
        console.error('Erro no endpoint de cadastro:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
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
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'E-mail é obrigatório' }));
        }

        const result = await pool.query(
          'SELECT id, name, email, password FROM usuarios WHERE LOWER(email) = LOWER($1)',
          [email]
        );

        if (result.rows.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'E-mail não cadastrado.' }));
        }

        const user = result.rows[0];

        // Se a senha for um hash criptografado longo ou vazia, gera uma nova senha legível e atualiza no banco
        let sendPassword = user.password;
        if (!sendPassword || sendPassword.length > 30 || sendPassword.includes(':')) {
          sendPassword = Math.floor(100000 + Math.random() * 900000).toString();
          await pool.query('UPDATE usuarios SET password = $1 WHERE id = $2', [sendPassword, user.id]);
        }

        // Tenta o disparo de e-mail real via SMTP
        const emailSent = await sendPasswordEmail(user.email, user.name, sendPassword);

        if (emailSent) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, mode: 'email' }));
        } else {
          // Se o e-mail não puder ser enviado por falta de credenciais SMTP, exibe a nova senha temporária gerada na tela
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ 
            success: true, 
            mode: 'direct', 
            tempPassword: sendPassword 
          }));
        }
      } catch (err) {
        console.error('Erro ao processar recuperação de senha:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Falha ao processar solicitação de senha.' }));
      }
    });
    return;
  }

  // Rota GET de Usuários
  if (req.method === 'GET' && parsedUrl.pathname === '/api/users') {
    pool.query('SELECT name, email, password, role, active FROM usuarios ORDER BY id ASC')
      .then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.rows));
      })
      .catch(err => {
        console.error('Erro ao buscar usuários:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Erro no banco de dados' }));
      });
    return;
  }

  // Rota POST de Usuários (recebe a lista completa e sincroniza com a tabela)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/users') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      const client = await pool.connect();
      try {
        const users = JSON.parse(body);
        if (!Array.isArray(users)) throw new Error('Formato inválido');

        await client.query('BEGIN');

        const emails = users.map(u => u.email);
        // Remove usuários que não estão mais na lista enviada (ex: exclusão pelo admin)
        await client.query(
          `DELETE FROM usuarios WHERE email <> ALL($1::text[])`,
          [emails.length ? emails : ['__nunca__']]
        );

        // Insere ou atualiza cada usuário da lista (upsert por e-mail)
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Erro ao salvar usuários:', e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
      } finally {
        client.release();
      }
    });
    return;
  }

  // Rota GET para buscar dados financeiros do Usuário no banco
  if (req.method === 'GET' && parsedUrl.pathname === '/api/data') {
    const email = parsedUrl.query.email;
    pool.query('SELECT dados FROM dados_financeiros WHERE email = $1', [email])
      .then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.rows[0] ? result.rows[0].dados : null));
      })
      .catch(err => {
        console.error('Erro ao buscar dados financeiros:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Erro no banco de dados' }));
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
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false }));
      }
      if (!payload.email || !payload.data) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false }));
      }
      pool.query(
        `INSERT INTO dados_financeiros (email, dados, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (email) DO UPDATE
         SET dados = EXCLUDED.dados, updated_at = now();`,
        [payload.email, payload.data]
      )
        .then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        })
        .catch(err => {
          console.error('Erro ao salvar nas configurações:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ErrorCode: DB' }));
        });
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlContent);
});

initDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}`);
      console.log(`Conectado ao PostgreSQL (banco: ${process.env.DB_NAME || 'FINANCEIRO'})`);
    });
  })
  .catch(err => {
    console.error('Falha ao conectar/inicializar o banco de dados PostgreSQL:', err);
    process.exit(1);
  });
