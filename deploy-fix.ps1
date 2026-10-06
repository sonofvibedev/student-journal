<#
.SYNOPSIS
    Публикует index.html, data.json, cabinet.html и PWA-файлы (manifest.json, sw.js, icons/) в GitHub Pages.

.DESCRIPTION
    1. Переходит в папку локального репозитория.
    2. Подтягивает актуальную версию (git pull), чтобы не было конфликтов.
    3. Проставляет в index.html и cabinet.html дату и время этого деплоя (константа
       APP_VERSION_DATE в changelog.js — её показывает окно "Что нового").
    4. Добавляет index.html, data.json, cabinet.html, manifest.json, sw.js и папку icons
       (те, что реально есть в папке) в индекс git.
    5. Делает коммит (если есть изменения) и отправляет его на GitHub (git push).
    После пуша GitHub Pages обычно обновляется в течение 1-2 минут.

.PARAMETER RepoPath
    Путь к папке с локальной копией репозитория (там, где лежит index.html).
    По умолчанию — текущая папка, из которой запущен скрипт.

.EXAMPLE
    .\deploy-fix.ps1 -RepoPath "C:\Users\dimpo\student-journal"
#>

param(
    [string]$RepoPath = (Get-Location).Path,
    [string]$CommitMessage = "Update: адаптивная вёрстка под мобильные устройства, обновлены студенты и предметы"
)

if (-not (Test-Path $RepoPath)) {
    Write-Error "Папка не найдена: $RepoPath"
    exit 1
}

Set-Location $RepoPath
Write-Host "Репозиторий: $RepoPath" -ForegroundColor Cyan

$indexPath = Join-Path $RepoPath "index.html"
if (-not (Test-Path $indexPath)) {
    Write-Error "В этой папке нет index.html. Сначала скопируйте сюда исправленный файл."
    exit 1
}

# Подтягиваем актуальную версию репозитория
# --no-edit       — не открывать редактор для сообщения merge-коммита
# --no-rebase     — явно использовать слияние (merge), а не rebase, чтобы Git не
#                   останавливался с ошибкой "Need to specify how to reconcile divergent branches"
git pull --no-edit --no-rebase
if ($LASTEXITCODE -ne 0) {
    Write-Error "git pull не смог обновить локальную копию (см. текст ошибки выше). Push отменён, чтобы не потерять изменения. Обычно помогает разрешить конфликт вручную и запустить скрипт ещё раз."
    exit 1
}

# Проставляем в index.html и cabinet.html реальный момент этого деплоя (константа
# APP_VERSION_DATE в changelog.js, которую показывает окно "Что нового") — руками её обновлять не нужно.
# Используем .NET напрямую (а не Get-Content/Set-Content), чтобы гарантированно сохранить
# UTF-8 с BOM и не сломать кириллицу, как уже бывало раньше с этими файлами.
$deployTimestamp = Get-Date -Format "dd.MM.yyyy, HH:mm"
$utf8WithBom = New-Object System.Text.UTF8Encoding($true)
$changelogPath = Join-Path $RepoPath "changelog.js"
if (Test-Path $changelogPath) {
    $content = [System.IO.File]::ReadAllText($changelogPath, [System.Text.Encoding]::UTF8)
    $updated = [System.Text.RegularExpressions.Regex]::Replace(
        $content, "const APP_VERSION_DATE = '[^']*';", "const APP_VERSION_DATE = '$deployTimestamp';"
    )
    if ($updated -ne $content) {
        [System.IO.File]::WriteAllText($changelogPath, $updated, $utf8WithBom)
        Write-Host "Дата обновления в changelog.js проставлена: $deployTimestamp" -ForegroundColor Cyan
    }
}

# Список учебных дней собирается из schedule.js: по нему считаются серии
# в достижениях. Пересобираем перед каждым деплоем, чтобы правка расписания
# не разъехалась со study-days.json.
if (Test-Path (Join-Path $RepoPath "tools\build-study-days.js")) {
    node tools/build-study-days.js
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Не удалось собрать study-days.json. Публикация отменена."
        exit 1
    }
}

# Добавляем изменённые файлы (каждый — только если реально есть в папке)
git add index.html
foreach ($name in @("data.json", "study-days.json", "cabinet.html", "pass.html", "app.css", "profile.css", "env.js", "theme.js", "changelog.js", "shared.js", "profile.js", "studak.js", "schedule.js", "notify.js", "achievements.js", "achievements.css", "manifest.json", "sw.js", "icons", "fonts")) {    $p = Join-Path $RepoPath $name
    if (Test-Path $p) {
        git add $name
    }
}

# Проверяем, есть ли что коммитить
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Host "Изменений нет — файлы в репозитории уже совпадают с локальными." -ForegroundColor Yellow
    exit 0
}

git commit -m $CommitMessage

git push
if ($LASTEXITCODE -ne 0) {
    Write-Host "Push отклонён — на GitHub появились изменения уже после pull. Пробую ещё раз автоматически..." -ForegroundColor Yellow
    git pull --no-edit --no-rebase
    git push
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Push всё ещё не проходит. Скопируйте текст ошибки выше и пришлите его — разберём вручную."
        exit 1
    }
}

Write-Host "Готово! Изменения отправлены на GitHub. Через 1-2 минуты сайт (и Telegram Mini App) обновится." -ForegroundColor Green
