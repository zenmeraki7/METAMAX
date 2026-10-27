ALTER TABLE "CatalogChange"
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leasedUntil" TIMESTAMP(3);

ALTER TABLE "CatalogChange" ADD CONSTRAINT "CatalogChange_lease_pair"
  CHECK (("leaseToken" IS NULL) = ("leasedUntil" IS NULL));
