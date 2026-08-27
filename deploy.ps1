# Script de automação de commit e deploy para GitHub & Render
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "🚀 Iniciando Deploy Automático (GitHub -> Render)" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Cyan

git add .
$msg = Read-Host "Digite a mensagem do commit (pressione Enter para padrão)"
if ([string]::IsNullOrWhiteSpace($msg)) {
    $msg = "auto: atualização do ambiente de homologação"
}

git commit -m "$msg"
git push origin main

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "✅ Alterações enviadas com sucesso!" -ForegroundColor Green
Write-Host "⚡ O Render irá compilar e atualizar automaticamente em instantes." -ForegroundColor Yellow
Write-Host "==================================================" -ForegroundColor Cyan
