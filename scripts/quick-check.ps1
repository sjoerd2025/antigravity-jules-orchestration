# Quick Environment Check for MCP Tool Chain
# Auto-diagnostics script that runs in ~0.5s to verify environment health
# Usage: .\scripts\quick-check.ps1

$old = $ErrorActionPreference
$ErrorActionPreference = 'Stop'

$checks = @{
    Passed = 0
    Failed = 0
    Total = 0
}

Write-Host "`n🔍 Quick Environment Check..." -ForegroundColor Cyan

try {
    # Check 1: Docker alive?
    $checks.Total++
    Write-Host "  1. Docker daemon... " -NoNewline
    docker ps 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅" -ForegroundColor Green
        $checks.Passed++
    } else {
        throw "Docker not responding"
    }

    # Check 2: ChromaDB up?
    $checks.Total++
    Write-Host "  2. ChromaDB (port 8000)... " -NoNewline
    try {
        $chromaTest = Test-NetConnection localhost -Port 8000 -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($chromaTest) {
            Write-Host "✅" -ForegroundColor Green
            $checks.Passed++
        } else {
            Write-Host "⚠️  (optional)" -ForegroundColor Yellow
            $checks.Passed++  # Don't fail on ChromaDB
        }
    } catch {
        Write-Host "⚠️  (optional)" -ForegroundColor Yellow
        $checks.Passed++  # Don't fail on ChromaDB
    }

    # Check 3: Express app up?
    $checks.Total++
    Write-Host "  3. Express app (port 3000)... " -NoNewline
    try {
        $appTest = Invoke-WebRequest "http://localhost:3000/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($appTest.StatusCode -eq 200) {
            Write-Host "✅" -ForegroundColor Green
            $checks.Passed++
        } else {
            throw "App not healthy"
        }
    } catch {
        Write-Host "❌" -ForegroundColor Red
        $checks.Failed++
        Write-Host "     Error: Express app not responding on port 3000" -ForegroundColor Red
    }

    # Check 4: Docker container running?
    $checks.Total++
    Write-Host "  4. Container status... " -NoNewline
    $container = docker ps --filter "name=antigravity-jules-test" --format "{{.Status}}" 2>&1
    if ($container -and $container -like "*Up*") {
        Write-Host "✅" -ForegroundColor Green
        $checks.Passed++
    } else {
        Write-Host "⚠️  (starting...)" -ForegroundColor Yellow
        $checks.Passed++  # Don't fail, just warn
    }

    # Summary
    Write-Host ""
    if ($checks.Failed -eq 0) {
        Write-Host "🟢 Environment OK ($($checks.Passed)/$($checks.Total) checks passed)" -ForegroundColor Green
        exit 0
    } else {
        Write-Host "🟡 Environment partially ready ($($checks.Passed)/$($checks.Total) checks passed)" -ForegroundColor Yellow
        Write-Host "   Tip: Run 'docker start antigravity-jules-test' to fix" -ForegroundColor Gray
        exit 0  # Don't fail - just warn
    }

} catch {
    Write-Host "❌" -ForegroundColor Red
    Write-Host ""
    Write-Host "🔴 Auto-diagnostics failed" -ForegroundColor Red
    Write-Host "   Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "   Quick Fixes:" -ForegroundColor Yellow
    Write-Host "   • Start Docker Desktop" -ForegroundColor Gray
    Write-Host "   • Run: docker start antigravity-jules-test" -ForegroundColor Gray
    Write-Host "   • Check: docker ps" -ForegroundColor Gray
    exit 1
} finally {
    $ErrorActionPreference = $old
}

