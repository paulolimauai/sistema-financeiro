// [source: 1]
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
// TELA DE LOGIN / CADASTRO REFORMULADA (ULTRA LUXO & GLASSMORPHISM)
// ==========================================
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="pt-BR" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PLP FINANCEIRO - Gestão Patrimonial de Alta Performance</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
        
        [data-theme="dark"] {
            --bg-main: #020617;
            --panel-bg: rgba(15, 23, 42, 0.75);
            --panel-soft: rgba(30, 41, 59, 0.65);
            --field-bg: #030712;
            --accent: #6366f1;
            --accent-glow: rgba(99, 102, 241, 0.4);
            --emerald: #10b981;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --border-color: rgba(99, 102, 241, 0.3);
            --danger: #f43f5e;
            --info-gradient-1: rgba(15, 23, 42, 0.95);
            --info-gradient-2: rgba(2, 6, 23, 0.98);
            --input-border: rgba(255, 255, 255, 0.12);
            --input-placeholder: #475569;
            --ledger-bg: rgba(255, 255, 255, 0.03);
            --ledger-border: rgba(255, 255, 255, 0.08);
            --ledger-txt: #cbd5e1;
            --shadow-main: 0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 50px rgba(99, 102, 241, 0.15);
        }

        [data-theme="light"] {
            --bg-main: #f8fafc;
            --panel-bg: rgba(255, 255, 255, 0.85);
            --panel-soft: rgba(241, 245, 249, 0.9);
            --field-bg: #ffffff;
            --accent: #4f46e5;
            --accent-glow: rgba(79, 70, 229, 0.25);
            --emerald: #059669;
            --text-main: #0f172a;
            --text-muted: #64748b;
            --border-color: rgba(79, 70, 229, 0.25);
            --danger: #e11d48;
            --info-gradient-1: rgba(255, 255, 255, 0.95);
            --info-gradient-2: rgba(226, 232, 240, 0.95);
            --input-border: rgba(15, 23, 42, 0.15);
            --input-placeholder: #94a3b8;
            --ledger-bg: rgba(0, 0, 0, 0.02);
            --ledger-border: rgba(0, 0, 0, 0.06);
            --ledger-txt: #334155;
            --shadow-main: 0 25px 50px -12px rgba(0, 0, 0, 0.1), 0 0 35px rgba(79, 70, 229, 0.08);
        }

        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            color: var(--text-main);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
            overflow-y: auto;
            position: relative;
            background: var(--bg-main);
            transition: background 0.3s ease, color 0.3s ease;
        }
        
        .grain { position: fixed; inset: 0; z-index: 0; pointer-events: none; opacity: 0.03;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
        
        .theme-toggle-btn {
            position: fixed; top: 24px; right: 24px; z-index: 10;
            background: var(--panel-bg); border: 1px solid var(--border-color);
            color: var(--text-main); padding: 10px 16px; border-radius: 12px;
            cursor: pointer; font-family: 'JetBrains Mono', monospace; font-size: 11px;
            font-weight: 700; display: flex; align-items: center; gap: 8px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.1); transition: all 0.2s;
            backdrop-filter: blur(12px);
        }
        .theme-toggle-btn:hover { border-color: var(--accent); color: var(--accent); transform: translateY(-1px); }

        .auth-wrapper { position: relative; z-index: 1; width: 100%; display: flex; justify-content: center; align-items: center; max-width: 1150px; margin: auto; }
        .auth-container {
            width: 100%; display: grid; grid-template-columns: 1.15fr 0.85fr;
            background: var(--panel-bg);
            border-radius: 28px; overflow: hidden;
            border: 1px solid var(--border-color);
            box-shadow: var(--shadow-main);
            backdrop-filter: blur(30px);
            transition: background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
        }
        @media (max-width: 950px) { .auth-container { grid-template-columns: 1fr; max-width: 480px; } .info-section { display: none; } }

        .info-section {
            position: relative;
            background: linear-gradient(135deg, var(--info-gradient-1) 0%, var(--info-gradient-2) 100%);
            padding: 56px 48px;
            display: flex; flex-direction: column; justify-content: space-between;
            border-right: 1px solid var(--border-color);
        }
        .info-header .eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; letter-spacing: 2.5px; color: var(--accent); text-transform: uppercase; margin-bottom: 12px; }
        .info-header h1 { font-size: 38px; font-weight: 800; color: var(--text-main); margin-bottom: 16px; letter-spacing: -0.5px; }
        .info-header h1 span { background: linear-gradient(90deg, var(--accent), #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .info-header p { font-size: 14.5px; font-weight: 500; color: var(--text-muted); line-height: 1.7; max-width: 380px; }

        .ledger { margin-top: 36px; display: flex; flex-direction: column; gap: 14px; }
        .ledger-row {
            display: flex; align-items: center; gap: 14px;
            font-size: 13.5px; color: var(--text-muted); padding: 14px 18px;
            background: var(--ledger-bg); border-radius: 14px; border: 1px solid var(--ledger-border);
        }
        .ledger-row .dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--emerald); box-shadow: 0 0 12px var(--emerald); }
        .ledger-row .txt { flex: 1; color: var(--ledger-txt); font-weight: 600; }

        .dev-badge-animated {
            margin-top: 48px;
            padding: 20px 24px;
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(16, 185, 129, 0.1));
            border: 1px solid rgba(99, 102, 241, 0.35);
            border-radius: 18px;
            text-align: center;
            position: relative;
            overflow: hidden;
            box-shadow: 0 0 30px rgba(99, 102, 241, 0.15);
            animation: cardGlow 4s ease-in-out infinite alternate;
        }
        @keyframes cardGlow {
            0% { border-color: rgba(99, 102, 241, 0.35); box-shadow: 0 0 15px rgba(99, 102, 241, 0.1); }
            100% { border-color: rgba(16, 185, 129, 0.65); box-shadow: 0 0 35px rgba(16, 185, 129, 0.25); }
        }
        
        .dev-label-anim { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: 2px; color: var(--accent); text-transform: uppercase; font-weight: 700; margin-bottom: 6px; }
        .dev-name-anim { 
            font-size: 19px; font-weight: 900; letter-spacing: 1.5px; text-transform: uppercase;
            background: linear-gradient(90deg, #6366f1, #10b981, #fff, #6366f1);
            background-size: 300% auto;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            animation: gradientText 5s linear infinite;
        }
        @keyframes gradientText { 0% { background-position: 0% center; } 100% { background-position: 300% center; } }

        .form-section {
            padding: 56px 48px; display: flex; flex-direction: column; justify-content: center;
            background: var(--panel-soft); position: relative; z-index: 1; max-height: 98vh; overflow-y: auto;
            transition: background 0.3s ease;
        }
        @media (max-width: 950px) { .form-section { padding: 40px 28px; max-height: none; } }
        
        .form-header-title { font-size: 28px; font-weight: 800; color: var(--text-main); margin-bottom: 6px; letter-spacing: -0.5px; }
        .form-header-sub { font-size: 14px; color: var(--text-muted); margin-bottom: 28px; font-weight: 500; }

        label { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-muted); display: block; margin-top: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
        .field-wrap { position: relative; }
        
        input {
            width: 100%; padding: 14px 18px; margin-top: 6px; background: var(--field-bg);
            border: 1px solid var(--input-border); color: var(--text-main); border-radius: 14px;
            font-size: 14.5px; font-family: 'Plus Jakarta Sans', sans-serif; outline: none; transition: all 0.2s;
        }
        input::placeholder { color: var(--input-placeholder); }
        input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
        input.field-error { border-color: var(--danger); animation: shake 0.32s; }
        @keyframes shake { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
        
        .pw-toggle {
            position: absolute; right: 16px; top: 50%; transform: translateY(-1px);
            background: none; border: none; cursor: pointer; padding: 4px; color: var(--text-muted);
            display: flex; align-items: center; transition: color 0.15s;
        }
        .pw-toggle:hover { color: var(--accent); }
        .pw-toggle svg { width: 18px; height: 18px; }
        
        .caps-warning {
            display: none; align-items: center; gap: 6px; font-size: 11px; color: #fbbf24;
            font-weight: 600; margin-top: 6px; font-family: 'JetBrains Mono', monospace;
        }
        .caps-warning.show { display: flex; }

        .remember-row { display: flex; align-items: center; justify-content: space-between; margin-top: 22px; }
        .remember-check { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
        .remember-check input[type=checkbox] {
            appearance: none; width: 18px; height: 18px; margin: 0; border-radius: 6px;
            border: 1px solid var(--input-border); background: var(--field-bg); cursor: pointer;
            display: grid; place-content: center; flex-shrink: 0; transition: all 0.2s;
        }
        .remember-check input[type=checkbox]:checked { background: var(--accent); border-color: var(--accent); }
        .remember-check input[type=checkbox]::before {
            content: ''; width: 8px; height: 8px; transform: scale(0); border-radius: 2px; background: #fff;
            transition: transform 0.12s;
        }
        .remember-check input[type=checkbox]:checked::before { transform: scale(1); }
        .remember-check label { margin: 0; text-transform: none; font-size: 13px; color: var(--text-muted); letter-spacing: 0; font-weight: 500; font-family: 'Plus Jakarta Sans', sans-serif; cursor: pointer; }

        button.btn-submit {
            width: 100%; padding: 15px; background: linear-gradient(135deg, var(--accent) 0%, #4338ca 100%); color: #ffffff; border: none;
            border-radius: 14px; cursor: pointer; font-weight: 800; font-size: 13.5px; transition: all 0.2s;
            margin-top: 28px; text-transform: uppercase; letter-spacing: 1px; font-family: 'JetBrains Mono', monospace;
            box-shadow: 0 10px 25px rgba(99, 102, 241, 0.4);
            display: flex; align-items: center; justify-content: center; gap: 10px;
        }
        button.btn-submit:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 15px 35px rgba(99, 102, 241, 0.5); }
        button.btn-submit:disabled { opacity: 0.75; cursor: wait; }
        
        .spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.3); border-top-color: #ffffff; animation: spin 0.7s linear infinite; display: none; }
        button.btn-submit.loading .spinner { display: inline-block; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .toggle-action { text-align: center; margin-top: 24px; font-size: 14px; color: var(--text-muted); cursor: pointer; font-weight: 500; }
        .toggle-action span { color: var(--accent); font-weight: 700; }
        .toggle-action span:hover { text-decoration: underline; }
        .hidden { display: none; }
        .error-message { color: var(--danger); font-size: 13px; text-align: center; margin-top: 14px; font-weight: 700; min-height: 14px; }
    </style>
</head>
<body>
    <button class="theme-toggle-btn" onclick="toggleTheme()" id="theme-btn">☀️ Tema Claro</button>
    <div class="grain"></div>
    <div class="auth-wrapper">
        <div class="auth-container">
            <div class="info-section">
                <div>
                    <div class="info-header">
                        <div class="eyebrow">Enterprise Financial System</div>
                        <h1>PLP <span>Financeiro</span></h1>
                        <p>Plataforma avançada de inteligência corporativa e controle patrimonial com máxima segurança e automação inteligente.</p>
                    </div>
                    <div class="ledger">
                        <div class="ledger-row">
                            <span class="dot"></span>
                            <span class="txt">Criptografia avançada de ponta a ponta</span>
                        </div>
                        <div class="ledger-row">
                            <span class="dot"></span>
                            <span class="txt">Consolidação multi-contas e ativos em tempo real</span>
                        </div>
                        <div class="ledger-row">
                            <span class="dot"></span>
                            <span class="txt">Análise preditiva de orçamentos e despesas</span>
                        </div>
                    </div>
                </div>
                <div class="dev-badge-animated">
                    <div class="dev-label-anim">Sistema Desenvolvido por</div>
                    <div class="dev-name-anim">Paulo Lima</div>
                </div>
            </div>
            <div class="form-section">
                <div class="form-header-title" id="form-title">Acessar Plataforma</div>
                <div class="form-header-sub" id="form-subtitle">Entre com suas credenciais corporativas</div>
                <form id="auth-form" novalidate>
                    <div id="register-fields" class="hidden">
                        <label for="name">Nome Completo</label>
                        <input type="text" id="name" placeholder="Seu nome completo" autocomplete="name">
                        <label for="cpf">CPF</label>
                        <input type="text" id="cpf" placeholder="000.000.000-00" inputmode="numeric" maxlength="14">
                        <label for="phone">Telefone / WhatsApp</label>
                        <input type="text" id="phone" placeholder="(00) 00000-0000" inputmode="numeric" maxlength="15" autocomplete="tel">
                    </div>
                    <label for="email">E-mail de Acesso</label>
                    <input type="email" id="email" placeholder="seu@email.com" required autocomplete="email">
                    <label for="password">Senha de Segurança</label>
                    <div class="field-wrap">
                        <input type="password" id="password" placeholder="••••••••" required minlength="4" autocomplete="current-password">
                        <button type="button" class="pw-toggle" id="pw-toggle" aria-label="Mostrar senha" tabindex="-1">
                            <svg id="eye-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                        </button>
                    </div>
                    <div class="caps-warning" id="caps-warning">⇪ Caps Lock está ativado</div>
                    <div class="remember-row">
                        <label class="remember-check" for="remember">
                            <input type="checkbox" id="remember">
                            <label for="remember" style="margin:0;">Mantenha-me conectado por 30 dias</label>
                        </label>
                    </div>
                    <button type="submit" class="btn-submit" id="submit-btn">
                        <span class="spinner"></span>
                        <span id="submit-btn-text">Entrar no Sistema</span>
                    </button>
                    <div class="error-message" id="error-msg" role="alert" aria-live="polite"></div>
                </form>
                <div class="toggle-action" onclick="toggleMode()">Ainda não tem cadastro? <span id="toggle-text">Criar Conta Gratuitamente</span></div>
            </div>
        </div>
    </div>
    <script>
        function applySavedTheme() {
            const saved = localStorage.getItem('plp_theme') || 'dark';
            document.documentElement.setAttribute('data-theme', saved);
            document.getElementById('theme-btn').innerText = saved === 'dark' ? '☀️ Tema Claro' : '🌙 Tema Escuro';
        }
        applySavedTheme();

        function toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('plp_theme', next);
            document.getElementById('theme-btn').innerText = next === 'dark' ? '☀️ Tema Claro' : '🌙 Tema Escuro';
        }

        let isLogin = true;

        function toggleMode() {
            isLogin = !isLogin;
            document.getElementById('form-title').innerText = isLogin ? 'Acessar Plataforma' : 'Criar Nova Conta';
            document.getElementById('form-subtitle').innerText = isLogin ? 'Entre com suas credenciais corporativas' : 'Cadastre-se para gerenciar sua saúde financeira';
            document.getElementById('submit-btn-text').innerText = isLogin ? 'Entrar no Sistema' : 'Cadastrar na Plataforma';
            document.getElementById('toggle-text').innerText = isLogin ? 'Criar Conta Gratuitamente' : 'Já possui cadastro? Entrar';
            document.getElementById('register-fields').classList.toggle('hidden', isLogin);
            const nameInput = document.getElementById('name');
            if (nameInput) nameInput.required = !isLogin;
            document.getElementById('error-msg').innerText = '';
            document.querySelectorAll('input').forEach(i => i.classList.remove('field-error'));
        }

        const pwInput = document.getElementById('password');
        const pwToggle = document.getElementById('pw-toggle');
        const eyeIcon = document.getElementById('eye-icon');
        pwToggle.addEventListener('click', () => {
            const show = pwInput.type === 'password';
            pwInput.type = show ? 'text' : 'password';
            pwToggle.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
            eyeIcon.innerHTML = show
                ? '<path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/>'
                : '<path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>';
        });

        const capsWarning = document.getElementById('caps-warning');
        pwInput.addEventListener('keyup', (e) => {
            if (typeof e.getModifierState === 'function') {
                capsWarning.classList.toggle('show', e.getModifierState('CapsLock'));
            }
        });
        pwInput.addEventListener('blur', () => capsWarning.classList.remove('show'));

        const cpfInput = document.getElementById('cpf');
        if (cpfInput) {
            cpfInput.addEventListener('input', () => {
                let v = cpfInput.value.replace(/\D/g, '').slice(0, 11);
                v = v.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
                cpfInput.value = v;
            });
        }
        const phoneInput = document.getElementById('phone');
        if (phoneInput) {
            phoneInput.addEventListener('input', () => {
                let v = phoneInput.value.replace(/\D/g, '').slice(0, 11);
                if (v.length > 10) v = v.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
                else if (v.length > 5) v = v.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
                else if (v.length > 2) v = v.replace(/(\d{2})(\d{0,5})/, '($1) $2');
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
            errorEl.innerText = '';
            document.querySelectorAll('input').forEach(i => i.classList.remove('field-error'));

            const email = document.getElementById('email').value.trim().toLowerCase();
            const password = document.getElementById('password').value;
            const name = document.getElementById('name') ? document.getElementById('name').value.trim() : '';
            const cpf = document.getElementById('cpf') ? document.getElementById('cpf').value.trim() : '';
            const phone = document.getElementById('phone') ? document.getElementById('phone').value.trim() : '';
            const remember = document.getElementById('remember').checked;

            if (!email || !password || (!isLogin && !name)) {
                errorEl.innerText = 'Preencha todos os campos obrigatórios.';
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
                        alert('🎉 Conta criada com sucesso!');
                        toggleMode();
                    }
                } else {
                    errorEl.innerText = data.error || 'Ocorreu um erro. Tente novamente.';
                    document.getElementById('password').classList.add('field-error');
                }
            } catch (err) {
                errorEl.innerText = '⚠️ Erro de conexão com o servidor.';
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
// DASHBOARD EXECUTIVO REFORMULADO (COM SELETOR DE MÊS AUTOMÁTICO E VISUAL REFINADO)
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
            --accent-glow: rgba(99, 102, 241, 0.3);
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

        header.main-header {
            position: sticky; top: 0; width: 100%;
            background: var(--header-bg); border-bottom: 1px solid var(--header-border);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            padding: 16px 32px; z-index: 1000; backdrop-filter: blur(20px); box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            gap: 14px; transition: background 0.3s ease, border-color 0.3s ease;
        }
        .header-top-row { width: 100%; display: flex; align-items: center; justify-content: space-between; max-width: 1400px; }
        .header-brand { font-size: 20px; font-weight: 800; color: var(--text-main); letter-spacing: 0.5px; display: flex; align-items: center; gap: 10px; white-space: nowrap; }
        .header-brand span { background: linear-gradient(90deg, var(--accent), #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }

        .header-nav { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; max-width: 1400px; width: 100%; padding-top: 8px; border-top: 1px solid var(--panel-border); }
        .menu-item { font-family: 'JetBrains Mono', monospace; background: var(--panel-bg); border: 1px solid var(--panel-border); color: var(--text-muted); padding: 8px 14px; border-radius: 10px; text-align: center; font-weight: 700; font-size: 11px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 6px; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
        .menu-item:hover, .menu-item.active { background: var(--accent); color: #fff; border-color: var(--accent); box-shadow: 0 0 15px var(--accent-glow); }

        .header-actions { display: flex; align-items: center; gap: 12px; }
        .user-box { font-weight: 700; font-size: 12px; color: var(--text-main); text-transform: uppercase; letter-spacing: 0.5px; background: var(--panel-bg); padding: 9px 16px; border-radius: 10px; border: 1px solid var(--panel-border); white-space: nowrap; }
        
        .theme-toggle-dash { background: var(--panel-bg); color: var(--text-main); border: 1px solid var(--panel-border); padding: 9px 14px; border-radius: 10px; font-weight: 700; cursor: pointer; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; font-family: 'JetBrains Mono', monospace; transition: all 0.2s; }
        .theme-toggle-dash:hover { border-color: var(--accent); color: var(--accent); }

        .btn-exit-yellow { background: transparent; color: #f43f5e; border: 1px solid rgba(244, 63, 94, 0.4); padding: 9px 16px; border-radius: 10px; font-weight: 700; cursor: pointer; font-size: 11px; text-decoration: none; transition: all 0.2s; text-transform: uppercase; letter-spacing: 0.5px; font-family: 'JetBrains Mono', monospace; display: inline-block; text-align: center; white-space: nowrap; }
        .btn-exit-yellow:hover { background: rgba(244, 63, 94, 0.15); border-color: #f43f5e; }

        .global-filter-bar {
            max-width: 1400px; margin: 24px auto 0 auto; padding: 0 32px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;
        }
        .filter-group { display: flex; align-items: center; gap: 10px; background: var(--panel-bg); border: 1px solid var(--panel-border); padding: 8px 16px; border-radius: 12px; backdrop-filter: blur(10px); }
        .filter-group label { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; color: var(--accent); text-transform: uppercase; margin: 0; }
        .filter-group select { background: var(--field-bg); border: 1px solid var(--panel-border); color: var(--text-main); padding: 6px 12px; border-radius: 8px; font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 700; outline: none; cursor: pointer; }

        main { margin-top: 20px; padding: 0 32px 48px 32px; max-width: 1400px; margin-left: auto; margin-right: auto; position: relative; z-index: 1; }
        @media(max-width: 950px) { main { padding: 12px; margin-top: 12px; } .global-filter-bar { padding: 0 12px; } }

        .metrics-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 16px; margin-bottom: 28px; }
        @media(max-width: 1200px) { .metrics-grid { grid-template-columns: repeat(3, 1fr); } }
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
        
        .panel { background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 18px; padding: 32px; margin-bottom: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); backdrop-filter: blur(12px); overflow: hidden; transition: background 0.3s; }
        .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px; border-bottom: 1px solid var(--panel-border); padding-bottom: 16px; flex-wrap: wrap; gap: 10px; }
        .panel-title { font-family: 'JetBrains Mono', monospace; font-size: 13.5px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 0.6px; }
        
        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; margin-bottom: 22px; }
        .form-group { display: flex; flex-direction: column; gap: 6px; }
        label { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
        input, select { background: var(--field-bg); border: 1px solid var(--panel-border); color: var(--text-main); padding: 13px 16px; border-radius: 12px; font-size: 13.5px; outline: none; width: 100%; transition: all 0.2s; font-weight: 600; }
        input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
        .btn-primary { font-family: 'JetBrains Mono', monospace; background: linear-gradient(135deg, var(--accent) 0%, #4338ca 100%); color: #ffffff; border: none; padding: 13px 22px; border-radius: 12px; font-weight: 800; cursor: pointer; font-size: 13px; width: 100%; text-transform: uppercase; letter-spacing: 1px; transition: all 0.2s; box-shadow: 0 6px 20px rgba(0,0,0,0.15); }
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
        th, td { padding: 15px 18px; text-align: left; font-size: 13.5px; border-bottom: 1px solid var(--panel-border); white-space: nowrap; font-weight: 500; color: var(--text-main); }
        th { background: var(--table-th-bg); color: var(--text-muted); font-weight: 800; text-transform: uppercase; letter-spacing: 0.6px; font-family: 'JetBrains Mono', monospace; font-size: 11px; }
        tr:hover td { background: var(--field-bg); }
        .empty-row td { text-align: center; color: var(--text-muted); font-style: italic; padding: 28px; }
        
        .section-view { display: none; }
        .section-view.active { display: block; }
        
        .action-btns { display: flex; gap: 6px; flex-shrink: 0; }
        .btn-edit { padding: 6px 12px; font-size: 11px; background: rgba(99, 102, 241, 0.15); color: var(--accent); border: 1px solid var(--panel-border); border-radius: 8px; cursor: pointer; font-weight: 700; transition: background 0.2s; }
        .btn-edit:hover { background: rgba(99, 102, 241, 0.3); }
        .btn-delete { padding: 6px 12px; font-size: 11px; background: rgba(244, 63, 94, 0.15); color: #f43f5e; border: 1px solid var(--panel-border); border-radius: 8px; cursor: pointer; font-weight: 700; transition: background 0.2s; }
        .btn-delete:hover { background: rgba(244, 63, 94, 0.3); }

        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: var(--modal-overlay); z-index: 2000; display: flex; justify-content: center; align-items: center; padding: 20px; backdrop-filter: blur(10px); opacity: 0; pointer-events: none; transition: opacity 0.3s ease; }
        .modal-overlay.active { opacity: 1; pointer-events: auto; }
        .modal-box { background: var(--modal-box); border: 1px solid var(--panel-border); border-radius: 22px; width: 100%; max-width: 600px; padding: 32px; box-shadow: 0 30px 70px rgba(0,0,0,0.4); position: relative; max-height: 90vh; overflow-y: auto; transform: translateY(20px); transition: transform 0.3s ease, background 0.3s; }
        .modal-overlay.active .modal-box { transform: translateY(0); }
        .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px; border-bottom: 1px solid var(--panel-border); padding-bottom: 16px; }
        .modal-title { font-size: 18.5px; font-weight: 800; color: var(--accent); text-transform: uppercase; letter-spacing: 0.8px; display: flex; align-items: center; gap: 8px; }
        .modal-close { background: transparent; border: none; color: var(--text-muted); font-size: 18px; font-weight: 900; cursor: pointer; transition: color 0.2s; }
        .modal-close:hover { color: #f43f5e; }
        .modal-actions { display: flex; gap: 12px; margin-top: 24px; }
        .btn-secondary { font-family: 'JetBrains Mono', monospace; background: var(--field-bg); color: var(--text-main); border: 1px solid var(--panel-border); padding: 13px 22px; border-radius: 12px; font-weight: 700; cursor: pointer; font-size: 13px; width: 100%; text-transform: uppercase; letter-spacing: 1px; transition: all 0.2s; }
        .btn-secondary:hover { border-color: var(--accent); }

        .dev-tag-dash { 
            text-align: center; 
            margin-top: 48px; 
            padding: 32px 24px; 
            background: var(--panel-bg); 
            border-radius: 18px; 
            border: 1px solid var(--panel-border);
            box-shadow: 0 10px 30px rgba(0,0,0,0.05);
            position: relative;
            overflow: hidden;
            transition: background 0.3s;
        }

        .dev-tag-label-dash { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-muted); letter-spacing: 2px; text-transform: uppercase; font-weight: 700; margin-bottom: 8px; }
        .dev-tag-name-dash { 
            font-size: 24px; font-weight: 900; letter-spacing: 2px; text-transform: uppercase;
            background: linear-gradient(90deg, var(--accent), #10b981, var(--text-main), var(--accent));
            background-size: 300% auto;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            animation: gradientText 5s linear infinite;
            display: inline-block;
            padding: 4px 12px;
        }

        .progress-bar-bg { width: 100%; background: var(--field-bg); border-radius: 6px; height: 8px; border: 1px solid var(--panel-border); overflow: hidden; margin-top: 6px; }
        .progress-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), #10b981); border-radius: 6px; transition: width 0.4s; }
    </style>
</head>
<body>

    <header class="main-header">
        <div class="header-top-row">
            <div class="header-brand">
                <span>💼 PLP FINANCEIRO</span>
            </div>
            <div class="header-actions">
                <button class="theme-toggle-dash" onclick="toggleTheme()" id="dash-theme-btn">☀️ Tema Claro</button>
                <div class="user-box" id="user-display">👤 Carregando...</div>
                <a href="/api/logout" class="btn-exit-yellow">Sair</a>
            </div>
        </div>
        <nav class="header-nav">
            <button class="menu-item active" onclick="switchView('overview', this)">📊 Dashboard</button>
            <button class="menu-item" onclick="switchView('accounts', this)">🏦 Contas & Bancos</button>
            <button class="menu-item" onclick="switchView('cards', this)">💳 Cartões</button>
            <button class="menu-item" onclick="switchView('transactions', this)">📋 Receitas & Despesas</button>
            <button class="menu-item" onclick="switchView('investments', this)">📈 Investimentos</button>
            <button class="menu-item" onclick="switchView('budgets', this)">🎯 Orçamentos</button>
            <button class="menu-item" onclick="switchView('goals', this)">🏆 Metas</button>
            <button class="menu-item" onclick="switchView('debts', this)">⚠️ Dívidas</button>
            <button class="menu-item" onclick="switchView('recurring', this)">🔄 Recorrentes</button>
        </nav>
    </header>

    <div class="global-filter-bar">
        <div class="filter-group">
            <label for="global-month-select">📅 Mês de Referência:</label>
            <select id="global-month-select" onchange="onMonthFilterChange()">
                <option value="all">Todos os Meses (Consolidado Geral)</option>
            </select>
        </div>
        <div style="font-family:'JetBrains Mono', monospace; font-size:11px; color:var(--text-muted); font-weight:700;">
            ⚡ SELEÇÃO AUTOMÁTICA DE DESPESAS ATIVA
        </div>
    </div>

    <main>
        <div id="view-overview" class="section-view active">
            <div class="metrics-grid">
                <div class="metric-card"><div class="metric-title">💎 Patrimônio Líquido Total</div><div class="metric-value" id="kpi-networth">R$ 0,00</div></div>
                <div class="metric-card"><div class="metric-title">📈 Receitas Consolidadas</div><div class="metric-value" id="kpi-revenue" style="color: #10b981;">R$ 0,00</div></div>
                <div class="metric-card"><div class="metric-title">📉 Despesas Consolidadas</div><div class="metric-value" id="kpi-expense" style="color: #f43f5e;">R$ 0,00</div></div>
                <div class="metric-card"><div class="metric-title">💼 Portfólio de Ativos</div><div class="metric-value" id="kpi-investments" style="color: var(--accent);">R$ 0,00</div></div>
                <div class="metric-card"><div class="metric-title">💳 Comprometimento Cartões</div><div class="metric-value" id="kpi-cards-spent" style="color: #f59e0b;">R$ 0,00</div></div>
                <div class="metric-card"><div class="metric-title">⚠️ Passivos / Dívidas</div><div class="metric-value" id="kpi-debts" style="color: #f43f5e;">R$ 0,00</div></div>
            </div>

            <div class="charts-grid">
                <div class="chart-container-box">
                    <div class="chart-title">📊 Comparativo: Receitas vs Despesas</div>
                    <div style="position: relative; height: 260px; width: 100%;"><canvas id="barChart"></canvas></div>
                </div>
                <div class="chart-container-box">
                    <div class="chart-title">🥧 Distribuição Detalhada de Despesas</div>
                    <div style="position: relative; height: 260px; width: 100%; display: flex; justify-content: center; align-items: center;"><canvas id="pieChart"></canvas></div>
                </div>
            </div>

            <div class="charts-grid">
                <div class="chart-container-box">
                    <div class="chart-title">📈 Linha do Tempo do Fluxo de Caixa</div>
                    <div style="position: relative; height: 260px; width: 100%;"><canvas id="lineChart"></canvas></div>
                </div>
                <div class="chart-container-box">
                    <div class="chart-title">📈 Evolução Histórica Patrimonial</div>
                    <div style="position: relative; height: 260px; width: 100%;"><canvas id="areaChart"></canvas></div>
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

        function switchView(viewId, btn) {
            document.querySelectorAll('.section-view').forEach(v => v.classList.remove('active'));
            document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
            document.getElementById('view-' + viewId).classList.add('active');
            btn.classList.add('active');
            window.scrollTo({ top: 0, behavior: 'smooth' });
            if (viewId === 'overview' && window.allTransactions) { setTimeout(() => renderFilteredData(window.allTransactions), 100); }
        }

        async function loadUserData() {
            const res = await fetch('/api/user');
            if (res.ok) {
                const user = await res.json();
                document.getElementById('user-display').innerHTML = \`👤 \${user.name.toUpperCase()}\`;
            }
        }
        loadUserData();

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
                    const ym = t.date.substring(0, 7); // YYYY-MM
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

            // Seleção automática inteligente: se houver meses e nenhum selecionado ainda, define o mês mais recente (atual) automaticamente
            if (currentSelected && select.querySelector(\`option[value="\${currentSelected}"]\`)) {
                select.value = currentSelected;
            } else if (sortedMonths.length > 0) {
                select.value = sortedMonths[0]; // Seleciona automaticamente o mês mais recente
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

            // 1. Contas & Bancos
            let totalAcc = 0;
            const tbAcc = document.getElementById('accounts-list');
            tbAcc.innerHTML = globalAccounts.length ? '' : emptyRow(5, 'Nenhuma conta cadastrada.');
            globalAccounts.forEach(a => {
                totalAcc += Number(a.balance) || 0;
                tbAcc.innerHTML += \`<tr><td>🏦 \${a.name}</td><td>\${a.type}</td><td>\${a.agency || 'Geral'}</td><td>R$ \${fmt(a.balance)}</td><td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("accounts", \${JSON.stringify(a)})'>Editar</button><button class="btn-delete" onclick="deleteItem('accounts', '\${a.id}')">Excluir</button></div></td></tr>\`;
            });

            // 2. Transações
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

            // 3. Cartões Visuais
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

            // 4. Investimentos
            let totalInv = 0;
            const tbInv = document.getElementById('investments-list');
            tbInv.innerHTML = globalInvestments.length ? '' : emptyRow(5, 'Nenhum ativo cadastrado.');
            globalInvestments.forEach(i => {
                totalInv += Number(i.amount) || 0;
                tbInv.innerHTML += \`<tr><td>💼 \${i.name}</td><td>\${i.class}</td><td>R$ \${fmt(i.amount)}</td><td>\${i.yield || 'N/D'}</td><td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("investments", \${JSON.stringify(i)})'>Editar</button><button class="btn-delete" onclick="deleteItem('investments', '\${i.id}')">Excluir</button></div></td></tr>\`;
            });
            document.getElementById('kpi-investments').innerText = \`R$ \${fmt(totalInv)}\`;
            document.getElementById('kpi-networth').innerText = \`R$ \${fmt(totalAcc + totalInv)}\`;

            // 5. Orçamentos
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

            // 6. Metas
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

            // 7. Dívidas
            let totalDebtsVal = 0;
            const tbDebt = document.getElementById('debts-list');
            tbDebt.innerHTML = globalDebts.length ? '' : emptyRow(5, 'Nenhuma dívida cadastrada.');
            globalDebts.forEach(d => {
                totalDebtsVal += Number(d.remaining) || 0;
                tbDebt.innerHTML += \`<tr><td>⚠️ \${d.name}</td><td>\${d.category || 'Outros'}</td><td>R$ \${fmt(d.total)}</td><td style="color:#f43f5e;">R$ \${fmt(d.remaining)}</td><td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("debts", \${JSON.stringify(d)})'>Editar</button><button class="btn-delete" onclick="deleteItem('debts', '\${d.id}')">Excluir</button></div></td></tr>\`;
            });
            document.getElementById('kpi-debts').innerText = \`R$ \${fmt(totalDebtsVal)}\`;

            // 8. Recorrentes
            const tbRec = document.getElementById('recurring-list');
            tbRec.innerHTML = globalRecurring.length ? '' : emptyRow(4, 'Nenhuma recorrente.');
            globalRecurring.forEach(r => {
                tbRec.innerHTML += \`<tr><td>🔄 \${r.desc}</td><td>R$ \${fmt(r.amount)}</td><td>Dia \${r.day}</td><td><div class="action-btns"><button class="btn-edit" onclick='openEditModal("recurring", \${JSON.stringify(r)})'>Editar</button><button class="btn-delete" onclick="deleteItem('recurring', '\${r.id}')">Excluir</button></div></td></tr>\`;
            });

            loadChartsData(filteredTxs);
        }

        function loadChartsData(txs) {
            let totalReceita = 0, totalDespesa = 0;
            const catMap = {};
            
            const sortedTxs = txs.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
            const dateMapRev = {};
            const dateMapExp = {};
            const netWorthTimeline = [];
            let runningNet = 10000;

            sortedTxs.forEach(t => {
                const amt = Number(t.amount) || 0;
                const dt = t.date || 'Sem Data';
                if (t.type === 'Receita') {
                    totalReceita += amt;
                    dateMapRev[dt] = (dateMapRev[dt] || 0) + amt;
                    runningNet += amt;
                } else {
                    totalDespesa += amt;
                    dateMapExp[dt] = (dateMapExp[dt] || 0) + amt;
                    catMap[t.category] = (catMap[t.category] || 0) + amt;
                    runningNet -= amt;
                }
                netWorthTimeline.push({ date: dt, net: runningNet });
            });

            const uniqueDates = [...new Set(sortedTxs.map(t => t.date))].sort();
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const textColor = isDark ? '#94a3b8' : '#64748b';
            const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.05)';

            const ctxBar = document.getElementById('barChart').getContext('2d');
            if (barChartInstance) barChartInstance.destroy();
            barChartInstance = new Chart(ctxBar, {
                type: 'bar',
                data: {
                    labels: ['Receitas Período', 'Despesas Período'],
                    datasets: [{ label: 'R$', data: [totalReceita, totalDespesa], backgroundColor: ['#10b981', '#f43f5e'], borderRadius: 8, barThickness: 35 }]
                },
                options: { 
                    responsive: true, 
                    maintainAspectRatio: false, 
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { weight: 'bold', size: 10 } } },
                        x: { grid: { display: false }, ticks: { color: textColor, font: { weight: 'bold', size: 10 } } }
                    }
                }
            });

            const ctxPie = document.getElementById('pieChart').getContext('2d');
            if (pieChartInstance) pieChartInstance.destroy();
            pieChartInstance = new Chart(ctxPie, {
                type: 'doughnut',
                data: {
                    labels: Object.keys(catMap).length ? Object.keys(catMap) : ['Sem Despesas'],
                    datasets: [{ data: Object.values(catMap).length ? Object.values(catMap) : [1], backgroundColor: ['#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#a855f7', '#3b82f6', '#ec4899'], borderWidth: 2, borderColor: isDark ? '#0f172a' : '#ffffff' }]
                },
                options: { 
                    responsive: true, 
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'bottom', labels: { color: isDark ? '#f8fafc' : '#0f172a', font: { weight: 'bold', size: 10 }, padding: 10 } }
                    }
                }
            });

            const ctxLine = document.getElementById('lineChart').getContext('2d');
            if (lineChartInstance) lineChartInstance.destroy();
            lineChartInstance = new Chart(ctxLine, {
                type: 'line',
                data: {
                    labels: uniqueDates.length ? uniqueDates : ['Hoje'],
                    datasets: [
                        {
                            label: 'Entradas',
                            data: uniqueDates.map(d => dateMapRev[d] || 0),
                            borderColor: '#10b981',
                            backgroundColor: 'rgba(16, 185, 129, 0.1)',
                            tension: 0.3,
                            fill: true
                        },
                        {
                            label: 'Saídas',
                            data: uniqueDates.map(d => dateMapExp[d] || 0),
                            borderColor: '#f43f5e',
                            backgroundColor: 'rgba(244, 63, 94, 0.1)',
                            tension: 0.3,
                            fill: true
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: isDark ? '#f8fafc' : '#0f172a', font: { size: 10, weight: 'bold' } } } },
                    scales: {
                        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 } } },
                        x: { grid: { display: false }, ticks: { color: textColor, font: { size: 10 } } }
                    }
                }
            });

            const ctxArea = document.getElementById('areaChart').getContext('2d');
            if (areaChartInstance) areaChartInstance.destroy();
            areaChartInstance = new Chart(ctxArea, {
                type: 'line',
                data: {
                    labels: uniqueDates.length ? uniqueDates : ['Início'],
                    datasets: [{
                        label: 'Tendência Patrimonial',
                        data: uniqueDates.map((d, idx) => netWorthTimeline[idx] ? netWorthTimeline[idx].net : 10000),
                        borderColor: '#6366f1',
                        backgroundColor: 'rgba(99, 102, 241, 0.15)',
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 } } },
                        x: { grid: { display: false }, ticks: { color: textColor, font: { size: 10 } } }
                    }
                }
            });
        }

        function openEditModal(type, item) {
            document.getElementById('edit-resource-type').value = type;
            document.getElementById('edit-resource-id').value = item.id;
            const body = document.getElementById('modal-form-body');
            const titleEl = document.getElementById('modal-title-text');
            body.innerHTML = '';

            if (type === 'accounts') {
                titleEl.innerHTML = '🏦 Editar Conta / Banco';
                body.innerHTML = \`
                    <div class="form-group"><label>Instituição / Banco</label><input type="text" id="m-name" value="\${item.name}" required></div>
                    <div class="form-group"><label>Tipo de Conta</label><select id="m-type"><option value="Conta Corrente" \${item.type==='Conta Corrente'?'selected':''}>Conta Corrente</option><option value="Conta PJ" \${item.type==='Conta PJ'?'selected':''}>Conta PJ / Empresarial</option><option value="Poupança" \${item.type==='Poupança'?'selected':''}>Poupança</option><option value="Dinheiro Físico" \${item.type==='Dinheiro Físico'?'selected':''}>Dinheiro Físico / Espécie</option></select></div>
                    <div class="form-group"><label>Saldo Atual (R$)</label><input type="number" step="0.01" id="m-balance" value="\${item.balance}" required></div>
                    <div class="form-group"><label>Agência / Conta</label><input type="text" id="m-agency" value="\${item.agency || ''}"></div>
                \`;
            } else if (type === 'cards') {
                titleEl.innerHTML = '💳 Editar Cartão de Crédito';
                body.innerHTML = \`
                    <div class="form-group"><label>Nome do Cartão</label><input type="text" id="m-name" value="\${item.name}" required></div>
                    <div class="form-group"><label>Limite Total (R$)</label><input type="number" step="0.01" id="m-limit" value="\${item.limit}" required></div>
                    <div class="form-group"><label>Dia de Vencimento</label><input type="text" id="m-due" value="\${item.due}" required></div>
                    <div class="form-group"><label>Bandeira</label><select id="m-brand"><option value="Mastercard" \${item.brand==='Mastercard'?'selected':''}>Mastercard</option><option value="Visa" \${item.brand==='Visa'?'selected':''}>Visa</option><option value="Elo" \${item.brand==='Elo'?'selected':''}>Elo</option><option value="American Express" \${item.brand==='American Express'?'selected':''}>American Express</option></select></div>
                    <div class="form-group"><label>Nova Foto / Logo (Opcional)</label><input type="file" id="m-image" accept="image/*"></div>
                \`;
            } else if (type === 'transactions') {
                titleEl.innerHTML = '📋 Editar Transação';
                let cardOptions = '<option value="">Nenhum (Movimentação Direta)</option>';
                globalCards.forEach(c => {
                    cardOptions += \`<option value="\${c.id}" \${String(c.id)===String(item.cardId)?'selected':''}>\${c.name}</option>\`;
                });
                body.innerHTML = \`
                    <div class="form-group"><label>Tipo de Lançamento</label><select id="m-type"><option value="Receita" \${item.type==='Receita'?'selected':''}>Receita (Entrada)</option><option value="Despesa" \${item.type==='Despesa'?'selected':''}>Despesa (Saída)</option></select></div>
                    <div class="form-group"><label>Descrição</label><input type="text" id="m-desc" value="\${item.desc}" required></div>
                    <div class="form-group"><label>Valor (R$)</label><input type="number" step="0.01" id="m-amount" value="\${item.amount}" required></div>
                    <div class="form-group"><label>Categoria</label><input type="text" id="m-category" value="\${item.category}" required></div>
                    <div class="form-group"><label>Vincular a Cartão?</label><select id="m-card">\${cardOptions}</select></div>
                    <div class="form-group"><label>Data</label><input type="date" id="m-date" value="\${item.date}" required></div>
                \`;
            } else if (type === 'investments') {
                titleEl.innerHTML = '📈 Editar Ativo / Investimento';
                body.innerHTML = \`
                    <div class="form-group"><label>Nome do Ativo</label><input type="text" id="m-name" value="\${item.name}" required></div>
                    <div class="form-group"><label>Classe</label><select id="m-class"><option value="Renda Fixa" \${item.class==='Renda Fixa'?'selected':''}>Renda Fixa</option><option value="Ações" \${item.class==='Ações'?'selected':''}>Ações</option><option value="FIIs" \${item.class==='FIIs'?'selected':''}>FIIs</option><option value="Cripto" \${item.class==='Cripto'?'selected':''}>Cripto</option><option value="Exterior" \${item.class==='Exterior'?'selected':''}>Exterior</option></select></div>
                    <div class="form-group"><label>Valor Aplicado (R$)</label><input type="number" step="0.01" id="m-amount" value="\${item.amount}" required></div>
                    <div class="form-group"><label>Rentabilidade (% a.a.)</label><input type="text" id="m-yield" value="\${item.yield || ''}"></div>
                \`;
            } else if (type === 'budgets') {
                titleEl.innerHTML = '🎯 Editar Orçamento';
                body.innerHTML = \`
                    <div class="form-group"><label>Categoria</label><input type="text" id="m-category" value="\${item.category}" required></div>
                    <div class="form-group"><label>Limite Máximo (R$)</label><input type="number" step="0.01" id="m-limit" value="\${item.limit}" required></div>
                    <div class="form-group"><label>Alerta de Consumo (%)</label><input type="number" id="m-alert" value="\${item.alert || 80}"></div>
                \`;
            } else if (type === 'goals') {
                titleEl.innerHTML = '🏆 Editar Meta';
                body.innerHTML = \`
                    <div class="form-group"><label>Objetivo</label><input type="text" id="m-name" value="\${item.name}" required></div>
                    <div class="form-group"><label>Valor Alvo (R$)</label><input type="number" step="0.01" id="m-target" value="\${item.target}" required></div>
                    <div class="form-group"><label>Valor Guardado (R$)</label><input type="number" step="0.01" id="m-current" value="\${item.current}" required></div>
                    <div class="form-group"><label>Data Limite</label><input type="date" id="m-deadline" value="\${item.deadline || ''}"></div>
                \`;
            } else if (type === 'debts') {
                titleEl.innerHTML = '⚠️ Editar Dívida / Passivo';
                body.innerHTML = \`
                    <div class="form-group"><label>Credor / Descrição</label><input type="text" id="m-name" value="\${item.name}" required></div>
                    <div class="form-group"><label>Categoria</label><select id="m-category"><option value="Cartão de Crédito" \${item.category==='Cartão de Crédito'?'selected':''}>Cartão de Crédito</option><option value="Empréstimo Bancário" \${item.category==='Empréstimo Bancário'?'selected':''}>Empréstimo Bancário</option><option value="Financiamento Imobiliário/Veículo" \${item.category.includes('Financiamento')?'selected':''}>Financiamento</option><option value="Outros Passivos" \${item.category==='Outros Passivos'?'selected':''}>Outros Passivos</option></select></div>
                    <div class="form-group"><label>Valor Total (R$)</label><input type="number" step="0.01" id="m-total" value="\${item.total}" required></div>
                    <div class="form-group"><label>Valor Restante (R$)</label><input type="number" step="0.01" id="m-remaining" value="\${item.remaining}" required></div>
                \`;
            } else if (type === 'recurring') {
                titleEl.innerHTML = '🔄 Editar Recorrência';
                body.innerHTML = \`
                    <div class="form-group"><label>Descrição</label><input type="text" id="m-desc" value="\${item.desc}" required></div>
                    <div class="form-group"><label>Valor Mensal (R$)</label><input type="number" step="0.01" id="m-amount" value="\${item.amount}" required></div>
                    <div class="form-group"><label>Dia de Vencimento</label><input type="number" min="1" max="31" id="m-day" value="\${item.day}" required></div>
                \`;
            }

            document.getElementById('edit-modal-overlay').classList.add('active');
        }

        function closeEditModal() {
            document.getElementById('edit-modal-overlay').classList.remove('active');
        }

        document.getElementById('dynamic-edit-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const type = document.getElementById('edit-resource-type').value;
            const id = document.getElementById('edit-resource-id').value;
            let payload = {};

            if (type === 'accounts') {
                payload = { name: document.getElementById('m-name').value, type: document.getElementById('m-type').value, balance: Number(document.getElementById('m-balance').value), agency: document.getElementById('m-agency').value };
            } else if (type === 'cards') {
                const base64Img = await getBaseImage('m-image');
                payload = { name: document.getElementById('m-name').value, limit: Number(document.getElementById('m-limit').value), due: document.getElementById('m-due').value, brand: document.getElementById('m-brand').value };
                if (base64Img) payload.image = base64Img;
            } else if (type === 'transactions') {
                payload = { type: document.getElementById('m-type').value, desc: document.getElementById('m-desc').value, amount: Number(document.getElementById('m-amount').value), category: document.getElementById('m-category').value, cardId: document.getElementById('m-card').value, date: document.getElementById('m-date').value };
            } else if (type === 'investments') {
                payload = { name: document.getElementById('m-name').value, class: document.getElementById('m-class').value, amount: Number(document.getElementById('m-amount').value), yield: document.getElementById('m-yield').value };
            } else if (type === 'budgets') {
                payload = { category: document.getElementById('m-category').value, limit: Number(document.getElementById('m-limit').value), alert: document.getElementById('m-alert').value };
            } else if (type === 'goals') {
                payload = { name: document.getElementById('m-name').value, target: Number(document.getElementById('m-target').value), current: Number(document.getElementById('m-current').value), deadline: document.getElementById('m-deadline').value };
            } else if (type === 'debts') {
                payload = { name: document.getElementById('m-name').value, category: document.getElementById('m-category').value, total: Number(document.getElementById('m-total').value), remaining: Number(document.getElementById('m-remaining').value) };
            } else if (type === 'recurring') {
                payload = { desc: document.getElementById('m-desc').value, amount: Number(document.getElementById('m-amount').value), day: Number(document.getElementById('m-day').value) };
            }

            await fetch(\`/api/\${type}/\${id}\`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            closeEditModal();
            loadAllData();
        });

        document.getElementById('account-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = { name: document.getElementById('acc-name').value, type: document.getElementById('acc-type').value, balance: Number(document.getElementById('acc-balance').value), agency: document.getElementById('acc-agency').value };
            await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            document.getElementById('account-form').reset();
            loadAllData();
        });

        document.getElementById('card-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const base64Img = await getBaseImage('card-image');
            const payload = { name: document.getElementById('card-name').value, limit: Number(document.getElementById('card-limit').value), due: document.getElementById('card-due').value, brand: document.getElementById('card-brand').value, image: base64Img };
            await fetch('/api/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            document.getElementById('card-form').reset();
            loadAllData();
        });

        document.getElementById('tx-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = { type: document.getElementById('tx-type').value, desc: document.getElementById('tx-desc').value, amount: Number(document.getElementById('tx-amount').value), category: document.getElementById('tx-category').value, cardId: document.getElementById('tx-card').value, date: document.getElementById('tx-date').value };
            await fetch('/api/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            document.getElementById('tx-form').reset();
            document.getElementById('tx-date').valueAsDate = new Date();
            loadAllData();
        });

        document.getElementById('inv-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = { name: document.getElementById('inv-name').value, class: document.getElementById('inv-class').value, amount: Number(document.getElementById('inv-amount').value), yield: document.getElementById('inv-yield').value };
            await fetch('/api/investments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            document.getElementById('inv-form').reset();
            loadAllData();
        });

        document.getElementById('budget-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = { category: document.getElementById('bud-category').value, limit: Number(document.getElementById('bud-limit').value), alert: document.getElementById('bud-alert').value };
            await fetch('/api/budgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            document.getElementById('budget-form').reset();
            loadAllData();
        });

        document.getElementById('goal-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = { name: document.getElementById('goal-name').value, target: Number(document.getElementById('goal-target').value), current: Number(document.getElementById('goal-current').value), deadline: document.getElementById('goal-deadline').value };
            await fetch('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            document.getElementById('goal-form').reset();
            loadAllData();
        });

        document.getElementById('debt-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = { name: document.getElementById('debt-name').value, category: document.getElementById('debt-category').value, total: Number(document.getElementById('debt-total').value), remaining: Number(document.getElementById('debt-remaining').value) };
            await fetch('/api/debts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            document.getElementById('debt-form').reset();
            loadAllData();
        });

        document.getElementById('rec-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = { desc: document.getElementById('rec-desc').value, amount: Number(document.getElementById('rec-amount').value), day: Number(document.getElementById('rec-day').value) };
            await fetch('/api/recurring', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            document.getElementById('rec-form').reset();
            loadAllData();
        });

        async function deleteItem(type, id) {
            if (confirm('Deseja excluir este item permanentemente?')) {
                await fetch(\`/api/\${type}/\${id}\`, { method: 'DELETE' });
                loadAllData();
            }
        }

        loadAllData();
    </script>
</body>
</html>`);
});

app.get('/', (req, res) => { res.redirect('/login'); });

app.post('/api/register', async (req, res) => {
    try {
        let db = getDb();
        let { name, cpf, phone, email, password } = req.body;
        name = (name || '').trim();
        email = (email || '').trim().toLowerCase();
        if (!name || !email || !password) return res.status(400).json({ error: 'Preencha nome, e-mail e senha.' });
        if (password.length < 4) return res.status(400).json({ error: 'A senha deve ter pelo menos 4 caracteres.' });
        if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'E-mail já cadastrado.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        db.users.push({ id: Date.now().toString(), name, cpf, phone, email, password: hashedPassword });
        saveDatabase(db);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro interno ao cadastrar.' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const db = getDb();
        const email = (req.body.email || '').trim().toLowerCase();
        const password = req.body.password || '';
        const remember = !!req.body.remember;
        const user = db.users.find(u => u.email === email);
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.userId = user.id;
            req.session.cookie.maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'E-mail ou senha inválidos.' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro interno ao entrar.' });
    }
});

app.get('/api/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

['accounts', 'cards', 'transactions', 'investments', 'budgets', 'goals', 'debts', 'recurring'].forEach(resource => {
    app.get(`/api/${resource}`, isAuthenticated, (req, res) => {
        const db = getDb();
        res.json(db[resource].filter(item => String(item.userId) === String(req.session.userId)));
    });
    app.post(`/api/${resource}`, isAuthenticated, (req, res) => {
        const db = getDb();
        const newItem = { id: Date.now().toString(), userId: String(req.session.userId), ...req.body };
        db[resource].push(newItem);
        saveDatabase(db);
        res.json({ success: true, item: newItem });
    });
    app.put(`/api/${resource}/:id`, isAuthenticated, (req, res) => {
        const db = getDb();
        const idx = db[resource].findIndex(i => String(i.id) === String(req.params.id) && String(i.userId) === String(req.session.userId));
        if (idx !== -1) {
            db[resource][idx] = { ...db[resource][idx], ...req.body };
            saveDatabase(db);
            return res.json({ success: true, item: db[resource][idx] });
        }
        res.status(404).json({ error: 'Item não encontrado.' });
    });
    app.delete(`/api/${resource}/:id`, isAuthenticated, (req, res) => {
        const db = getDb();
        const initialLength = db[resource].length;
        db[resource] = db[resource].filter(i => !(String(i.id) === String(req.params.id) && String(i.userId) === String(req.session.userId)));
        if (db[resource].length !== initialLength) {
            saveDatabase(db);
            return res.json({ success: true });
        }
        res.status(404).json({ error: 'Item não encontrado.' });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 PLP Financeiro rodando com máxima performance na porta ${PORT}`);
});
