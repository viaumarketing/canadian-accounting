# Installing on a UGREEN DXP2800, step by step

This guide assumes no Docker or Linux experience. It takes about an hour the first time. Read each step fully before doing it.

> **Status:** these steps were rehearsed with the same images and scripts on a Mac running Docker. They have **not yet been run on a real DXP2800.** Where UGOS screens are described, the wording follows UGREEN's own help pages (Docker app, firmware 1.19.1 or later) and may differ slightly on your NAS. If something on screen does not match, stop and ask rather than guess.

## What you will decide (write these down first)

Nothing here is assumed for you. Before starting, choose:

| You need | Example of the *kind* of value (not a suggestion) | Where it is used |
|---|---|---|
| **Data folder**: an empty folder on a NAS storage volume | something under the `docker` shared folder | All your data: database, documents, backups |
| **Site name**: the name you will type in the browser | a private name such as `books.<something>.lan` | The HTTPS certificate and the browser address |
| **NAS LAN IP address** | the address your router gave the NAS | Making the site name point at the NAS |
| **Ports**: HTTPS and HTTP ports that are free on the NAS | 443/80, or e.g. 8443/8080 if those are taken | How browsers reach the app |
| **GitHub repository and release version** | `owner/repository`, `1.0.0` | Where the NAS downloads the application from |
| **Where you will keep a copy of the secrets file** | a password manager, an encrypted USB stick | Disaster recovery |

You do **not** choose passwords for the database, the encryption key or the backup passphrase: the installer generates strong ones.

## Part 1: Prepare the NAS (UGOS Pro web interface)

1. **Update UGOS Pro** (Control Panel → Update). Restart if asked.
2. **Install Docker**: open App Center, search for **Docker**, install it, and open it once. Its *Overview* page should show the service running.
3. **RAM check**: Control Panel → Hardware or Information should show 8 GB (or 16 GB). The app is sized to use about 3.3 GB at most, leaving the rest to UGOS.
4. **Turn on SSH, temporarily**: Control Panel → Terminal → enable SSH (port 22). UGOS can switch it off again automatically after a while; that is a good idea. You will turn it off at the end.
5. **Create the data folder**: in File Manager, open the `docker` shared folder (create it via Control Panel → Shared Folder if it does not exist) and create an empty folder, e.g. `canadian-accounting`. Right-click → Properties (or Details) shows its full path, which will look like `/volume<N>/docker/canadian-accounting`. **Write down the exact path.**
6. **Give the NAS a fixed LAN address**: in your router, reserve the NAS's current IP address (often called "DHCP reservation"), so it never changes.

## Part 2: Copy the application files to the NAS

From the GitHub release page, download the source archive of the release you want, then unzip it on your computer. You only need these items:

```
compose.production.yaml
.env.production.example
infrastructure/        (the whole folder)
scripts/               (the whole folder)
```

Copy them into a **second** folder next to the data folder, for example `docker/canadian-accounting-app`, with File Manager (drag and drop) or any file-sharing method you normally use. Keep app files and data separate: the data folder must stay empty for now.

## Part 3: Run the installer (SSH)

1. On your computer, open a terminal (macOS: Terminal; Windows: PowerShell) and connect. Use your NAS admin user and the NAS IP:
   ```bash
   ssh <your-nas-admin-user>@<nas-ip>
   ```
2. Become administrator and go to the app folder (use the path you wrote down, ending in `-app`):
   ```bash
   sudo -i
   cd /volume<N>/docker/canadian-accounting-app
   docker compose version
   ```
   The last command must print a version. If it says "command not found", stop here: the Docker app is not installed or not started.
3. Run the installer. It asks for each value from the table above; nothing is filled in for you:
   ```bash
   sh scripts/install.sh
   ```
   It refuses invalid answers, refuses a data folder that is not empty, and warns if a port is already used. It writes `.env` (readable only by the administrator) and creates `postgres`, `redis`, `documents`, `backups` and `caddy` inside your data folder.
4. **Save your secrets now.** Show the file and copy it into your password manager (or save it to an encrypted USB stick):
   ```bash
   cat .env
   ```
   Without `ENCRYPTION_KEY` and `BACKUP_PASSPHRASE` from this file, **your backups cannot be restored**. Nobody can recover them for you.
5. If the GitHub packages are private, sign in once with a GitHub token that has `read:packages`:
   ```bash
   docker login ghcr.io
   ```
6. Download the images and start everything:
   ```bash
   docker compose -f compose.production.yaml pull
   docker compose -f compose.production.yaml up -d
   docker compose -f compose.production.yaml ps
   ```
   Wait a minute and run the last command again. `postgres`, `redis`, `api`, `web` and `backup` should say **healthy**, `worker` and `caddy` **running**, and `prepare` and `migrate` **exited (0)**. Only `caddy` should list ports.

   Optional: the containers also appear in the UGOS **Docker** app under *Container*, where you can see logs and resource use. Manage the stack with the commands in this guide rather than editing it in the app, so `.env` keeps being used.

