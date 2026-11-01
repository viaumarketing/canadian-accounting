# UGREEN NAS (UGOS Pro): general notes

**To install, follow [dxp2800-install-guide.md](dxp2800-install-guide.md)** (step by step, written for the DXP2800 and valid for other x86-64 UGREEN models with at least 8 GB of RAM). Sizing and test results are in [dxp2800.md](dxp2800.md).

Notes that apply to any UGOS Pro NAS:
- **CPU architecture.** Images are published for `linux/amd64`. Check with `uname -m` over SSH: it must print `x86_64`.
- **Ports.** UGOS's own web interface is reported to use 9999 (HTTP) and 9443 (HTTPS). If 80/443 are taken, `scripts/install.sh` asks for other ports and sets `WEB_ORIGIN` for you. UGREEN's note on port conflicts: [support article 539](https://support.ugnas.com/detail/article/en-US/539).
- **Docker app.** UGREEN's own guides: [Docker app overview](https://support.ugnas.com/knowledgecenter/detail/article/en-US/236) and [Compose projects](https://support.ugnas.com/knowledgecenter/detail/article/en-US/411) (firmware 1.19.1 or later). The install guide deploys with `docker compose` over SSH so that `.env` is used; the containers still appear in the Docker app for logs and resource use. Deploying through the Docker app's *Project* editor was **not tested**.
- **Folder ownership.** The app runs as uid 1000. The one-shot `prepare` service makes `documents/` and `backups/` belong to uid 1000 on every start, so folders created in File Manager work.
- **Keep it private.** Use a VPN for remote access; do not forward ports to the NAS.
