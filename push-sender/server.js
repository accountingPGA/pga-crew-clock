import express from "express";
import webpush from "web-push";

const {
  PORT = "8080",
  VAPID_SUBJECT,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  PUSH_SENDER_TOKEN,
  PUSH_TTL_SECONDS = "3600",
} = process.env;

const required = {
  VAPID_SUBJECT,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  PUSH_SENDER_TOKEN,
};

const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "pga-crew-clock-push-sender" });
});

app.post("/send", async (req, res) => {
  const authorization = req.get("authorization") || "";
  if (authorization !== `Bearer ${PUSH_SENDER_TOKEN}`) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const subscription = req.body?.subscription;
  const notification = req.body?.notification || {};
  const validationError = validateSubscription(subscription);
  if (validationError) {
    res.status(400).json({ ok: false, error: validationError });
    return;
  }

  const payload = JSON.stringify({
    title: notification.title || "PGA Crew Clock",
    body: notification.body || "Tap to open Crew Clock.",
    url: notification.url || "./index.html",
    tag: notification.tag || "pga-crew-clock-reminder",
  });

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
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(Number(PORT), () => {
  console.log(`PGA Crew Clock push sender listening on ${PORT}`);
});

function validateSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") return "Missing push subscription.";
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

function safeTopic(value) {
  const topic = String(value || "pga-crew-clock")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 32);
  return topic || "pga-crew-clock";
}
