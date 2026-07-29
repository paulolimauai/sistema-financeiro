require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const DB_FILE = path.join(__dirname, 'database.json');

function loadDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return JSON.parse(data);
        } catch (e) {
            console.error('Erro ao ler database.json, inicializando vazio.', e);
        }
    }
    return {
        users: [],
        accounts: [],
        cards: [],
        transactions: [],
        investments: [],
        budgets: [],
        goals: [],
        debts: [],
        recurring: []
    };
}

function saveDatabase(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function getDb() {
    return loadDatabase();
}

app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'plp_financeiro_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000
    }
}));

function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) return next();
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ error: '🔒 Sessão expirada. Faça login novamente.' });
    }
    res.redirect('/login');
}

// ==========================================
// TELA DE LOGIN / CADASTRO (DESIGN HIGH-FREQUENCY TRADING TERMINAL)
// ==========================================
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="pt-BR" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PLP FINANCEIRO - Acesso ao Terminal</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700;800&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }

        :root {
            --bg-main: #06111f;
            --card-bg: rgba(13, 27, 46, 0.75);
            --card-border: rgba(56, 189, 248, 0.2);
            --field-bg: #ffffff;
            --field-text: #0f172a;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --accent-cyan: #38bdf8;
            --accent-blue: #2563eb;
            --neon-green: #10b981;
            --neon-red: #f43f5e;
            --glow-cyan: rgba(56, 189, 248, 0.35);
        }

        html, body { height: 100%; width: 100%; margin: 0; padding: 0; }
        
        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background: var(--bg-main);
            color: var(--text-main);
            min-height: 100vh;
            position: relative;
            overflow-x: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px 16px;
        }

        /* CENÁRIO DE BACKGROUND COM VELAS E SÍMBOLOS FINANANCEIROS */
        .bg-scene {
            position: fixed;
            inset: 0;
            z-index: 0;
            overflow: hidden;
            background: radial-gradient(circle at 50% 40%, #0d1e36 0%, #050b14 80%);
        }

        .bg-grid {
            position: absolute;
            inset: 0;
            background-image: 
                linear-gradient(rgba(56, 189, 248, 0.08) 1px, transparent 1px),
                linear-gradient(90deg, rgba(56, 189, 248, 0.08) 1px, transparent 1px);
            background-size: 40px 40px;
            opacity: 0.6;
        }

        /* GRÁFICO CANDLESTICK DE FUNDO */
        .chart-bg-line {
            position: absolute;
            top: 52%;
            left: 0;
            right: 0;
            height: 2px;
            background: rgba(56, 189, 248, 0.4);
            box-shadow: 0 0 15px rgba(56, 189, 248, 0.6);
            z-index: 1;
        }

        .candles-layer {
            position: absolute;
            top: 40%;
            width: 100%;
            height: 200px;
            display: flex;
            align-items: center;
            justify-content: space-around;
            z-index: 1;
            opacity: 0.65;
            pointer-events: none;
        }

        .candle { position: relative; width: 18px; border-radius: 2px; }
        .candle::before { content: ''; position: absolute; left: 50%; transform: translateX(-50%); width: 2px; background: inherit; }
        .candle.green { background: var(--neon-green); height: 35px; box-shadow: 0 0 10px rgba(16, 185, 129, 0.4); }
        .candle.green::before { top: -14px; bottom: -14px; }
        .candle.red { background: var(--neon-red); height: 40px; box-shadow: 0 0 10px rgba(244, 63, 94, 0.4); }
        .candle.red::before { top: -16px; bottom: -16px; }

        /* MOEDAS EM MARCA D'ÁGUA */
        .symbol-float { position: absolute; color: rgba(255, 255, 255, 0.07); font-family: 'JetBrains Mono', monospace; font-weight: 700; user-select: none; z-index: 1; }

        .login-container { 
            position: relative; 
            z-index: 5; 
            width: 100%; 
            max-width: 450px; 
            margin: auto; 
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            justify-content: center; 
        }

        .brand-header-container { text-align: center; margin-bottom: 22px; width: 100%; }

        .brand-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: rgba(16, 185, 129, 0.12);
            border: 1px solid var(--neon-green);
            color: var(--neon-green);
            font-family: 'JetBrains Mono', monospace;
            font-size: 10px;
            font-weight: 800;
            padding: 4px 14px;
            border-radius: 20px;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            margin-bottom: 12px;
            box-shadow: 0 0 12px rgba(16, 185, 129, 0.2);
        }

        .brand-animated-name {
            font-family: 'Plus Jakarta Sans', sans-serif;
            font-size: 30px;
            font-weight: 900;
            letter-spacing: 2px;
            text-transform: uppercase;
            color: #ffffff;
            display: block;
            text-shadow: 0 0 20px var(--glow-cyan);
        }

        .brand-subtitle { 
            font-size: 11px; 
            color: var(--text-muted); 
            letter-spacing: 3px; 
            text-transform: uppercase; 
            font-weight: 700; 
            margin-top: 4px; 
        }

        .login-card { 
            width: 100%; 
            background: var(--card-bg); 
            border: 1px solid var(--card-border); 
            border-radius: 18px; 
            padding: 28px 28px 24px; 
            box-shadow: 0 25px 50px rgba(0, 0, 0, 0.7), 0 0 30px rgba(56, 189, 248, 0.08); 
            backdrop-filter: blur(16px); 
            -webkit-backdrop-filter: blur(16px);
            animation: cardIn 0.4s ease-out; 
        }
        @keyframes cardIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

        .login-card-head { text-align: left; margin-bottom: 18px; display: flex; align-items: center; gap: 8px; }
        .login-title { font-size: 16px; font-weight: 800; color: #ffffff; letter-spacing: -0.2px; display: flex; align-items: center; gap: 8px; }

        .form-group { margin-bottom: 14px; position: relative; text-align: left; }
        label { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: #ffffff; display: block; margin-bottom: 6px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
        
        input { 
            width: 100%; 
            padding: 12px 14px; 
            background: var(--field-bg); 
            border: 1px solid #cbd5e1; 
            color: var(--field-text); 
            border-radius: 8px; 
            font-size: 13.5px; 
            font-family: 'Plus Jakarta Sans', sans-serif; 
            font-weight: 600;
            outline: none; 
            transition: all 0.2s ease; 
        }
        input::placeholder { color: #94a3b8; }
        input:focus { border-color: var(--accent-cyan); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.3); }
        input.field-error { border-color: var(--neon-red); animation: shake 0.3s ease-in-out; }
        @keyframes shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }

        .reg-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .hidden { display: none; }

        .bottom-row { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; margin-bottom: 18px; }
        .remember-check { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; font-family: 'JetBrains Mono', monospace; }
        .remember-check input[type=checkbox] { appearance: none; padding: 0; width: 14px; height: 14px; margin: 0; border-radius: 3px; border: 1px solid var(--card-border); background: rgba(255,255,255,0.05); cursor: pointer; display: grid; place-content: center; flex-shrink: 0; transition: all 0.2s; }
        .remember-check input[type=checkbox]:checked { background: var(--accent-blue); border-color: var(--accent-cyan); }
        .remember-check input[type=checkbox]::before { content: ''; width: 6px; height: 6px; transform: scale(0); border-radius: 1px; background: #fff; transition: transform 0.15s ease-in-out; }
        .remember-check input[type=checkbox]:checked::before { transform: scale(1); }
        
        .pill-link { color: var(--accent-cyan); font-size: 11px; font-weight: 700; text-decoration: none; cursor: pointer; transition: color 0.2s; font-family: 'JetBrains Mono', monospace; }
        .pill-link:hover { text-decoration: underline; color: #7dd3fc; }

        button.btn-submit { 
            width: 100%; 
            padding: 12px; 
            background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); 
            color: #ffffff; 
            border: 1px solid rgba(255, 255, 255, 0.2); 
            border-radius: 8px; 
            cursor: pointer; 
            font-weight: 800; 
            font-size: 12.5px; 
            font-family: 'JetBrains Mono', monospace;
            letter-spacing: 1px;
            text-transform: uppercase;
            box-shadow: 0 4px 15px rgba(37, 99, 235, 0.4); 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            gap: 8px; 
            transition: all 0.2s ease; 
        }
        button.btn-submit:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(56, 189, 248, 0.5); border-color: var(--accent-cyan); }
        button.btn-submit:disabled { opacity: 0.65; cursor: wait; }
        .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; animation: spin 0.7s linear infinite; display: none; }
        button.btn-submit.loading .spinner { display: inline-block; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .error-message { font-size: 12px; font-weight: 600; min-height: 18px; margin-bottom: 10px; text-align: center; }

        .register-section-box {
            width: 100%;
            margin-top: 14px;
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 10px 16px;
            backdrop-filter: blur(16px);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }
        .register-section-box span { font-size: 12px; color: var(--text-muted); font-weight: 600; }
        .btn-toggle-mode { font-family: 'JetBrains Mono', monospace; background: rgba(56, 189, 248, 0.1); border: 1px solid var(--accent-cyan); color: var(--accent-cyan); padding: 6px 14px; border-radius: 6px; font-weight: 800; font-size: 11px; cursor: pointer; transition: all 0.2s; white-space: nowrap; text-transform: uppercase; }
        .btn-toggle-mode:hover { background: var(--accent-cyan); color: #0b1528; }

        .login-footer { 
            text-align: center; 
            padding-top: 20px; 
            font-size: 11px; 
            font-family: 'JetBrains Mono', monospace;
            letter-spacing: 1px;
            color: var(--text-muted);
            text-transform: uppercase;
            width: 100%;
        }

        @media (max-width: 480px) {
            .login-card { padding: 22px 18px; }
            .reg-grid-2 { grid-template-columns: 1fr; }
            .brand-animated-name { font-size: 24px; }
            .register-section-box { flex-direction: column; gap: 8px; text-align: center; }
            .btn-toggle-mode { width: 100%; }
        }
    </style>
</head>
<body>

    <!-- AMBIENTE DE FUNDO TERMINAL / CANDLESTICKS -->
    <div class="bg-scene">
        <div class="bg-grid"></div>
        <div class="chart-bg-line"></div>
        
        <div class="candles-layer">
            <div class="candle red"></div>
            <div class="candle green"></div>
            <div class="candle green"></div>
            <div class="candle red"></div>
            <div class="candle green"></div>
            <div class="candle green"></div>
            <div class="candle red"></div>
            <div class="candle green"></div>
            <div class="candle green"></div>
        </div>

        <!-- SIMBOLOS MOEDAS -->
        <span class="symbol-float" style="top: 25%; left: 15%; font-size: 20px;">฿</span>
        <span class="symbol-float" style="top: 30%; left: 30%; font-size: 14px;">£</span>
        <span class="symbol-float" style="top: 35%; left: 20%; font-size: 16px;">¥</span>
        <span class="symbol-float" style="top: 45%; left: 30%; font-size: 15px;">%</span>
        <span class="symbol-float" style="top: 52%; left: 18%; font-size: 22px;">฿</span>
        <span class="symbol-float" style="top: 68%; left: 30%; font-size: 18px;">฿</span>
        <span class="symbol-float" style="top: 22%; right: 25%; font-size: 14px;">%</span>
        <span class="symbol-float" style="top: 32%; right: 10%; font-size: 18px;">$</span>
        <span class="symbol-float" style="top: 62%; right: 12%; font-size: 16px;">£</span>
    </div>

    <div class="login-container">
        <div class="brand-header-container">
            <div class="brand-pill">@ PLATAFORMA HIGH-FREQUENCY</div>
            <span class="brand-animated-name">PLP FINANCEIRO</span>
            <div class="brand-subtitle">Gestão & Inteligência de Mercado</div>
        </div>

        <div class="login-card">
            <div class="login-card-head">
                <div class="login-title" id="form-title">🔒 Acesso ao Terminal</div>
            </div>

            <div class="error-message" id="error-msg"></div>

            <form id="auth-form" autocomplete="off">
                <div id="register-fields" class="hidden">
                    <div class="form-group">
                        <label for="name">Nome completo</label>
                        <input type="text" id="name" placeholder="Seu nome completo">
                    </div>
                    
                    <div class="reg-grid-2">
                        <div class="form-group">
                            <label for="cpf">CPF</label>
                            <input type="text" id="cpf" placeholder="000.000.000-00">
                        </div>
                        <div class="form-group">
                            <label for="phone">Telefone</label>
                            <input type="text" id="phone" placeholder="(00) 00000-0000">
                        </div>
                    </div>
                </div>

                <div class="form-group">
                    <label for="email">E-mail Corporativo</label>
                    <input type="email" id="email" placeholder="paulo@email.com" required>
                </div>

                <div class="form-group">
                    <label for="password">Senha de Segurança</label>
                    <input type="password" id="password" placeholder="••••••••" required>
                </div>

                <div class="bottom-row">
                    <label class="remember-check">
                        <input type="checkbox" id="remember">
                        <span>Lembrar Credenciais</span>
                    </label>
                    <a class="pill-link" onclick="forgotPassword(event)">Esqueceu a senha? Recuperar</a>
                </div>

                <button type="submit" class="btn-submit" id="submit-btn">
                    <span id="submit-btn-text">Autenticar no Sistema</span>
                    <span class="spinner"></span>
                </button>
            </form>
        </div>

        <div class="register-section-box">
            <span id="toggle-question">Ainda não possui credenciais?</span>
            <button type="button" class="btn-toggle-mode" id="toggle-btn" onclick="toggleMode()">Criar Cadastro</button>
        </div>

        <footer class="login-footer">
            Desenvolvido por Paulo Lima • 2026
        </footer>
    </div>

    <script>
        let isLogin = true;

        function toggleMode() {
            isLogin = !isLogin;
            document.getElementById('form-title').innerText = isLogin ? '🔒 Acesso ao Terminal' : '📝 Registrar Nova Conta';
            document.getElementById('submit-btn-text').innerText = isLogin ? 'Autenticar no Sistema' : 'Concluir Cadastro';
            document.getElementById('toggle-question').innerText = isLogin ? 'Ainda não possui credenciais?' : 'Já possui acesso registrado?';
            document.getElementById('toggle-btn').innerText = isLogin ? 'Criar Cadastro' : 'Fazer Login';
            document.getElementById('register-fields').classList.toggle('hidden', isLogin);
            const nameInput = document.getElementById('name');
            if (nameInput) nameInput.required = !isLogin;
            document.getElementById('error-msg').innerText = '';
            document.querySelectorAll('input').forEach(i => i.classList.remove('field-error'));
        }

        function forgotPassword(e) {
            e.preventDefault();
            const errorEl = document.getElementById('error-msg');
            errorEl.style.color = 'var(--accent-cyan)';
            errorEl.innerText = 'ℹ️ Entre em contato com o suporte para redefinir sua senha.';
            setTimeout(() => { errorEl.innerText = ''; errorEl.style.color = ''; }, 5000);
        }

        const cpfInput = document.getElementById('cpf');
        if (cpfInput) {
            cpfInput.addEventListener('input', () => {
                let v = cpfInput.value.replace(/[^0-9]/g, '').slice(0, 11);
                v = v.replace(/(\\d{3})(\\d)/, '$1.$2').replace(/(\\d{3})(\\d)/, '$1.$2').replace(/(\\d{3})(\\d{1,2})$/, '$1-$2');
                cpfInput.value = v;
            });
        }
        const phoneInput = document.getElementById('phone');
        if (phoneInput) {
            phoneInput.addEventListener('input', () => {
                let v = phoneInput.value.replace(/[^0-9]/g, '').slice(0, 11);
                if (v.length > 10) v = v.replace(/(\\d{2})(\\d{5})(\\d{4})/, '($1) $2-$3');
                else if (v.length > 5) v = v.replace(/(\\d{2})(\\d{4})(\\d{0,4})/, '($1) $2-$3');
                else if (v.length > 2) v = v.replace(/(\\d{2})(\\d{0,5})/, '($1) $2');
                phoneInput.value = v;
            });
        }

        function setLoading(loading) {
            const btn = document.getElementById('submit-btn');
            btn.disabled = loading;
            btn.classList.toggle('loading', loading);
        }

        document.getElementById('auth-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const errorEl = document.getElementById('error-msg');
            errorEl.style.color = '';
            errorEl.innerText = '';
            document.querySelectorAll('input').forEach(i => i.classList.remove('field-error'));

            const email = document.getElementById('email').value.trim().toLowerCase();
            const password = document.getElementById('password').value;
            const name = document.getElementById('name') ? document.getElementById('name').value.trim() : '';
            const cpf = document.getElementById('cpf') ? document.getElementById('cpf').value.trim() : '';
            const phone = document.getElementById('phone') ? document.getElementById('phone').value.trim() : '';
            const remember = document.getElementById('remember').checked;

            if (!email || !password || (!isLogin && !name)) {
                errorEl.style.color = 'var(--neon-red)';
                errorEl.innerText = 'Por favor, preencha todos os campos obrigatórios.';
                if (!email) document.getElementById('email').classList.add('field-error');
                if (!password) document.getElementById('password').classList.add('field-error');
                if (!isLogin && !name) document.getElementById('name').classList.add('field-error');
                return;
            }

            const endpoint = isLogin ? '/api/login' : '/api/register';
            const payload = isLogin ? { email, password, remember } : { name, cpf, phone, email, password };

            setLoading(true);
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (res.ok) {
                    if (isLogin) {
                        window.location.href = '/dashboard';
                        return;
                    } else {
                        errorEl.style.color = 'var(--neon-green)';
                        errorEl.innerText = 'Conta registrada com sucesso! Faça login para continuar.';
                        toggleMode();
                    }
                } else {
                    errorEl.style.color = 'var(--neon-red)';
                    errorEl.innerText = data.error || 'Não foi possível concluir a operação.';
                    document.getElementById('password').classList.add('field-error');
                }
            } catch (err) {
                errorEl.style.color = 'var(--neon-red)';
                errorEl.innerText = 'Erro na comunicação com o servidor.';
            } finally {
                setLoading(false);
            }
        });
    </script>
