# PowerShell script for Windows
# Usage: .\scripts\start-ngrok.ps1 YOUR_NGROK_TOKEN

param(
    [string]$Token = $env:NGROK_AUTHTOKEN
)

if (-not $Token) {
    Write-Host "❌ ERREUR: Token ngrok manquant" -ForegroundColor Red
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  .\scripts\start-ngrok.ps1 YOUR_TOKEN"
    Write-Host ""
    Write-Host "Ou définissez la variable d'environnement:"
    Write-Host "  `$env:NGROK_AUTHTOKEN = 'your_token'"
    Write-Host "  .\scripts\start-ngrok.ps1"
    Write-Host ""
    Write-Host "Obtenez votre token: https://dashboard.ngrok.com/get-started/your-authtoken"
    exit 1
}

Write-Host "🚀 Démarrage de Lightning Arena avec ngrok..." -ForegroundColor Green

$env:NGROK_AUTHTOKEN = $Token

docker-compose -f docker-compose.ngrok.yml up -d

Write-Host ""
Write-Host "⏳ Attente du démarrage..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

try {
    $response = Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" -TimeoutSec 5
    $publicUrl = $response.tunnels[0].public_url
    
    if ($publicUrl) {
        Write-Host ""
        Write-Host "✅ LIGHTNING ARENA EST EN LIGNE !" -ForegroundColor Green
        Write-Host ""
        Write-Host "🌐 URL Publique: $publicUrl" -ForegroundColor Cyan
        Write-Host "📊 Dashboard ngrok: http://localhost:4040" -ForegroundColor Gray
        Write-Host ""
        Write-Host "Partagez cette URL avec vos amis pour jouer !"
        Write-Host ""
        Write-Host "Pour arrêter: docker-compose -f docker-compose.ngrok.yml down"
    }
} catch {
    Write-Host ""
    Write-Host "⚠️  Ngrok démarre encore..." -ForegroundColor Yellow
    Write-Host "📊 Vérifiez le dashboard: http://localhost:4040"
    Write-Host ""
    Write-Host "Logs: docker-compose -f docker-compose.ngrok.yml logs -f ngrok"
}
