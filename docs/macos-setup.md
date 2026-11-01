# macOS setup (beginner friendly)

You need: **Homebrew**, **Node 22+**, **Docker Desktop**, and **git**. Open the *Terminal* app and paste commands one at a time.

1. **Homebrew** (package manager) – skip if `brew --version` works. Install from https://brew.sh.
2. **Node.js and pnpm**
   ```bash
   brew install node@22
   corepack enable
   ```
   If `corepack` is not found, run `npm install -g corepack` first. Check with `node --version` (22 or newer).
3. **Docker Desktop**: `brew install --cask docker`, then open *Docker* from Applications once and wait until it says it is running.
4. **Get the code and install**
   ```bash
   cd ~/Projects/canadian-accounting
   pnpm install
   ```
5. **Create your settings file**
   ```bash
   cp .env.example .env
   sed -i '' "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env
   ```
6. **Start the database and Redis**, then create the tables:
   ```bash
   docker compose up -d
   pnpm build:packages
   pnpm db:deploy
   ```
7. **Run the app** (two Terminal tabs):
   ```bash
   pnpm dev:api
   ```
   ```bash
   pnpm dev:web
   ```
8. Open http://localhost:3000. The first visit asks you to create the administrator account.
   Then go to *Account menu → System administration* to provision your first company.

**Useful commands**: `pnpm test` (all tests), `pnpm lint`, `pnpm typecheck`, `docker compose down` (stop services; data is kept), `docker compose down -v` (stop **and delete** dev data).

**No Docker?** The API test suite runs without Docker (it downloads a private PostgreSQL binary). The app itself needs a PostgreSQL 17 reachable via `DATABASE_URL`.

**Troubleshooting**
- *`pnpm: command not found`* → run `corepack enable`, then reopen Terminal.
- *Port 5432 in use* → another Postgres is running; stop it or change the port mapping in `compose.yaml` and `DATABASE_URL`.
- *"Invalid environment configuration"* → `ENCRYPTION_KEY` is empty; redo step 5.
