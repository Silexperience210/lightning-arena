# PowerShell script pour LocalTunnel
# Usage: .\scripts\start-localtunnel.ps1

Write-Host "🚀 Démarrage de Lightning Arena avec LocalTunnel..." -ForegroundColor Green
Write-Host "   (Aucun token nécessaire !)" -ForegroundColor Gray
Write-Host ""

docker-compose -f docker-compose.localtunnel.yml up -d

Write-Host ""
Write-Host "⏳ Attente du démarrage..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

Write-Host ""
Write-Host "📊 Récupération de l'URL publique..." -ForegroundColor Cyan
Write-Host ""

docker-compose -f docker-compose.localtunnel.yml logs localtunnel | Select-Object -Last 20

Write-Host ""
Write-Host "✅ Lightning Arena démarré !" -ForegroundColor Green
Write-Host ""
Write-Host "💡 L'URL sera affichée dans les logs ci-dessus (chercher 'url:')" -ForegroundColor Gray
Write-Host ""
Write-Host "Pour voir l'URL en temps réel:" -ForegroundColor White
Write-Host "  docker-compose -f docker-compose.localtunnel.yml logs -f localtunnel"
Write-Host ""
Write-Host "Pour arrêter:" -ForegroundColor White
Write-Host "  docker-compose -f docker-compose.localtunnel.yml down"
