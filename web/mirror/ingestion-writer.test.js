import test from "node:test";
import assert from "node:assert/strict";
import { createIngestionWriter } from "./ingestion-writer.server.js";
import { validateProducts } from "./catalog-validation.js";
import { product, variant } from "./integration/sync-hardening.js";
test("complete catalog validation rejects partial, duplicate and coerced values", () => {
  for (const records of [
    [],
    [{}],
    [product(), product()],
    [{ ...product(), variants: [{ ...variant(10), taxable: "false" }] }],
    [{ ...product(), variants: [{ ...variant(10), price: 10 }] }],
    [{ ...product(), variants: [variant(10), variant(10)] }],
  ])
    assert.throws(() => validateProducts(records));
  assert.doesNotThrow(() => validateProducts([product()]));
});
test("invalid import records fail before SQL or checkpointing", async () => {
  const writer = createIngestionWriter({
    syncRunService: {
      recordCheckpoint() {
        assert.fail("Invalid checkpoint");
      },
    },
  });
  await assert.rejects(() =>
    writer.writeStagingBatch({
      client: {
        query() {
          assert.fail("Invalid write");
        },
      },
      records: [{ id: "bad" }],
      ordinal: 0,
    }),
  );
});

test("tag ingestion requires a complete dense bounded string list and preserves exact values", () => {
  const sample = product();
  const { tags, ...missing } = sample;
  for (const record of [
    missing,
    ...[
      null,
      "Summer",
      [null],
      [undefined],
      new Array(1),
      [["Summer"]],
      Array(101).fill("tag"),
    ].map((tags) => ({ ...sample, tags })),
  ]) {
    assert.throws(() => validateProducts([record]));
  }
  const complete = [
    "Summer",
    "summer",
    "Summer sale",
    "100%_literal",
    "a,b",
    " leading ",
    "Summer",
  ];
  assert.doesNotThrow(() => validateProducts([{ ...sample, tags: complete }]));
  assert.deepEqual(complete, [
    "Summer",
    "summer",
    "Summer sale",
    "100%_literal",
    "a,b",
    " leading ",
    "Summer",
  ]);
  assert.doesNotThrow(() => validateProducts([{ ...sample, tags: [] }]));
});
