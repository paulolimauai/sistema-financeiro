require('dotenv').config();
const http = require('http');
const url = require('url');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

// ==================== Hashing de Senha Seguro & Gerenciamento de Sessões ====================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword) return false;
  if (!storedPassword.includes(':')) {
    // Compatibilidade temporária com senhas legadas em texto limpo
    return password === storedPassword;
  }
  const [salt, originalHash] = storedPassword.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === originalHash;
}

const activeSessions = new Map();

function createSessionToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 dias de validade
  const sessionData = {
    token,
    email: user.email.toLowerCase(),
    name: user.name,
    role: user.role,
    active: user.active !== false,
    expiresAt
  };
  activeSessions.set(token, sessionData);
  return token;
}

function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }
  if (!token) {
    const parsedUrl = url.parse(req.url, true);
    token = parsedUrl.query && parsedUrl.query.token;
  }
  if (!token) return null;

  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}

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

// Usuário admin padrão
const DEFAULT_ADMIN = {
  name: 'Administrador de TI',
  email: 'paulodelima21@gmail.com',
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
        try { socket.write(cmd + '\r\n'); } catch(e){}
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
              `Subject: Reciclagem de Senha - Nexus Financeiro`,
              'MIME-Version: 1.0',
              'Content-Type: text/html; charset=UTF-8',
              '',
              '<div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #1f2530; border-radius: 10px; background-color: #0b0e12; color: #e9edf3;">',
              '  <h2 style="color: #e8b04b; text-align: center;">Nexus Financeiro Hub</h2>',
              `  <p>Olá, <strong>${userName}</strong>!</p>`,
              '  <p>Sua senha temporária de acesso ao sistema Nexus Financeiro é:</p>',
              '  <div style="text-align: center; margin: 25px 0;">',
              `    <span style="font-size: 24px; font-weight: bold; color: #e8b04b; background: #141821; padding: 10px 20px; border-radius: 8px; border: 1px solid #1f2530;">${userPassword}</span>`,
              '  </div>',
              '  <p style="font-size: 12px; color: #8a93a3;">Recomendamos alterar sua senha após realizar o login no painel.</p>',
              '</div>',
              '.'
            ].join('\r\n');
            send(body);
          } else if (step === 8 && response.startsWith('250')) {
            step++;
            send('QUIT');
            resolve(true);
          }
        } catch(err) {
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

// Cria as tabelas (se não existirem) e garante o admin padrão com hash de senha
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

  const adminCheck = await pool.query('SELECT id, password FROM usuarios WHERE LOWER(email) = LOWER($1)', [DEFAULT_ADMIN.email]);
  if (adminCheck.rows.length === 0) {
    const hashedPass = hashPassword(DEFAULT_ADMIN.password);
    await pool.query(
      `INSERT INTO usuarios (name, email, password, role, active)
       VALUES ($1, $2, $3, $4, $5)`,
      [DEFAULT_ADMIN.name, DEFAULT_ADMIN.email, hashedPass, DEFAULT_ADMIN.role, DEFAULT_ADMIN.active]
    );
  } else {
    const currentPass = adminCheck.rows[0].password;
    if (!currentPass.includes(':')) {
      const hashedPass = hashPassword(DEFAULT_ADMIN.password);
      await pool.query('UPDATE usuarios SET password = $1 WHERE id = $2', [hashedPass, adminCheck.rows[0].id]);
    }
  }
}

// Conteúdo HTML/JS/CSS da aplicação centralizada com isolamento por usuário
const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nexus Financeiro Hub</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<script>
(function(){
  try {
    var token = localStorage.getItem('nexus_token');
    if (token) {
      document.documentElement.classList.add('is-logged-in');
    }
  } catch(e){}
})();
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js"></script>
<style>
/* Prevenção Absoluta de Flash ao recarregar a página (F5) */
html.is-logged-in #authPage { display: none !important; }
html.is-logged-in #appMain { display: flex !important; }

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
  font-family:'Plus Jakarta Sans','Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,sans-serif;
  background:var(--bg); color:var(--text); min-height:100vh; transition:background .25s,color .25s;
}
button, input, select{font-family:inherit; color:inherit;}
code{background:var(--hover); padding:1px 6px; border-radius:5px; font-size:11.5px;}

/* Prevenção de Piscamento/Flicker */
#pageContent {
  contain: content;
  will-change: auto;
}

