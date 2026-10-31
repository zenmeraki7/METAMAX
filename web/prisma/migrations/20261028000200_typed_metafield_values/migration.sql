-- Atomic, data-preserving consolidation of the two legacy value tables.
BEGIN;
LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE;
LOCK TABLE mirror.metafield_definitions IN SHARE MODE;
LOCK TABLE mirror.product_metafields, mirror.variant_metafields IN ACCESS EXCLUSIVE MODE;
SET LOCAL TIME ZONE 'UTC';

-- CreateTable
CREATE TABLE "mirror"."metafield_values" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "product_id" BIGINT,
    "variant_id" BIGINT,
    "definition_id" BIGINT NOT NULL,
    "owner_entity" "mirror"."OwnerEntity" NOT NULL,
    "definition_token" TEXT NOT NULL,
    "value_type" TEXT NOT NULL,
    "is_null" BOOLEAN NOT NULL DEFAULT false,
    "text_value" TEXT,
    "boolean_value" BOOLEAN,
    "integer_value" BIGINT,
    "decimal_value" DECIMAL,
    "date_value" DATE,
    "datetime_value" TIMESTAMPTZ(6),
    "string_list_value" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "json_value" JSONB,

    CONSTRAINT "metafield_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metafield_values_shop_id_generation_id_definition_id_id_idx" ON "mirror"."metafield_values"("shop_id", "generation_id", "definition_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "metafield_values_shop_id_generation_id_product_id_definitio_key" ON "mirror"."metafield_values"("shop_id", "generation_id", "product_id", "definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "metafield_values_shop_id_generation_id_variant_id_definitio_key" ON "mirror"."metafield_values"("shop_id", "generation_id", "variant_id", "definition_id");

-- AddForeignKey
ALTER TABLE "mirror"."metafield_values" ADD CONSTRAINT "metafield_values_shop_id_generation_id_product_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "product_id") REFERENCES "mirror"."products"("shop_id", "generation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."metafield_values" ADD CONSTRAINT "metafield_values_shop_id_generation_id_variant_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "variant_id") REFERENCES "mirror"."variants"("shop_id", "generation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."metafield_values" ADD CONSTRAINT "metafield_values_shop_id_definition_id_owner_entity_fkey" FOREIGN KEY ("shop_id", "definition_id", "owner_entity") REFERENCES "mirror"."metafield_definitions"("shop_id", "id", "owner_entity") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE mirror.metafield_values ALTER COLUMN string_list_value SET NOT NULL;
ALTER TABLE mirror.metafield_values ADD CONSTRAINT metafield_single_owner CHECK (
  (owner_entity = 'product' AND product_id IS NOT NULL AND variant_id IS NULL)
  OR (owner_entity = 'variant' AND variant_id IS NOT NULL AND product_id IS NULL)
);
ALTER TABLE mirror.metafield_values ADD CONSTRAINT metafield_typed_value CHECK (
  value_type IN ('string','boolean','integer','decimal','date','datetime','string_list','json')
  AND array_position(string_list_value, NULL) IS NULL
  AND (decimal_value IS NULL OR decimal_value::text NOT IN ('NaN','Infinity','-Infinity'))
  AND CASE
    WHEN is_null THEN num_nonnulls(text_value,boolean_value,integer_value,decimal_value,date_value,datetime_value,json_value) = 0
      AND cardinality(string_list_value) = 0
    WHEN value_type = 'string_list' THEN num_nonnulls(text_value,boolean_value,integer_value,decimal_value,date_value,datetime_value,json_value) = 0
    ELSE cardinality(string_list_value) = 0
      AND num_nonnulls(text_value,boolean_value,integer_value,decimal_value,date_value,datetime_value,json_value) = 1
      AND CASE value_type
        WHEN 'string' THEN text_value IS NOT NULL
        WHEN 'boolean' THEN boolean_value IS NOT NULL
        WHEN 'integer' THEN integer_value IS NOT NULL
        WHEN 'decimal' THEN decimal_value IS NOT NULL
        WHEN 'date' THEN date_value IS NOT NULL
        WHEN 'datetime' THEN datetime_value IS NOT NULL
        WHEN 'json' THEN json_value IS NOT NULL
        ELSE false END
    END
);

-- Refuse unsafe conversion rather than losing stale or ambiguously typed data.
-- Old snapshots with changed definitions must be reconciled before migration.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT shop_id,definition_id,definition_token,value FROM mirror.product_metafields
      UNION ALL SELECT shop_id,definition_id,definition_token,value FROM mirror.variant_metafields
    ) v JOIN mirror.metafield_definitions d ON d.shop_id = v.shop_id AND d.id = v.definition_id
    WHERE d.definition_token <> v.definition_token
      OR (v.value = 'null'::jsonb AND d.canonical_type <> 'json' AND NOT d.nullable)
      OR d.canonical_type NOT IN ('string','boolean','integer','decimal','date','datetime','string_list','json')
      OR (d.canonical_type = 'string_list' AND v.value <> 'null'::jsonb AND
        CASE WHEN jsonb_typeof(v.value) <> 'array' THEN true ELSE EXISTS (
          SELECT 1 FROM jsonb_array_elements(v.value) e WHERE jsonb_typeof(e) <> 'string') END)
  ) THEN RAISE EXCEPTION 'Legacy metafield data requires reconciliation before typed migration' USING ERRCODE = '23514'; END IF;
