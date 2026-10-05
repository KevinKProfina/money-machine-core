# Builds the whole Money Machine system into one image.
# Build context must be the PARENT directory that contains all component repos:
#   docker build -f money-machine-core/deploy/Dockerfile -t money-machine .
FROM node:22-bookworm-slim

WORKDIR /opt/mm
COPY . .
RUN cd money-machine-core \
 && npm ci --no-audit --no-fund \
 && npx tsx src/cli.ts install \
 && mkdir -p /data /backups logs \
 && chown -R node:node /data /backups /opt/mm/money-machine-core/logs

ENV NODE_ENV=production \
    MM_STATE_DIR=/data \
    MM_BACKUP_DIR=/backups \
    MM_DASHBOARD_HOST=0.0.0.0 \
    HOST=0.0.0.0
VOLUME ["/data", "/backups"]
EXPOSE 8780 8790 8791

# /health answers 503 when no cycle finished recently (supervisor hung or crashed)
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8780/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

USER node
WORKDIR /opt/mm/money-machine-core
# node directly (not npx) so SIGTERM from `docker stop` reaches the supervisor
CMD ["node", "--import", "tsx", "src/cli.ts", "start"]
