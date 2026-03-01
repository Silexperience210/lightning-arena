#!/bin/bash
# DÉMO ULTRA RAPIDE - Sans aucune inscription !
# Utilise Serveo.net (SSH tunnel)
# Usage: ./scripts/quick-demo.sh

echo "⚡ DÉMO RAPIDE - Lightning Arena"
echo "   Aucun token, aucun compte requis !"
echo ""

# Vérifier que le serveur local tourne
if ! curl -s http://localhost:3001/api/health > /dev/null; then
    echo "🚀 Démarrage du serveur local..."
    docker-compose -f docker-compose.nwc-only.yml up -d
    echo "⏳ Attente du serveur (15s)..."
    sleep 15
fi

echo ""
echo "🔗 Création du tunnel public avec Serveo..."
echo "   (Ctrl+C pour arrêter le tunnel)"
echo ""
echo "🌐 Votre URL publique apparaîtra ci-dessous:"
echo "   (Attendez 'Forwarding HTTP traffic from ...')"
echo ""
echo "---------------------------------------------------"

# Tunnel SSH avec Serveo (gratuit, pas de compte)
ssh -R 80:localhost:3001 serveo.net

echo ""
echo "---------------------------------------------------"
echo ""
echo "🛑 Tunnel fermé"
