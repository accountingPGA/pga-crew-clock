import crypto from "crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});

const publicJwk = publicKey.export({ format: "jwk" });
const privateJwk = privateKey.export({ format: "jwk" });

const publicBuffer = Buffer.concat([
  Buffer.from([4]),
  base64UrlToBuffer(publicJwk.x),
  base64UrlToBuffer(publicJwk.y),
]);

console.log(JSON.stringify({
  publicKey: publicBuffer.toString("base64url"),
  privateKey: privateJwk.d,
}, null, 2));

function base64UrlToBuffer(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64 + "=".repeat((4 - base64.length % 4) % 4), "base64");
}
