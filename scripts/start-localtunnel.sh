#!/bin/bash
# Script pour démarrer avec LocalTunnel (PAS DE TOKEN NÉCESSAIRE !)
# Usage: ./scripts/start-localtunnel.sh

echo "🚀 Démarrage de Lightning Arena avec LocalTunnel..."
echo "   (Aucun token nécessaire !)"
echo ""

# Démarrer
docker-compose -f docker-compose.localtunnel.yml up -d

echo ""
echo "⏳ Attente du démarrage..."
sleep 10

echo ""
echo "📊 Récupération de l'URL publique..."
echo ""
# Attendre que localtunnel affiche l'URL
docker-compose -f docker-compose.localtunnel.yml logs localtunnel | tail -20

echo ""
echo "✅ Lightning Arena démarré !"
echo ""
echo "💡 L'URL sera affichée dans les logs ci-dessus (chercher 'url:')"
echo ""
echo "Pour voir l'URL en temps réel:"
echo "  docker-compose -f docker-compose.localtunnel.yml logs -f localtunnel"
echo ""
echo "Pour arrêter:"
echo "  docker-compose -f docker-compose.localtunnel.yml down"