</body>
</html>`);
});

app.get('/api/user', isAuthenticated, (req, res) => {
    const db = getDb();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ error: '❌ Usuário não encontrado.' });
    res.json({ id: user.id, name: user.name, cpf: user.cpf, phone: user.phone, email: user.email });
});

// ==========================================
// DASHBOARD EXECUTIVO COM MENU REFORMULADO
// ==========================================
app.get('/dashboard', isAuthenticated, (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="pt-BR" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PLP FINANCEIRO - Dashboard Executivo</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { box-sizing: border-box; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
        
        [data-theme="dark"] {
            --bg-main: #020617;
            --header-bg: rgba(15, 23, 42, 0.85);
            --header-border: rgba(99, 102, 241, 0.2);
            --panel-bg: rgba(15, 23, 42, 0.75);
            --panel-border: rgba(255, 255, 255, 0.08);
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --accent: #6366f1;
            --accent-glow: rgba(99, 102, 241, 0.35);
            --field-bg: #030712;
            --table-th-bg: rgba(3, 7, 18, 0.95);
            --modal-overlay: rgba(2, 6, 23, 0.85);
            --modal-box: rgba(15, 23, 42, 0.98);
            --bank-card-bg: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%);
        }

        [data-theme="light"] {
            --bg-main: #f8fafc;
            --header-bg: rgba(255, 255, 255, 0.9);
            --header-border: rgba(79, 70, 229, 0.2);
            --panel-bg: rgba(255, 255, 255, 0.9);
            --panel-border: rgba(15, 23, 42, 0.08);
            --text-main: #0f172a;
            --text-muted: #64748b;
            --accent: #4f46e5;
            --accent-glow: rgba(79, 70, 229, 0.2);
            --field-bg: #ffffff;
            --table-th-bg: rgba(241, 245, 249, 0.95);
            --modal-overlay: rgba(15, 23, 42, 0.5);
            --modal-box: rgba(255, 255, 255, 0.98);
            --bank-card-bg: linear-gradient(135deg, #e0e7ff 0%, #cbd5e1 100%);
        }

        body { 
            font-family: 'Plus Jakarta Sans', sans-serif; 
            background: var(--bg-main); 
            color: var(--text-main); 
            margin: 0; 
            padding: 0; 
            min-height: 100vh; 
            overflow-x: hidden; 
            position: relative; 
            transition: background 0.3s ease, color 0.3s ease;
        }

        /* ============ LAYOUT BASE & SIDEBAR REFORMULADA ============ */
        .app-shell { display: flex; align-items: stretch; min-height: 100vh; }

        .sidebar { 
            width: 265px; 
            flex-shrink: 0; 
            background: var(--header-bg); 
            border-right: 1px solid var(--panel-border); 
            padding: 24px 16px; 
            display: flex; 
            flex-direction: column; 
            position: sticky; 
            top: 0; 
            height: 100vh; 
            overflow-y: auto; 
            backdrop-filter: blur(24px); 
            z-index: 900; 
            box-shadow: 4px 0 25px rgba(0,0,0,0.1);
        }

        .sidebar-logo { 
            display: flex; 
            align-items: center; 
            justify-content: space-between;
            padding: 4px 8px 24px 8px; 
            font-size: 16px; 
            font-weight: 800; 
            color: var(--text-main); 
            border-bottom: 1px solid var(--panel-border);
            margin-bottom: 16px;
        }
        .sidebar-logo-content { display: flex; align-items: center; gap: 10px; }
        .sidebar-logo .mark { 
            width: 36px; 
            height: 36px; 
            border-radius: 10px; 
            background: linear-gradient(135deg, var(--accent), #818cf8); 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            font-size: 17px; 
            box-shadow: 0 8px 18px var(--accent-glow); 
            flex-shrink: 0; 
        }
        .sidebar-badge { font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 700; background: rgba(99, 102, 241, 0.15); color: var(--accent); border: 1px solid rgba(99, 102, 241, 0.3); padding: 3px 6px; border-radius: 6px; }

        .sidebar-section-label { 
            font-family: 'JetBrains Mono', monospace; 
            font-size: 9.5px; 
            color: var(--text-muted); 
            text-transform: uppercase; 
            letter-spacing: 1.5px; 
            font-weight: 700; 
            margin: 16px 10px 8px; 
            opacity: 0.8;
        }

        .sidebar-nav { display: flex; flex-direction: column; gap: 4px; }
        
        .sidebar-nav .menu-item { 
            font-family: 'Plus Jakarta Sans', sans-serif; 
            display: flex; 
            align-items: center; 
            gap: 12px; 
            padding: 10px 14px; 
            border-radius: 12px; 
            background: transparent; 
            border: 1px solid transparent; 
            color: var(--text-muted); 
            font-weight: 600; 
            font-size: 13px; 
            cursor: pointer; 
            text-align: left; 
            width: 100%; 
            position: relative;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .sidebar-nav .menu-item .ic { 
            font-size: 16px; 
            width: 22px; 
            text-align: center; 
            flex-shrink: 0; 
            transition: transform 0.2s ease;
        }

        .sidebar-nav .menu-item:hover { 
            background: rgba(255, 255, 255, 0.04); 
            color: var(--text-main); 
            transform: translateX(3px);
        }

        .sidebar-nav .menu-item:hover .ic { transform: scale(1.15); }

        .sidebar-nav .menu-item.active { 
            background: linear-gradient(135deg, var(--accent) 0%, #4338ca 100%); 
            color: #ffffff; 
            font-weight: 700;
            border-color: rgba(255, 255, 255, 0.15); 
            box-shadow: 0 8px 20px var(--accent-glow); 
        }

        .sidebar-nav .menu-item.active::before {
            content: '';
            position: absolute;
            left: -16px;
            top: 20%;
            height: 60%;
            width: 4px;
            background: var(--accent);
            border-radius: 0 4px 4px 0;
            box-shadow: 0 0 10px var(--accent);
        }

        .sidebar-bottom { 
            margin-top: auto; 
            padding-top: 18px; 
            border-top: 1px solid var(--panel-border); 
            display: flex; 
            flex-direction: column; 
            gap: 10px; 
        }

        .sidebar-bottom .theme-toggle-dash, 
        .sidebar-bottom .btn-exit-yellow { 
            width: 100%; 
            box-sizing: border-box; 
            text-align: center; 
        }

        .sidebar-credit { 
            font-family: 'JetBrains Mono', monospace; 
            font-size: 10px; 
            color: var(--text-muted); 
            text-align: center; 
            padding: 8px 4px 0; 
            letter-spacing: 0.5px; 
        }
        .sidebar-credit b { color: var(--accent); }

        .main-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }

        .topbar { position: sticky; top: 0; z-index: 800; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 28px; background: var(--header-bg); border-bottom: 1px solid var(--header-border); backdrop-filter: blur(20px); flex-wrap: wrap; }
        .topbar-title { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
        .topbar-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .search-fake { display: flex; align-items: center; gap: 8px; background: var(--panel-bg); border: 1px solid var(--panel-border); padding: 9px 14px; border-radius: 12px; color: var(--text-muted); font-size: 12.5px; font-weight: 600; white-space: nowrap; }
        .icon-avatar { width: 38px; height: 38px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), #818cf8); display: flex; align-items: center; justify-content: center; font-weight: 800; color: #fff; font-size: 13px; flex-shrink: 0; }
        
        .filter-group { display: flex; align-items: center; gap: 8px; background: var(--panel-bg); border: 1px solid var(--panel-border); padding: 6px 12px; border-radius: 10px; backdrop-filter: blur(10px); }
        .filter-group label { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; color: var(--accent); text-transform: uppercase; margin: 0; }
        .filter-group select { background: var(--field-bg); border: 1px solid var(--panel-border); color: var(--text-main); padding: 6px 10px; border-radius: 8px; font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 700; outline: none; cursor: pointer; }

        main { margin-top: 20px; padding: 0 28px 48px 28px; max-width: 1400px; margin-left: auto; margin-right: auto; position: relative; z-index: 1; }
        @media(max-width: 950px) { main { padding: 12px; margin-top: 12px; } }

        .metrics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 22px; }
        @media(max-width: 768px) { .metrics-grid { grid-template-columns: 1fr; } }

        .metric-card { background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 18px; padding: 20px 18px; position: relative; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.1); backdrop-filter: blur(12px); transition: transform 0.2s, border-color 0.2s, background 0.3s; display: flex; flex-direction: column; justify-content: space-between; min-height: 115px; }
        .metric-card:hover { transform: translateY(-3px); border-color: var(--accent); box-shadow: 0 15px 35px rgba(0,0,0,0.15); }
        .metric-card::after { content: ''; position: absolute; bottom: 0; left: 0; width: 100%; height: 3px; background: linear-gradient(90deg, var(--accent), #10b981); }
        .metric-title { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; line-height: 1.3; }
        .metric-value { font-size: 17.5px; font-weight: 800; color: var(--text-main); letter-spacing: -0.5px; word-break: break-all; }
        
        .charts-grid { display: grid; grid-template-columns: 1.5fr 1fr; gap: 24px; margin-bottom: 24px; }
        @media(max-width: 1100px) { .charts-grid { grid-template-columns: 1fr; } }
        .chart-container-box { background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 18px; padding: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); backdrop-filter: blur(12px); display: flex; flex-direction: column; justify-content: space-between; transition: background 0.3s; }
        .chart-title { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; }
        
        .panel { background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 18px; padding: 28px; margin-bottom: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); backdrop-filter: blur(12px); overflow: hidden; transition: background 0.3s; }
        .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--panel-border); padding-bottom: 14px; flex-wrap: wrap; gap: 10px; }
        .panel-title { font-family: 'JetBrains Mono', monospace; font-size: 13.5px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 0.6px; }
        
        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; margin-bottom: 22px; }
        .form-group { display: flex; flex-direction: column; gap: 6px; }
        label { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
        input, select { background: var(--field-bg); border: 1px solid var(--panel-border); color: var(--text-main); padding: 12px 14px; border-radius: 10px; font-size: 13.5px; outline: none; width: 100%; transition: all 0.2s; font-weight: 600; }
        input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
        .btn-primary { font-family: 'JetBrains Mono', monospace; background: linear-gradient(135deg, var(--accent) 0%, #4338ca 100%); color: #ffffff; border: none; padding: 13px 22px; border-radius: 10px; font-weight: 800; cursor: pointer; font-size: 13px; width: 100%; text-transform: uppercase; letter-spacing: 1px; transition: all 0.2s; box-shadow: 0 6px 20px rgba(0,0,0,0.15); }
        .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 10px 25px rgba(0,0,0,0.25); }
        
        .cards-visual-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .bank-card-visual { background: var(--bank-card-bg); border: 1px solid var(--panel-border); border-radius: 18px; padding: 24px; position: relative; overflow: hidden; box-shadow: 0 12px 30px rgba(0,0,0,0.2); display: flex; flex-direction: column; justify-content: space-between; min-height: 200px; }
        .card-header-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .card-brand-name { font-size: 13.5px; font-weight: 800; color: var(--accent); letter-spacing: 0.6px; text-transform: uppercase; }
        .card-photo-thumb { width: 48px; height: 32px; border-radius: 6px; object-fit: cover; border: 1px solid var(--panel-border); flex-shrink: 0; }
        .card-number-sim { font-family: monospace; font-size: 14px; letter-spacing: 1.5px; color: var(--text-main); margin: 10px 0; font-weight: 700; }
        
        .card-stats-box { background: var(--field-bg); border: 1px solid var(--panel-border); border-radius: 12px; padding: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
        .card-stat-item div:first-child { font-size: 9.5px; color: var(--text-muted); text-transform: uppercase; font-weight: 700; }
        .card-stat-item div:last-child { font-size: 12.5px; font-weight: 800; color: var(--text-main); margin-top: 2px; }
        
        .card-footer-row { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; gap: 8px; }
        .card-limit-val { font-size: 12.5px; font-weight: 800; color: #10b981; }
        
        .table-responsive { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 14px; border: 1px solid var(--panel-border); box-shadow: 0 8px 20px rgba(0,0,0,0.05); }
        table { width: 100%; border-collapse: collapse; min-width: 680px; }
        th, td { padding: 14px 16px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--panel-border); white-space: nowrap; font-weight: 500; color: var(--text-main); }
        th { background: var(--table-th-bg); color: var(--text-muted); font-weight: 800; text-transform: uppercase; letter-spacing: 0.6px; font-family: 'JetBrains Mono', monospace; font-size: 10.5px; }
        tr:hover td { background: var(--field-bg); }
        .empty-row td { text-align: center; color: var(--text-muted); font-style: italic; padding: 28px; }
        
        .section-view { display: none; }
        .section-view.active { display: block; }
        
        .action-btns { display: flex; gap: 6px; flex-shrink: 0; }
        .btn-edit { padding: 5px 10px; font-size: 11px; background: rgba(99, 102, 241, 0.15); color: var(--accent); border: 1px solid var(--panel-border); border-radius: 6px; cursor: pointer; font-weight: 700; transition: background 0.2s; }
        .btn-edit:hover { background: rgba(99, 102, 241, 0.3); }
        .btn-delete { padding: 5px 10px; font-size: 11px; background: rgba(244, 63, 94, 0.15); color: #f43f5e; border: 1px solid var(--panel-border); border-radius: 6px; cursor: pointer; font-weight: 700; transition: background 0.2s; }
        .btn-delete:hover { background: rgba(244, 63, 94, 0.3); }

        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: var(--modal-overlay); z-index: 2000; display: flex; justify-content: center; align-items: center; padding: 20px; backdrop-filter: blur(10px); opacity: 0; pointer-events: none; transition: opacity 0.3s ease; }
        .modal-overlay.active { opacity: 1; pointer-events: auto; }
        .modal-box { background: var(--modal-box); border: 1px solid var(--panel-border); border-radius: 20px; width: 100%; max-width: 580px; padding: 28px; box-shadow: 0 30px 70px rgba(0,0,0,0.4); position: relative; max-height: 90vh; overflow-y: auto; transform: translateY(20px); transition: transform 0.3s ease, background 0.3s; }
        .modal-overlay.active .modal-box { transform: translateY(0); }
        .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--panel-border); padding-bottom: 14px; }
        .modal-title { font-size: 17.5px; font-weight: 800; color: var(--accent); text-transform: uppercase; letter-spacing: 0.8px; display: flex; align-items: center; gap: 8px; }
        .modal-close { background: transparent; border: none; color: var(--text-muted); font-size: 18px; font-weight: 900; cursor: pointer; transition: color 0.2s; }
        .modal-close:hover { color: #f43f5e; }
        .modal-actions { display: flex; gap: 12px; margin-top: 22px; }
        .btn-secondary { font-family: 'JetBrains Mono', monospace; background: var(--field-bg); color: var(--text-main); border: 1px solid var(--panel-border); padding: 12px 20px; border-radius: 10px; font-weight: 700; cursor: pointer; font-size: 12.5px; width: 100%; text-transform: uppercase; letter-spacing: 1px; transition: all 0.2s; }
        .btn-secondary:hover { border-color: var(--accent); }

        .dev-tag-dash { 
            text-align: center; 
            margin-top: 40px; 
            padding: 28px 20px; 
            background: var(--panel-bg); 
            border-radius: 16px; 
            border: 1px solid var(--panel-border);
            box-shadow: 0 10px 30px rgba(0,0,0,0.05);
            position: relative;
            overflow: hidden;
            transition: background 0.3s;
        }

        .dev-tag-label-dash { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--text-muted); letter-spacing: 2px; text-transform: uppercase; font-weight: 700; margin-bottom: 6px; }
        .dev-tag-name-dash { 
            font-size: 22px; font-weight: 900; letter-spacing: 2px; text-transform: uppercase;
            background: linear-gradient(90deg, var(--accent), #10b981, var(--text-main), var(--accent));
            background-size: 300% auto;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            animation: gradientText 5s linear infinite;
            display: inline-block;
            padding: 2px 10px;
        }

        .progress-bar-bg { width: 100%; background: var(--field-bg); border-radius: 6px; height: 8px; border: 1px solid var(--panel-border); overflow: hidden; margin-top: 6px; }
        .progress-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), #10b981); border-radius: 6px; transition: width 0.4s; }

        .right-panel { width: 290px; flex-shrink: 0; padding: 20px 16px; display: flex; flex-direction: column; gap: 16px; border-left: 1px solid var(--panel-border); position: sticky; top: 0; height: 100vh; overflow-y: auto; }
        .rp-card { background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 16px; padding: 18px; backdrop-filter: blur(12px); }
        .rp-profile-top { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .rp-avatar { width: 46px; height: 46px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), #818cf8); display: flex; align-items: center; justify-content: center; font-weight: 800; color: #fff; font-size: 15px; flex-shrink: 0; }
        .rp-name { font-weight: 800; font-size: 14px; }
        .rp-role { font-size: 11px; color: var(--text-muted); font-weight: 600; }
        .rp-info-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted); font-weight: 600; padding: 8px 0; border-top: 1px solid var(--panel-border); }
        .rp-info-row:first-of-type { border-top: none; padding-top: 0; }
        .rp-info-row a { color: var(--accent); text-decoration: none; font-weight: 700; word-break: break-all; }

        .calendar-widget .cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        .calendar-widget .cal-nav { background: var(--field-bg); border: 1px solid var(--panel-border); color: var(--text-muted); width: 24px; height: 24px; border-radius: 6px; cursor: pointer; font-weight: 800; }
        .calendar-widget .cal-nav:hover { border-color: var(--accent); color: var(--accent); }
        .calendar-widget .cal-title { font-weight: 800; font-size: 13px; text-transform: capitalize; }
        .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; text-align: center; }
        .cal-grid .cal-dow { font-size: 9px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; padding-bottom: 4px; }
        .cal-grid .cal-day { font-size: 11px; font-weight: 700; color: var(--text-main); padding: 5px 0; border-radius: 6px; }
        .cal-grid .cal-day.muted { visibility: hidden; }
        .cal-grid .cal-day.today { background: linear-gradient(135deg, var(--accent), #818cf8); color: #fff; box-shadow: 0 4px 12px var(--accent-glow); }

        .notif-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
        .notif-item { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-muted); font-weight: 600; padding: 8px 0; border-bottom: 1px solid var(--panel-border); }
        .notif-item:last-child { border-bottom: none; }
        .notif-dot { width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; flex-shrink: 0; box-shadow: 0 0 6px #f59e0b; }
        .notif-item b { color: var(--text-main); }

        .hero-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
        @media(max-width: 1200px) { .hero-grid { grid-template-columns: 1fr; } }
        .hero-card { background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 18px; padding: 20px; backdrop-filter: blur(12px); box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
        .hero-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .hero-label { font-size: 13px; font-weight: 700; color: var(--text-muted); }
        .hero-icon { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 15px; background: rgba(99,102,241,0.15); border: 1px solid var(--panel-border); flex-shrink: 0; }
        .hero-value { font-size: 26px; font-weight: 800; letter-spacing: -1px; margin-bottom: 8px; word-break: break-all; }
        .hero-delta { font-size: 11.5px; font-weight: 700; color: var(--text-muted); }
        .hero-delta.up { color: #10b981; } .hero-delta.down { color: #f43f5e; }

        .flow-goal-grid { display: grid; grid-template-columns: 1.5fr 1fr; gap: 20px; margin-bottom: 22px; }
        @media(max-width: 1100px) { .flow-goal-grid { grid-template-columns: 1fr; } }
        .flow-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 10px; }
        .flow-panel-head-title { font-size: 15.5px; font-weight: 800; }
        .btn-details { font-family: 'JetBrains Mono', monospace; background: var(--field-bg); border: 1px solid var(--panel-border); color: var(--text-main); padding: 8px 14px; border-radius: 8px; font-size: 10.5px; font-weight: 700; cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px; }
        .btn-details:hover { border-color: var(--accent); color: var(--accent); }
        .flow-compare { display: flex; gap: 32px; margin-bottom: 14px; flex-wrap: wrap; }
        .flow-compare div span.lbl { display: block; font-size: 11px; color: var(--text-muted); font-weight: 700; margin-bottom: 3px; }
        .flow-compare div span.val { font-size: 17.5px; font-weight: 800; }

        .goal-ring-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4px 0 18px; }
        .goal-ring { width: 170px; height: 180px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: conic-gradient(var(--accent) 0deg, #4338ca 0deg, var(--field-bg) 0deg); transition: background 0.5s; }
        .goal-ring .goal-ring-inner { width: 134px; height: 134px; border-radius: 50%; background: var(--panel-bg); display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .goal-ring .goal-total-lbl { font-size: 10px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
        .goal-ring .goal-total-val { font-size: 22px; font-weight: 800; margin-top: 2px; }
        .goal-footer { display: flex; justify-content: space-between; border-top: 1px solid var(--panel-border); padding-top: 14px; }
        .goal-footer div span.lbl { display: block; font-size: 10.5px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; margin-bottom: 3px; }
        .goal-footer div span.val { font-size: 18px; font-weight: 800; }

        .theme-toggle-dash { background: var(--panel-bg); color: var(--text-main); border: 1px solid var(--panel-border); padding: 9px 12px; border-radius: 10px; font-weight: 700; cursor: pointer; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; font-family: 'JetBrains Mono', monospace; transition: all 0.2s; }
        .theme-toggle-dash:hover { border-color: var(--accent); color: var(--accent); }

        .btn-exit-yellow { background: transparent; color: #f43f5e; border: 1px solid rgba(244, 63, 94, 0.4); padding: 9px 12px; border-radius: 10px; font-weight: 700; cursor: pointer; font-size: 11px; text-decoration: none; transition: all 0.2s; text-transform: uppercase; letter-spacing: 0.5px; font-family: 'JetBrains Mono', monospace; display: inline-block; text-align: center; white-space: nowrap; }
        .btn-exit-yellow:hover { background: rgba(244, 63, 94, 0.15); border-color: #f43f5e; }

        @media(max-width: 1100px) {
            .app-shell { flex-direction: column; }
            .sidebar { width: 100%; height: auto; position: relative; flex-direction: row; align-items: center; overflow-x: auto; padding: 12px 16px; gap: 10px; }
            .sidebar-logo { padding: 0; border-bottom: none; margin-bottom: 0; }
            .sidebar-section-label { display: none; }
            .sidebar-nav { flex-direction: row; }
            .sidebar-nav .menu-item span.txt { display: none; }
            .sidebar-nav .menu-item.active::before { display: none; }
            .sidebar-bottom { display: none; }
            .right-panel { width: 100%; height: auto; position: relative; border-left: none; border-top: 1px solid var(--panel-border); flex-direction: row; flex-wrap: wrap; }
            .right-panel .rp-card { flex: 1; min-width: 260px; }
        }
    </style>
</head>
<body>

    <div class="app-shell">
        <!-- SIDEBAR COM MENU PRINCIPAL REFORMULADO -->
        <aside class="sidebar">
            <div class="sidebar-logo">
                <div class="sidebar-logo-content">
                    <span class="mark">💼</span> 
                    <span>PLP <span style="color:var(--accent);">Financeiro</span></span>
                </div>
                <span class="sidebar-badge">v2.0 PRO</span>
            </div>

            <!-- VISÃO GERAL -->
            <div class="sidebar-section-label">Visão Geral</div>
            <nav class="sidebar-nav">
                <button class="menu-item active" onclick="switchView('overview', this)"><span class="ic">📊</span><span class="txt">Dashboard</span></button>
            </nav>

            <!-- GESTÃO FINANCEIRA -->
            <div class="sidebar-section-label">Gestão Financeira</div>
            <nav class="sidebar-nav">
                <button class="menu-item" onclick="switchView('accounts', this)"><span class="ic">🏦</span><span class="txt">Contas & Bancos</span></button>
                <button class="menu-item" onclick="switchView('cards', this)"><span class="ic">💳</span><span class="txt">Cartões de Crédito</span></button>
                <button class="menu-item" onclick="switchView('transactions', this)"><span class="ic">📋</span><span class="txt">Receitas & Despesas</span></button>
                <button class="menu-item" onclick="switchView('recurring', this)"><span class="ic">🔄</span><span class="txt">Contas Recorrentes</span></button>
            </nav>

            <!-- ESTRATÉGIA & PLANEJAMENTO -->
            <div class="sidebar-section-label">Estratégia & Metas</div>
            <nav class="sidebar-nav">
                <button class="menu-item" onclick="switchView('investments', this)"><span class="ic">📈</span><span class="txt">Investimentos</span></button>
                <button class="menu-item" onclick="switchView('budgets', this)"><span class="ic">🎯</span><span class="txt">Orçamentos</span></button>
                <button class="menu-item" onclick="switchView('goals', this)"><span class="ic">🏆</span><span class="txt">Metas Patrimoniais</span></button>
                <button class="menu-item" onclick="switchView('debts', this)"><span class="ic">⚠️</span><span class="txt">Dívidas & Passivos</span></button>
            </nav>

            <div class="sidebar-bottom">
                <button class="theme-toggle-dash" onclick="toggleTheme()" id="dash-theme-btn">☀️ Tema Claro</button>
                <a href="/api/logout" class="btn-exit-yellow">Sair do Sistema</a>
                <div class="sidebar-credit">Desenvolvido por <b>Paulo Lima</b></div>
            </div>
        </aside>

        <div class="main-col">
            <header class="topbar">
                <div class="topbar-title" id="page-title">Dashboard</div>
                <div class="topbar-right">
                    <div class="filter-group">
                        <label for="global-month-select">📅 Periodo:</label>
                        <select id="global-month-select" onchange="onMonthFilterChange()">
                            <option value="all">Todos os Meses</option>
                        </select>
                    </div>
                    <div class="search-fake">🔍 Buscar...</div>
                    <div class="icon-avatar" id="user-avatar-chip">👤</div>
                </div>
            </header>

            <main>
                <div id="view-overview" class="section-view active">
                    <div class="hero-grid">
                        <div class="hero-card">
                            <div class="hero-card-top"><div class="hero-label">Receitas Consolidadas</div><div class="hero-icon">📈</div></div>
                            <div class="hero-value" id="kpi-revenue" style="color: #10b981;">R$ 0,00</div>
                            <div class="hero-delta" id="kpi-revenue-delta">— vs mês anterior</div>
                        </div>
                        <div class="hero-card">
                            <div class="hero-card-top"><div class="hero-label">Despesas Consolidadas</div><div class="hero-icon">📉</div></div>
                            <div class="hero-value" id="kpi-expense" style="color: #f43f5e;">R$ 0,00</div>
                            <div class="hero-delta" id="kpi-expense-delta">— vs mês anterior</div>
                        </div>
                        <div class="hero-card">
                            <div class="hero-card-top"><div class="hero-label">Patrimônio Líquido</div><div class="hero-icon">💎</div></div>
                            <div class="hero-value" id="kpi-networth" style="color: var(--accent);">R$ 0,00</div>
                            <div class="hero-delta">Contas + Investimentos</div>
                        </div>
                    </div>

                    <div class="metrics-grid">
                        <div class="metric-card"><div class="metric-title">💼 Portfólio de Ativos</div><div class="metric-value" id="kpi-investments" style="color: var(--accent);">R$ 0,00</div></div>
                        <div class="metric-card"><div class="metric-title">💳 Comprometimento Cartões</div><div class="metric-value" id="kpi-cards-spent" style="color: #f59e0b;">R$ 0,00</div></div>
                        <div class="metric-card"><div class="metric-title">⚠️ Passivos / Dívidas</div><div class="metric-value" id="kpi-debts" style="color: #f43f5e;">R$ 0,00</div></div>
                    </div>

                    <div class="flow-goal-grid">
                        <div class="chart-container-box">
                            <div class="flow-panel-head">
                                <div class="flow-panel-head-title">📈 Fluxo de Caixa Mensal</div>
                                <button class="btn-details" onclick="switchView('transactions', document.querySelectorAll('.menu-item')[3])">Ver Extrato</button>
                            </div>
                            <div class="flow-compare">
                                <div><span class="lbl">Este mês (líquido)</span><span class="val" id="flow-this-month">R$ 0,00</span></div>
                                <div><span class="lbl">Mês passado (líquido)</span><span class="val" id="flow-last-month">R$ 0,00</span></div>
                            </div>
                            <div style="position: relative; height: 220px; width: 100%;"><canvas id="lineChart"></canvas></div>
                        </div>
                        <div class="chart-container-box">
                            <div class="flow-panel-head"><div class="flow-panel-head-title">🏆 Metas Patrimoniais</div></div>
                            <div class="goal-ring-wrap">
                                <div class="goal-ring" id="goal-ring">
                                    <div class="goal-ring-inner">
                                        <div class="goal-total-lbl">Progresso Médio</div>
                                        <div class="goal-total-val" id="goal-total-pct">0%</div>
                                    </div>
                                </div>
                            </div>
                            <div class="goal-footer">
                                <div><span class="lbl">Concluídas</span><span class="val" id="goal-completed" style="color:#10b981;">0</span></div>
                                <div><span class="lbl">Em Progresso</span><span class="val" id="goal-inprogress" style="color:var(--accent);">0</span></div>
                            </div>
                        </div>
                    </div>

                    <div class="charts-grid">
                        <div class="chart-container-box">
                            <div class="chart-title">📊 Comparativo: Receitas vs Despesas</div>
                            <div style="position: relative; height: 250px; width: 100%;"><canvas id="barChart"></canvas></div>
                        </div>
                        <div class="chart-container-box">
                            <div class="chart-title">🥧 Distribuição de Despesas</div>
                            <div style="position: relative; height: 250px; width: 100%; display: flex; justify-content: center; align-items: center;"><canvas id="pieChart"></canvas></div>
                        </div>
                    </div>

                    <div class="charts-grid" style="grid-template-columns: 1fr;">
                        <div class="chart-container-box">
                            <div class="chart-title">📈 Evolução Histórica Patrimonial</div>
                            <div style="position: relative; height: 250px; width: 100%;"><canvas id="areaChart"></canvas></div>
                        </div>
                    </div>
                </div>

                <div id="view-accounts" class="section-view">
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">🏦 Cadastro de Contas e Bancos</div></div>
                        <form id="account-form">
                            <div class="form-grid">
                                <div class="form-group"><label>Instituição / Banco</label><input type="text" id="acc-name" placeholder="Ex: Nubank, Itaú, XP" required></div>
                                <div class="form-group"><label>Tipo de Conta</label><select id="acc-type"><option value="Conta Corrente">Conta Corrente</option><option value="Conta PJ">Conta PJ / Empresarial</option><option value="Poupança">Poupança</option><option value="Dinheiro Físico">Dinheiro Físico / Espécie</option></select></div>
                                <div class="form-group"><label>Saldo Inicial / Atual (R$)</label><input type="number" step="0.01" id="acc-balance" placeholder="0,00" required></div>
                                <div class="form-group"><label>Agência / Conta (Opcional)</label><input type="text" id="acc-agency" placeholder="Ex: Ag 0001 / C/C 12345-6"></div>
                            </div>
                            <button type="submit" class="btn-primary">Registrar Conta no Sistema</button>
                        </form>
                    </div>
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">📋 Contas e Bancos Cadastrados</div></div>
                        <div class="table-responsive"><table><thead><tr><th>Instituição</th><th>Tipo</th><th>Dados / Agência</th><th>Saldo Atual</th><th>Ações</th></tr></thead><tbody id="accounts-list"></tbody></table></div>
                    </div>
                </div>

                <div id="view-cards" class="section-view">
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">💳 Cadastro de Cartões de Crédito</div></div>
                        <form id="card-form">
                            <div class="form-grid">
                                <div class="form-group"><label>Nome do Cartão</label><input type="text" id="card-name" placeholder="Ex: Nubank Ultravioleta" required></div>
                                <div class="form-group"><label>Limite Total (R$)</label><input type="number" step="0.01" id="card-limit" placeholder="5000.00" required></div>
                                <div class="form-group"><label>Dia de Vencimento</label><input type="text" id="card-due" placeholder="Ex: Vencimento dia 10" required></div>
                                <div class="form-group"><label>Bandeira</label><select id="card-brand"><option value="Mastercard">Mastercard</option><option value="Visa">Visa</option><option value="Elo">Elo</option><option value="American Express">American Express</option></select></div>
                                <div class="form-group" style="grid-column: 1 / -1;"><label>Foto / Logo do Cartão (Opcional)</label><input type="file" id="card-image" accept="image/*"></div>
                            </div>
                            <button type="submit" class="btn-primary">Adicionar Cartão com Inteligência</button>
                        </form>
                    </div>
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">🖼️ Cartões Visuais & Limites em Tempo Real</div></div>
                        <div class="cards-visual-grid" id="cards-grid-visual"></div>
                    </div>
                </div>

                <div id="view-transactions" class="section-view">
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">📋 Nova Receita ou Despesa</div></div>
                        <form id="tx-form">
                            <div class="form-grid">
                                <div class="form-group"><label>Tipo de Lançamento</label><select id="tx-type"><option value="Receita">Receita (Entrada)</option><option value="Despesa">Despesa (Saída)</option></select></div>
                                <div class="form-group"><label>Descrição Detalhada</label><input type="text" id="tx-desc" placeholder="Ex: Salário Corporativo / Supermercado" required></div>
                                <div class="form-group"><label>Valor (R$)</label><input type="number" step="0.01" id="tx-amount" placeholder="0,00" required></div>
                                <div class="form-group"><label>Categoria</label><input type="text" id="tx-category" placeholder="Ex: Alimentação, Moradia, Vendas" required></div>
                                <div class="form-group"><label>Vincular a Cartão?</label><select id="tx-card"><option value="">Nenhum (Movimentação Direta)</option></select></div>
                                <div class="form-group"><label>Data</label><input type="date" id="tx-date" required></div>
                            </div>
                            <button type="submit" class="btn-primary">Registrar Transação no Fluxo</button>
                        </form>
                    </div>
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">📊 Extrato Consolidado e Detalhado</div></div>
                        <div class="table-responsive"><table><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Cartão Vinculado</th><th>Tipo</th><th>Valor</th><th>Ações</th></tr></thead><tbody id="transactions-list"></tbody></table></div>
                    </div>
                </div>

                <div id="view-investments" class="section-view">
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">📈 Cadastro de Investimentos e Ativos</div></div>
                        <form id="inv-form">
                            <div class="form-grid">
                                <div class="form-group"><label>Nome do Ativo</label><input type="text" id="inv-name" placeholder="Ex: Tesouro IPCA+ / PETR4 / Bitcoin" required></div>
                                <div class="form-group"><label>Classe do Ativo</label><select id="inv-class"><option value="Renda Fixa">Renda Fixa</option><option value="Ações">Ações Nacionais/Internacionais</option><option value="FIIs">Fundos Imobiliários (FIIs)</option><option value="Cripto">Criptomoedas</option><option value="Exterior">Ativos no Exterior</option></select></div>
                                <div class="form-group"><label>Valor Aplicado / Atual (R$)</label><input type="number" step="0.01" id="inv-amount" placeholder="0,00" required></div>
                                <div class="form-group"><label>Rentabilidade Esperada (% a.a.)</label><input type="text" id="inv-yield" placeholder="Ex: 12% a.a. ou CDI+2%"></div>
                            </div>
                            <button type="submit" class="btn-primary">Incluir Ativo no Portfólio</button>
                        </form>
                    </div>
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">💼 Ativos Detalhados</div></div>
                        <div class="table-responsive"><table><thead><tr><th>Ativo</th><th>Classe</th><th>Valor Atual</th><th>Rentabilidade</th><th>Ações</th></tr></thead><tbody id="investments-list"></tbody></table></div>
                    </div>
                </div>

                <div id="view-budgets" class="section-view">
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">🎯 Cadastro de Orçamento por Categoria</div></div>
                        <form id="budget-form">
                            <div class="form-grid">
                                <div class="form-group"><label>Categoria do Orçamento</label><input type="text" id="bud-category" placeholder="Ex: Lazer, Alimentação, Transporte" required></div>
                                <div class="form-group"><label>Limite Máximo Mensal (R$)</label><input type="number" step="0.01" id="bud-limit" placeholder="0,00" required></div>
                                <div class="form-group"><label>Alerta de Consumo (%)</label><input type="number" id="bud-alert" placeholder="Ex: 80% (Aviso preventivo)" value="80"></div>
                            </div>
                            <button type="submit" class="btn-primary">Salvar Orçamento Inteligente</button>
                        </form>
                    </div>
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">📊 Orçamentos Vigentes e Monitoramento</div></div>
                        <div class="table-responsive"><table><thead><tr><th>Categoria</th><th>Limite Máximo</th><th>Gasto Atual</th><th>Progresso</th><th>Ações</th></tr></thead><tbody id="budgets-list"></tbody></table></div>
                    </div>
                </div>

                <div id="view-goals" class="section-view">
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">🏆 Cadastro de Metas Patrimoniais</div></div>
                        <form id="goal-form">
                            <div class="form-grid">
                                <div class="form-group"><label>Objetivo da Meta</label><input type="text" id="goal-name" placeholder="Ex: Reserva de Emergência / Viagem Europa" required></div>
                                <div class="form-group"><label>Valor Alvo (R$)</label><input type="number" step="0.01" id="goal-target" placeholder="0,00" required></div>
                                <div class="form-group"><label>Valor Já Guardado (R$)</label><input type="number" step="0.01" id="goal-current" placeholder="0,00" required></div>
                                <div class="form-group"><label>Data Limite (Prazo)</label><input type="date" id="goal-deadline"></div>
                            </div>
                            <button type="submit" class="btn-primary">Cadastrar Meta Estratégica</button>
                        </form>
                    </div>
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">🎯 Acompanhamento de Metas</div></div>
                        <div class="table-responsive"><table><thead><tr><th>Objetivo</th><th>Guardado</th><th>Alvo</th><th>Progresso</th><th>Ações</th></tr></thead><tbody id="goals-list"></tbody></table></div>
                    </div>
                </div>

                <div id="view-debts" class="section-view">
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">⚠️ Cadastro de Dívidas e Passivos</div></div>
                        <form id="debt-form">
                            <div class="form-grid">
                                <div class="form-group"><label>Credor / Descrição</label><input type="text" id="debt-name" placeholder="Ex: Empréstimo Pessoal / Financiamento" required></div>
                                <div class="form-group"><label>Categoria do Passivo</label><select id="debt-category"><option value="Cartão de Crédito">Cartão de Crédito</option><option value="Empréstimo Bancário">Empréstimo Bancário</option><option value="Financiamento Imobiliário/Veículo">Financiamento</option><option value="Outros Passivos">Outros Passivos</option></select></div>
                                <div class="form-group"><label>Valor Total da Dívida (R$)</label><input type="number" step="0.01" id="debt-total" placeholder="0,00" required></div>
                                <div class="form-group"><label>Valor Restante (R$)</label><input type="number" step="0.01" id="debt-remaining" placeholder="0,00" required></div>
                            </div>
                            <button type="submit" class="btn-primary">Registrar Dívida no Sistema</button>
                        </form>
                    </div>
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">📋 Passivos Ativos</div></div>
                        <div class="table-responsive"><table><thead><tr><th>Credor</th><th>Categoria</th><th>Total</th><th>Restante</th><th>Ações</th></tr></thead><tbody id="debts-list"></tbody></table></div>
                    </div>
                </div>

                <div id="view-recurring" class="section-view">
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">🔄 Cadastro de Conta Recorrente</div></div>
                        <form id="rec-form">
                            <div class="form-grid">
                                <div class="form-group"><label>Descrição da Conta</label><input type="text" id="rec-desc" placeholder="Ex: Aluguel, Internet, Netflix" required></div>
                                <div class="form-group"><label>Valor Mensal (R$)</label><input type="number" step="0.01" id="rec-amount" placeholder="0,00" required></div>
                                <div class="form-group"><label>Dia de Vencimento</label><input type="number" min="1" max="31" id="rec-day" placeholder="10" required></div>
                            </div>
                            <button type="submit" class="btn-primary">Adicionar Recorrência</button>
                        </form>
                    </div>
                    <div class="panel">
                        <div class="panel-header"><div class="panel-title">📅 Recorrentes Ativas</div></div>
                        <div class="table-responsive"><table><thead><tr><th>Descrição</th><th>Valor</th><th>Dia</th><th>Ações</th></tr></thead><tbody id="recurring-list"></tbody></table></div>
                    </div>
                </div>

                <div class="dev-tag-dash">
                    <div class="dev-tag-label-dash">SISTEMA DESENVOLVIDO POR</div>
                    <div class="dev-tag-name-dash">PAULO LIMA</div>
                </div>
            </main>
        </div>

        <aside class="right-panel">
            <div class="rp-card">
                <div class="rp-profile-top">
                    <div class="rp-avatar" id="rp-avatar">👤</div>
                    <div>
                        <div class="rp-name" id="rp-name">Carregando...</div>
                        <div class="rp-role">Titular da Conta</div>
                    </div>
                </div>
                <div class="rp-info-row">✉️&nbsp;<a href="#" id="rp-email">-</a></div>
                <div class="rp-info-row" id="rp-phone-row" style="display:none;">📞&nbsp;<span id="rp-phone"></span></div>
            </div>

            <div class="rp-card calendar-widget">
                <div class="cal-head">
                    <button class="cal-nav" onclick="calChangeMonth(-1)" type="button">‹</button>
                    <div class="cal-title" id="cal-title">-</div>
                    <button class="cal-nav" onclick="calChangeMonth(1)" type="button">›</button>
                </div>
                <div class="cal-grid" id="cal-grid"></div>
            </div>

            <div class="rp-card">
                <div style="font-weight:800; font-size:13.5px; margin-bottom:2px;">🔔 Contas a Vencer</div>
                <div style="font-size:11px; color:var(--text-muted); font-weight:600;">Recorrências cadastradas</div>
                <div class="notif-list" id="notif-list"></div>
            </div>
        </aside>
    </div>

    <div class="modal-overlay" id="edit-modal-overlay">
        <div class="modal-box">
            <div class="modal-header">
                <div class="modal-title" id="modal-title-text">✏️ Editar Registro</div>
                <button class="modal-close" onclick="closeEditModal()">✕</button>
            </div>
            <form id="dynamic-edit-form">
                <input type="hidden" id="edit-resource-type">
                <input type="hidden" id="edit-resource-id">
                <div id="modal-form-body" class="form-grid" style="grid-template-columns: 1fr;"></div>
                <div class="modal-actions">
                    <button type="button" class="btn-secondary" onclick="closeEditModal()">Cancelar</button>
                    <button type="submit" class="btn-primary" id="modal-submit-btn">Salvar Alterações</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        function applySavedTheme() {
            const saved = localStorage.getItem('plp_theme') || 'dark';
            document.documentElement.setAttribute('data-theme', saved);
            const btn = document.getElementById('dash-theme-btn');
            if (btn) btn.innerText = saved === 'dark' ? '☀️ Tema Claro' : '🌙 Tema Escuro';
        }
        applySavedTheme();

        function toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('plp_theme', next);
            const btn = document.getElementById('dash-theme-btn');
            if (btn) btn.innerText = next === 'dark' ? '☀️ Tema Claro' : '🌙 Tema Escuro';
            if (window.allTransactions) renderFilteredData(window.allTransactions);
        }

        let barChartInstance = null;
        let pieChartInstance = null;
        let lineChartInstance = null;
        let areaChartInstance = null;
        let globalCards = [];
        let globalTransactions = [];
        let globalBudgets = [];
        let globalAccounts = [];
        let globalInvestments = [];
        let globalGoals = [];
        let globalDebts = [];
        let globalRecurring = [];

        document.getElementById('tx-date').valueAsDate = new Date();

        const viewTitles = {
            overview: 'Dashboard', accounts: 'Contas & Bancos', cards: 'Cartões de Crédito',
            transactions: 'Receitas & Despesas', investments: 'Investimentos',
            budgets: 'Orçamentos', goals: 'Metas Patrimoniais', debts: 'Dívidas & Passivos', recurring: 'Contas Recorrentes'
        };

        function switchView(viewId, btn) {
            document.querySelectorAll('.section-view').forEach(v => v.classList.remove('active'));
            document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
            document.getElementById('view-' + viewId).classList.add('active');
            if (btn) btn.classList.add('active');
            const titleEl = document.getElementById('page-title');
            if (titleEl) titleEl.innerText = viewTitles[viewId] || 'Dashboard';
            window.scrollTo({ top: 0, behavior: 'smooth' });
            if (viewId === 'overview' && window.allTransactions) { setTimeout(() => renderFilteredData(window.allTransactions), 100); }
        }

        async function loadUserData() {
            const res = await fetch('/api/user');
            if (res.ok) {
                const user = await res.json();
                const initials = (user.name || '?').trim().split(/\\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();
                const avatarChip = document.getElementById('user-avatar-chip');
                if (avatarChip) avatarChip.innerText = initials || '👤';
                const rpAvatar = document.getElementById('rp-avatar');
                if (rpAvatar) rpAvatar.innerText = initials || '👤';
                const rpName = document.getElementById('rp-name');
                if (rpName) rpName.innerText = user.name || 'Usuário';
                const rpEmail = document.getElementById('rp-email');
                if (rpEmail) { rpEmail.innerText = user.email || '-'; rpEmail.href = user.email ? \`mailto:\${user.email}\` : '#'; }
                if (user.phone) {
                    const rpPhoneRow = document.getElementById('rp-phone-row');
                    const rpPhone = document.getElementById('rp-phone');
                    if (rpPhoneRow && rpPhone) { rpPhone.innerText = user.phone; rpPhoneRow.style.display = 'flex'; }
                }
            }
        }
        loadUserData();

        const calState = (() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; })();
        const calMonthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
        const calDowNames = ['D','S','T','Q','Q','S','S'];

        function renderCalendar() {
            const titleEl = document.getElementById('cal-title');
            const gridEl = document.getElementById('cal-grid');
            if (!titleEl || !gridEl) return;
            titleEl.innerText = \`\${calMonthNames[calState.month]} \${calState.year}\`;

            const today = new Date();
            const firstDow = new Date(calState.year, calState.month, 1).getDay();
            const daysInMonth = new Date(calState.year, calState.month + 1, 0).getDate();

            let html = calDowNames.map(d => \`<div class="cal-dow">\${d}</div>\`).join('');
            for (let i = 0; i < firstDow; i++) html += '<div class="cal-day muted">0</div>';
            for (let day = 1; day <= daysInMonth; day++) {
                const isToday = day === today.getDate() && calState.month === today.getMonth() && calState.year === today.getFullYear();
                html += \`<div class="cal-day \${isToday ? 'today' : ''}">\${day}</div>\`;
            }
            gridEl.innerHTML = html;
        }

        function calChangeMonth(delta) {
            calState.month += delta;
            if (calState.month > 11) { calState.month = 0; calState.year++; }
            if (calState.month < 0) { calState.month = 11; calState.year--; }
            renderCalendar();
        }
        renderCalendar();

        function renderGoalOverview() {
            const ring = document.getElementById('goal-ring');
            const pctEl = document.getElementById('goal-total-pct');
            const completedEl = document.getElementById('goal-completed');
            const inProgressEl = document.getElementById('goal-inprogress');
            if (!ring) return;

            let avgPct = 0, completed = 0, inProgress = 0;
            if (globalGoals.length) {
                let sum = 0;
                globalGoals.forEach(g => {
                    const target = Number(g.target) || 0;
                    const current = Number(g.current) || 0;
                    const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
                    sum += pct;
                    if (pct >= 100) completed++; else inProgress++;
                });
                avgPct = sum / globalGoals.length;
            }
            const deg = (avgPct / 100) * 360;
            ring.style.background = \`conic-gradient(var(--accent) \${deg}deg, #4338ca \${deg}deg, var(--field-bg) \${deg}deg 360deg)\`;
            pctEl.innerText = \`\${avgPct.toFixed(1)}%\`;
            completedEl.innerText = completed;
            inProgressEl.innerText = inProgress;
        }

        function renderNotifications() {
            const listEl = document.getElementById('notif-list');
            if (!listEl) return;
            if (!globalRecurring.length) {
                listEl.innerHTML = '<div class="notif-item" style="border-bottom:none;">Nenhuma recorrência cadastrada.</div>';
                return;
            }
            const todayDay = new Date().getDate();
            const sorted = globalRecurring.slice().sort((a, b) => {
                const da = Number(a.day) >= todayDay ? Number(a.day) : Number(a.day) + 31;
                const db = Number(b.day) >= todayDay ? Number(b.day) : Number(b.day) + 31;
                return da - db;
            });
            listEl.innerHTML = sorted.slice(0, 6).map(r => \`
                <div class="notif-item">
                    <span class="notif-dot"></span>
                    <span>Dia \${r.day} — <b>\${r.desc}</b> — R$ \${fmt(r.amount)}</span>
                </div>\`).join('');
        }

        function renderFlowComparison() {
            const now = new Date();
            const curKey = \`\${now.getFullYear()}-\${String(now.getMonth() + 1).padStart(2, '0')}\`;
            const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const prevKey = \`\${prevDate.getFullYear()}-\${String(prevDate.getMonth() + 1).padStart(2, '0')}\`;

            let curRev = 0, curExp = 0, prevRev = 0, prevExp = 0;
            (window.allTransactions || []).forEach(t => {
                if (!t.date) return;
                const amt = Number(t.amount) || 0;
                if (t.date.startsWith(curKey)) { t.type === 'Receita' ? curRev += amt : curExp += amt; }
                else if (t.date.startsWith(prevKey)) { t.type === 'Receita' ? prevRev += amt : prevExp += amt; }
            });

            const curNet = curRev - curExp, prevNet = prevRev - prevExp;
            const thisMonthEl = document.getElementById('flow-this-month');
            const lastMonthEl = document.getElementById('flow-last-month');
            if (thisMonthEl) thisMonthEl.innerText = \`R$ \${fmt(curNet)}\`;
            if (lastMonthEl) lastMonthEl.innerText = \`R$ \${fmt(prevNet)}\`;

            renderDelta('kpi-revenue-delta', curRev, prevRev);
            renderDelta('kpi-expense-delta', curExp, prevExp, true);
        }

        function renderDelta(elId, curVal, prevVal, invertColor) {
            const el = document.getElementById(elId);
            if (!el) return;
            if (prevVal === 0) { el.innerText = 'Sem dados do mês anterior'; el.className = 'hero-delta'; return; }
            const change = ((curVal - prevVal) / prevVal) * 100;
            const isUp = change >= 0;
            const goodDirection = invertColor ? !isUp : isUp;
            el.className = 'hero-delta ' + (goodDirection ? 'up' : 'down');
            el.innerText = \`\${isUp ? '▲' : '▼'} \${Math.abs(change).toFixed(1)}% vs mês anterior\`;
        }

        function getBaseImage(fileInputId) {
            return new Promise((resolve) => {
                const fileInput = document.getElementById(fileInputId);
                if (fileInput.files && fileInput.files[0]) {
                    const reader = new FileReader();
                    reader.onload = (e) => resolve(e.target.result);
                    reader.readAsDataURL(fileInput.files[0]);
                } else { resolve(''); }
            });
        }

        function fmt(v) { return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }
        function emptyRow(colspan, text) { return \`<tr class="empty-row"><td colspan="\${colspan}">\${text}</td></tr>\`; }

        async function loadAllData() {
            const [resAcc, resCard, resTx, resInv, resBud, resGoal, resDebt, resRec] = await Promise.all([
                fetch('/api/accounts'),
                fetch('/api/cards'),
                fetch('/api/transactions'),
                fetch('/api/investments'),
                fetch('/api/budgets'),
                fetch('/api/goals'),
                fetch('/api/debts'),
                fetch('/api/recurring')
            ]);

            if (resAcc.ok) globalAccounts = await resAcc.json();
            if (resCard.ok) {
                globalCards = await resCard.json();
                const selectCard = document.getElementById('tx-card');
                selectCard.innerHTML = '<option value="">Nenhum (Movimentação Direta)</option>';
                globalCards.forEach(c => {
                    selectCard.innerHTML += \`<option value="\${c.id}">\${c.name}</option>\`;
                });
            }
            if (resTx.ok) {
                globalTransactions = await resTx.json();
                window.allTransactions = globalTransactions;
                populateMonthSelector(globalTransactions);
            }
            if (resInv.ok) globalInvestments = await resInv.json();
            if (resBud.ok) globalBudgets = await resBud.json();
            if (resGoal.ok) globalGoals = await resGoal.json();
            if (resDebt.ok) globalDebts = await resDebt.json();
            if (resRec.ok) globalRecurring = await resRec.json();

            renderFilteredData(globalTransactions);
        }

        function populateMonthSelector(transactions) {
            const select = document.getElementById('global-month-select');
            const currentSelected = select.value;
            
            const monthsSet = new Set();
            transactions.forEach(t => {
                if (t.date) {
                    const ym = t.date.substring(0, 7);
                    monthsSet.add(ym);
                }
            });

            const sortedMonths = Array.from(monthsSet).sort().reverse();
            
            let optionsHtml = '<option value="all">Todos os Meses (Consolidado Geral)</option>';
            const monthNames = {
                '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março', '04': 'Abril',
                '05': 'Maio', '06': 'Junho', '07': 'Julho', '08': 'Agosto',
                '09': 'Setembro', '10': 'Outubro', '11': 'Novembro', '12': 'Dezembro'
            };

            sortedMonths.forEach(ym => {
                const [y, m] = ym.split('-');
                const label = \`\${monthNames[m] || m}/\${y}\`;
                optionsHtml += \`<option value="\${ym}">\${label}</option>\`;
            });

            select.innerHTML = optionsHtml;

            if (currentSelected && select.querySelector(\`option[value="\${currentSelected}"]\`)) {
                select.value = currentSelected;
            } else if (sortedMonths.length > 0) {
                select.value = sortedMonths[0];
            } else {
                select.value = 'all';
            }
        }

        function onMonthFilterChange() {
            renderFilteredData(window.allTransactions || []);
        }

        function renderFilteredData(transactions) {
            const selectedMonth = document.getElementById('global-month-select').value;
            
            let filteredTxs = transactions;
            if (selectedMonth !== 'all') {
                filteredTxs = transactions.filter(t => t.date && t.date.startsWith(selectedMonth));
            }

            let totalAcc = 0;
            const tbAcc = document.getElementById('accounts-list');
            tbAcc.innerHTML = globalAccounts.length ? '' : emptyRow(5, 'Nenhuma conta cadastrada.');
            globalAccounts.forEach(a => {
                totalAcc += Number(a.balance) || 0;
                tbAcc.innerHTML += \`<tr><td>🏦 \${a.name}</td><td>\${a.type}</td><td>\${a.agency || 'Geral'}</td><td>R$ \${fmt(a.balance)}</td><td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("accounts", \${JSON.stringify(a)})'>Editar</button><button class="btn-delete" onclick="deleteItem('accounts', '\${a.id}')">Excluir</button></div></td></tr>\`;
            });

            let rev = 0, exp = 0;
            const tbTx = document.getElementById('transactions-list');
            tbTx.innerHTML = filteredTxs.length ? '' : emptyRow(7, 'Nenhuma movimentação registrada no período.');
            filteredTxs.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).forEach(t => {
                const amt = Number(t.amount) || 0;
                if (t.type === 'Receita') rev += amt; else exp += amt;
                const icon = t.type === 'Receita' ? '📈' : '📉';
                const cardObj = globalCards.find(c => String(c.id) === String(t.cardId));
                const cardNameDisplay = cardObj ? \`💳 \${cardObj.name}\` : 'Direto';
                tbTx.innerHTML += \`<tr><td>📅 \${t.date}</td><td>\${t.desc}</td><td>\${t.category}</td><td>\${cardNameDisplay}</td><td>\${icon} \${t.type}</td><td>R$ \${fmt(amt)}</td><td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("transactions", \${JSON.stringify(t)})'>Editar</button><button class="btn-delete" onclick="deleteItem('transactions', '\${t.id}')">Excluir</button></div></td></tr>\`;
            });
            document.getElementById('kpi-revenue').innerText = \`R$ \${fmt(rev)}\`;
            document.getElementById('kpi-expense').innerText = \`R$ \${fmt(exp)}\`;

            const gridCards = document.getElementById('cards-grid-visual');
            gridCards.innerHTML = globalCards.length ? '' : '<p style="color:var(--text-muted); font-style:italic;">Nenhum cartão cadastrado.</p>';
            let totalCardsSpentGlobal = 0;
            globalCards.forEach(c => {
                const fakeDigits = String(c.id).slice(-4);
                const limitTotal = Number(c.limit) || 0;
                
                let spent = 0;
                filteredTxs.forEach(t => {
                    if (String(t.cardId) === String(c.id) && t.type === 'Despesa') {
                        spent += Number(t.amount) || 0;
                    }
                });
                totalCardsSpentGlobal += spent;
                const remaining = Math.max(0, limitTotal - spent);

                gridCards.innerHTML += \`
                    <div class="bank-card-visual">
                        <div class="card-header-row">
                            <div class="card-brand-name">💳 \${c.name} (\${c.brand || 'Mastercard'})</div>
                            \${c.image ? \`<img src="\${c.image}" class="card-photo-thumb" alt="Cartão">\` : ''}
                        </div>
                        <div class="card-number-sim">•••• •••• •••• \${fakeDigits}</div>
                        
                        <div class="card-stats-box">
                            <div class="card-stat-item">
                                <div>Gasto Atual</div>
                                <div style="color: #f43f5e;">R$ \${fmt(spent)}</div>
                            </div>
                            <div class="card-stat-item">
                                <div>Disponível</div>
                                <div style="color: #10b981;">R$ \${fmt(remaining)}</div>
                            </div>
                        </div>

                        <div class="card-footer-row">
                            <div>
                                <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; font-weight:700;">Limite Total</div>
                                <div class="card-limit-val">R$ \${fmt(limitTotal)}</div>
                            </div>
                            <div class="action-btns">
                                <button class="btn-edit" onclick='openEditModal("cards", \${JSON.stringify(c)})'>Editar</button>
                                <button class="btn-delete" onclick="deleteItem('cards', '\${c.id}')">Excluir</button>
                            </div>
                        </div>
                    </div>\`;
            });
            document.getElementById('kpi-cards-spent').innerText = \`R$ \${fmt(totalCardsSpentGlobal)}\`;

            let totalInv = 0;
            const tbInv = document.getElementById('investments-list');
            tbInv.innerHTML = globalInvestments.length ? '' : emptyRow(5, 'Nenhum ativo cadastrado.');
            globalInvestments.forEach(i => {
                totalInv += Number(i.amount) || 0;
                tbInv.innerHTML += \`<tr><td>💼 \${i.name}</td><td>\${i.class}</td><td>R$ \${fmt(i.amount)}</td><td>\${i.yield || 'N/D'}</td><td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("investments", \${JSON.stringify(i)})'>Editar</button><button class="btn-delete" onclick="deleteItem('investments', '\${i.id}')">Excluir</button></div></td></tr>\`;
            });
            document.getElementById('kpi-investments').innerText = \`R$ \${fmt(totalInv)}\`;
            document.getElementById('kpi-networth').innerText = \`R$ \${fmt(totalAcc + totalInv)}\`;

            const tbBud = document.getElementById('budgets-list');
            tbBud.innerHTML = globalBudgets.length ? '' : emptyRow(5, 'Nenhum orçamento cadastrado.');
            globalBudgets.forEach(b => {
                let spentCat = 0;
                filteredTxs.forEach(t => {
                    if (t.type === 'Despesa' && t.category.toLowerCase() === b.category.toLowerCase()) {
                        spentCat += Number(t.amount) || 0;
                    }
                });
                const limitVal = Number(b.limit) || 1;
                const pct = Math.min(100, (spentCat / limitVal) * 100).toFixed(1);
                tbBud.innerHTML += \`
                    <tr>
                        <td>🎯 \${b.category}</td>
                        <td>R$ \${fmt(limitVal)}</td>
                        <td style="color: #f43f5e;">R$ \${fmt(spentCat)}</td>
                        <td>
                            \${pct}%
                            <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: \${pct}%;"></div></div>
                        </td>
                        <td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("budgets", \${JSON.stringify(b)})'>Editar</button><button class="btn-delete" onclick="deleteItem('budgets', '\${b.id}')">Excluir</button></div></td>
                    </tr>\`;
            });

            const tbGoal = document.getElementById('goals-list');
            tbGoal.innerHTML = globalGoals.length ? '' : emptyRow(5, 'Nenhuma meta cadastrada.');
            globalGoals.forEach(g => {
                const target = Number(g.target) || 0;
                const current = Number(g.current) || 0;
                const pct = target > 0 ? Math.min(100, (current / target) * 100).toFixed(1) : 0;
                tbGoal.innerHTML += \`
                    <tr>
                        <td>🏆 \${g.name}</td>
                        <td>R$ \${fmt(current)}</td>
                        <td>R$ \${fmt(target)}</td>
                        <td>
                            \${pct}%
                            <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: \${pct}%;"></div></div>
                        </td>
                        <td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("goals", \${JSON.stringify(g)})'>Editar</button><button class="btn-delete" onclick="deleteItem('goals', '\${g.id}')">Excluir</button></div></td>
                    </tr>\`;
            });

            let totalDebtsVal = 0;
            const tbDebt = document.getElementById('debts-list');
            tbDebt.innerHTML = globalDebts.length ? '' : emptyRow(5, 'Nenhuma dívida cadastrada.');
            globalDebts.forEach(d => {
                const rem = Number(d.remaining) || 0;
                totalDebtsVal += rem;
                tbDebt.innerHTML += \`<tr><td>⚠️ \${d.name}</td><td>\${d.category}</td><td>R$ \${fmt(d.total)}</td><td style="color:#f43f5e;">R$ \${fmt(rem)}</td><td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("debts", \${JSON.stringify(d)})'>Editar</button><button class="btn-delete" onclick="deleteItem('debts', '\${d.id}')">Excluir</button></div></td></tr>\`;
            });
            document.getElementById('kpi-debts').innerText = \`R$ \${fmt(totalDebtsVal)}\`;

            const tbRec = document.getElementById('recurring-list');
            tbRec.innerHTML = globalRecurring.length ? '' : emptyRow(4, 'Nenhuma recorrência cadastrada.');
            globalRecurring.forEach(r => {
                tbRec.innerHTML += \`<tr><td>🔄 \${r.desc}</td><td>R$ \${fmt(r.amount)}</td><td>Dia \${r.day}</td><td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("recurring", \${JSON.stringify(r)})'>Editar</button><button class="btn-delete" onclick="deleteItem('recurring', '\${r.id}')">Excluir</button></div></td></tr>\`;
            });

            renderGoalOverview();
            renderNotifications();
            renderFlowComparison();
            renderCharts(filteredTxs, transactions);
        }

        function renderCharts(filteredTxs, allTxs) {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
            const textColor = isDark ? '#94a3b8' : '#64748b';

            const mapMonths = {};
            allTxs.forEach(t => {
                if (!t.date) return;
                const ym = t.date.substring(0, 7);
                if (!mapMonths[ym]) mapMonths[ym] = { rev: 0, exp: 0 };
                if (t.type === 'Receita') mapMonths[ym].rev += Number(t.amount) || 0;
                else mapMonths[ym].exp += Number(t.amount) || 0;
            });

            const sortedYms = Object.keys(mapMonths).sort().slice(-6);
            const barLabels = sortedYms.map(ym => {
                const [y, m] = ym.split('-');
                return \`\${m}/\${y}\`;
            });
            const barRevData = sortedYms.map(ym => mapMonths[ym].rev);
            const barExpData = sortedYms.map(ym => mapMonths[ym].exp);

            if (barChartInstance) barChartInstance.destroy();
            const ctxBar = document.getElementById('barChart').getContext('2d');
            barChartInstance = new Chart(ctxBar, {
                type: 'bar',
                data: {
                    labels: barLabels.length ? barLabels : ['Nenhum dado'],
                    datasets: [
                        { label: 'Receitas', data: barLabels.length ? barRevData : [0], backgroundColor: '#10b981', borderRadius: 6 },
                        { label: 'Despesas', data: barLabels.length ? barExpData : [0], backgroundColor: '#f43f5e', borderRadius: 6 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: textColor, font: { family: 'JetBrains Mono', size: 11 } } } },
                    scales: {
                        x: { grid: { color: gridColor }, ticks: { color: textColor, font: { family: 'JetBrains Mono', size: 10 } } },
                        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { family: 'JetBrains Mono', size: 10 } } }
                    }
                }
            });

            const catMap = {};
            filteredTxs.filter(t => t.type === 'Despesa').forEach(t => {
                catMap[t.category] = (catMap[t.category] || 0) + (Number(t.amount) || 0);
            });
            const pieLabels = Object.keys(catMap);
            const pieData = Object.values(catMap);

            if (pieChartInstance) pieChartInstance.destroy();
            const ctxPie = document.getElementById('pieChart').getContext('2d');
            pieChartInstance = new Chart(ctxPie, {
                type: 'doughnut',
                data: {
                    labels: pieLabels.length ? pieLabels : ['Sem despesas'],
                    datasets: [{
                        data: pieLabels.length ? pieData : [1],
                        backgroundColor: ['#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#ec4899', '#3b82f6'],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { color: textColor, font: { family: 'JetBrains Mono', size: 10 } } } }
                }
            });

            const lineLabels = barLabels;
            const lineData = sortedYms.map(ym => mapMonths[ym].rev - mapMonths[ym].exp);

            if (lineChartInstance) lineChartInstance.destroy();
            const ctxLine = document.getElementById('lineChart').getContext('2d');
            lineChartInstance = new Chart(ctxLine, {
                type: 'line',
                data: {
                    labels: lineLabels.length ? lineLabels : ['Nenhum dado'],
                    datasets: [{
                        label: 'Resultado Líquido',
                        data: lineLabels.length ? lineData : [0],
                        borderColor: '#6366f1',
                        backgroundColor: 'rgba(99, 102, 241, 0.1)',
                        fill: true,
                        tension: 0.35,
                        borderWidth: 3,
                        pointBackgroundColor: '#6366f1'
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { color: gridColor }, ticks: { color: textColor, font: { family: 'JetBrains Mono', size: 10 } } },
                        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { family: 'JetBrains Mono', size: 10 } } }
                    }
                }
            });

            let runningSum = 0;
            const areaData = sortedYms.map(ym => {
                runningSum += (mapMonths[ym].rev - mapMonths[ym].exp);
                return runningSum;
            });

            if (areaChartInstance) areaChartInstance.destroy();
            const ctxArea = document.getElementById('areaChart').getContext('2d');
            areaChartInstance = new Chart(ctxArea, {
                type: 'line',
                data: {
                    labels: lineLabels.length ? lineLabels : ['Nenhum dado'],
                    datasets: [{
                        label: 'Evolução Patrimonial Acumulada',
                        data: lineLabels.length ? areaData : [0],
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.12)',
                        fill: true,
                        tension: 0.4,
                        borderWidth: 3,
                        pointBackgroundColor: '#10b981'
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { color: gridColor }, ticks: { color: textColor, font: { family: 'JetBrains Mono', size: 10 } } },
                        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { family: 'JetBrains Mono', size: 10 } } }
                    }
                }
            });
        }

        async function handleFormSubmit(url, payload, successMsg) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (res.ok) {
                    loadAllData();
                    return true;
                } else {
                    alert(data.error || 'Erro ao salvar registro.');
                    return false;
                }
            } catch (err) {
                alert('Erro de conexão com o servidor.');
                return false;
            }
        }

        document.getElementById('account-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const success = await handleFormSubmit('/api/accounts', {
                name: document.getElementById('acc-name').value.trim(),
                type: document.getElementById('acc-type').value,
                balance: document.getElementById('acc-balance').value,
                agency: document.getElementById('acc-agency').value.trim()
            });
            if (success) e.target.reset();
        });

        document.getElementById('card-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const imageBase64 = await getBaseImage('card-image');
            const success = await handleFormSubmit('/api/cards', {
                name: document.getElementById('card-name').value.trim(),
                limit: document.getElementById('card-limit').value,
                due: document.getElementById('card-due').value.trim(),
                brand: document.getElementById('card-brand').value,
                image: imageBase64
            });
            if (success) e.target.reset();
        });

        document.getElementById('tx-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const success = await handleFormSubmit('/api/transactions', {
                type: document.getElementById('tx-type').value,
                desc: document.getElementById('tx-desc').value.trim(),
                amount: document.getElementById('tx-amount').value,
                category: document.getElementById('tx-category').value.trim(),
                cardId: document.getElementById('tx-card').value,
                date: document.getElementById('tx-date').value
            });
            if (success) {
                e.target.reset();
                document.getElementById('tx-date').valueAsDate = new Date();
            }
        });

        document.getElementById('inv-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const success = await handleFormSubmit('/api/investments', {
                name: document.getElementById('inv-name').value.trim(),
                class: document.getElementById('inv-class').value,
                amount: document.getElementById('inv-amount').value,
                yield: document.getElementById('inv-yield').value.trim()
            });
            if (success) e.target.reset();
        });

        document.getElementById('budget-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const success = await handleFormSubmit('/api/budgets', {
                category: document.getElementById('bud-category').value.trim(),
                limit: document.getElementById('bud-limit').value,
                alert: document.getElementById('bud-alert').value
            });
            if (success) e.target.reset();
        });

        document.getElementById('goal-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const success = await handleFormSubmit('/api/goals', {
                name: document.getElementById('goal-name').value.trim(),
                target: document.getElementById('goal-target').value,
                current: document.getElementById('goal-current').value,
                deadline: document.getElementById('goal-deadline').value
            });
            if (success) e.target.reset();
        });

        document.getElementById('debt-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const success = await handleFormSubmit('/api/debts', {
                name: document.getElementById('debt-name').value.trim(),
                category: document.getElementById('debt-category').value,
                total: document.getElementById('debt-total').value,
                remaining: document.getElementById('debt-remaining').value
            });
            if (success) e.target.reset();
        });

        document.getElementById('rec-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const success = await handleFormSubmit('/api/recurring', {
                desc: document.getElementById('rec-desc').value.trim(),
                amount: document.getElementById('rec-amount').value,
                day: document.getElementById('rec-day').value
            });
            if (success) e.target.reset();
        });

        async function deleteItem(resource, id) {
            if (!confirm('Tem certeza que deseja excluir este registro?')) return;
            try {
                const res = await fetch(\`/api/\${resource}/\${id}\`, { method: 'DELETE' });
                if (res.ok) {
                    loadAllData();
                } else {
                    alert('Erro ao excluir registro.');
                }
            } catch (err) {
                alert('Erro de conexão com o servidor.');
            }
        }

        function openEditModal(resource, item) {
            document.getElementById('edit-resource-type').value = resource;
            document.getElementById('edit-resource-id').value = item.id;
            const body = document.getElementById('modal-form-body');
            
            let html = '';
            if (resource === 'accounts') {
                html = \`
                    <div class="form-group"><label>Instituição</label><input type="text" name="name" value="\${item.name || ''}" required></div>
                    <div class="form-group"><label>Tipo</label><input type="text" name="type" value="\${item.type || ''}" required></div>
                    <div class="form-group"><label>Saldo</label><input type="number" step="0.01" name="balance" value="\${item.balance || 0}" required></div>
                    <div class="form-group"><label>Agência</label><input type="text" name="agency" value="\${item.agency || ''}"></div>
                \`;
            } else if (resource === 'cards') {
                html = \`
                    <div class="form-group"><label>Nome</label><input type="text" name="name" value="\${item.name || ''}" required></div>
                    <div class="form-group"><label>Limite</label><input type="number" step="0.01" name="limit" value="\${item.limit || 0}" required></div>
                    <div class="form-group"><label>Vencimento</label><input type="text" name="due" value="\${item.due || ''}" required></div>
                    <div class="form-group"><label>Bandeira</label><input type="text" name="brand" value="\${item.brand || ''}"></div>
                \`;
            } else if (resource === 'transactions') {
                html = \`
                    <div class="form-group"><label>Tipo</label><input type="text" name="type" value="\${item.type || ''}" required></div>
                    <div class="form-group"><label>Descrição</label><input type="text" name="desc" value="\${item.desc || ''}" required></div>
                    <div class="form-group"><label>Valor</label><input type="number" step="0.01" name="amount" value="\${item.amount || 0}" required></div>
                    <div class="form-group"><label>Categoria</label><input type="text" name="category" value="\${item.category || ''}" required></div>
                    <div class="form-group"><label>Data</label><input type="date" name="date" value="\${item.date || ''}" required></div>
                \`;
            } else if (resource === 'investments') {
                html = \`
                    <div class="form-group"><label>Nome</label><input type="text" name="name" value="\${item.name || ''}" required></div>
                    <div class="form-group"><label>Classe</label><input type="text" name="class" value="\${item.class || ''}" required></div>
                    <div class="form-group"><label>Valor</label><input type="number" step="0.01" name="amount" value="\${item.amount || 0}" required></div>
                    <div class="form-group"><label>Rentabilidade</label><input type="text" name="yield" value="\${item.yield || ''}"></div>
                \`;
            } else if (resource === 'budgets') {
                html = \`
                    <div class="form-group"><label>Categoria</label><input type="text" name="category" value="\${item.category || ''}" required></div>
                    <div class="form-group"><label>Limite</label><input type="number" step="0.01" name="limit" value="\${item.limit || 0}" required></div>
                \`;
            } else if (resource === 'goals') {
                html = \`
                    <div class="form-group"><label>Objetivo</label><input type="text" name="name" value="\${item.name || ''}" required></div>
                    <div class="form-group"><label>Alvo</label><input type="number" step="0.01" name="target" value="\${item.target || 0}" required></div>
                    <div class="form-group"><label>Guardado</label><input type="number" step="0.01" name="current" value="\${item.current || 0}" required></div>
                \`;
            } else if (resource === 'debts') {
                html = \`
                    <div class="form-group"><label>Credor</label><input type="text" name="name" value="\${item.name || ''}" required></div>
                    <div class="form-group"><label>Categoria</label><input type="text" name="category" value="\${item.category || ''}" required></div>
                    <div class="form-group"><label>Total</label><input type="number" step="0.01" name="total" value="\${item.total || 0}" required></div>
                    <div class="form-group"><label>Restante</label><input type="number" step="0.01" name="remaining" value="\${item.remaining || 0}" required></div>
                \`;
            } else if (resource === 'recurring') {
                html = \`
                    <div class="form-group"><label>Descrição</label><input type="text" name="desc" value="\${item.desc || ''}" required></div>
                    <div class="form-group"><label>Valor</label><input type="number" step="0.01" name="amount" value="\${item.amount || 0}" required></div>
                    <div class="form-group"><label>Dia</label><input type="number" name="day" value="\${item.day || 1}" required></div>
                \`;
            }
            body.innerHTML = html;
            document.getElementById('edit-modal-overlay').classList.add('active');
        }

        function closeEditModal() {
            document.getElementById('edit-modal-overlay').classList.remove('active');
        }

        document.getElementById('dynamic-edit-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const resource = document.getElementById('edit-resource-type').value;
            const id = document.getElementById('edit-resource-id').value;
            
            const formData = new FormData(e.target);
            const payload = {};
            formData.forEach((val, key) => {
                if (key !== 'edit-resource-type' && key !== 'edit-resource-id') {
                    payload[key] = val;
                }
            });

            try {
                const res = await fetch(\`/api/\${resource}/\${id}\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    closeEditModal();
                    loadAllData();
                } else {
                    alert('Erro ao atualizar registro.');
                }
            } catch (err) {
                alert('Erro de conexão com o servidor.');
            }
        });

        loadAllData();
    </script>
</body>
</html>`);
});

