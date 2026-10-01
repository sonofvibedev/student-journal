<#
.SYNOPSIS
    Кладёт секреты напоминаний в РАБОЧИЙ проект Supabase (journal-24dmm2).

.DESCRIPTION
    Секреты НЕ хранятся в репозитории. Они лежат в файле рядом с ним:
        C:\Users\dimpo\vapid-journal-prod.local.txt
    Там уже есть VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY и CRON_SECRET.
    Токен рабочего бота нужно дописать туда самому, строкой:
        TELEGRAM_BOT_TOKEN=12345:AA...
    (токен даёт @BotFather; в переписку его отправлять не нужно).

    Скрипт собирает из этого файла временный env-файл, передаёт его
    команде supabase secrets set и сразу удаляет.

    Для тестового стенда есть такой же скрипт set-secrets-test.ps1
    в репозитории student-journal-test — у него свои ключи и свой проект.

.EXAMPLE
    npx supabase login
    .\set-secrets.ps1
#>

param(
    [string]$SecretsFile = "C:\Users\dimpo\vapid-journal-prod.local.txt",
    [string]$ProjectRef = "woiqekpuoddxixlrbvkp",
    [string]$SiteUrl = "https://sonofvibedev.github.io/student-journal"
)

if (-not (Test-Path $SecretsFile)) {
    Write-Error "Файл с секретами не найден: $SecretsFile"
    exit 1
}

# Берём только строки вида КЛЮЧ=значение, комментарии и пустые пропускаем
$pairs = [ordered]@{}
foreach ($line in Get-Content $SecretsFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$') {
        $pairs[$Matches[1]] = $Matches[2]
    }
}

$pairs['SITE_URL'] = $SiteUrl

$required = @('VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'CRON_SECRET')
$missing = $required | Where-Object { -not $pairs.Contains($_) }
if ($missing.Count -gt 0) {
    Write-Error ("В файле не хватает: " + ($missing -join ', '))
    exit 1
}

if (-not $pairs.Contains('TELEGRAM_BOT_TOKEN')) {
    Write-Host "TELEGRAM_BOT_TOKEN в файле нет — напоминания в Telegram работать не будут." -ForegroundColor Yellow
    Write-Host "Допишите в $SecretsFile строку TELEGRAM_BOT_TOKEN=... и запустите скрипт ещё раз." -ForegroundColor Yellow
}

Write-Host "Будут записаны секреты: $($pairs.Keys -join ', ')" -ForegroundColor Cyan
Write-Host "Проект: $ProjectRef (рабочий)" -ForegroundColor Cyan

# Временный env-файл: живёт несколько секунд и удаляется в finally
$tmp = Join-Path $env:TEMP ("supabase-secrets-" + [guid]::NewGuid().ToString('N') + ".env")
try {
    $lines = foreach ($k in $pairs.Keys) { "$k=$($pairs[$k])" }
    [System.IO.File]::WriteAllLines($tmp, $lines, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host "`nЕсли не входили раньше — выполните: npx supabase login" -ForegroundColor DarkGray
    npx --yes supabase@latest link --project-ref $ProjectRef
    if ($LASTEXITCODE -ne 0) { Write-Error "Не удалось связать проект. Сначала: npx supabase login"; exit 1 }

    npx --yes supabase@latest secrets set --env-file $tmp --project-ref $ProjectRef
    if ($LASTEXITCODE -ne 0) { Write-Error "Секреты записать не удалось (см. ошибку выше)."; exit 1 }

    Write-Host "`nГотово. Проверить рассылку вручную:" -ForegroundColor Green
    Write-Host ('  $s = (Select-String -Path "' + $SecretsFile + '" -Pattern "^CRON_SECRET=(.+)$").Matches.Groups[1].Value')
    Write-Host ('  Invoke-RestMethod -Method Post -Uri "https://' + $ProjectRef + '.supabase.co/functions/v1/send-reminders" -Headers @{ "x-cron-secret" = $s } -Body "{}" -ContentType "application/json"')
}
finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
}
