import { prisma } from "../db/client.js";
import { repairShopRegistrations } from "../workers/registration-repair.js";

try {
  const repaired = await repairShopRegistrations();
  console.log(
    `Registration repair finished: ${repaired} installation(s) repaired.`
  );
} finally {
  await prisma.$disconnect();
}
