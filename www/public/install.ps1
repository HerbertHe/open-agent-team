# powershell -c "irm https://oat.ibert.me/install.ps1 | iex"
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  🚀 Open Agent Team Installer" -ForegroundColor Cyan
Write-Host "  Declarative multi-agent orchestration." -ForegroundColor DarkGray
Write-Host ""

# 1. Detect OS
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Host "[✗] Error: PowerShell 5+ required" -ForegroundColor Red
    exit 1
}
Write-Host "[✓] Windows detected" -ForegroundColor Green

# 2. Check Node.js
$nodeVersion = (node -v 2>$null)
if (-not $nodeVersion) {
    Write-Host "[✗] Node.js not found." -ForegroundColor Red
    Write-Host "Please install Node.js 22+ manually: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

$versionMatch = $nodeVersion -match '^v(\d+)\.'
if ($versionMatch) {
    $version = [int]$matches[1]
    if ($version -lt 22) {
        Write-Host "[✗] Node.js $nodeVersion found, but v22+ required" -ForegroundColor Red
        Write-Host "Please upgrade Node.js and try again." -ForegroundColor Yellow
        exit 1
    }
}
Write-Host "[✓] Node.js $nodeVersion found" -ForegroundColor Green

# 3. Install open-agent-team
Write-Host "[·] Installing open-agent-team globally via npm..." -ForegroundColor Gray
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    Write-Host "[✗] npm not found. Please ensure npm is installed." -ForegroundColor Red
    exit 1
}

try {
    & npm install -g open-agent-team@latest --silent
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[✗] npm install failed." -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[✗] npm install failed: $_" -ForegroundColor Red
    exit 1
}
Write-Host "[✓] Open Agent Team installed globally" -ForegroundColor Green

# 4. Check PATH and finish
$oatCmd = Get-Command oat -ErrorAction SilentlyContinue
if (-not $oatCmd) {
    Write-Host "[!] 'oat' command not found on PATH." -ForegroundColor Yellow
    Write-Host "Please restart PowerShell or add your npm global folder to PATH." -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "Open Agent Team is ready to use!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Quick start:" -ForegroundColor Gray
    Write-Host "  oat init    # Initialize team.json in current directory" -ForegroundColor Cyan
    Write-Host "  oat start   # Start the orchestrator" -ForegroundColor Cyan
    Write-Host ""
}
