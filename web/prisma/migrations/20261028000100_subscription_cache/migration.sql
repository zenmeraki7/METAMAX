-- CreateTable
CREATE TABLE "mirror"."subscriptions" (
    "shop_id" TEXT NOT NULL,
    "installation_version" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'SHOPIFY_APP_PRICING',
    "provider_subscription_id" TEXT,
    "plan_handle" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verification_revision" BIGINT NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMPTZ(3),
    "verification_expires_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("shop_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_shop_id_installation_version_key" ON "mirror"."subscriptions"("shop_id", "installation_version");

-- CreateIndex
CREATE UNIQUE INDEX "shops_id_installation_version_key" ON "mirror"."shops"("id", "installation_version");

-- AddForeignKey
ALTER TABLE "mirror"."subscriptions" ADD CONSTRAINT "subscriptions_shop_id_installation_version_fkey" FOREIGN KEY ("shop_id", "installation_version") REFERENCES "mirror"."shops"("id", "installation_version") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Local cache of a verified Shopify App Pricing observation, never a grant.
ALTER TABLE mirror.subscriptions ADD CONSTRAINT subscription_verification CHECK (
  provider = 'SHOPIFY_APP_PRICING' AND verification_revision >= 0
  AND ((status = 'UNVERIFIED' AND verified_at IS NULL AND verification_expires_at IS NULL
        AND provider_subscription_id IS NULL AND plan_handle IS NULL)
    OR (verified_at IS NOT NULL AND verification_expires_at IS NOT NULL
        AND verification_expires_at > verified_at AND verification_revision > 0))
);

CREATE FUNCTION mirror.guard_subscription_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.shop_id, NEW.installation_version) IS DISTINCT FROM (OLD.shop_id, OLD.installation_version) THEN
    RAISE EXCEPTION 'Subscription observation belongs to a different installation' USING ERRCODE = '23514';
  END IF;
  IF NEW.verification_revision < OLD.verification_revision OR
    ((to_jsonb(NEW) - ARRAY['updated_at','verification_revision']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['updated_at','verification_revision'])
      AND NEW.verification_revision <= OLD.verification_revision) THEN
    RAISE EXCEPTION 'Subscription cache update requires a newer verification revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_subscription_revision BEFORE UPDATE ON mirror.subscriptions
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_subscription_revision();
