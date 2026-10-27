import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInventoryService,
  writeInventoryItemSnapshot,
} from "../domains/inventory/inventory.service.js";
import { GET_INVENTORY_ITEM_VERSION } from "../domains/inventory/inventory.queries.js";
import { itemId, version, observation, level } from "./fixtures/inventory.js";
const shop = "example.myshopify.com";

function paginated(count = 101, transform = (response) => response) {
  const calls = [];
  const service = createInventoryService({
    graphql: async (_shop, query, variables, context) => {
      const index = calls.length;
      calls.push({ query, variables, context });
      if (query === GET_INVENTORY_ITEM_VERSION)
        return transform(
          { data: { inventoryItem: { id: itemId, updatedAt: version } } },
          index,
          query
        );
      const start = Number(variables.after ?? 0);
      const end = Math.min(start + 100, count);
      return transform(
        {
          data: {
            inventoryItem: {
              ...observation(0).item,
              inventoryLevels: {
                edges: Array.from({ length: end - start }, (_, i) => ({
                  node: level(start + i + 1),
                })),
                pageInfo: { hasNextPage: end < count, endCursor: String(end) },
              },
            },
          },
        },
        index,
        query
      );
    },
  });
  return { ...service, calls };
}

test("inventory fetch collects independent pages, including inactive levels and opaque IDs", async () => {
  const service = paginated();
  const current = await service.fetchInventoryItem(shop, itemId, {
    generation: "installation-1",
  });
  assert.equal(current.levels.length, 101);
  assert.equal(current.levels[0].isActive, false);
  assert.equal(
    current.levels[0].id,
    "gid://shopify/InventoryLevel/1?inventory_item_id=123"
  );
  assert.equal(current.levels[0].quantities.length, 8);
  assert.deepEqual(
    service.calls.map((c) => c.variables.after),
    [null, "100", undefined]
  );
  assert.deepEqual(
    service.calls.map((c) => c.context.requestedCost),
    [400, 400, 10]
  );
  assert.ok(
    service.calls.every((c) => c.context.generation === "installation-1")
  );
  assert.strictEqual(
    service.calls[0].context.installation,
    service.calls[2].context.installation
  );
  assert.strictEqual(
    service.calls[0].context.signal,
    service.calls[2].context.signal
  );
});

test("empty inventory is valid after final item verification", async () => {
  const service = paginated(0);
  assert.deepEqual((await service.fetchInventoryItem(shop, itemId)).levels, []);
  assert.equal(service.calls.length, 2);
});

test("item deletion requires two explicit null observations", async () => {
  let calls = 0;
  const service = createInventoryService({
    graphql: async () => {
      calls++;
      return { data: { inventoryItem: null } };
    },
  });
  assert.equal(await service.fetchInventoryItem(shop, itemId), null);
  assert.equal(calls, 2);
  const restored = createInventoryService({
    graphql: async (_s, q) => ({
      data: {
        inventoryItem:
          q === GET_INVENTORY_ITEM_VERSION
            ? { id: itemId, updatedAt: version }
            : null,
      },
    }),
  });
  await assert.rejects(restored.fetchInventoryItem(shop, itemId), {
    code: "INVALID_INVENTORY_SNAPSHOT",
  });
});

const malformed = {
  "GraphQL partial errors": (r) => {
    r.errors = [{ message: "denied" }];
  },
  "malformed errors": (r) => {
    r.errors = false;
  },
  "missing data": (r) => {
    r.data = null;
  },
  "missing item": (r) => {
    delete r.data.inventoryItem;
  },
  "wrong item identity": (r) => {
    r.data.inventoryItem.id += "9";
  },
  "invalid item flags": (r) => {
    r.data.inventoryItem.tracked = "true";
  },
  "invalid item timestamp": (r) => {
    r.data.inventoryItem.updatedAt = "yesterday";
  },
  "missing connection": (r) => {
    delete r.data.inventoryItem.inventoryLevels;
  },
  "invalid pagination": (r) => {
    r.data.inventoryItem.inventoryLevels.pageInfo.hasNextPage = "false";
  },
  "duplicate level identity": (r) => {
    const e = r.data.inventoryItem.inventoryLevels.edges;
    e[1].node.id = e[0].node.id;
  },
  "duplicate location": (r) => {
    const e = r.data.inventoryItem.inventoryLevels.edges;
    e[1].node.location.id = e[0].node.location.id;
  },
  "duplicate quantity": (r) => {
    const q = r.data.inventoryItem.inventoryLevels.edges[0].node.quantities;
    q.push(q[0]);
  },
  "missing requested state": (r) => {
    r.data.inventoryItem.inventoryLevels.edges[0].node.quantities.pop();
  },
  "out-of-range quantity": (r) => {
    r.data.inventoryItem.inventoryLevels.edges[0].node.quantities[0].quantity = 2147483648;
  },
  "invalid location timestamp": (r) => {
    r.data.inventoryItem.inventoryLevels.edges[0].node.location.updatedAt =
      "bad";
  },
};
for (const [name, mutate] of Object.entries(malformed)) {
  test(`inventory fetch rejects ${name}`, async () => {
    const service = paginated(2, (r) => {
      mutate(r);
      return r;
    });
    await assert.rejects(service.fetchInventoryItem(shop, itemId), {
      code: "INVALID_INVENTORY_SNAPSHOT",
    });
    assert.equal(service.calls.length, 1);
  });
}