## Part 4: Make the site name work and trust the certificate

1. **Point the name at the NAS**: in your router's DNS (or "local DNS", "host names"), add the site name → NAS IP. If your router can't do this, add a line `<nas-ip> <site-name>` to the hosts file of each computer that will use the app.
2. **Trust the private certificate**: the app uses its own private certificate authority, so browsers need to trust it once per device. Copy this file from the data folder to your computer:
   ```
   <data folder>/caddy/data/caddy/pki/authorities/local/root.crt
   ```
   - macOS: double-click it → Keychain Access → find "Caddy Local Authority" → Trust → *Always Trust*.
   - Windows: double-click → Install Certificate → Local Machine → "Trusted Root Certification Authorities".
   - iPhone/iPad and Android have their own "install certificate" steps; install only this file.
3. Open `https://<site-name>` (add `:<port>` if you chose a port other than 443). You should see the sign-in page with no certificate warning.

## Part 5: Create the first administrator (secure setup)

1. On the NAS, show the one-time setup token:
   ```bash
   grep SETUP_TOKEN .env
   ```
2. In the browser, the app shows **first-time setup** and asks for the token. Enter it with your name, e-mail and a long passphrase (12+ characters). The app refuses to create an administrator without the token, so nobody else on your network can claim the instance before you.
3. Immediately turn on two-factor authentication: top-right menu → Security → set up an authenticator app. Save the recovery codes.
4. Remove the token so it can never be reused, then restart the API:
   ```bash
   sed -i 's/^SETUP_TOKEN=.*/SETUP_TOKEN=/' .env
   docker compose -f compose.production.yaml up -d api
   ```
5. In **System administration → Companies**, create your company. As platform administrator you do *not* automatically see a company's books: name yourself (or your accountant) as the owner.

## Part 6: Check it is healthy, then secure the NAS

1. **System administration → System health**: Database *up*, Backups *ok* (one is taken at start-up), Queue *ok*, Encryption key *no data* or *ok*.
2. **System administration → Resources**: NAS memory, each service against its limit, free space. Warnings appear at the top of every admin page if memory or disk run low.
3. **Test a backup now** (takes a minute; it never touches your live data):
   ```bash
   docker compose -f compose.production.yaml exec backup sh -c 'ls -1t /backups/*.sql.gz.enc | head -1'
   docker compose -f compose.production.yaml exec backup /scripts/restore.sh /backups/<file name from the line above>
   ```
   The last line must say `ledger balanced (sum debit - sum credit): 0`.
4. **Copy backups off the NAS automatically.** Plug in a USB drive (or mount another NAS share), find its path in File Manager → Properties, put it in `.env` as `BACKUP_COPY_DIR=<that path>`, then run `docker compose -f compose.production.yaml up -d`. System health → Backups should show "Off-NAS copy: ok" after the next backup (or run one now: `docker compose -f compose.production.yaml exec backup /bin/sh /scripts/backup-once.sh`). A backup that lives only on the NAS does not survive the NAS.
5. **Turn SSH off** again (Control Panel → Terminal).
6. **Do not** forward any port to the NAS on your router. To use the app from outside, use a VPN to your home network instead.

## Everyday operations

| Task | Command (from the app folder, after `sudo -i`) |
|---|---|
| See status | `docker compose -f compose.production.yaml ps` |
| See recent errors | `docker compose -f compose.production.yaml logs --tail 100 api worker` |
| Upgrade to a new release | `sh scripts/upgrade.sh 1.1.0` (backs up first, then waits for health) |
| Undo the last upgrade | `sh scripts/rollback.sh` (keeps your data when the upgrade was compatible, otherwise restores the pre-upgrade backup and tells you so) |
| Restore the whole system from a backup | `sh scripts/restore-live.sh <backup file name>` (type REPLACE) |
| Stop everything | `docker compose -f compose.production.yaml down` (data stays in the data folder) |

## If something goes wrong

- **A container keeps restarting**: `docker compose -f compose.production.yaml logs <name>`. The Docker app's *Container → Logs* shows the same thing.
- **"QUEUE_BUSY" when syncing Shopify**: the NAS is still working through earlier jobs; try again in a few minutes.
- **"SCHEMA_TOO_NEW"**: an older version was started on a database upgraded by a newer one. Run `sh scripts/rollback.sh` or upgrade again.
- **"ENCRYPTION_KEY_MISMATCH"**: the `.env` in use is not the one this database was created with. Put back your saved `.env`.
- **Memory warnings**: stop UGOS apps you do not use, or add RAM (the DXP2800 takes up to 16 GB). Do not raise the container limits without watching the Resources page.