END $$;

INSERT INTO mirror.metafield_values (shop_id,generation_id,product_id,variant_id,definition_id,owner_entity,
  definition_token,value_type,is_null,text_value,boolean_value,integer_value,decimal_value,date_value,
  datetime_value,string_list_value,json_value)
SELECT v.shop_id,v.generation_id,v.product_id,v.variant_id,v.definition_id,v.owner_entity,v.definition_token,
  d.canonical_type,
  v.value = 'null'::jsonb AND d.canonical_type <> 'json',
  CASE WHEN d.canonical_type = 'string' AND jsonb_typeof(v.value) = 'string' THEN v.value #>> '{}' END,
  CASE WHEN d.canonical_type = 'boolean' AND jsonb_typeof(v.value) = 'boolean' THEN (v.value #>> '{}')::boolean END,
  CASE WHEN d.canonical_type = 'integer' AND (v.value #>> '{}') ~ '^-?(0|[1-9][0-9]*)$' THEN (v.value #>> '{}')::bigint END,
  CASE WHEN d.canonical_type = 'decimal' AND jsonb_typeof(v.value) IN ('number','string') THEN (v.value #>> '{}')::numeric END,
  CASE WHEN d.canonical_type = 'date' AND (v.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (v.value #>> '{}')::date END,
  CASE WHEN d.canonical_type = 'datetime' AND (v.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN (v.value #>> '{}')::timestamptz END,
  CASE WHEN d.canonical_type = 'string_list' AND jsonb_typeof(v.value) = 'array'
    THEN ARRAY(SELECT e #>> '{}' FROM jsonb_array_elements(v.value) WITH ORDINALITY AS item(e,n) ORDER BY n) ELSE ARRAY[]::text[] END,
  CASE WHEN d.canonical_type = 'json' THEN v.value END
FROM (
  SELECT shop_id,generation_id,product_id,NULL::bigint AS variant_id,definition_id,owner_entity,definition_token,value
    FROM mirror.product_metafields
  UNION ALL
  SELECT shop_id,generation_id,NULL::bigint,variant_id,definition_id,owner_entity,definition_token,value
    FROM mirror.variant_metafields
) v JOIN mirror.metafield_definitions d ON d.shop_id = v.shop_id AND d.id = v.definition_id;

-- Only retire the old storage after conversion and all constraints succeeded.
DROP TABLE mirror.product_metafields;
DROP TABLE mirror.variant_metafields;

CREATE TRIGGER guard_generation_data BEFORE INSERT OR UPDATE OR DELETE ON mirror.metafield_values
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_generation_data();

CREATE FUNCTION mirror.guard_metafield_type() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d mirror.metafield_definitions%ROWTYPE;
BEGIN
  SELECT * INTO d FROM mirror.metafield_definitions
    WHERE shop_id = NEW.shop_id AND id = NEW.definition_id FOR SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF; -- Foreign key reports missing definition.
  IF d.owner_entity <> NEW.owner_entity OR d.canonical_type <> NEW.value_type
    OR d.definition_token <> NEW.definition_token OR NOT d.definition_verified
    OR d.status <> 'ACTIVE' OR d.verification_expires_at <= now()
    OR d.verification_expires_at IS NULL OR (NEW.is_null AND NOT d.nullable) THEN
    RAISE EXCEPTION 'Metafield value differs from its verified definition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_metafield_type BEFORE INSERT OR UPDATE ON mirror.metafield_values
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_metafield_type();

-- Text equality and exact decimal ranges are the initial dynamic workloads.
CREATE INDEX metafield_values_text ON mirror.metafield_values (shop_id,generation_id,definition_id,text_value,id)
  WHERE value_type = 'string' AND NOT is_null;
CREATE INDEX metafield_values_decimal ON mirror.metafield_values (shop_id,generation_id,definition_id,decimal_value,id)
  WHERE value_type = 'decimal' AND NOT is_null;
COMMIT;
