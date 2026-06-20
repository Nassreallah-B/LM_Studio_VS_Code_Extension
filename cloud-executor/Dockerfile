FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git curl wget python3 python3-pip \
    ripgrep jq build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @vscode/vsce --no-fund --no-audit --loglevel error

WORKDIR /app

COPY package.json ./
COPY package-lock.json* ./
RUN npm install --ignore-scripts --omit=dev 2>/dev/null || npm install --ignore-scripts

COPY extension.js ./
COPY lib/ ./lib/
COPY cloud-executor/ ./cloud-executor/
COPY sandbox/ ./sandbox/
COPY resources/ ./resources/

ENV CLOUD_EXECUTOR_DATA_DIR=/data
ENV PORT=7789

# LM Studio accessible depuis le réseau host.docker.internal
ENV LOCALAI_BASE_URL=http://host.docker.internal:1234/v1
ENV LOCALAI_NATIVE_BASE_URL=http://host.docker.internal:1234

EXPOSE 7789

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["node", "cloud-executor/server.js"]
