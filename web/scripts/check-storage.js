import assert from "node:assert/strict";
import { checkStorage, uploadObject, downloadObject, deleteObject, closeStorage } from "../storage.js";

const key = `_connection-check/${crypto.randomUUID()}.txt`;
const body = "newmeta-r2-connection-ok";
let uploaded = false;
try {
  await checkStorage();
  await uploadObject(key, body, "text/plain");
  uploaded = true;
  const object = await downloadObject(key);
  assert.equal(await object.Body.transformToString(), body);
  console.log("PASS: Cloudflare R2 bucket access, upload, and download succeeded.");
} catch (error) {
  console.error("R2 verification failed:", error.message);
  process.exitCode = 1;
} finally {
  try {
    if (uploaded) {
      await deleteObject(key);
      console.log("Temporary verification object deleted.");
    }
  } catch (error) {
    console.error("Could not remove verification object:", key, error.message);
    process.exitCode = 1;
  }
  closeStorage();
}
