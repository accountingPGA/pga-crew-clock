import express from "express";
import admin from "firebase-admin";
import webpush from "web-push";

const {
  PORT = "8080",
  APP_URL = "https://accountingpga.github.io/pga-crew-clock/",
  APP_ICON_URL = "https://accountingpga.github.io/pga-crew-clock/assets/PINNACLE.png",
  FIREBASE_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "",
  FCM_SERVICE_ACCOUNT_JSON = "",
  PUSH_SENDER_TOKEN,
  PUSH_TTL_SECONDS = "3600",
  VAPID_SUBJECT = "",
  VAPID_PUBLIC_KEY = "",
  VAPID_PRIVATE_KEY = "",
} = process.env;

if (!PUSH_SENDER_TOKEN) {
  throw new Error("Missing required environment variable: PUSH_SENDER_TOKEN");
}

if (VAPID_SUBJECT && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "pga-crew-clock-push-sender",
    delivery: "fcm",
    legacyWebPush: !!(VAPID_SUBJECT && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
  });
});

app.post("/send", async (req, res) => {
  const authorization = req.get("authorization") || "";
  if (authorization !== `Bearer ${PUSH_SENDER_TOKEN}`) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const notification = normalizeNotification(req.body?.notification || {});
  const fcmToken = normalize(req.body?.fcmToken || req.body?.token || req.body?.registrationToken);

  if (fcmToken) {
    await sendFcmNotification(res, fcmToken, notification);
    return;
  }

  await sendLegacyWebPush(res, req.body?.subscription, notification);
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(Number(PORT), () => {
  console.log(`PGA Crew Clock push sender listening on ${PORT}`);
});

async function sendFcmNotification(res, fcmToken, notification) {
  try {
    const messaging = getMessaging();
    const messageId = await messaging.send({
      token: fcmToken,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: {
        title: notification.title,
        body: notification.body,
        url: notification.url,
        tag: notification.tag,
      },
      webpush: {
        headers: {
          TTL: String(Number(PUSH_TTL_SECONDS) || 3600),
          Urgency: "normal",
        },
        notification: {
          title: notification.title,
          body: notification.body,
          icon: APP_ICON_URL,
          badge: APP_ICON_URL,
          tag: notification.tag,
          renotify: false,
        },
        fcmOptions: {
          link: notification.url,
        },
      },
    });

    res.json({ ok: true, statusCode: 200, messageId });
  } catch (error) {
    const statusCode = isUnregisteredFcmToken(error) ? 410 : 500;
    res.status(statusCode === 410 ? 200 : 500).json({
      ok: false,
      statusCode,
      error: safeError(error),
    });
  }
}

async function sendLegacyWebPush(res, subscription, notification) {
  const validationError = validateLegacySubscription(subscription);
  if (validationError) {
    res.status(400).json({ ok: false, error: validationError });
    return;
  }
  if (!(VAPID_SUBJECT && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)) {
    res.status(400).json({ ok: false, error: "Legacy Web Push VAPID secrets are not configured." });
    return;
  }

  const payload = JSON.stringify(notification);
  try {
    const response = await webpush.sendNotification(subscription, payload, {
      TTL: Number(PUSH_TTL_SECONDS),
      urgency: "normal",
      topic: safeTopic(notification.tag),
      contentEncoding: "aes128gcm",
    });
    res.json({
      ok: true,
      statusCode: response.statusCode,
      headers: response.headers || {},
    });
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    res.json({
      ok: false,
      statusCode,
      error: error.body || error.message || "Push delivery failed",
    });
  }
}

function getMessaging() {
  if (!admin.apps.length) {
    if (FCM_SERVICE_ACCOUNT_JSON) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(FCM_SERVICE_ACCOUNT_JSON)),
        projectId: FIREBASE_PROJECT_ID || undefined,
      });
    } else {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: FIREBASE_PROJECT_ID || undefined,
      });
    }
  }
  return admin.messaging();
}

function normalizeNotification(notification) {
  const url = absoluteAppUrl(notification.url || APP_URL);
  return {
    title: normalize(notification.title) || "PGA Crew Clock",
    body: normalize(notification.body) || "Tap to open Crew Clock.",
    url,
    tag: safeTopic(notification.tag || "pga-crew-clock-reminder"),
  };
}

function validateLegacySubscription(subscription) {
  if (!subscription || typeof subscription !== "object") return "Missing push subscription or FCM token.";
  if (!isHttpsUrl(subscription.endpoint)) return "Push endpoint must be HTTPS.";
  if (!subscription.keys || typeof subscription.keys !== "object") return "Missing push keys.";
  if (!subscription.keys.p256dh || !subscription.keys.auth) return "Missing push encryption keys.";
  return "";
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function absoluteAppUrl(value) {
  try {
    return new URL(value, APP_URL).href;
  } catch {
    return APP_URL;
  }
}

function isUnregisteredFcmToken(error) {
  const code = String(error?.code || "");
  return code.includes("registration-token-not-registered") || code.includes("invalid-registration-token");
}

function safeError(error) {
  const text = error?.message || error?.code || "FCM delivery failed";
  return String(text).slice(0, 180);
}

function safeTopic(value) {
  const topic = String(value || "pga-crew-clock")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 32);
  return topic || "pga-crew-clock";
}

function normalize(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}