test("changing or disappearing items cannot produce a full replacement", async () => {
  for (const target of [1, 2]) {
    for (const change of ["version", "delete"]) {
      const service = paginated(101, (r, index) => {
        if (index === target) {
          if (change === "delete") r.data.inventoryItem = null;
          else r.data.inventoryItem.updatedAt = "2026-10-25T01:00:00Z";
        }
        return r;
      });
      await assert.rejects(service.fetchInventoryItem(shop, itemId), {
        code: "INVALID_INVENTORY_SNAPSHOT",
      });
    }
  }
});

test("nonadvancing, cyclic, and empty continuation pages fail closed", async () => {
  for (const mode of ["repeated", "cycle", "empty"]) {
    let calls = 0;
    const service = createInventoryService({
      graphql: async () => {
        calls++;
        return {
          inventoryItem: {
            ...observation(0).item,
            inventoryLevels: {
              edges: mode === "empty" ? [] : [{ node: level(calls) }],
              pageInfo: {
                hasNextPage: true,
                endCursor: mode === "cycle" ? String(calls % 2) : "fixed",
              },
            },
          },
        };
      },
    });
    await assert.rejects(service.fetchInventoryItem(shop, itemId), {
      code: "INVALID_INVENTORY_SNAPSHOT",
    });
    assert.ok(calls <= 3);
  }
});

test("pagination is bounded even when every cursor advances", async () => {
  let calls = 0;
  const service = createInventoryService({
    graphql: async () => ({
      inventoryItem: {
        ...observation(0).item,
        inventoryLevels: {
          edges: [{ node: level(++calls) }],
          pageInfo: { hasNextPage: true, endCursor: String(calls) },
        },
      },
    }),
  });
  await assert.rejects(
    service.fetchInventoryItem(shop, itemId),
    /exceeded limit/
  );
  assert.equal(calls, 100);
});

test("identity and cancellation checks prevent external requests", async () => {
  let calls = 0;
  const service = createInventoryService({
    graphql: async () => {
      calls++;
    },
  });
  await assert.rejects(service.fetchInventoryItem("bad", itemId), TypeError);
  await assert.rejects(service.fetchInventoryItem(shop, "123"), TypeError);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    service.fetchInventoryItem(shop, itemId, { signal: controller.signal }),
    { name: "AbortError" }
  );
  assert.equal(calls, 0);
});

test("cancellation between pages prevents the next request", async () => {
  const controller = new AbortController();
  const service = paginated(101, (r) => {
    controller.abort();
    return r;
  });
  await assert.rejects(
    service.fetchInventoryItem(shop, itemId, { signal: controller.signal }),
    { name: "AbortError" }
  );
  assert.equal(service.calls.length, 1);
});

test("writer rejects a root client and validates all input before writes", async () => {
  await assert.rejects(
    writeInventoryItemSnapshot(
      { $queryRaw() {}, $transaction() {} },
      shop,
      "snapshot",
      itemId,
      null
    ),
    TypeError
  );
  let writes = 0;
  const tx = {
    async $executeRaw() {},
    inventoryItem: {
      upsert: async () => {
        writes++;
      },
    },
  };
  for (const mutate of [
    (c) => {
      c.item.tracked = "false";
    },
    (c) => {
      c.levels.push(structuredClone(c.levels[0]));
    },
    (c) => {
      c.levels[0].quantities.pop();
    },
  ]) {
    const current = observation();
    mutate(current);
    await assert.rejects(
      writeInventoryItemSnapshot(tx, shop, "snapshot", itemId, current),
      { code: "INVALID_INVENTORY_SNAPSHOT" }
    );
  }
  assert.equal(writes, 0);
});

test("transaction probe preserves database failures for the caller's retry policy", async () => {
  const conflict = Object.assign(new Error("transaction conflict"), {
    code: "P2034",
  });
  const tx = {
    async $executeRaw() {
      throw conflict;
    },
  };
  await assert.rejects(
    writeInventoryItemSnapshot(tx, shop, "snapshot", itemId, observation()),
    (error) => error === conflict
  );
});
