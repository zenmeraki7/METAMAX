import "./env.js";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client;

function storageConfig() {
  const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`Configure Cloudflare R2 in web/.env: ${missing.join(", ")}`);
  }
  return {
    bucket: process.env.R2_BUCKET,
    endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  };
}

function storageClient() {
  const { endpoint } = storageConfig();
  client ??= new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 10000, requestTimeout: 30000 },
  });
  return client;
}

export async function checkStorage() {
  await storageClient().send(new HeadBucketCommand({ Bucket: storageConfig().bucket }));
}

export async function uploadObject(key, body, contentType = "application/octet-stream") {
  await storageClient().send(new PutObjectCommand({
    Bucket: storageConfig().bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    StorageClass: "STANDARD",
  }));
  return { key };
}

export async function downloadObject(key) {
  return storageClient().send(new GetObjectCommand({ Bucket: storageConfig().bucket, Key: key }));
}

export async function deleteObject(key) {
  await storageClient().send(new DeleteObjectCommand({ Bucket: storageConfig().bucket, Key: key }));
}

export async function signedDownloadUrl(key, expiresIn = 900) {
  return getSignedUrl(
    storageClient(),
    new GetObjectCommand({ Bucket: storageConfig().bucket, Key: key }),
    { expiresIn },
  );
}

export function closeStorage() {
  client?.destroy();
  client = undefined;
}
