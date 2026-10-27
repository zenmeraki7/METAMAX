import { withGraphqlBudget } from "./graphql-budget.js";

let usedSessionStorage;

export async function closeGraphqlSessions() {
  if (usedSessionStorage) await usedSessionStorage.disconnect();
}

function requestFailure(code, message) {
  return Object.assign(new Error(message), { code, retryable: true });
}

// The shared client performs one HTTP request. Reconciliation owns durable retries.
// Each page is independently budgeted and checks the same installation generation.
export async function graphql(shop, query, variables, context = {}) {
  if (
    typeof shop !== "string" ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)
  ) {
    throw new TypeError("Invalid canonical shop domain");
  }
  const { prisma } = await import("../../db/client.js");
  return withGraphqlBudget(
    shop,
    async () => {
      const merchant = await prisma.shop.findUnique({
        where: { domain: shop },
        select: { status: true, generation: true },
      });
      const expected = context.generation ?? context.installation?.generation;
      if (
        !merchant ||
        merchant.status !== "ACTIVE" ||
        (expected && merchant.generation !== expected)
      ) {
        throw requestFailure(
          "INSTALLATION_CHANGED",
          "Reconciliation cancelled because the installation changed"
        );
      }
      if (context.installation)
        context.installation.generation ??= merchant.generation;
      const { sessionStorage } = await import("../../session-storage.js");
      usedSessionStorage = sessionStorage;
      const session = await sessionStorage.loadSession(`offline_${shop}`);
      if (!session?.accessToken || session.isExpired())
        throw requestFailure(
          "OFFLINE_SESSION_MISSING",
          "No active offline session is available for this shop"
        );
      const timeout = AbortSignal.timeout(15000);
      const response = await fetch(
        `https://${shop}/admin/api/2026-10/graphql.json`,
        {
          method: "POST",
          signal: context.signal
            ? AbortSignal.any([context.signal, timeout])
            : timeout,
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({ query, variables }),
        }
      );
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        throw Object.assign(
          requestFailure("SHOPIFY_THROTTLED", "Shopify request throttled"),
          {
            throttled: true,
            retryAfterMs:
              Number.isFinite(seconds) && seconds > 0
                ? Math.min(seconds * 1000, 60000)
                : 1000,
          }
        );
      }
      if (!response.ok)
        throw requestFailure(
          "SHOPIFY_HTTP_ERROR",
          `Shopify request failed (${response.status})`
        );
      const body = await response.json();
      if (
        Array.isArray(body?.errors) &&
        body.errors.some((error) => error.extensions?.code === "THROTTLED")
      ) {
        throw Object.assign(
          requestFailure(
            "SHOPIFY_THROTTLED",
            "Shopify GraphQL budget throttled"
          ),
          { throttled: true }
        );
      }
      return body;
    },
    { requestedCost: context.requestedCost ?? 400, signal: context.signal }
  );
}
