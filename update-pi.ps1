param(
    [string]$OutDir = "$HOME\apps\pi",
    [switch]$SkipPull
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Set-Location $RepoRoot

if (-not $SkipPull) {
    Write-Host "==> Pulling upstream..." -ForegroundColor Cyan
    git pull upstream main
    Write-Host "==> Syncing fork..." -ForegroundColor Cyan
    git push origin main
}

Write-Host "==> Building all packages..." -ForegroundColor Cyan
npm run build

Write-Host "==> Compiling binary..." -ForegroundColor Cyan
Set-Location "$RepoRoot\packages\coding-agent"

bun build --compile --target=bun-windows-x64 ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OutDir\pi.exe"

Write-Host "==> Copying assets..." -ForegroundColor Cyan
$null = New-Item -ItemType Directory -Path "$OutDir\theme", "$OutDir\assets", "$OutDir\export-html", "$OutDir\docs", "$OutDir\examples", "$OutDir\node_modules\@mariozechner", "$OutDir\native\win32\prebuilds\win32-x64" -Force

Copy-Item "$RepoRoot\packages\coding-agent\dist\modes\interactive\theme\*.json" "$OutDir\theme\"
Copy-Item "$RepoRoot\packages\coding-agent\dist\modes\interactive\assets\*.png" "$OutDir\assets\"
Copy-Item "$RepoRoot\packages\coding-agent\dist\core\export-html\*" "$OutDir\export-html\" -Recurse
Copy-Item "$RepoRoot\packages\coding-agent\docs\*" "$OutDir\docs\" -Recurse
Copy-Item "$RepoRoot\packages\coding-agent\examples\*" "$OutDir\examples\" -Recurse
Copy-Item "$RepoRoot\node_modules\@silvia-odwyer\photon-node\photon_rs_bg.wasm" "$OutDir\"

Copy-Item "$RepoRoot\node_modules\@mariozechner\clipboard\*" "$OutDir\node_modules\@mariozechner\clipboard\" -Recurse
Copy-Item "$RepoRoot\node_modules\@mariozechner\clipboard-win32-x64-msvc\*" "$OutDir\node_modules\@mariozechner\clipboard-win32-x64-msvc\" -Recurse
Copy-Item "$RepoRoot\packages\tui\native\win32\prebuilds\win32-x64\win32-console-mode.node" "$OutDir\native\win32\prebuilds\win32-x64\"

Write-Host "pi updated: $OutDir\pi.exe ($((Get-Item "$OutDir\pi.exe").Length / 1MB) MB)" -ForegroundColor Green
