#!/bin/bash
# Script pour démarrer Lightning Arena avec ngrok facilement
# Usage: ./scripts/start-ngrok.sh YOUR_NGROK_TOKEN

set -e

NGROK_TOKEN=${1:-$NGROK_AUTHTOKEN}

if [ -z "$NGROK_TOKEN" ]; then
    echo "❌ ERREUR: Token ngrok manquant"
    echo ""
    echo "Usage:"
    echo "  ./scripts/start-ngrok.sh YOUR_TOKEN"
    echo ""
    echo "Ou définissez la variable d'environnement:"
    echo "  export NGROK_AUTHTOKEN=your_token"
    echo "  ./scripts/start-ngrok.sh"
    echo ""
    echo "Obtenez votre token: https://dashboard.ngrok.com/get-started/your-authtoken"
    exit 1
fi

echo "🚀 Démarrage de Lightning Arena avec ngrok..."

# Exporter le token
export NGROK_AUTHTOKEN=$NGROK_TOKEN

# Démarrer
docker-compose -f docker-compose.ngrok.yml up -d

echo ""
echo "⏳ Attente du démarrage..."
sleep 5

# Récupérer l'URL publique
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$NGROK_URL" ]; then
    echo ""
    echo "✅ LIGHTNING ARENA EST EN LIGNE !"
    echo ""
    echo "🌐 URL Publique: $NGROK_URL"
    echo "📊 Dashboard ngrok: http://localhost:4040"
    echo ""
    echo "Partagez cette URL avec vos amis pour jouer !"
    echo ""
    echo "Pour arrêter: docker-compose -f docker-compose.ngrok.yml down"
else
    echo ""
    echo "⚠️  Ngrok démarre encore..."
    echo "📊 Vérifiez le dashboard: http://localhost:4040"
    echo ""
    echo "Logs: docker-compose -f docker-compose.ngrok.yml logs -f ngrok"
fi
