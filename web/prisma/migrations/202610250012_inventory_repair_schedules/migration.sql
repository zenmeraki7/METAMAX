-- Requires migration 011 to commit its new CatalogRepairKind enum values.

-- 10. Create inventory repair schedules
-- for verified active installations.

INSERT INTO "CatalogRepair" (
  "shop",
  "kind"
)
SELECT
  s."domain",
  k."kind"::"CatalogRepairKind"
FROM "Shop" s
JOIN "InstallationState" i
  ON i."shopHash" = encode(
    sha256(convert_to(s."domain", 'UTF8')),
    'hex'
  )
  AND i."generation" = s."generation"
CROSS JOIN (
  VALUES
    ('INVENTORY_ITEM'),
    ('INVENTORY_LEVEL')
) AS k("kind")
WHERE
  s."status" = 'ACTIVE'
  AND s."installationVerified" = true
  AND i."status" = 'ACTIVE'
ON CONFLICT ("shop", "kind") DO NOTHING;
