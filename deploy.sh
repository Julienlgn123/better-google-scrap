#!/bin/bash
# Déploie ce scraper sur une machine fraîche en une commande :
#   git clone <repo-url> scraper && cd scraper
#   API_SECRET=ta-cle-secrete ./deploy.sh
#
# Détecte automatiquement si la machine est "grosse" ou "petite" (nombre de
# cœurs) et choisit la config MAX_BROWSERS/MAX_TABS_PER_BROWSER en conséquence
# — les mêmes valeurs que scraper-1/3 (grosses, ≥3 cœurs) et scraper-2/4
# (petites, <3 cœurs). Surchageable via variables d'env si besoin.
set -euo pipefail

CORES=$(nproc)
if [ "$CORES" -ge 3 ]; then
  DEFAULT_MAX_BROWSERS=2
  DEFAULT_MAX_TABS=10
  SIZE_LABEL="grosse (${CORES} cœurs, style scraper-1/3)"
else
  DEFAULT_MAX_BROWSERS=1
  DEFAULT_MAX_TABS=5
  SIZE_LABEL="petite (${CORES} cœurs, style scraper-2/4)"
fi

MAX_BROWSERS="${MAX_BROWSERS:-$DEFAULT_MAX_BROWSERS}"
MAX_TABS_PER_BROWSER="${MAX_TABS_PER_BROWSER:-$DEFAULT_MAX_TABS}"
PORT_EXTERNAL="${PORT_EXTERNAL:-8443}"

if [ -z "${API_SECRET:-}" ]; then
  echo "Erreur : API_SECRET n'est pas défini." >&2
  echo "Lance avec : API_SECRET=ta-cle-secrete ./deploy.sh" >&2
  exit 1
fi

echo "Machine détectée : $SIZE_LABEL"
echo "Config retenue   : MAX_BROWSERS=$MAX_BROWSERS, MAX_TABS_PER_BROWSER=$MAX_TABS_PER_BROWSER (= $((MAX_BROWSERS * MAX_TABS_PER_BROWSER)) onglets max)"
echo "Port externe      : $PORT_EXTERNAL (8443 par défaut — contourne le firewall UpCloud en mode trial qui bloque 3000 ; passe PORT_EXTERNAL=3000 si ta machine n'a pas cette restriction)"

if ! command -v docker &> /dev/null; then
  echo ""
  echo "Docker absent — installation..."
  curl -fsSL https://get.docker.com | sh
fi

echo ""
echo "Build de l'image..."
docker build -t scraper:latest .

docker rm -f scraper 2>/dev/null || true

echo "Lancement du container..."
docker run -d \
  --name scraper \
  --restart always \
  -p "${PORT_EXTERNAL}:3000" \
  -e PORT=3000 \
  -e MAX_TABS_PER_BROWSER="$MAX_TABS_PER_BROWSER" \
  -e MAX_BROWSERS="$MAX_BROWSERS" \
  -e API_SECRET="$API_SECRET" \
  scraper:latest

echo ""
echo "Déployé. Vérification dans 3s..."
sleep 3
curl -sf -H "x-api-key: $API_SECRET" "http://localhost:${PORT_EXTERNAL}/health" && echo "" && echo "✅ OK" || echo "⚠️  Le health check a échoué — regarde 'docker logs scraper'"

echo ""
echo "N'oublie pas d'ajouter cette machine dans :"
echo "  - dispatcher/machines.js (avec sa maxConcurrent = $((MAX_BROWSERS * MAX_TABS_PER_BROWSER)))"
echo "  - les variables d'env Vercel de public-checker (SCRAPER_N_URL)"
