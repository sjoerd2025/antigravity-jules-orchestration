# FINAL DEPLOYMENT INSTRUCTIONS

**Current State:**
- Code pushed to GitHub: `Scarmonit/antigravity-jules-orchestration`
- Render Service: Created (`srv-d4mmhh6uk2gs7393u580`)
- Recent Fixes: Added `google-auth-library`, removed Redis dependency, updated Dockerfile.

## 🚀 CRITICAL NEXT STEP: GOOGLE AUTH

The system requires a Google Service Account to authenticate with Jules API.

1.  **Create Service Account Key**:
    - Go to [Google Cloud Console](https://console.cloud.google.com/iam-admin/serviceaccounts).
    - Select project `jules-orchestrator` (or create it).
    - Create Service Account -> Keys -> Add Key -> JSON.
    - Download the file (e.g., `jules-orchestrator-key.json`).

2.  **Update Render Environment**:
    - Go to [Render Dashboard](https://dashboard.render.com/web/srv-d4mmhh6uk2gs7393u580/env).
    - **Delete** `JULES_API_KEY` if present.
    - **Add** `GOOGLE_APPLICATION_CREDENTIALS_JSON`.
    - **Value**: Paste the *entire content* of the JSON key file.

## Verify Live System

Once deployed (watch the Events tab), verify:

```bash
curl https://jules-orchestrator.onrender.com/api/v1/health
```

Expected output:
```json
{
  "status": "ok",
  "version": "1.2.0",
  "services": {
    "julesApi": "configured",
    ...
  }
}
```

## Local Testing (Optional)

Run the updated test script against the live URL:

```bash
bash scripts/test-live-mcp.sh
```
