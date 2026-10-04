# Builds the whole Money Machine system into one image.
# Build context must be the PARENT directory that contains all component repos:
#   docker build -f money-machine-core/deploy/Dockerfile -t money-machine .
FROM node:22-bookworm-slim

WORKDIR /opt/mm
COPY . .
RUN cd money-machine-core \
 && npm ci --no-audit --no-fund \
 && npx tsx src/cli.ts install \
 && mkdir -p /data logs \
 && chown -R node:node /data /opt/mm/money-machine-core/logs

ENV NODE_ENV=production \
    MM_STATE_DIR=/data \
    MM_DASHBOARD_HOST=0.0.0.0 \
    HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 8780 8790

USER node
WORKDIR /opt/mm/money-machine-core
CMD ["npx", "tsx", "src/cli.ts", "start"]
