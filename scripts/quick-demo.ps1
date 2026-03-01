# DÉMO ULTRA RAPIDE Windows - Sans aucune inscription !
# Usage: .\scripts\quick-demo.ps1

Write-Host "⚡ DÉMO RAPIDE - Lightning Arena" -ForegroundColor Cyan
Write-Host "   Aucun token, aucun compte requis !" -ForegroundColor Gray
Write-Host ""

# Vérifier que le serveur local tourne
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3001/api/health" -TimeoutSec 2
} catch {
    Write-Host "🚀 Démarrage du serveur local..." -ForegroundColor Green
    docker-compose -f docker-compose.nwc-only.yml up -d
    Write-Host "⏳ Attente du serveur (15s)..." -ForegroundColor Yellow
    Start-Sleep -Seconds 15
}

Write-Host ""
Write-Host "🔗 Création du tunnel public avec Serveo..." -ForegroundColor Cyan
Write-Host "   (Ctrl+C pour arrêter le tunnel)" -ForegroundColor Gray
Write-Host ""
Write-Host "🌐 Votre URL publique apparaîtra ci-dessous:" -ForegroundColor White
Write-Host "   (Attendez 'Forwarding HTTP traffic from ...')" -ForegroundColor Gray
Write-Host ""
Write-Host "---------------------------------------------------" -ForegroundColor DarkGray

# Tunnel SSH avec Serveo (Windows doit avoir OpenSSH installé)
ssh -R 80:localhost:3001 serveo.net

Write-Host ""
Write-Host "---------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "🛑 Tunnel fermé" -ForegroundColor Red
