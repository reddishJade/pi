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

# Ensure generated model files exist before building
# (generate-models.ts deletes them on start, but may fail to recreate if offline)
Write-Host "==> Restoring model files from git (if missing)..." -ForegroundColor Cyan
git checkout HEAD -- packages/ai/src/providers/*.models.ts 2>$null
git checkout HEAD -- packages/ai/src/models.generated.ts 2>$null

# Build packages in dependency order, handling ai model gen failures gracefully
Write-Host "==> Building packages..." -ForegroundColor Cyan
$packages = @(
    @{Name="tui"; Path="packages/tui"},
    @{Name="ai"; Path="packages/ai"},
    @{Name="agent"; Path="packages/agent-core"},
    @{Name="coding-agent"; Path="packages/coding-agent"},
    @{Name="orchestrator"; Path="packages/orchestrator"}
)

foreach ($pkg in $packages) {
    Write-Host "  Building $($pkg.Name)..." -ForegroundColor Yellow
    Set-Location "$RepoRoot/$($pkg.Path)"
    npm run build 2>&1
    if ($LASTEXITCODE -ne 0) {
        if ($pkg.Name -eq "ai") {
            # Retry: restore model files and rebuild without model regeneration
            Write-Host "  AI build failed (likely network). Restoring model files and retrying..." -ForegroundColor Yellow
            Set-Location $RepoRoot
            git checkout HEAD -- packages/ai/src/providers/*.models.ts packages/ai/src/models.generated.ts
            Set-Location "$RepoRoot/packages/ai"
            npm run generate-image-models
            tsgo -p tsconfig.build.json
            if ($LASTEXITCODE -ne 0) { throw "Failed to build ai package" }
        } else {
            throw "Failed to build $($pkg.Name)"
        }
    }
}

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