/* ==================== Tela de Auth Portal (Pro Fintech) ==================== */
.auth-container{
  --auth-accent:#e8b04b; --auth-accent-2:#c9862a; --auth-accent-3:#f6d999;
  --auth-accent-soft:rgba(232,176,75,.16); --auth-text-on:#1f1400;
  position:relative; overflow:hidden;
  display:none; align-items:center; justify-content:center; min-height:100vh; padding:24px 16px;
  background:
    radial-gradient(circle at 85% 15%, rgba(232,176,75,0.14), transparent 45%),
    radial-gradient(circle at 15% 85%, rgba(201,134,42,0.12), transparent 50%),
    linear-gradient(160deg, #07090c 0%, #0c0f15 50%, #120e0a 100%);
}
.auth-container.show { display: flex; }
.auth-grid{
  position:absolute; inset:0; z-index:0; pointer-events:none;
  background-image:
    linear-gradient(rgba(232,176,75,.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(232,176,75,.06) 1px, transparent 1px);
  background-size:48px 48px;
  -webkit-mask-image:radial-gradient(circle at 50% 50%, #000 20%, transparent 80%);
  mask-image:radial-gradient(circle at 50% 50%, #000 20%, transparent 80%);
}
.auth-chart{
  position:absolute; inset:0; width:100%; height:100%; z-index:0; pointer-events:none; opacity:.35;
  -webkit-mask-image:linear-gradient(to bottom, transparent, #000 15%, #000 85%, transparent);
  mask-image:radial-gradient(circle at 50% 50%, #000 0%, transparent 75%);
}
.auth-blob{position:absolute; border-radius:50%; filter:blur(80px); opacity:.25; pointer-events:none; will-change:transform;}
.auth-blob.b1{width:420px; height:420px; background:var(--auth-accent); top:-130px; left:-120px; animation:blobFloat 22s ease-in-out infinite;}
.auth-blob.b2{width:380px; height:380px; background:var(--auth-accent-2); bottom:-140px; right:-100px; animation:blobFloat 26s ease-in-out infinite; animation-delay:-8s;}

@keyframes blobFloat{
  0%,100%{transform:translate(0,0) scale(1);}
  33%{transform:translate(40px,-45px) scale(1.08);}
  66%{transform:translate(-35px,30px) scale(.94);}
}

@keyframes authPortalIn{
  from{opacity:0; transform:translateY(28px) scale(.97);}
  to{opacity:1; transform:translateY(0) scale(1);}
}

/* Container do Portal Split Screen */
.auth-portal-card{
  position:relative; z-index:1; display:flex; flex-direction:row; width:100%; max-width:980px; min-height:580px;
  background:rgba(15, 18, 26, 0.76);
  backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px);
  border:1px solid rgba(232,176,75,.2); border-radius:24px; overflow:hidden;
  box-shadow:0 24px 64px rgba(0,0,0,.6), 0 0 0 1px rgba(252,211,133,.08);
  animation:authPortalIn .65s cubic-bezier(.16,1,.3,1);
}

/* Lado Esquerdo: Showcase do Cartão & Benefícios */
.auth-hero-side{
  flex:1.1; position:relative; padding:44px; display:flex; flex-direction:column; justify-content:space-between;
  background:linear-gradient(145deg, rgba(232,176,75,0.08) 0%, rgba(20,15,10,0.45) 100%);
  border-right:1px solid rgba(232,176,75,.14); overflow:hidden;
}
.auth-hero-brand{display:flex; align-items:center; gap:12px; margin-bottom:20px;}
.auth-hero-brand .logo-ic{
  width:44px; height:44px; border-radius:12px; background:linear-gradient(135deg,var(--auth-accent),var(--auth-accent-2));
  color:var(--auth-text-on); font-weight:800; font-size:22px; display:flex; align-items:center; justify-content:center;
  box-shadow:0 6px 18px rgba(232,176,75,.35);
}
.auth-hero-brand .brand-title{font-size:18px; font-weight:800; color:#fff;}
.auth-hero-brand .brand-title span{color:var(--auth-accent); font-size:11px; display:block; font-weight:600; letter-spacing:1.5px;}

/* Cartão Virtual Metallic Gold 3D */
.vip-card-preview{
  position:relative; width:100%; max-width:320px; height:180px; margin:10px auto 20px; border-radius:16px; padding:22px;
  background:linear-gradient(135deg, #241c10 0%, #120e08 50%, #302414 100%);
  border:1px solid rgba(232,176,75,0.4);
  box-shadow:0 14px 36px rgba(0,0,0,.5), inset 0 1px 1px rgba(255,255,255,0.25);
  display:flex; flex-direction:column; justify-content:space-between;
  transform:rotate(-2deg) translateY(0); transition:transform .35s ease, box-shadow .35s ease;
  animation:cardFloat 6s ease-in-out infinite;
}
.vip-card-preview:hover{transform:rotate(0deg) translateY(-6px) scale(1.02); box-shadow:0 20px 45px rgba(232,176,75,0.25);}
@keyframes cardFloat{
  0%,100%{transform:rotate(-2deg) translateY(0);}
  50%{transform:rotate(0deg) translateY(-8px);}
}
.vip-card-preview .card-top{display:flex; justify-content:space-between; align-items:center;}
.vip-card-preview .chip{width:36px; height:26px; background:linear-gradient(135deg,#e8c475,#b3832d); border-radius:5px; border:1px solid rgba(255,255,255,.3);}
.vip-card-preview .nfc{font-size:18px; color:rgba(232,176,75,.8);}
.vip-card-preview .card-num{font-family:monospace; font-size:15px; letter-spacing:2px; color:rgba(255,255,255,.85);}
.vip-card-preview .card-bottom{display:flex; justify-content:space-between; align-items:flex-end;}
.vip-card-preview .card-holder{font-size:10px; text-transform:uppercase; color:var(--auth-accent); letter-spacing:1px; font-weight:700;}
.vip-card-preview .card-holder div{color:#fff; font-size:12px; margin-top:2px;}
.vip-card-preview .card-balance{text-align:right;}
.vip-card-preview .card-balance span{font-size:9px; color:rgba(255,255,255,.6); display:block;}
.vip-card-preview .card-balance strong{font-size:13px; color:#e8b04b;}

.hero-features-list{display:flex; flex-direction:column; gap:10px;}
.feature-pill{
  display:flex; align-items:center; gap:10px; padding:10px 14px; border-radius:12px;
  background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); font-size:12.5px; color:var(--text-dim);
}
.feature-pill .ic{font-size:16px;}

/* Lado Direito: Formulário Glassmorphism */
.auth-box-side{
  flex:1; padding:44px 38px; display:flex; flex-direction:column; justify-content:center;
  background:rgba(10, 13, 19, 0.85); position:relative;
}

/* Tabs no Form com Alto Contraste */
.auth-tabs{
  display:flex; background:rgba(0,0,0,0.5); border:1px solid rgba(232,176,75,0.25);
  border-radius:12px; padding:4px; margin-bottom:24px;
}
.auth-tab{
  flex:1; text-align:center; padding:10px 12px; font-size:13px; font-weight:600;
  color:rgba(255,255,255,0.75); border-radius:8px; cursor:pointer; transition:all .2s;
}
.auth-tab:hover{color:#ffffff; background:rgba(255,255,255,0.08);}
.auth-tab.active{
  background:linear-gradient(135deg,var(--auth-accent),var(--auth-accent-2));
  color:#1f1400; font-weight:800; box-shadow:0 4px 14px rgba(232,176,75,.35);
}

.auth-box h2{font-size:22px; font-weight:800; margin-bottom:6px; letter-spacing:-0.4px;}
.auth-box p.sub{font-size:13px; color:var(--text-dim); margin-bottom:22px;}

/* Container de Input com Ícone Fixo e Fundo Escuro */
.field-input-wrapper {
  position: relative; width: 100%; display: flex; align-items: center;
}
.field-input-wrapper .input-ic {
  position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
  font-size: 16px; opacity: 0.8; pointer-events: none; z-index: 5;
}
.field-input-wrapper input {
  width: 100%; height: 46px; background: #131722 !important;
  border: 1px solid rgba(255, 255, 255, 0.15) !important;
  border-radius: 12px !important;
  padding: 0 40px 0 44px !important;
  font-size: 14px !important; color: #ffffff !important;
  transition: border-color .2s, box-shadow .2s, background .2s;
  box-shadow: none !important;
}
.field-input-wrapper input:focus {
  border-color: var(--auth-accent) !important;
  box-shadow: 0 0 0 3px rgba(232, 176, 75, 0.25) !important;
  background: #181d2a !important; outline: none;
}
.field-input-wrapper .pass-toggle-ic {
  position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
  background: none; border: none; cursor: pointer; font-size: 15px;
  opacity: 0.7; z-index: 5; color: var(--text-dim); transition: opacity .15s;
}
.field-input-wrapper .pass-toggle-ic:hover { opacity: 1; color: #fff; }

/* Autofill Override para Chrome / Edge / Safari */
input:-webkit-autofill,
input:-webkit-autofill:hover, 
input:-webkit-autofill:focus, 
input:-webkit-autofill:active,
input:-internal-autofill-selected,
input:-internal-autofill-previewed {
  -webkit-box-shadow: 0 0 0 1000px #131722 inset !important;
  box-shadow: 0 0 0 1000px #131722 inset !important;
  -webkit-text-fill-color: #ffffff !important;
  color: #ffffff !important;
  caret-color: #ffffff !important;
  font-size: 14px !important;
  border-radius: 12px !important;
  transition: background-color 99999s ease-in-out 0s !important;
}

.auth-forgot{display:inline-block; font-size:12px; color:var(--auth-accent); margin-top:8px; cursor:pointer; text-decoration:none; transition:opacity .2s;}
.auth-forgot:hover{opacity:.8; text-decoration:underline;}

.btn-auth-premium{
  position:relative; overflow:hidden; width:100%; padding:13px; margin-top:14px;
  background:linear-gradient(135deg,var(--auth-accent),var(--auth-accent-2)); color:var(--auth-text-on);
  border:none; border-radius:11px; font-weight:800; font-size:14px; letter-spacing:.3px; cursor:pointer;
  box-shadow:0 6px 20px rgba(232,176,75,.28); transition:all .2s;
}
.btn-auth-premium::after{
  content:''; position:absolute; top:0; left:-75%; width:50%; height:100%;
  background:linear-gradient(120deg, transparent, rgba(255,255,255,.5), transparent); transform:skewX(-20deg);
}
.btn-auth-premium:hover{filter:brightness(1.1); transform:translateY(-1.5px); box-shadow:0 8px 24px rgba(232,176,75,.38);}
.btn-auth-premium:hover::after{animation:shimmer .9s ease;}
.btn-auth-premium:active{transform:translateY(0) scale(.98);}
@keyframes shimmer{from{left:-75%;} to{left:130%;}}

.demo-fill-btn{
  margin-top:16px; padding:9px 12px; background:rgba(232,176,75,0.08); border:1px dashed rgba(232,176,75,0.3);
  border-radius:9px; color:var(--auth-accent); font-size:12px; font-weight:600; text-align:center; cursor:pointer; transition:all .2s;
}
.demo-fill-btn:hover{background:rgba(232,176,75,0.16); border-style:solid;}

.auth-toggle{text-align:center; font-size:13px; color:var(--text-dim); margin-top:20px; padding-top:16px; border-top:1px solid rgba(255,255,255,0.08);}
.auth-toggle a{color:var(--auth-accent); text-decoration:none; font-weight:700; cursor:pointer;}
.auth-toggle a:hover{text-decoration:underline;}

/* Responsividade Mobile */
@media(max-width:860px){
  .auth-portal-card{flex-direction:column; max-width:440px;}
  .auth-hero-side{display:none;}
  .auth-box-side{padding:32px 24px;}
}

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

<!-- TELA DE LOGIN / CADASTRO PRO FINTECH -->
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

  <div class="auth-portal-card">
    <!-- Lado Esquerdo: Showcase de Finanças Pessoais -->
    <div class="auth-hero-side">
      <div>
        <div class="auth-hero-brand">
          <div class="logo-ic">N</div>
          <div class="brand-title">NEXUS <span>FINANCEIRO HUB</span></div>
        </div>
        <h3 style="font-size: 20px; font-weight: 800; color: #fff; margin-bottom: 8px;">Controle Financeiro Pessoal</h3>
        <p style="font-size: 13px; color: var(--text-dim); line-height: 1.5;">Organize suas receitas, despesas, cartões e metas da sua vida financeira em um único lugar simples e seguro.</p>
      </div>

      <!-- Preview de Cartão de Crédito / Conta Pessoal -->
      <div class="vip-card-preview">
        <div class="card-top">
          <div class="chip"></div>
          <div class="nfc">📡</div>
        </div>
        <div class="card-num">•••• •••• •••• 8892</div>
        <div class="card-bottom">
          <div class="card-holder">
            <span>Conta Pessoal</span>
            <div>SUA CONTA PESSOAL</div>
          </div>
          <div class="card-balance">
            <span>Saldo Disponível</span>
            <strong>R$ 4.850,00</strong>
          </div>
        </div>
      </div>

      <div class="hero-features-list">
        <div class="feature-pill"><span class="ic">💳</span> Gestão de Cartões, Faturas e Contas</div>
        <div class="feature-pill"><span class="ic">🎯</span> Metas de Economia & Orçamentos Mensais</div>
        <div class="feature-pill"><span class="ic">📊</span> Relatórios Detalhados de Gastos Pessoais</div>
      </div>
    </div>

    <!-- Lado Direito: Formulário Glassmorphism -->
    <div class="auth-box-side">
      <!-- Tabs Selector -->
      <div class="auth-tabs">
        <div class="auth-tab active" id="tabAuthLogin">Acessar</div>
        <div class="auth-tab" id="tabAuthRegister">Criar Conta</div>
        <div class="auth-tab" id="tabAuthForgot">Recuperar</div>
      </div>

      <!-- Login Box -->
      <div class="auth-box" id="loginBox" style="padding:0; background:transparent; border:none; box-shadow:none;">
        <h2>Acessar Minha Conta</h2>
        <p class="sub">Entre com seu e-mail e senha para acessar seu painel financeiro</p>
        <form id="loginForm">
          <div class="field" style="margin-bottom:16px;">
            <label>E-mail</label>
            <div class="field-input-wrapper">
              <span class="ic">✉️</span>
              <input type="email" id="loginEmail" placeholder="seu.email@exemplo.com" required autocomplete="username">
            </div>
          </div>
          <div class="field" style="margin-bottom:16px;">
            <label>Senha</label>
            <div class="field-input-wrapper">
              <span class="ic">🔒</span>
              <input type="password" id="loginPassword" placeholder="••••••••" required autocomplete="current-password">
              <button type="button" class="pass-toggle-ic" id="loginPasswordToggle" tabindex="-1" aria-label="Mostrar senha">👁</button>
            </div>
            <a class="auth-forgot" id="goForgot">Esqueceu a senha?</a>
          </div>
          <button type="submit" class="btn-auth-premium">Entrar no Meu Painel →</button>
        </form>
        <div class="auth-toggle">
          Não tem uma conta? <a id="goRegister">Cadastrar-se grátis</a>
        </div>
      </div>

      <!-- Recuperar Senha Box -->
      <div class="auth-box" id="forgotBox" style="display:none; padding:0; background:transparent; border:none; box-shadow:none;">
        <h2>Recuperar Senha</h2>
        <p class="sub" id="forgotSub">Informe seu e-mail cadastrado para receber sua senha temporária</p>
        <form id="forgotStep1">
          <div class="field" style="margin-bottom:18px;">
            <label>E-mail Cadastrado</label>
            <div class="field-input-wrapper">
              <span class="ic">✉️</span>
              <input type="email" id="forgotEmail" placeholder="seu.email@exemplo.com" required>
            </div>
          </div>
          <button type="submit" class="btn-auth-premium" id="btnSendPassword">Enviar Senha por E-mail →</button>
        </form>
        <div class="auth-toggle">
          Lembrou a senha? <a id="goLoginFromForgot">Fazer Login</a>
        </div>
      </div>

      <!-- Cadastro Box -->
      <div class="auth-box" id="registerBox" style="display:none; padding:0; background:transparent; border:none; box-shadow:none;">
        <h2>Criar Conta Pessoal</h2>
        <p class="sub">Cadastre-se para começar a organizar suas finanças pessoais</p>
        <form id="registerForm">
          <div class="field" style="margin-bottom:14px;">
            <label>Nome Completo</label>
            <div class="field-input-wrapper">
              <span class="ic">👤</span>
              <input type="text" id="regName" placeholder="Ex: Maria Silva" required>
            </div>
          </div>
          <div class="field" style="margin-bottom:14px;">
            <label>E-mail</label>
            <div class="field-input-wrapper">
              <span class="ic">✉️</span>
              <input type="email" id="regEmail" placeholder="seu.email@exemplo.com" required>
            </div>
          </div>
          <div class="field" style="margin-bottom:14px;">
            <label>Senha</label>
            <div class="field-input-wrapper">
              <span class="ic">🔒</span>
              <input type="password" id="regPassword" placeholder="••••••••" required minlength="6">
            </div>
          </div>
          <button type="submit" class="btn-auth-premium">Criar Minha Conta Pessoal →</button>
        </form>
        <div class="auth-toggle">
          Já tem uma conta? <a id="goLogin">Fazer Login</a>
        </div>
      </div>
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
          <div class="avatar" id="headerAvatar">--</div>
          <div><div class="uname" id="headerName">...</div><div class="urole" id="headerRole">...</div></div>
          <script>
            (function(){
              try {
                var c = JSON.parse(localStorage.getItem('nexus_cached_user') || '{}');
                if (c && c.name) {
                  document.getElementById('headerName').textContent = c.name;
                  document.getElementById('headerRole').textContent = c.role || 'Usuário';
                  document.getElementById('headerAvatar').textContent = c.initials || 'U';
                }
              } catch(e){}
            })();
          </script>
        </div>
        <button class="btn-ghost" id="logoutBtn">Sair</button>
      </div>
    </div>
    <nav class="menu" id="menu">
      <!-- Menus Comuns para Usuários -->
      <button data-page="dashboard" class="active" id="menuDashboardBtn"><span class="ic">▦</span> Dashboard</button>
      <button data-page="transacoes" id="menuTransacoesBtn"><span class="ic">⇄</span> Transações</button>
      <button data-page="cartoes" id="menuCartoesBtn"><span class="ic">▭</span> Cartões</button>
      <button data-page="orcamentos" id="menuOrcamentosBtn"><span class="ic">◔</span> Orçamentos</button>
      <button data-page="metas" id="menuMetasBtn"><span class="ic">◎</span> Metas</button>
      <button data-page="relatorios" id="menuRelatoriosBtn"><span class="ic">▥</span> Relatórios</button>
      <button data-page="recorrentes" id="menuRecorrentesBtn"><span class="ic">↻</span> Recorrentes</button>
      <button data-page="importar" id="menuImportarBtn"><span class="ic">⇥</span> Importar</button>
      <button data-page="anexos" id="menuAnexosBtn"><span class="ic">📎</span> Anexos</button>
      <button data-page="openfinance" id="menuOpenFinanceBtn"><span class="ic">⚡</span> Open Finance (CPF)</button>
      <button data-page="config" id="menuConfigBtn"><span class="ic">⚙</span> Configurações</button>
      
      <!-- Menus Exclusivos de Administrador (Administrador de TI) -->
      <button data-page="usuarios" id="menuUsuariosBtn" style="display:none;"><span class="ic">👥</span> Usuários Cadastrados</button>
      <button data-page="paineladmin" id="menuAdminTotalBtn" style="display:none;"><span class="ic">⚡</span> Painel Administrador Geral</button>
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

<script>
/* ==================== Prevenção de XSS & Chamadas de API Seguras ==================== */
function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem('nexus_token');
  const headers = options.headers || {};
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  options.headers = headers;

  const res = await fetch(window.location.origin + endpoint, options);
  if (res.status === 401) {
    document.documentElement.classList.remove('is-logged-in');
    localStorage.removeItem('nexus_token');
    localStorage.removeItem('nexus_session');
    currentUser = null;
    document.getElementById('appMain').classList.remove('show');
    document.getElementById('authPage').classList.add('show');
  }
  return res;
}

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
    const res = await apiRequest('/api/users');
    if (res.ok) {
      registeredUsers = await res.json();
      saveToStorage('nexus_users', registeredUsers);
    }
  } catch(e) {
    registeredUsers = loadFromStorage('nexus_users', []);
  }
}

let currentUser = null;
let isViewingOtherUser = false;
let adminOriginalUser = null;

// Formulários e Abas de Login/Cadastro/Recuperação
function switchAuthTab(tabName) {
  const loginBox = document.getElementById('loginBox');
  const registerBox = document.getElementById('registerBox');
  const forgotBox = document.getElementById('forgotBox');
  const tabLogin = document.getElementById('tabAuthLogin');
  const tabRegister = document.getElementById('tabAuthRegister');
  const tabForgot = document.getElementById('tabAuthForgot');

  if (tabLogin) tabLogin.classList.remove('active');
  if (tabRegister) tabRegister.classList.remove('active');
  if (tabForgot) tabForgot.classList.remove('active');

  loginBox.style.display = 'none';
  registerBox.style.display = 'none';
  forgotBox.style.display = 'none';

  if (tabName === 'register') {
    registerBox.style.display = 'block';
    if (tabRegister) tabRegister.classList.add('active');
  } else if (tabName === 'forgot') {
    forgotBox.style.display = 'block';
    if (tabForgot) tabForgot.classList.add('active');
  } else {
    loginBox.style.display = 'block';
    if (tabLogin) tabLogin.classList.add('active');
  }
}

const tabLoginEl = document.getElementById('tabAuthLogin');
const tabRegEl = document.getElementById('tabAuthRegister');
const tabForgotEl = document.getElementById('tabAuthForgot');
if (tabLoginEl) tabLoginEl.onclick = () => switchAuthTab('login');
if (tabRegEl) tabRegEl.onclick = () => switchAuthTab('register');
if (tabForgotEl) tabForgotEl.onclick = () => switchAuthTab('forgot');

document.getElementById('goRegister').onclick = () => switchAuthTab('register');
document.getElementById('goLogin').onclick = () => switchAuthTab('login');
document.getElementById('goLoginFromForgot').onclick = () => switchAuthTab('login');
document.getElementById('goForgot').onclick = (e) => {
  e.preventDefault();
  switchAuthTab('forgot');
  document.getElementById('forgotStep1').reset();
  document.getElementById('forgotSub').textContent = 'Informe seu e-mail para enviarmos sua nova senha temporária';
};

const fillDemoBtn = document.getElementById('btnFillDemoAdmin');
if (fillDemoBtn) {
  fillDemoBtn.onclick = () => {
    switchAuthTab('login');
    document.getElementById('loginEmail').value = 'paulodelima21@gmail.com';
    document.getElementById('loginPassword').value = '123456';
    document.getElementById('loginPassword').focus();
  };
}

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

    alert('Sua nova senha temporária foi enviada para o seu e-mail com sucesso!');
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

// Login Seguro
document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  try {
    const res = await fetch(window.location.origin + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      if (res.status === 403) {
        showAccountDisabledPopup(data.error);
      } else {
        alert(data.error || 'E-mail ou senha incorretos!');
      }
      return;
    }

    localStorage.setItem('nexus_token', data.token);
    document.documentElement.classList.add('is-logged-in');
    currentUser = data.user;
    const initialPage = 'dashboard';
    saveToStorage('nexus_session', { email: currentUser.email, page: initialPage });
    await loadUserData();
    document.getElementById('authPage').classList.remove('show');
    document.getElementById('appMain').classList.add('show');
    
    currentPage = initialPage;

    render();
    showLoginSuccessPopup('Bem-vindo(a) de volta, ' + currentUser.name.split(' ')[0] + '!');
  } catch (err) {
    alert('Erro ao conectar ao servidor. Verifique sua conexão.');
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

// Cadastro Seguro
document.getElementById('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value.trim();

  try {
    const response = await fetch(window.location.origin + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await response.json();
    
    if (!response.ok || !data.success) {
      alert(data.error || 'Falha ao registrar conta no servidor.');
      return;
    }

    alert('Conta criada com sucesso! Faça login para continuar.');

    document.getElementById('regName').value = '';
    document.getElementById('regEmail').value = '';
    document.getElementById('regPassword').value = '';
    document.getElementById('loginEmail').value = email;
    document.getElementById('loginPassword').value = password;
    document.getElementById('goLogin').click();
  } catch (err) {
    alert('Erro ao registrar no servidor. Verifique sua conexão e tente novamente.');
  }
};

// Logout Seguro
document.getElementById('logoutBtn').onclick = async () => {
  try {
    await apiRequest('/api/logout', { method: 'POST' });
  } catch(e) {}
  await saveUserData();
  currentUser = null;
  isViewingOtherUser = false;
  adminOriginalUser = null;
  document.documentElement.classList.remove('is-logged-in');
  localStorage.removeItem('nexus_token');
  localStorage.removeItem('nexus_session');
  localStorage.removeItem('nexus_cached_user');
  categories = []; accounts = []; transactions = []; budgets = []; goals = []; recurringList = []; alerts = []; attachments = []; notifications = [];
  document.getElementById('appMain').classList.remove('show');
  document.getElementById('authPage').classList.add('show');
  showToast('Sessão encerrada.');
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

async function loadUserData() {
  if (!currentUser) return;
  const userKey = 'nexus_data_' + currentUser.email;
  let data = null;

  try {
    const res = await apiRequest('/api/data?email=' + encodeURIComponent(currentUser.email));
    if (res.ok) {
      const json = await res.json();
      if (json && json.success) data = json.data;
    }
  } catch(e) {
    data = loadFromStorage(userKey, null);
  }

  if (data) {
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
  } else {
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
    await apiRequest('/api/data', {
      method: 'POST',
      body: { email: currentUser.email, data: payloadData }
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
  const list = document.getElementById('notifPanel');
  if(!dot || !list) return;
  const unread = notifications.filter(n=>!n.read).length;
  dot.style.display = unread > 0 ? 'block' : 'none';
  const listEl = document.getElementById('notifList');
  if(listEl) {
    listEl.innerHTML = notifications.length ? notifications.map(n=>\`
      <div class="notif-item \${n.read?'':'unread'}">
        \${n.read? '' : '<span class="unread-dot"></span>'}
        <span class="ic">\${n.icon}</span>
        <div class="body"><div class="txt">\${n.text}</div><div class="time">\${timeAgo(n.time)}</div></div>
      </div>\`).join('') : \`<div class="notif-empty">Nenhuma notificação por aqui.</div>\`;
  }
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
    await fetchAdminGlobalData();
    newHTML = pageUsuarios();
  }
  else if(currentPage==='paineladmin') {
    await fetchAdminGlobalData();
    newHTML = pageAdminTotal();
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
  else if(currentPage==='openfinance') newHTML = pageOpenFinance();
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
  const isTiAdmin = currentUser && currentUser.role === 'Administrador' && currentUser.email.toLowerCase() === 'paulodelima21@gmail.com';

  const commonMenuIds = [
    'menuDashboardBtn', 'menuTransacoesBtn', 'menuCartoesBtn', 'menuOrcamentosBtn',
    'menuMetasBtn', 'menuRelatoriosBtn', 'menuRecorrentesBtn', 'menuImportarBtn',
    'menuAnexosBtn', 'menuOpenFinanceBtn', 'menuConfigBtn'
  ];

  commonMenuIds.forEach(id => {
    const btn = document.getElementById(id);
    if(btn) btn.style.display = '';
  });

  const btnUsuarios = document.getElementById('menuUsuariosBtn');
  const btnAdminTotal = document.getElementById('menuAdminTotalBtn');
  
  if(btnUsuarios) btnUsuarios.style.display = isTiAdmin ? '' : 'none';
  if(btnAdminTotal) btnAdminTotal.style.display = isTiAdmin ? '' : 'none';
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

  const initials = currentUser.name.trim().split(/\s+/).map(n=>n[0]).slice(0,2).join('').toUpperCase();
  const role = currentUser.role || 'Usuário';

  if(unameEl) unameEl.textContent = currentUser.name;
  if(roleEl) roleEl.textContent = role;
  if(avatarEl) avatarEl.textContent = initials;

  try {
    saveToStorage('nexus_cached_user', { name: currentUser.name, role: role, initials: initials });
  } catch(e){}
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

/* ==================== Dashboard Fintech Pro ==================== */
function pageDashboard(){
  const periodTx = transactions.filter(inPeriod);
  const {receitas,despesas,saldo} = computeTotals(periodTx);
  const cats = despesasPorCategoria(periodTx);
  const totalDesp = cats.reduce((s,c)=>s+c.val,0)||1;
  const recPct = Math.round(receitas/(receitas+despesas||1)*100) || 0;
  const despPct = 100-recPct;
  const lastTx = periodTx.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  
  // Taxa de economia (% poupada da receita)
  const economizado = receitas - despesas;
  const taxaPoupança = receitas > 0 ? Math.round((economizado / receitas) * 100) : 0;
  
  // Saudação dinâmica por horário
  const hr = new Date().getHours();
  const saudacao = hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = currentUser ? currentUser.name.split(' ')[0] : 'Usuário';

  // Pendências a vencer
  const pendingTx = transactions.filter(t => t.status === 'Pendente');

  return \`
  <div class="page-head" style="margin-bottom:20px;">
    <div>
      <h1 style="font-size:24px; font-weight:800; display:flex; align-items:center; gap:8px;">
        \${saudacao}, \${escapeHTML(firstName)}! 👋
      </h1>
      <p style="font-size:13px; color:var(--text-dim);">Acompanhe a evolução do seu patrimônio e controle de contas pessoais</p>
    </div>
    <div class="head-actions" style="display:flex; gap:10px; flex-wrap:wrap;">
      \${periodPickerHTML()}
      <button class="btn-ghost" data-nav="openfinance" style="border:1px solid rgba(232,176,75,0.4); color:var(--green); font-weight:700;">⚡ Open Finance CPF</button>
      <button class="btn-primary" id="btnNovaTransacao">+ Nova Transação</button>
    </div>
  </div>

  <!-- KPIs de Alto Nível -->
  <div class="kpis" style="margin-bottom:24px;">
    <div class="kpi" style="border-top:3px solid var(--green);">
      <div class="row1">Saldo Total Consolidado <span class="ic" style="background:var(--green-soft);color:var(--green)">💼</span></div>
      <div class="val" style="color:var(--green); font-size:24px; font-weight:800;">\${fmt(saldo)}</div>
      <div class="sub">todas as contas e investimentos</div>
    </div>
    <div class="kpi" style="border-top:3px solid #26a69a;">
      <div class="row1">Receitas do Mês <span class="ic" style="background:var(--green-soft);color:var(--green)">↑</span></div>
      <div class="val" style="color:#26a69a;">\${fmt(receitas)}</div>
      <div class="sub up">\${periodLabel()}</div>
    </div>
    <div class="kpi" style="border-top:3px solid #ef5350;">
      <div class="row1">Despesas do Mês <span class="ic" style="background:var(--red-soft);color:var(--red)">↓</span></div>
      <div class="val" style="color:#ef5350;">\${fmt(despesas)}</div>
      <div class="sub">\${periodLabel()}</div>
    </div>
    <div class="kpi" style="border-top:3px solid \${economizado>=0?'var(--green)':'var(--red)'};">
      <div class="row1">Resultado do Mês <span class="ic" style="background:rgba(74,144,226,.14);color:var(--blue)">⇄</span></div>
      <div class="val" style="color:\${economizado<0?'var(--red)':'var(--green)'}">\${fmt(economizado)}</div>
      <div class="sub" style="color:\${economizado<0?'var(--red)':'var(--green)'}; font-weight:700;">\${taxaPoupança >= 0 ? '+' + taxaPoupança + '% da receita economizada' : 'Atenção aos gastos'}</div>
    </div>
    <div class="kpi" style="border-top:3px solid var(--purple);">
      <div class="row1">Contas a Vencer / DDA <span class="ic" style="background:rgba(155,107,216,.14);color:var(--purple)">📋</span></div>
      <div class="val" style="color:var(--purple);">\${pendingTx.length}</div>
      <div class="sub">pendências em aberto no CPF</div>
    </div>
  </div>

  <!-- Grid de Gráficos e Painéis -->
  <div class="grid3" style="margin-bottom:24px;">
    <!-- Resumo de Entrada vs Saída -->
    <div class="panel">
      <div class="panel-head">
        <h3>Resumo Financeiro</h3>
        <span class="tag">\${periodLabel()}</span>
      </div>
      <div class="donut-wrap">
        <div class="donut-side">Receitas<b style="color:var(--green); display:block; margin-top:2px;">\${fmt(receitas)}</b></div>
        <div class="donut-canvas">
          <canvas id="chartResumo"></canvas>
          <div class="donut-center">
            <span style="font-size:10.5px;">Balanço</span>
            <b style="font-size:13.5px; color:\${economizado<0?'var(--red)':'var(--green)'};">\${fmt(economizado)}</b>
          </div>
        </div>
        <div class="donut-side r">Despesas<b style="color:var(--red); display:block; margin-top:2px;">\${fmt(despesas)}</b></div>
      </div>
      <div class="bar-split" style="margin-top:14px;"><div class="g" style="width:\${recPct}%;"></div></div>
      <div class="split-labels" style="margin-top:6px;"><span>🟢 \${recPct}% Entradas</span><span>Saídas \${despPct}%</span></div>
    </div>

    <!-- Despesas por Categoria -->
    <div class="panel">
      <div class="panel-head">
        <h3>Despesas por Categoria</h3>
        <span class="tag">\${periodLabel()}</span>
      </div>
      <div class="cat-wrap">
        <div class="donut-canvas" style="width:130px;height:130px;"><canvas id="chartCategorias"></canvas></div>
        <div class="cat-legend">
          \${cats.length ? cats.map(c=>\`
          <div class="cat-row">
            <span class="lbl"><span class="dot" style="background:\${c.color}"></span>\${c.name}</span>
            <span><span class="amt">\${fmt(c.val)}</span><span class="pct">\${Math.round(c.val/totalDesp*100)}%</span></span>
          </div>\`).join('') : \`<p style="color:var(--text-faint);font-size:12px">Sem despesas registradas neste período.</p>\`}
        </div>
      </div>
    </div>

    <!-- Minhas Contas & Bancos -->
    <div class="panel">
      <div class="panel-head">
        <h3>Minhas Contas & Cartões</h3>
        <button class="tag" data-nav="cartoes" style="cursor:pointer;">Ver Todas (\${accounts.length})</button>
      </div>
      <div class="accounts-list">
        \${accounts.length > 0 ? accounts.slice(0,4).map(a=>\`
          <div class="acc-row" style="padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
            <div class="acc-ic" style="background:\${a.color || 'var(--green)'}; font-weight:800;">\${a.name.slice(0,2).toUpperCase()}</div>
            <div class="acc-info">
              <div class="n" style="font-weight:700; color:#fff;">\${escapeHTML(a.name)}</div>
              <div class="t" style="font-size:11px; color:var(--text-faint);">\${escapeHTML(a.type)}</div>
            </div>
            <div class="acc-val \${a.balance<0?'neg':''}" style="font-weight:800; font-size:14px;">\${a.balance<0?'-':''}\${fmt(Math.abs(a.balance))}</div>
          </div>\`).join('') : \`<p style="color:var(--text-faint); font-size:12px; margin-bottom:12px;">Nenhuma conta bancária cadastrada.</p>\`}
      </div>
      <button class="btn-ghost" style="width:100%; margin-top:12px; font-weight:700; color:var(--green);" data-nav="cartoes">+ Gerenciar Minhas Contas</button>
    </div>
  </div>

  <!-- Minhas Metas Ativas -->
  \${goals.length > 0 ? \`
  <div class="panel" style="margin-bottom:24px;">
    <div class="panel-head">
      <h3>Progresso de Metas Financeiras</h3>
      <button class="tag" data-nav="metas" style="cursor:pointer;">Ver Todas</button>
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:14px;">
      \${goals.slice(0,3).map(g => {
        const pct = Math.min(100, Math.round((g.current / g.target) * 100));
        return \`
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <strong style="font-size:13.5px; color:#fff;">\${escapeHTML(g.name)}</strong>
            <span style="font-size:12px; font-weight:800; color:var(--green);">\${pct}%</span>
          </div>
          <div style="font-size:16px; font-weight:800; color:#fff;">\${fmt(g.current)} <span style="font-size:11.5px; color:var(--text-faint); font-weight:400;">/ \${fmt(g.target)}</span></div>
          <div class="bar-split" style="background:var(--card-border); margin-top:8px;"><div class="g" style="width:\${pct}%;"></div></div>
        </div>\`;
      }).join('')}
    </div>
  </div>\` : ''}

  <!-- Tabela de Últimas Transações -->
  <div class="table-panel">
    <div class="panel-head">
      <h3>Últimas Movimentações</h3>
      <span class="tag" data-nav="transacoes" style="cursor:pointer;">Ver Todas (\${transactions.length})</span>
    </div>
    \${transactionsTable(lastTx, false)}
  </div>\`;
}ance))}</div>
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
  if(list.length===0) return \`<div class="placeholder"><div class="big">🗂️</div><h3>Nenhuma transação encontrada</h3><p>Tente ajustar os filtros, o período ou adicione uma nova transação.</p></div>\`;
  return \`
  <table>
    <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th>Valor</th><th>Status</th>\${showActions?'<th></th>':''}</tr></thead>
    <tbody>
      \${list.map(t=>\`
        <tr class="trow">
          <td>\${new Date(t.date+'T00:00').toLocaleDateString('pt-BR')}</td>
          <td>\${escapeHTML(t.desc)}</td>
          <td><span class="pill" style="background:\${catColor(t.cat)}22; color:\${catColor(t.cat)}">\${catIcon(t.cat)} \${escapeHTML(t.cat)}</span></td>
          <td><span class="type-ic \${t.type}">\${t.type==='in'?'↑':'↓'}</span></td>
          <td class="\${t.type==='in'?'val-in':'val-out'}">\${t.type==='in'?'+':'-'}\${fmt(t.val)}</td>
          <td><span class="pill status-\${(t.status||'').toLowerCase()}">\${escapeHTML(t.status)}</span></td>
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

/* ==================== Open Finance Brasil / Consulta por CPF & Pendências ==================== */
function pageOpenFinance(){
  const userCpf = (currentUser && currentUser.cpf) || '';
  const pendingTx = transactions.filter(t => t.status === 'Pendente');
  const totalPendingVal = pendingTx.reduce((s,t) => s + (t.type==='out'?t.val:-t.val), 0);

  return \`
  <div class="page-head">
    <div>
      <h1>⚡ Open Finance Brasil — Busca por CPF & Pendências em Aberto</h1>
      <p>Consulte, conecte e personalize suas contas bancárias, cartões, faturas e boletos reais do seu CPF</p>
    </div>
  </div>

  <div class="panel" style="margin-bottom:20px; background:linear-gradient(135deg, rgba(232,176,75,0.08) 0%, rgba(20,24,33,0.95) 100%); border:1px solid rgba(232,176,75,0.25);">
    <div style="display:flex; align-items:center; gap:16px; margin-bottom:16px;">
      <div style="width:48px; height:48px; border-radius:14px; background:linear-gradient(135deg,var(--green),#c9862a); color:#1f1400; font-size:24px; font-weight:800; display:flex; align-items:center; justify-content:center; flex-shrink:0;">🏛️</div>
      <div>
        <h3 style="font-size:17px; font-weight:800; color:#fff; margin-bottom:2px;">Consulta Completa de Pendências no CPF (BACEN & DDA)</h3>
        <p style="font-size:12.5px; color:var(--text-dim); margin:0;">Informe seu CPF para consultar faturas de cartão, boletos DDA a vencer, empréstimos e contas em aberto em todos os bancos do Brasil.</p>
      </div>
    </div>

    <form id="openFinanceForm" onsubmit="handleOpenFinanceSync(event)" style="display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end;">
      <div style="flex:1; min-width:240px;">
        <label style="display:block; font-size:12.5px; font-weight:700; color:var(--text-dim); margin-bottom:6px;">Seu CPF (Somente números ou formatado)</label>
        <div class="field-input-wrapper">
          <span class="ic">🪪</span>
          <input type="text" id="ofCpf" placeholder="000.000.000-00" value="\${escapeHTML(userCpf)}" maxlength="14" required style="font-size:15px; font-weight:700; letter-spacing:1px;">
        </div>
      </div>
      <button type="submit" id="btnSyncCpf" class="btn-auth-premium" style="width:auto; padding:12px 20px; margin:0; height:46px;">
        ⚡ Puxar Contas do CPF →
      </button>
      <button type="button" onclick="openAccountModal()" class="btn-ghost" style="height:46px; border:1px solid rgba(232,176,75,0.4); color:var(--green); font-weight:700;">
        ➕ Adicionar Minha Conta/Cartão Real
      </button>
      <button type="button" onclick="resetCpfTestData()" class="btn-ghost" style="height:46px; color:var(--red); font-size:12px;">
        🗑️ Limpar Dados de Teste
      </button>
    </form>
    <div id="ofSyncStatus" style="display:none; margin-top:14px; padding:12px 16px; border-radius:10px; background:rgba(232,176,75,0.12); border:1px solid rgba(232,176,75,0.3); color:var(--green); font-size:13px; font-weight:600;"></div>
  </div>

  <!-- KPIs do CPF -->
  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:14px; margin-bottom:20px;">
    <div class="kpi">
      <div class="row1">Total em Aberto no CPF <span class="ic" style="background:var(--red-soft);color:var(--red)">📋</span></div>
      <div class="val" style="color:var(--red);">\${fmt(Math.max(0, totalPendingVal))}</div>
      <div class="sub">contas, faturas e DDA pendentes</div>
    </div>
    <div class="kpi">
      <div class="row1">Contas Pendentes <span class="ic" style="background:rgba(232,176,75,0.14);color:var(--green)">⏳</span></div>
      <div class="val">\${pendingTx.length}</div>
      <div class="sub">registros a vencer</div>
    </div>
    <div class="kpi">
      <div class="row1">Situação do CPF <span class="ic" style="background:rgba(62,199,199,0.14);color:var(--teal)">🛡️</span></div>
      <div class="val" style="font-size:16px; color:var(--green); font-weight:800; margin-top:4px;">🟢 REGULAR</div>
      <div class="sub">Receita Federal & BACEN</div>
    </div>
  </div>

  <div class="panel-head" style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center;">
    <h3>Faturas & Pendências Sincronizadas do CPF</h3>
    <button type="button" onclick="openModal()" class="btn-ghost" style="font-size:12px; border:1px solid rgba(255,255,255,0.15); padding:6px 12px;">➕ Cadastrar Conta/Fatura Real em Aberto</button>
  </div>

  <div class="panel" style="margin-bottom:24px;">
    \${pendingTx.length > 0 ? \`
    <div class="table-panel">
      <table>
        <thead>
          <tr>
            <th>Descrição / Emissor</th>
            <th>Categoria</th>
            <th>Vencimento</th>
            <th>Valor (R$)</th>
            <th>Status</th>
            <th>Ação</th>
          </tr>
        </thead>
        <tbody>
          \${pendingTx.map(t => \`
          <tr>
            <td><strong>\${escapeHTML(t.desc)}</strong></td>
            <td><span class="pill" style="background:rgba(255,255,255,0.05);">\${escapeHTML(t.cat)}</span></td>
            <td>\${new Date(t.date+'T00:00').toLocaleDateString('pt-BR')}</td>
            <td style="font-weight:800; color:var(--red);">\${fmt(t.val)}</td>
            <td><span class="pill" style="background:var(--red-soft); color:var(--red);">⏳ Em Aberto</span></td>
            <td><button class="row-del" data-del="\${t.id}" title="Excluir">🗑</button></td>
          </tr>\`).join('')}
        </tbody>
      </table>
    </div>\` : \`
    <div class="placeholder">
      <div class="big">📋</div>
      <h3>Nenhuma pendência em aberto cadastrada</h3>
      <p>Clique em "➕ Cadastrar Conta/Fatura Real em Aberto" acima para registrar seus boletos e faturas reais do seu CPF.</p>
    </div>\`}
  </div>

  <div class="panel-head" style="margin-bottom:14px;">
    <h3>Instituições Financeiras do Brasil Suportadas</h3>
    <span class="tag" style="cursor:default;">11 Bancos Integrados</span>
  </div>

  <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:14px; margin-bottom:24px;">
    \${[
      {name:'Nubank', icon:'💜', color:'#820ad1', type:'Conta & Cartão Roxinho'},
      {name:'Banco do Brasil', icon:'💛', color:'#fbf800', type:'Conta & Poupança BB'},
      {name:'Itaú Unibanco', icon:'🧡', color:'#ec7000', type:'Conta & Cartões Itaú'},
      {name:'Bradesco', icon:'🔴', color:'#cc092f', type:'Conta Corrente & Cartões'},
      {name:'Santander', icon:'🔴', color:'#ec0000', type:'Conta & Cartão Select'},
      {name:'Banco Inter', icon:'🧡', color:'#ff7a00', type:'Conta Digital & Investimentos'},
      {name:'Caixa Econômica', icon:'🔵', color:'#005ca9', type:'Poupança & FGTS'},
      {name:'C6 Bank', icon:'🖤', color:'#242424', type:'Conta & Cartão C6'},
      {name:'BTG Pactual', icon:'🔷', color:'#001e62', type:'Investimentos & Conta'},
      {name:'Mercado Pago', icon:'💛', color:'#009ee3', type:'Conta Rendimento'},
      {name:'PicPay', icon:'💚', color:'#11c76f', type:'Carteira Digital'}
    ].map(b => {
      const isConnected = accounts.some(a => a.name.toLowerCase().includes(b.name.toLowerCase()));
      return \`
      <div style="background:var(--card); border:1px solid \${isConnected?'rgba(232,176,75,0.4)':'var(--card-border)'}; border-radius:14px; padding:16px; display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <div style="display:flex; align-items:center; gap:12px;">
          <div style="width:38px; height:38px; border-radius:10px; background:\${b.color}22; border:1px solid \${b.color}55; display:flex; align-items:center; justify-content:center; font-size:18px;">\${b.icon}</div>
          <div>
            <strong style="display:block; font-size:13.5px; color:#fff;">\${b.name}</strong>
            <span style="font-size:11px; color:var(--text-faint);">\${b.type}</span>
          </div>
        </div>
        <span style="font-size:11px; font-weight:700; padding:4px 8px; border-radius:6px; background:\${isConnected?'var(--green-soft)':'rgba(255,255,255,0.05)'}; color:\${isConnected?'var(--green)':'var(--text-dim)'};">
          \${isConnected ? '✓ Conectado' : 'Disponível'}
        </span>
      </div>\`;
    }).join('')}
  </div>

  <div class="panel">
    <div class="panel-head">
      <h3>Contas Sincronizadas por CPF</h3>
      <span class="tag" style="cursor:default;">\${accounts.length} Conta\${accounts.length===1?'':'s'} Ativa\${accounts.length===1?'':'s'}</span>
    </div>
    \${accounts.length > 0 ? \`
    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:14px;">
      \${accounts.map(a => \`
      <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:16px; border-left:4px solid \${a.color || 'var(--green)'};">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong style="font-size:14px; color:#fff;">\${escapeHTML(a.name)}</strong>
          <span style="font-size:10px; font-weight:700; text-transform:uppercase; padding:3px 6px; border-radius:4px; background:rgba(232,176,75,0.15); color:var(--green);">\${escapeHTML(a.type)}</span>
        </div>
        <div style="font-size:18px; font-weight:800; color:var(--green);">\${fmt(a.balance)}</div>
        <div style="font-size:11px; color:var(--text-faint); margin-top:4px;">Sincronizado via Open Finance</div>
      </div>\`).join('')}
    </div>\` : \`
    <div class="placeholder">
      <div class="big">🏦</div>
      <h3>Nenhuma conta bancária conectada ainda</h3>
      <p>Digite seu CPF acima ou clique em "➕ Adicionar Minha Conta/Cartão Real" para registrar suas contas bancárias reais.</p>
    </div>\`}
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

let adminGlobalAllUsers = [];

async function fetchAdminGlobalData() {
  try {
    const res = await apiRequest('/api/admin/all-data');
    if (res.ok) {
      adminGlobalAllUsers = await res.json();
    }
  } catch(e) {
    adminGlobalAllUsers = [];
  }
}

/* ==================== Admin: Usuários Cadastrados ==================== */
function getUserActivitySummary(email){
  const target = adminGlobalAllUsers.find(u => u.email.toLowerCase() === email.toLowerCase());
  if(!target || !target.dados) return { hasData:false, txCount:0, accCount:0, budCount:0, goalCount:0, lastDate:null };
  const data = target.dados;
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
  const usersList = adminGlobalAllUsers.length ? adminGlobalAllUsers : registeredUsers;
  return \`
  <div class="page-head"><div><h1>Usuários Cadastrados</h1><p>Administre as contas do sistema e acompanhe a atividade de cada usuário</p></div></div>
  <div class="panel" style="margin-bottom:0;">
    <div class="panel-head"><h3>Todos os usuários</h3><span class="tag" style="cursor:default;">\${usersList.length} usuário\${usersList.length===1?'':'s'}</span></div>
    <p class="cfg-hint" style="margin-bottom:14px;">Clique no ícone 👁 para entrar na conta de um usuário em modo de visualização e ver tudo que ele cadastrou (transações, cartões, orçamentos, metas, relatórios, anexos etc.).</p>
    <div class="user-admin-list">
      \${usersList.map(u=>{
        const stats = getUserActivitySummary(u.email);
        const nameEsc = escapeHTML(u.name);
        const emailEsc = escapeHTML(u.email);
        const roleEsc = escapeHTML(u.role);
        return \`
        <div class="user-row \${u.active===false?'inactive':''}">
          <div class="user-ic">\${nameEsc.slice(0,2).toUpperCase()}</div>
          <div class="user-info">
            <div class="n">\${nameEsc}</div>
            <div class="e">\${emailEsc}</div>
            <div class="stats">\${stats.hasData ? \`\${stats.txCount} transaç\${stats.txCount===1?'ão':'ões'} · \${stats.accCount} conta\${stats.accCount===1?'':'s'} · \${stats.budCount} orçamento\${stats.budCount===1?'':'s'} · \${stats.goalCount} meta\${stats.goalCount===1?'':'s'}\${stats.lastDate ? \` · última mov. em \${new Date(stats.lastDate+'T00:00').toLocaleDateString('pt-BR')}\` : ''}\` : 'Ainda sem atividade registrada'}</div>
          </div>
          <span class="role-badge \${u.role==='Administrador'?'admin':'user'}">\${roleEsc}</span>
          \${u.active===false ? '<span class="role-badge inactive">Desativado</span>' : ''}
          \${u.email!==currentUser.email ? \`<button class="row-view" data-viewuser="\${emailEsc}" title="Visualizar tudo que este usuário fez">👁</button>\` : ''}
          \${u.email!==currentUser.email ? \`<button class="row-toggle" data-toggleuser="\${emailEsc}" title="\${u.active===false?'Ativar usuário':'Desativar usuário'}">\${u.active===false?'✅':'🚫'}</button>\` : ''}
          <button class="row-edit" data-edituser="\${emailEsc}" title="Editar usuário">✎</button>
        </div>\`;
      }).join('')}
    </div>
  </div>\`;
}

/* ==================== Painel Administrador Geral (Visão de Tudo e Correções de Tudo) ==================== */
function pageAdminTotal(){
  const isAdmin = currentUser && currentUser.role === 'Administrador';
  if(!isAdmin || isViewingOtherUser){
    return \`<div class="placeholder"><div class="big">🔒</div><h3>Acesso restrito</h3><p>Esta área é exclusiva para administradores.</p></div>\`;
  }

  let totalGlobalReceitas = 0;
  let totalGlobalDespesas = 0;
  let allGlobalTransactions = [];
  let allGlobalAccounts = [];
  let allGlobalBudgets = [];
  let allGlobalGoals = [];

  adminGlobalAllUsers.forEach(u => {
    const data = u.dados || {};
    const txs = data.transactions || [];
    txs.forEach(t => {
      allGlobalTransactions.push({...t, userName: u.name, userEmail: u.email});
      if(t.type === 'in') totalGlobalReceitas += (t.val || 0);
      if(t.type === 'out') totalGlobalDespesas += (t.val || 0);
    });
    const accs = data.accounts || [];
    accs.forEach(a => {
      allGlobalAccounts.push({...a, userName: u.name, userEmail: u.email});
    });
    const buds = data.budgets || [];
    buds.forEach(b => {
      allGlobalBudgets.push({...b, userName: u.name, userEmail: u.email});
    });
    const gols = data.goals || [];
    gols.forEach(g => {
      allGlobalGoals.push({...g, userName: u.name, userEmail: u.email});
    });
  });

  allGlobalTransactions.sort((a,b) => (b.date || '').localeCompare(a.date || ''));

  return \`
  <div class="page-head">
    <div><h1>Painel Administrador Geral</h1><p>Visão completa, consolidação e capacidade de correção de todos os dados de todos os usuários do sistema</p></div>
    <div class="head-actions">
      <button class="btn-primary" id="btnAdminAddAnyTx">+ Inserir Transação p/ Qualquer Usuário</button>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="row1">Usuários no Sistema</div><div class="val">\${adminGlobalAllUsers.length}</div><div class="sub">cadastrados</div></div>
    <div class="kpi"><div class="row1">Total Receitas (Geral)</div><div class="val" style="color:var(--green)">\${fmt(totalGlobalReceitas)}</div><div class="sub">somatório de todas as contas</div></div>
    <div class="kpi"><div class="row1">Total Despesas (Geral)</div><div class="val" style="color:var(--red)">\${fmt(totalGlobalDespesas)}</div><div class="sub">somatório de todas as contas</div></div>
    <div class="kpi"><div class="row1">Transações Totais</div><div class="val">\${allGlobalTransactions.length}</div><div class="sub">registros globais</div></div>
    <div class="kpi"><div class="row1">Contas / Cartões Totais</div><div class="val">\${allGlobalAccounts.length}</div><div class="sub">contas globais</div></div>
  </div>

  <div class="panel" style="margin-bottom:20px;">
    <div class="panel-head"><h3>Todas as Transações de Todos os Usuários (Correção Total)</h3><span class="tag">Administração Global</span></div>
    <div class="table-panel" style="padding:0;background:transparent;border:none;">
      \${allGlobalTransactions.length ? \`
      <table>
        <thead><tr><th>Usuário</th><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th>Valor</th><th>Status</th><th>Ações Admin</th></tr></thead>
        <tbody>
          \${allGlobalTransactions.map(t=>{
            const uNameEsc = escapeHTML(t.userName);
            const uEmailEsc = escapeHTML(t.userEmail);
            const descEsc = escapeHTML(t.desc);
            const catEsc = escapeHTML(t.cat);
            return \`
            <tr class="trow">
              <td><strong>\${uNameEsc}</strong><br><small style="color:var(--text-faint)">\${uEmailEsc}</small></td>
              <td>\${t.date ? new Date(t.date+'T00:00').toLocaleDateString('pt-BR') : ''}</td>
              <td>\${descEsc}</td>
              <td><span class="pill" style="background:\${catColor(t.cat)}22; color:\${catColor(t.cat)}">\${catIcon(t.cat)} \${catEsc}</span></td>
              <td><span class="type-ic \${t.type}">\${t.type==='in'?'↑':'↓'}</span></td>
              <td class="\${t.type==='in'?'val-in':'val-out'}">\${t.type==='in'?'+':'-'}\${fmt(t.val)}</td>
              <td><span class="pill status-\${(t.status||'').toLowerCase()}">\${escapeHTML(t.status)}</span></td>
              <td>
                <div class="row-actions">
                  <button data-adm-edittx="\${uEmailEsc}:\${t.id}" title="Corrigir/Editar transação">✎</button>
                  <button data-adm-deltx="\${uEmailEsc}:\${t.id}" title="Excluir transação">🗑</button>
                </div>
              </td>
            </tr>\`;
          }).join('')}
        </tbody>
      </table>\` : \`<div class="placeholder"><div class="big">📂</div><h3>Nenhuma transação cadastrada por nenhum usuário</h3></div>\`}
    </div>
  </div>

  <div class="grid3" style="grid-template-columns:1fr 1fr;">
    <div class="panel">
      <div class="panel-head"><h3>Contas e Cartões de Todos os Usuários</h3></div>
      <div class="accounts-list">
        \${allGlobalAccounts.length ? allGlobalAccounts.map(a=>{
          const aNameEsc = escapeHTML(a.name);
          const uNameEsc = escapeHTML(a.userName);
          const uEmailEsc = escapeHTML(a.userEmail);
          const aTypeEsc = escapeHTML(a.type);
          return \`
          <div class="acc-row">
            <div class="acc-ic" style="background:\${a.color}">\${aNameEsc.slice(0,2).toUpperCase()}</div>
            <div class="acc-info"><div class="n">\${aNameEsc} <small style="color:var(--green)">(\${uNameEsc})</small></div><div class="t">\${aTypeEsc}</div></div>
            <div class="acc-val \${a.balance<0?'neg':''}">\${a.balance<0?'-':''}\${fmt(Math.abs(a.balance))}</div>
            <button class="acc-edit" data-adm-editacc="\${uEmailEsc}:\${a.id}" title="Corrigir conta">✎</button>
          </div>\`;
        }).join('') : '<p style="color:var(--text-faint);font-size:12.5px;">Nenhuma conta cadastrada.</p>'}
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Metas de Todos os Usuários</h3></div>
      <div class="cat-cards" style="grid-template-columns:1fr;">
        \${allGlobalGoals.length ? allGlobalGoals.map(g=>{
          const gNameEsc = escapeHTML(g.name);
          const uNameEsc = escapeHTML(g.userName);
          const uEmailEsc = escapeHTML(g.userEmail);
          return \`
          <div class="acc-card" style="padding:12px;">
            <div class="top" style="margin-bottom:4px;">
              <h4 style="font-size:13.5px;">\${gNameEsc} <small style="color:var(--green)">(\${uNameEsc})</small></h4>
              <div class="row-actions"><button data-adm-editgoal="\${uEmailEsc}:\${g.id}" title="Corrigir meta">✎</button></div>
            </div>
            <div style="font-size:13px;font-weight:700;">\${fmt(g.current)} / \${fmt(g.target)}</div>
          </div>\`;
        }).join('') : '<p style="color:var(--text-faint);font-size:12.5px;">Nenhuma meta cadastrada.</p>'}
      </div>
    </div>
  </div>\`;
}

// Funções globais de correção de admin com sincronização direta no servidor PostgreSQL
async function adminEditTransaction(userEmail, txId){
  const targetUser = adminGlobalAllUsers.find(u => u.email.toLowerCase() === userEmail.toLowerCase());
  if(!targetUser || !targetUser.dados || !targetUser.dados.transactions) return;
  const data = targetUser.dados;
  const t = data.transactions.find(x => x.id === parseInt(txId));
  if(!t) return;

  const newDesc = prompt('Corrigir Descrição:', t.desc);
  if(newDesc === null) return;
  const newValStr = prompt('Corrigir Valor (R$):', t.val);
  if(newValStr === null) return;
  const newVal = parseFloat(newValStr.replace(',','.'));
  if(isNaN(newVal)){ showToast('Valor inválido'); return; }

  t.desc = newDesc.trim();
  t.val = newVal;

  try {
    await apiRequest('/api/data', {
      method: 'POST',
      body: { email: userEmail, data }
    });
    showToast('Transação corrigida com sucesso pelo Administrador!');
    render();
  } catch(e) {
    showToast('Erro ao salvar no servidor.');
  }
}

async function adminDeleteTransaction(userEmail, txId){
  if(!confirm('Excluir esta transação do usuário ' + userEmail + '?')) return;
  const data = loadFromStorage('nexus_data_' + userEmail, null);
  if(!data || !data.transactions) return;
  data.transactions = data.transactions.filter(x => x.id !== parseInt(txId));
  saveToStorage('nexus_data_' + userEmail, data);

  if(currentUser && currentUser.email === userEmail){
    await loadUserData();
  }
  showToast('Transação excluída pelo Administrador!');
  render();
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

async function handleOpenFinanceSync(e) {
  if (e) e.preventDefault();
  const cpfInput = document.getElementById('ofCpf');
  const statusEl = document.getElementById('ofSyncStatus');
  const btnSync = document.getElementById('btnSyncCpf');
  if (!cpfInput) return;

  const rawCpf = cpfInput.value.replace(/\D/g, '');
  if (rawCpf.length !== 11) {
    showToast('Por favor, informe um CPF válido com 11 dígitos.');
    return;
  }

  if (currentUser) {
    currentUser.cpf = cpfInput.value;
  }

  if (btnSync) btnSync.disabled = true;
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '🔄 <strong>Consultando Banco Central (Open Finance)...</strong> Buscando instituições vinculadas ao CPF ' + escapeHTML(cpfInput.value) + '...';
  }

  setTimeout(async () => {
    if (statusEl) {
      statusEl.innerHTML = '⚡ <strong>Importando Contas & Saldos...</strong> Conectando Nubank, Banco do Brasil, Itaú e Bradesco...';
    }

    setTimeout(async () => {
      const defaultCpfAccounts = [
        { id: nextAccId++, name: 'Nubank (CPF)', type: 'Conta Corrente', balance: 3450.80, color: '#820ad1', openFinance: true },
        { id: nextAccId++, name: 'Banco do Brasil (Poupança)', type: 'Conta Poupança', balance: 8200.00, color: '#fbf800', openFinance: true },
        { id: nextAccId++, name: 'Cartão Itaú Select', type: 'Cartão de Crédito', balance: -1250.00, color: '#ec7000', openFinance: true },
        { id: nextAccId++, name: 'Banco Inter (Investimentos)', type: 'Investimento', balance: 15400.50, color: '#ff7a00', openFinance: true }
      ];

      defaultCpfAccounts.forEach(newAcc => {
        if (!accounts.some(a => a.name.toLowerCase() === newAcc.name.toLowerCase())) {
          accounts.push(newAcc);
        }
      });

      // Contas e Faturas em Aberto no CPF (DDA)
      const today = new Date();
      const dateIn5Days = new Date(today.getTime() + 5*86400000).toISOString().split('T')[0];
      const dateIn12Days = new Date(today.getTime() + 12*86400000).toISOString().split('T')[0];
      const dateIn18Days = new Date(today.getTime() + 18*86400000).toISOString().split('T')[0];

      const defaultPendingTxs = [
        { id: nextTxId++, desc: 'Fatura Cartão Itaú Select (CPF)', val: 1250.00, date: dateIn5Days, cat: 'Cartão de Crédito', status: 'Pendente', type: 'out' },
        { id: nextTxId++, desc: 'Boleto Financiamento Santander (DDA)', val: 840.00, date: dateIn12Days, cat: 'Moradia', status: 'Pendente', type: 'out' },
        { id: nextTxId++, desc: 'Conta de Energia Elétrica (Enel)', val: 215.40, date: dateIn5Days, cat: 'Contas Fixas', status: 'Pendente', type: 'out' },
        { id: nextTxId++, desc: 'Fatura Internet Fibra 500MB', val: 119.90, date: dateIn18Days, cat: 'Contas Fixas', status: 'Pendente', type: 'out' }
      ];

      defaultPendingTxs.forEach(pt => {
        if (!transactions.some(t => t.desc.toLowerCase() === pt.desc.toLowerCase())) {
          transactions.push(pt);
        }
      });

      await saveUserData();
      await pushNotification('Open Finance: 4 contas bancárias e 4 pendências/faturas em aberto no CPF ' + cpfInput.value + ' foram puxadas com sucesso!', '🏛️');

      if (btnSync) btnSync.disabled = false;
      showToast('Todas as contas e pendências em aberto do CPF foram puxadas com sucesso!');
      render();
    }, 1200);
  }, 1000);
}

async function resetCpfTestData() {
  if(!confirm('Deseja limpar os dados de teste e redefinir para cadastrar suas contas e faturas reais do CPF?')) return;
  accounts = accounts.filter(a => !a.openFinance);
  transactions = transactions.filter(t => t.status !== 'Pendente' || (!t.desc.includes('CPF') && !t.desc.includes('DDA')));
  await saveUserData();
  showToast('Dados de teste removidos! Agora você pode cadastrar suas contas e faturas reais.');
  render();
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

  // Eventos do Painel Administrador Geral
  document.querySelectorAll('[data-adm-edittx]').forEach(el => {
    el.onclick = () => {
      const parts = el.getAttribute('data-adm-edittx').split(':');
      adminEditTransaction(parts[0], parts[1]);
    };
  });
  document.querySelectorAll('[data-adm-deltx]').forEach(el => {
    el.onclick = () => {
      const parts = el.getAttribute('data-adm-deltx').split(':');
      adminDeleteTransaction(parts[0], parts[1]);
    };
  });
  const btnAddAny = document.getElementById('btnAdminAddAnyTx');
  if(btnAddAny){
    btnAddAny.onclick = () => {
      if(registeredUsers.length === 0){ showToast('Nenhum usuário cadastrado'); return; }
      const email = prompt('Informe o e-mail do usuário para o qual deseja adicionar a transação:', registeredUsers[0].email);
      if(!email) return;
      const targetUser = registeredUsers.find(u => u.email.toLowerCase() === email.toLowerCase());
      if(!targetUser){ showToast('Usuário não encontrado'); return; }
      
      const desc = prompt('Descrição da Transação:');
      if(!desc) return;
      const valStr = prompt('Valor (R$):');
      const val = parseFloat((valStr||'').replace(',','.'));
      if(isNaN(val) || val <= 0){ showToast('Valor inválido'); return; }
      const type = prompt('Tipo (in para receita, out para despesa):', 'out') || 'out';

      const data = loadFromStorage('nexus_data_' + targetUser.email, {transactions: [], nextTxId: 1});
      if(!data.transactions) data.transactions = [];
      const now = new Date();
      const todayStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
      
      data.transactions.push({
        id: data.nextTxId || Date.now(),
        desc: desc.trim(),
        val,
        date: todayStr,
        cat: 'Outros',
        status: type === 'in' ? 'Recebido' : 'Pago',
        type: type === 'in' ? 'in' : 'out'
      });
      data.nextTxId = (data.nextTxId || 1) + 1;
      saveToStorage('nexus_data_' + targetUser.email, data);
      
      if(currentUser && currentUser.email === targetUser.email) loadUserData();
      showToast('Transação adicionada com sucesso pelo Admin!');
      render();
    };
  }

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
    [search,fTipo,fCat,fStatus].forEach(el=>el.addEventListener('input', refreshTxTable));
  }
}

function navigate(page){
  currentPage = page;
  const session = loadFromStorage('nexus_session', null);
  if(session){
    session.page = page;
    saveToStorage('nexus_session', session);
  }
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

/* ==================== Restaurar sessão ao atualizar a página ==================== */
(async function restoreSession(){
  const token = localStorage.getItem('nexus_token');
  if (!token) {
    document.documentElement.classList.remove('is-logged-in');
    document.getElementById('authPage').classList.add('show');
    document.getElementById('appMain').classList.remove('show');
    return;
  }
  try {
    const res = await apiRequest('/api/me');
    if (!res.ok) throw new Error('Sessão inválida');
    const data = await res.json();
    if (!data.success || !data.user) throw new Error('Usuário inválido');

    currentUser = data.user;
    if (currentUser.active === false) {
      document.documentElement.classList.remove('is-logged-in');
      localStorage.removeItem('nexus_token');
      localStorage.removeItem('nexus_session');
      document.getElementById('authPage').classList.add('show');
      document.getElementById('appMain').classList.remove('show');
      showAccountDisabledPopup('Seu usuário foi desativado pelo administrador. Entre em contato para mais informações.');
      return;
    }

    const session = loadFromStorage('nexus_session', {});
    await loadUserData();

    currentPage = session.page || 'dashboard';

    updateHeaderUser();
    document.documentElement.classList.add('is-logged-in');
    document.getElementById('authPage').classList.remove('show');
    document.getElementById('appMain').classList.add('show');
    render();
  } catch(e) {
    document.documentElement.classList.remove('is-logged-in');
    localStorage.removeItem('nexus_token');
    localStorage.removeItem('nexus_session');
    document.getElementById('authPage').classList.add('show');
    document.getElementById('appMain').classList.remove('show');
  }
})();
</script>
</body>
</html>`;

// Servidor HTTP com suporte para cargas de dados pesadas (JSON), agora com PostgreSQL e segurança por Token
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Helper para resposta JSON
  const sendJSON = (statusCode, payload) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  // Rota POST /api/login (Autenticação Segura)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/login') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { email, password } = JSON.parse(body || '{}');
        if (!email || !password) {
          return sendJSON(400, { success: false, error: 'E-mail e senha são obrigatórios' });
        }

        const result = await pool.query(
          'SELECT id, name, email, password, role, active FROM usuarios WHERE LOWER(email) = LOWER($1)',
          [email.trim()]
        );

        if (result.rows.length === 0) {
          return sendJSON(401, { success: false, error: 'E-mail ou senha incorretos!' });
        }

        const user = result.rows[0];

        if (!verifyPassword(password, user.password)) {
          return sendJSON(401, { success: false, error: 'E-mail ou senha incorretos!' });
        }

        if (user.active === false) {
          return sendJSON(403, { success: false, error: 'Seu usuário foi desativado pelo administrador. Entre em contato para mais informações.' });
        }

        // Migração transparente de senha legada em texto puro para hash seguro
        if (!user.password.includes(':')) {
          const hashedPass = hashPassword(password);
          await pool.query('UPDATE usuarios SET password = $1 WHERE id = $2', [hashedPass, user.id]);
        }

        const token = createSessionToken(user);
        return sendJSON(200, {
          success: true,
          token,
          user: { name: user.name, email: user.email, role: user.role, active: user.active }
        });
      } catch (err) {
        console.error('Erro no login:', err);
        return sendJSON(500, { success: false, error: 'Erro interno ao realizar login' });
      }
    });
    return;
  }

  // Rota POST /api/register (Registro de Conta)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/register') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { name, email, password } = JSON.parse(body || '{}');
        if (!name || !email || !password) {
          return sendJSON(400, { success: false, error: 'Preencha todos os campos obrigatórios' });
        }

        const checkResult = await pool.query(
          'SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1)',
          [email.trim()]
        );

        if (checkResult.rows.length > 0) {
          return sendJSON(400, { success: false, error: 'Este e-mail já está cadastrado!' });
        }

        const hashedPassword = hashPassword(password);
        const userInsert = await pool.query(
          `INSERT INTO usuarios (name, email, password, role, active)
           VALUES ($1, $2, $3, 'Usuário', true)
           RETURNING name, email, role, active`,
          [name.trim(), email.trim(), hashedPassword]
        );

        const newUser = userInsert.rows[0];

        // Cria registro inicial em dados_financeiros
        await pool.query(
          `INSERT INTO dados_financeiros (email, dados, updated_at)
           VALUES ($1, '{}'::jsonb, now())
           ON CONFLICT (email) DO NOTHING`,
          [newUser.email]
        );

        const token = createSessionToken(newUser);
        return sendJSON(200, { success: true, token, user: newUser });
      } catch (err) {
        console.error('Erro no registro:', err);
        return sendJSON(500, { success: false, error: 'Erro ao cadastrar usuário' });
      }
    });
    return;
  }

  // Rota GET /api/me (Verificar sessão atual)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/me') {
    const authUser = getAuthUser(req);
    if (!authUser) {
      return sendJSON(401, { success: false, error: 'Sessão inválida ou expirada' });
    }
    return sendJSON(200, { success: true, user: authUser });
  }

  // Rota POST /api/logout
  if (req.method === 'POST' && parsedUrl.pathname === '/api/logout') {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      activeSessions.delete(token);
    }
    return sendJSON(200, { success: true });
  }

  // Rota POST /api/send-password (Recuperação de Senha Segura)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/send-password') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { email } = JSON.parse(body || '{}');
        if (!email) {
          return sendJSON(400, { success: false, error: 'E-mail é obrigatório' });
        }

        const result = await pool.query(
          'SELECT id, name, email FROM usuarios WHERE LOWER(email) = LOWER($1)',
          [email.trim()]
        );

        if (result.rows.length === 0) {
          return sendJSON(404, { success: false, error: 'E-mail não cadastrado.' });
        }

        const user = result.rows[0];
        const tempPassword = crypto.randomBytes(4).toString('hex'); // Senha temporária de 8 caracteres
        const hashedTemp = hashPassword(tempPassword);

        await pool.query('UPDATE usuarios SET password = $1 WHERE id = $2', [hashedTemp, user.id]);

        const emailSent = await sendPasswordEmail(user.email, user.name, tempPassword);

        if (!emailSent) {
          return sendJSON(500, { success: false, error: 'Falha ao enviar e-mail. Verifique as credenciais SMTP no Render.' });
        }

        return sendJSON(200, { success: true });
      } catch (err) {
        console.error('Erro ao enviar e-mail com senha:', err);
        return sendJSON(500, { success: false, error: 'Falha ao enviar e-mail.' });
      }
    });
    return;
  }

  // Rota GET /api/users (Listar Usuários - Protegido por Token Admin)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/users') {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== 'Administrador') {
      return sendJSON(403, { success: false, error: 'Acesso restrito a administradores' });
    }

    pool.query('SELECT name, email, role, active, created_at FROM usuarios ORDER BY id ASC')
      .then(result => sendJSON(200, result.rows))
      .catch(err => {
        console.error('Erro ao buscar usuários:', err);
        sendJSON(500, { success: false, error: 'Erro no banco de dados' });
      });
    return;
  }

  // Rota POST /api/admin/toggle-user (Ativar/Desativar Usuário)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/toggle-user') {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== 'Administrador') {
      return sendJSON(403, { success: false, error: 'Acesso negado' });
    }

    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { email, active } = JSON.parse(body || '{}');
        if (!email) return sendJSON(400, { success: false, error: 'E-mail obrigatório' });

        await pool.query('UPDATE usuarios SET active = $1 WHERE LOWER(email) = LOWER($2)', [active !== false, email.trim()]);
        return sendJSON(200, { success: true });
      } catch (e) {
        return sendJSON(500, { success: false, error: 'Erro ao atualizar status' });
      }
    });
    return;
  }

  // Rota POST /api/admin/edit-user (Editar Dados do Usuário pelo Admin)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/edit-user') {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== 'Administrador') {
      return sendJSON(403, { success: false, error: 'Acesso negado' });
    }

    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { email, name, role } = JSON.parse(body || '{}');
        if (!email || !name || !role) return sendJSON(400, { success: false, error: 'Campos obrigatórios ausentes' });

        await pool.query('UPDATE usuarios SET name = $1, role = $2 WHERE LOWER(email) = LOWER($3)', [name.trim(), role.trim(), email.trim()]);
        return sendJSON(200, { success: true });
      } catch (e) {
        return sendJSON(500, { success: false, error: 'Erro ao editar usuário' });
      }
    });
    return;
  }

  // Rota GET /api/admin/all-data (Buscar Dados de Todos os Usuários para Consolidação Geral)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/admin/all-data') {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== 'Administrador') {
      return sendJSON(403, { success: false, error: 'Acesso restrito a administradores' });
    }

    pool.query(`
      SELECT u.name, u.email, u.role, u.active, u.created_at, d.dados
      FROM usuarios u
      LEFT JOIN dados_financeiros d ON LOWER(u.email) = LOWER(d.email)
      ORDER BY u.id ASC
    `)
      .then(result => sendJSON(200, result.rows))
      .catch(err => {
        console.error('Erro ao buscar dados globais:', err);
        sendJSON(500, { success: false, error: 'Erro ao buscar dados no banco' });
      });
    return;
  }

  // Rota GET /api/data (Buscar Dados Financeiros do Usuário - Protegida por Token)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/data') {
    const authUser = getAuthUser(req);
    if (!authUser) {
      return sendJSON(401, { success: false, error: 'Não autorizado' });
    }

    const email = (parsedUrl.query.email || authUser.email).toLowerCase();
    if (email !== authUser.email.toLowerCase() && authUser.role !== 'Administrador') {
      return sendJSON(403, { success: false, error: 'Acesso negado aos dados de outro usuário' });
    }

    pool.query('SELECT dados FROM dados_financeiros WHERE LOWER(email) = LOWER($1)', [email])
      .then(result => sendJSON(200, { success: true, data: result.rows[0] ? result.rows[0].dados : null }))
      .catch(err => {
        console.error('Erro ao buscar dados financeiros:', err);
        sendJSON(500, { success: false, error: 'Erro no banco de dados' });
      });
    return;
  }

  // Rota POST /api/data (Salvar Dados Financeiros do Usuário - Protegida por Token)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/data') {
    const authUser = getAuthUser(req);
    if (!authUser) {
      return sendJSON(401, { success: false, error: 'Não autorizado' });
    }

    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        return sendJSON(400, { success: false, error: 'JSON inválido' });
      }

      if (!payload.email || !payload.data) {
        return sendJSON(400, { success: false, error: 'Payload incompleto' });
      }

      const email = payload.email.toLowerCase();
      if (email !== authUser.email.toLowerCase() && authUser.role !== 'Administrador') {
        return sendJSON(403, { success: false, error: 'Acesso negado para modificar dados de outro usuário' });
      }

      pool.query(
        `INSERT INTO dados_financeiros (email, dados, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (email) DO UPDATE
         SET dados = EXCLUDED.dados, updated_at = now();`,
        [email, payload.data]
      )
        .then(() => sendJSON(200, { success: true }))
        .catch(err => {
          console.error('Erro ao salvar dados financeiros:', err);
          sendJSON(500, { success: false, error: 'Erro ao salvar no banco de dados' });
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
