# Growth TableClinic — Table Growth Hub

Plataforma de conteúdo inteligente para a equipe TableClinic.

## Stack

- Node.js + Express
- PostgreSQL
- JWT (autenticação)
- Claude API (`claude-sonnet-4-20250514`) — geração de conteúdo, anúncios, repurposing, mercado e insights
- OpenAI API — planejamento de edição de vídeo

## Setup

### 1. Clonar e instalar dependências

```bash
git clone https://github.com/felipesantoscsb/growth-tableclinic.git
cd growth-tableclinic
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
# editar .env com suas credenciais
```

### 3. Criar banco de dados

```bash
createdb growth_tableclinic
# ou via DATABASE_URL no .env apontando para seu Postgres
```

### 4. Rodar migrations e seed

```bash
npm run db:migrate
npm run db:seed
```

### 5. Iniciar servidor

```bash
npm run dev   # desenvolvimento (nodemon)
npm start     # produção
```

Acesse: `http://localhost:3000`

## Usuários iniciais

| Email | Role | Senha |
|---|---|---|
| adm@tableclinic.com.br | admin | table2026 |
| evelyn@tableclinic.com.br | evelyn | table2026 |
| felipe@tableclinic.com.br | editor | table2026 |
| luiza@tableclinic.com.br | editor | table2026 |
| juliana@tableclinic.com.br | nutri | table2026 |
| natalia@tableclinic.com.br | nutri | table2026 |

## Módulos

| Módulo | Rota | Acesso |
|---|---|---|
| Calendário Editorial | `/calendario` | todos |
| Gerador de Conteúdo | `/gerador` | todos |
| Fábrica de Anúncios | `/anuncios` | admin, evelyn, editor |
| Repurposing | `/repurposing` | todos |
| Edição de Vídeo | `/edicao` | todos |
| Inteligência de Mercado | `/mercado` | admin, evelyn, editor |
| Performance & Insights | `/insights` | admin, evelyn, editor |
| Admin | `/admin` | admin |

## API Endpoints

### Auth
- `POST /api/auth/login`

### Cards
- `GET /api/cards` — listar (com filtros: format, pilar, status, responsible_id, from, to)
- `GET /api/cards/week` — visão semanal
- `GET /api/cards/month` — visão mensal
- `GET /api/cards/:id`
- `POST /api/cards`
- `PUT /api/cards/:id`
- `PUT /api/cards/:id/status`
- `DELETE /api/cards/:id` — soft delete

### Geração (Claude API)
- `POST /api/generate/content` — gerar roteiro por formato e pilar
- `POST /api/generate/ads` — gerar copies para anúncios (A/B)
- `POST /api/generate/repurpose` — repurposing de transcrição

### Anúncios
- `GET /api/ads` — histórico
- `GET /api/ads/:id`

### Mercado
- `POST /api/market/research` — pesquisa de mercado
- `GET /api/market/reports` — histórico de relatórios
- `GET /api/market/reports/:id`

### Insights
- `GET /api/insights` — dados Meta Ads
- `POST /api/insights/suggest` — análise de performance com IA

### Edição
- `POST /api/edit/video` — plano de edição via OpenAI

### Usuários (admin)
- `GET /api/users`
- `POST /api/users`
- `PUT /api/users/:id`

## Identidade Visual

- **Verde musgo**: `#3D4A35`
- **Bege creme**: `#F8F4EE`
- **Terracota**: `#B97040`
- **Títulos**: Cormorant Garamond
- **Corpo**: Jost

## Job Automático

Toda segunda-feira às 8h BRT: relatório semanal de tendências é gerado e enviado via WhatsApp (Z-API) para o admin.
