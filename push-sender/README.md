# PGA Crew Clock Push Sender

This Cloud Run service is the secure notification sender for PGA Crew Clock. Apps Script decides who should be notified, then calls `POST /send`; this service validates the shared sender token and delivers the notification through Firebase Cloud Messaging.

## Required Configuration

- `PUSH_SENDER_TOKEN`: Secret Manager value shared only with Apps Script.
- `FIREBASE_PROJECT_ID`: Firebase/GCP project ID for PGA Crew Clock Push.
- `APP_URL`: production GitHub Pages URL, normally `https://accountingpga.github.io/pga-crew-clock/`.
- `APP_ICON_URL`: notification icon URL.
- `PUSH_TTL_SECONDS`: optional, defaults to `3600`.

Use Cloud Run's runtime service account with Application Default Credentials for FCM. A Firebase service account JSON key is not required. If a JSON key is used anyway, store it in Secret Manager as `FCM_SERVICE_ACCOUNT_JSON`; never commit it.

## Optional Legacy Web Push Fallback

The service still supports the old encrypted Web Push payload shape while devices transition to FCM tokens. To keep that fallback enabled, set:

- `VAPID_SUBJECT`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`

`VAPID_PRIVATE_KEY` must remain in Secret Manager only.

## Endpoints

- `GET /health`: health check.
- `POST /send`: authenticated sender endpoint called by `CrewClockBackend.gs`.

FCM request shape:

```json
{
  "fcmToken": "device-fcm-registration-token",
  "notification": {
    "title": "PGA Crew Clock",
    "body": "⏰ Don't forget to clock in.",
    "url": "./index.html",
    "tag": "pga-worker-date-time"
  }
}
```

Legacy fallback request shape:

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
    "body": "Tap to open Crew Clock.",
    "url": "./index.html",
    "tag": "pga-worker-date-time"
  }
}
```

## Deploy

From this folder:

```bash
gcloud run deploy pga-crew-clock-push-sender \
  --source . \
  --region northamerica-northeast1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID="$PROJECT_ID",APP_URL=https://accountingpga.github.io/pga-crew-clock/,APP_ICON_URL=https://accountingpga.github.io/pga-crew-clock/assets/PINNACLE.png,PUSH_TTL_SECONDS=3600 \
  --set-secrets PUSH_SENDER_TOKEN=pga-crew-clock-push-sender-token:latest
```

After deployment, set the Apps Script property `PUSH_SENDER_URL` to:

```text
https://YOUR-CLOUD-RUN-SERVICE-URL/send
```
