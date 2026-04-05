FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    findutils \
    git \
    grep \
    procps \
    python3 \
    python3-pip \
    ripgrep \
    sed \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["sh", "-lc", "trap : TERM INT; while sleep 3600; do :; done"]
