# Nexus Financeiro Hub — Sistema de Gestão Financeira Pessoal #

## Visão Geral
O **Nexus Financeiro Hub** é um sistema completo de gestão financeira pessoal, orçamentos, cartões, metas e relatórios, construído com Node.js nativo e **PostgreSQL**.

## Arquitetura & Segurança Implementada
- **Autenticação Segura por Token (Bearer Token):** Todas as rotas da API (`/api/data`, `/api/users`, `/api/admin/all-data`) são protegidas e exigem sessão ativa.
- **Hashing de Senha com Salt (crypto PBKDF2):** Nenhuma senha é gravada em texto puro. Migração transparente automática para senhas legadas no login.
- **Proteção contra Injeção de Scripts (XSS):** Todo o conteúdo de entrada do usuário é escapado via `escapeHTML()`.
- **Persistência no PostgreSQL & Aba de Integração VS Code:**
  - `usuarios`: Armazena cadastro (id, name, email, password hash, role, active).
  - `dados_financeiros`: Armazena transações, contas, orçamentos, metas, alertas e anexos por usuário em coluna `JSONB`.
  - **Aba PostgreSQL & VS Code:** Permite visualizar em tempo real os dados de cadastro no banco, copiar o arquivo `.env`, copiar/baixar scripts SQL (`cadastro.sql`) e exportar cadastros em JSON.

## Como Rodar Localmente

1. Instale as dependências:
   ```bash
   npm install
   ```
2. Configure o arquivo `.env`:
   ```bash
   copy .env.example .env
   ```
   Preencha `DB_USER` e `DB_PASSWORD` com o seu usuário/senha do PostgreSQL local (`DB_NAME=FINANCEIRO`). O banco será verificado e criado automaticamente se necessário.
3. Inicie o servidor:
   ```bash
   npm start
   ```
4. Acesse no navegador:
   ```
   http://localhost:3000
   ```
5. Acesse a aba **🐘 PostgreSQL & VS Code** no menu principal para visualizar os dados cadastrados no banco e copiar as configurações de deploy.

## Deploy no Render / Servidores Cloud
Configure as variáveis de ambiente no painel do Render (`DATABASE_URL` ou `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `SMTP_USER`, `SMTP_PASS`).
