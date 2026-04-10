FROM node:22-slim

# Outils système essentiels pour les tâches agent
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    jq \
    zip \
    unzip \
    build-essential \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Outils Node.js fréquemment nécessaires dans le sandbox
RUN npm install -g \
    typescript \
    ts-node \
    eslint \
    prettier \
    jest \
    --no-fund \
    --no-audit \
    --loglevel error

# Dossier de travail par défaut
WORKDIR /workspace

# Variables d'environnement pour accès au modèle LM Studio sur l'hôte
# Ces valeurs peuvent être surchargées au runtime via docker run --env
ENV LOCALAI_BASE_URL=http://host.docker.internal:1234/v1
ENV LOCALAI_NATIVE_BASE_URL=http://host.docker.internal:1234

# L'agent écrira ses scripts dans .hfai-sandbox/ (ou .localai-sandbox/)
# Ces chemins sont réservés par le runtime