// ==========================================
// ROTAS DE API CRUD (BACKEND)
// ==========================================

app.post('/api/register', async (req, res) => {
    const { name, cpf, phone, email, password } = req.body;
    if (!email || !password || !name) {
        return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
    }
    const db = getDb();
    if (db.users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'Este e-mail já está cadastrado.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: Date.now().toString(),
        name,
        cpf: cpf || '',
        phone: phone || '',
        email,
        password: hashedPassword
    };
    db.users.push(newUser);
    saveDatabase(db);
    res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
    const { email, password, remember } = req.body;
    const db = getDb();
    const user = db.users.find(u => u.email === email);
    if (!user) {
        return res.status(400).json({ error: 'E-mail ou senha incorretos.' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
        return res.status(400).json({ error: 'E-mail ou senha incorretos.' });
    }
    req.session.userId = user.id;
    if (remember) {
        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 dias
    }
    res.json({ success: true });
});

app.get('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Helper genérico para rotas REST CRUD
function setupCrudRoutes(resourceName, arrayKey) {
    app.get(`/api/${resourceName}`, isAuthenticated, (req, res) => {
        const db = getDb();
        res.json(db[arrayKey] || []);
    });

    app.post(`/api/${resourceName}`, isAuthenticated, (req, res) => {
        const db = getDb();
        const newItem = { id: Date.now().toString(), ...req.body };
        db[arrayKey].push(newItem);
        saveDatabase(db);
        res.json({ success: true, item: newItem });
    });

    app.put(`/api/${resourceName}/:id`, isAuthenticated, (req, res) => {
        const db = getDb();
        const index = db[arrayKey].findIndex(i => i.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: 'Registro não encontrado.' });
        db[arrayKey][index] = { ...db[arrayKey][index], ...req.body };
        saveDatabase(db);
        res.json({ success: true, item: db[arrayKey][index] });
    });

    app.delete(`/api/${resourceName}/:id`, isAuthenticated, (req, res) => {
        const db = getDb();
        db[arrayKey] = db[arrayKey].filter(i => i.id !== req.params.id);
        saveDatabase(db);
        res.json({ success: true });
    });
}

setupCrudRoutes('accounts', 'accounts');
setupCrudRoutes('cards', 'cards');
setupCrudRoutes('transactions', 'transactions');
setupCrudRoutes('investments', 'investments');
setupCrudRoutes('budgets', 'budgets');
setupCrudRoutes('goals', 'goals');
setupCrudRoutes('debts', 'debts');
setupCrudRoutes('recurring', 'recurring');

app.listen(PORT, () => {
    console.log(`🚀 PLP Financeiro rodando na porta ${PORT}`);
});