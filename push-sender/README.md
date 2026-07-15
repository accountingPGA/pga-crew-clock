# PGA Crew Clock Push Sender

This service sends encrypted Web Push notifications for PGA Crew Clock. It is intended to run on Google Cloud Run.

## Required Secrets

- `VAPID_PRIVATE_KEY`: private Web Push VAPID key. Never commit this.
- `PUSH_SENDER_TOKEN`: shared bearer token used by Apps Script when calling `/send`. Never commit this.

To rotate the VAPID key pair later, run:

```bash
node generate-vapid.js
```

Then update the frontend public key and the Cloud Run private-key secret together.

## Public Configuration

- `VAPID_PUBLIC_KEY`: safe for the frontend. This must match `window.CREW_CLOCK_CONFIG.vapidPublicKey` in `index.html`.
- `VAPID_SUBJECT`: contact subject for VAPID, usually the production app URL or a `mailto:` address.

## Endpoints

- `GET /health`: health check.
- `POST /send`: authenticated sender endpoint called by `CrewClockBackend.gs`.

`POST /send` expects:

```json
{
  "subscription": {
    "endpoint": "https://...",
    "keys": {
      "p256dh": "...",
      "auth": "..."
    }
  },
  "notification": {
    "title": "PGA Crew Clock",
    "body": "⏰ Don't forget to clock in.",
    "url": "./index.html",
    "tag": "pga-worker-date-time"
  }
}
```

## Cloud Run Deployment

Use a Google Cloud project with Cloud Run, Cloud Build, Artifact Registry, and Secret Manager enabled. The Cloud Run runtime service account only needs permission to read the two secrets if you mount them through Secret Manager.

1. Create two local files outside the repository:

   - `vapid-private-key.txt`
   - `push-sender-token.txt`

2. Create Secret Manager secrets:

   ```bash
   gcloud secrets create pga-crew-clock-vapid-private-key --data-file=vapid-private-key.txt
   gcloud secrets create pga-crew-clock-push-sender-token --data-file=push-sender-token.txt
   ```

3. Deploy:

   ```bash
   gcloud run deploy pga-crew-clock-push-sender \
     --source . \
     --region northamerica-northeast1 \
     --allow-unauthenticated \
     --set-env-vars VAPID_SUBJECT=https://accountingpga.github.io/pga-crew-clock/,VAPID_PUBLIC_KEY=BD-c7u13VWKTjGRJabSz6NfuBGEhaQm5pbjAjQ13XEyzqDqS3Pr9eIApZ2pD4ahXqI12OWzjhScdbuRaspG93eU,PUSH_TTL_SECONDS=3600 \
     --set-secrets VAPID_PRIVATE_KEY=pga-crew-clock-vapid-private-key:latest,PUSH_SENDER_TOKEN=pga-crew-clock-push-sender-token:latest
   ```

4. Copy the Cloud Run service URL. The Apps Script property `PUSH_SENDER_URL` must be:

   ```text
   https://YOUR-CLOUD-RUN-URL/send
   ```

5. Set the Apps Script property `PUSH_SENDER_TOKEN` to the same value from `push-sender-token.txt`.

6. Redeploy the existing Apps Script Web App as a new version while keeping the same Web App URL.

7. Run `installCrewClockReminderTrigger()` once in Apps Script.
