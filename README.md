# Nexus Financeiro Hub — Sistema de Gestão Financeira Pessoal & Patrimonial

## Visão Geral
O **Nexus Financeiro Hub** é um sistema completo de gestão financeira pessoal, orçamentos, cartões, metas e relatórios, construído com Node.js nativo e **PostgreSQL**.

## Arquitetura & Segurança Implementada
- **Autenticação Segura por Token (Bearer Token):** Todas as rotas da API (`/api/data`, `/api/users`, `/api/admin/all-data`) são protegidas e exigem sessão ativa.
- **Hashing de Senha com Salt (crypto PBKDF2):** Nenhuma senha é gravada em texto puro. Migração transparente automática para senhas legadas no login.
- **Proteção contra Injeção de Scripts (XSS):** Todo o conteúdo de entrada do usuário é escapado via `escapeHTML()`.
- **Persistência no PostgreSQL:**
  - `usuarios`: Armazena cadastro (id, name, email, password hash, role, active).
  - `dados_financeiros`: Armazena transações, contas, orçamentos, metas, alertas e anexos por usuário em coluna `JSONB`.

## Como Rodar Localmente

1. Instale as dependências:
   ```bash
   npm install
   ```
2. Configure o arquivo `.env`:
   ```bash
   copy .env.example .env
   ```
   Preencha `DB_USER` e `DB_PASSWORD` com o seu usuário/senha do PostgreSQL local (`DB_NAME=FINANCEIRO`).
3. Inicie o servidor:
   ```bash
   npm start
   ```
4. Acesse no navegador:
   ```
   http://localhost:3000
   ```

## Deploy no Render
Configure as variáveis de ambiente no painel do Render (`DATABASE_URL` ou `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `SMTP_USER`, `SMTP_PASS`).
