# Jules API Authentication Setup

The Jules API requires Google OAuth 2.0 authentication via a Service Account for server-side operations. This guide explains how to set up the credentials.

## 1. Create a Google Cloud Project
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., `jules-orchestrator`).
3. Enable the **Jules API** (if available in the library) or ensure you have access to the specific Google API endpoint `jules.googleapis.com`.

## 2. Create a Service Account
1. Navigate to **IAM & Admin** > **Service Accounts**.
2. Click **Create Service Account**.
3. Name it `jules-agent`.
4. Grant it the necessary roles (e.g., **Editor** or specific Jules roles if defined).
5. Click **Done**.

## 3. Generate JSON Key
1. Click on the newly created service account email.
2. Go to the **Keys** tab.
3. Click **Add Key** > **Create new key**.
4. Select **JSON** and download the file.

## 4. Configure Render
1. Open your downloaded JSON key file and copy the entire content.
2. Go to your Render Service Dashboard.
3. Environment Variables:
   - **Remove** `JULES_API_KEY` if it exists.
   - **Add** `GOOGLE_APPLICATION_CREDENTIALS_JSON`.
   - **Value**: Paste the full JSON content of your key file.

## 5. Local Development
1. Save the JSON key as `service-account.json` in the root (gitignored).
2. Set `GOOGLE_APPLICATION_CREDENTIALS_JSON` in your `.env` file or directly point to the file path if running locally with standard Google libraries (though the code is set up to parse the JSON string from the env var).

## Code Implementation
The `orchestrator-api` uses `google-auth-library` to automatically handle token generation and refreshing using these credentials.
