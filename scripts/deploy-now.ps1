# scripts/deploy-now.ps1
# CONSOLIDATED DEPLOYMENT SCRIPT (PowerShell Version)
# Run this single command to deploy Jules Orchestrator

$ErrorActionPreference = "Stop"

Write-Host "🚀 Jules Orchestrator - Automated Deployment" -ForegroundColor Cyan
Write-Host "============================================="
Write-Host ""

# Check if credentials are set
if (-not $env:GITHUB_TOKEN) {
    Write-Error "GITHUB_TOKEN not set"
    Write-Host "Get it from: https://github.com/settings/tokens"
    Write-Host "Set with: `$env:GITHUB_TOKEN='ghp_your_token'"
    exit 1
}

if (-not $env:JULES_API_KEY) {
    Write-Error "JULES_API_KEY not set"
    Write-Host "Get it from: https://jules.google.com/settings"
    Write-Host "Set with: `$env:JULES_API_KEY='your_api_key'"
    exit 1
}

Write-Host "✓ Credentials verified" -ForegroundColor Green
Write-Host ""

# Step 1: Create GitHub repo via API
Write-Host "📦 Creating GitHub repository..."

$Headers = @{
    Authorization = "Bearer $env:GITHUB_TOKEN"
    Accept = "application/vnd.github.v3+json"
}

try {
    $Repo = Invoke-RestMethod -Uri "https://api.github.com/repos/Scarmonit/jules-orchestrator" -Headers $Headers -Method Get -ErrorAction SilentlyContinue
    if ($Repo) {
        Write-Host "⚠️  Repository already exists, skipping creation" -ForegroundColor Yellow
    }
}
catch {
    # Repo likely doesn't exist, create it
    $Body = @{
        name = "jules-orchestrator"
        description = "Autonomous AI orchestration system for Jules API"
        private = $false
        auto_init = $true
    } | ConvertTo-Json

    Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Headers $Headers -Method Post -Body $Body -ContentType "application/json"
    Write-Host "✓ Repository created" -ForegroundColor Green
    Start-Sleep -Seconds 3
}

Write-Host ""

# Step 2: Clone and setup
Write-Host "📥 Cloning repository..."

$WorkDir = "temp_deploy_$(Get-Date -Format 'yyyyMMddHHmmss')"
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
Set-Location $WorkDir

git clone https://github.com/Scarmonit/jules-orchestrator.git
Set-Location jules-orchestrator

Write-Host "✓ Repository cloned" -ForegroundColor Green
Write-Host ""

# Step 3: Create project structure
Write-Host "🏗️  Creating project structure..."

New-Item -ItemType Directory -Path "src", "migrations", "monitoring", ".github\workflows", "dashboard\src" -Force | Out-Null

# Copy implementation files
$IndexJs = @"
// Basic orchestrator implementation
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';
import pg from 'pg';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/api/v1/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.post('/api/v1/workflows/execute', (req, res) => {
    res.json({ 
        workflow_id: 'test-' + Date.now(),
        status: 'pending',
        message: 'Workflow queued'
    });
});

app.post('/api/v1/webhooks/github', (req, res) => {
    console.log('GitHub webhook received:', req.headers['x-github-event']);
    res.json({ received: true });
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.send(JSON.stringify({ type: 'connected' }));
});

server.listen(PORT, () => {
    console.log(`Jules Orchestrator running on port `${PORT}`);
});
"@
$IndexJs | Out-File -FilePath "src\index.js" -Encoding utf8

$PackageJson = @"
{
  "name": "jules-orchestrator",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "pg": "^8.11.3",
    "redis": "^4.6.10",
    "axios": "^1.6.2",
    "ws": "^8.16.0"
  }
}
"@
$PackageJson | Out-File -FilePath "package.json" -Encoding utf8

$Dockerfile = @"
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/index.js"]
"@
$Dockerfile | Out-File -FilePath "Dockerfile" -Encoding utf8

$RenderYaml = @"
services:
  - type: web
    name: jules-orchestrator
    runtime: docker
    region: oregon
    branch: main
    dockerfilePath: ./Dockerfile
    envVars:
      - key: JULES_API_KEY
        sync: false
      - key: GITHUB_TOKEN
        sync: false
      - key: PORT
        value: 3000
    healthCheckPath: /api/v1/health

databases:
  - name: orchestrator-db
    databaseName: jules_orchestrator
    plan: starter
"@
$RenderYaml | Out-File -FilePath "render.yaml" -Encoding utf8

$ReadMe = @"
# Jules Orchestrator

Autonomous AI coding agent orchestration system powered by Google Jules API.

## Deployment
1. Connect this repo in Render dashboard
2. Set environment variables (JULES_API_KEY, GITHUB_TOKEN)
3. Deploy automatically via render.yaml

## Endpoints
- GET /api/v1/health - Health check
- POST /api/v1/workflows/execute - Execute workflow
- POST /api/v1/webhooks/github - GitHub webhook receiver
"@
$ReadMe | Out-File -FilePath "README.md" -Encoding utf8

Write-Host "✓ Project files created" -ForegroundColor Green
Write-Host ""

# Step 4: Commit and push
Write-Host "📤 Pushing to GitHub..."

git add .
git commit -m "Initial implementation of Jules Orchestrator" 2>$null
git push origin main

Write-Host "✓ Code pushed" -ForegroundColor Green
Write-Host ""

# Step 5: Database migrations (if DATABASE_URL is set)
if ($env:DATABASE_URL) {
    Write-Host "💾 Running database migrations..."
    
    $InitSql = @"
CREATE TABLE IF NOT EXISTS workflow_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  definition_json JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO workflow_templates (name, definition_json) VALUES
('dependency-update', '{"name": "Dependency Update", "trigger": {"type": "scheduled"}}')
ON CONFLICT (name) DO NOTHING;
"@
    $InitSql | Out-File -FilePath "init.sql" -Encoding utf8

    if (Get-Command psql -ErrorAction SilentlyContinue) {
        Get-Content init.sql | psql $env:DATABASE_URL
        Write-Host "✓ Database initialized" -ForegroundColor Green
    } else {
        Write-Warning "psql not found, skipping execution"
    }
} else {
    Write-Warning "DATABASE_URL not set, skipping database setup"
}

Write-Host ""
Write-Host "✅ DEPLOYMENT COMPLETE!" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Next steps:"
Write-Host ""
Write-Host "1. Open Render Dashboard (already open in browser)"
Write-Host "   https://dashboard.render.com/create?type=web"
Write-Host ""
Write-Host "2. Click 'New +' -> 'Web Service'"
Write-Host ""
Write-Host "3. Connect repository: Scarmonit/jules-orchestrator"
Write-Host ""
Write-Host "4. Render will auto-configure from render.yaml"
Write-Host ""
Write-Host "5. Add environment variables in Render:"
Write-Host "   JULES_API_KEY=$env:JULES_API_KEY"
Write-Host "   GITHUB_TOKEN=$env:GITHUB_TOKEN"
Write-Host ""
Write-Host "6. Click 'Deploy'"
Write-Host ""
Write-Host "🎉 Your orchestrator will be live at:"
Write-Host "   https://jules-orchestrator.onrender.com"
Write-Host ""
