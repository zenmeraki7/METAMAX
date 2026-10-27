# Shopify App Template for Node

Webhook persistence, recovery workers, API resource controls, and privacy cleanup
are documented in [Reconciliation operations](docs/reconciliation-operations.md).

## Cloudflare R2 object storage

The backend has private object storage helpers in `web/storage.js`, using the
S3-compatible SDK with Standard storage. Enable R2 in your Cloudflare account,
create a private Standard bucket named `newmeta`, and create an R2 API token with
Object Read & Write permissions scoped to that bucket. Save its Access Key ID
and Secret Access Key in the ignored `web/.env` file:

```dotenv
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_BUCKET=newmeta
```

Use `R2_ENDPOINT` only if a jurisdiction-specific endpoint is needed. Run
`npm run storage:check` from the project root to verify bucket access and a
temporary object's upload/download/delete cycle. The check removes its own object.
Backend code can import `uploadObject`, `downloadObject`, `deleteObject`, and
`signedDownloadUrl` from `web/storage.js`. Signed download URLs expire after
15 minutes by default. Call `closeStorage` during shutdown.

Keep credentials on the server. No public bucket access or browser upload
endpoint is enabled by this integration. In production, configure these variables
in the server environment.

R2 Standard's monthly free allowance is 10 GB-month of storage, 1 million Class A
operations, and 10 million Class B operations. Usage beyond that is billed;
the free allowance is not a hard spending cap. See
[Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Redis and BullMQ

Start Docker Desktop, then run `npm run redis:up` from the project root.
This starts Redis on `127.0.0.1:6379`, with a persistent Docker volume,
append-only persistence, and the `noeviction` policy required by BullMQ.
Set `REDIS_URL=redis://127.0.0.1:6379` in `web/.env` (already configured locally).
Run `npm run queue:check` to enqueue and process a temporary job, then clean it up.
Use `npm run redis:stop` to stop Redis while keeping its data.

If Docker Desktop is stuck starting and its engine returns HTTP 500, stop it
with `docker desktop stop --force --timeout 30`. Wait for the Docker Desktop
processes to exit, then run `wsl --terminate docker-desktop`. If
`wsl --list --verbose` also lists `docker-desktop-data`, terminate that
distribution too. Start Docker Desktop again, then run `npm run redis:up`
and `npm run queue:check` to verify Redis and an actual BullMQ job. These
steps keep the existing containers and persistent volumes.

Import `createQueue` and `createWorker` from `web/queues.js` in backend code:

```js
import { createQueue, createWorker } from "./queues.js";

const queue = createQueue("jobs");
const worker = createWorker("jobs", async (job) => {
  // Perform the background task here.
  return { processed: job.id };
});
worker.on("error", (error) => console.error(error));
await queue.add("example", { example: true });
// On shutdown: await worker.close(); await queue.close();
```

Queue and worker factories use a `newmeta` prefix. The worker retries Redis
connections indefinitely; producers have a bounded per-command retry count.
Initial catalogue imports are reserved automatically when a merchant installs
the app and dispatched immediately after the offline session commits. Keep the
worker running alongside the HTTP app; its scanner recovers interrupted or
unavailable queue dispatches. For an app running in another
Docker Desktop container, use `redis://host.docker.internal:6379`; for a service
on this Compose network, use `redis://redis:6379`. Set `REDIS_URL` separately in
your production environment.

## Database

Shared configuration lives in `web/shared/env.js`, which loads `web/.env`
without overriding deployment or Shopify CLI environment variables.
`readEnvironment()` validates `DATABASE_URL`, optional `DIRECT_URL`, and
`REDIS_URL`; errors identify variable names without disclosing their values.
Callers can disable a required service using `{ requireDatabase: false }` or
`{ requireRedis: false }` as the second argument. The shared database module
re-exports the existing Prisma instance and lifecycle helpers. The shared Redis
module provides producer and worker connection options, with `web/queues.js`
preserving its existing public exports. Keep credentials in the environment,
never in these shared source files.

This project uses the Neon PostgreSQL database `newmeta` for Shopify sessions.
The local connection string is in `web/.env` (ignored by Git). For another checkout,
copy `web/.env.example` to `web/.env` and supply the connection string. In production,
set `DATABASE_URL` in the server environment; it takes precedence over the local file.
Use the pooled Neon connection URL with TLS enabled. The Shopify PostgreSQL adapter
creates and migrates its session table automatically on startup.

Install backend dependencies with `npm --prefix web install`, then start development
with `npm run dev` from the project root. Existing local SQLite sessions are not copied;
previously installed shops may need to authenticate again.

This is a template for building a [Shopify app](https://shopify.dev/docs/apps/getting-started) using Node and React. It contains the basics for building a Shopify app.

Rather than cloning this repo, you can use your preferred package manager and the Shopify CLI with [these steps](#installing-the-template).

## Benefits

Shopify apps are built on a variety of Shopify tools to create a great merchant experience. The [create an app](https://shopify.dev/docs/apps/getting-started/create) tutorial in our developer documentation will guide you through creating a Shopify app using this template.

The Node app template comes with the following out-of-the-box functionality:

- OAuth: Installing the app and granting permissions
- GraphQL Admin API: Querying or mutating Shopify admin data
- REST Admin API: Resource classes to interact with the API
- Shopify-specific tooling:
  - AppBridge
  - Polaris
  - Webhooks

## Tech Stack

This template combines a number of third party open-source tools:

- [Express](https://expressjs.com/) builds the backend.
- [Vite](https://vitejs.dev/) builds the [React](https://reactjs.org/) frontend.
- [React Router](https://reactrouter.com/) is used for routing. We wrap this with file-based routing.
- [React Query](https://react-query.tanstack.com/) queries the Admin API.
- [`i18next`](https://www.i18next.com/) and related libraries are used to internationalize the frontend.
  - [`react-i18next`](https://react.i18next.com/) is used for React-specific i18n functionality.
  - [`i18next-resources-to-backend`](https://github.com/i18next/i18next-resources-to-backend) is used to dynamically load app translations.
  - [`@formatjs/intl-localematcher`](https://formatjs.io/docs/polyfills/intl-localematcher/) is used to match the user locale with supported app locales.
  - [`@formatjs/intl-locale`](https://formatjs.io/docs/polyfills/intl-locale) is used as a polyfill for [`Intl.Locale`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Locale) if necessary.
  - [`@formatjs/intl-pluralrules`](https://formatjs.io/docs/polyfills/intl-pluralrules) is used as a polyfill for [`Intl.PluralRules`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules) if necessary.

The following Shopify tools complement these third-party tools to ease app development:

- [Shopify API library](https://github.com/Shopify/shopify-node-api) adds OAuth to the Express backend. This lets users install the app and grant scope permissions.
- [App Bridge React](https://shopify.dev/docs/apps/tools/app-bridge/getting-started/using-react) adds [authentication to API requests](https://shopify.dev/docs/api/app-bridge-library/apis/resource-fetching) in the frontend and renders components outside of the App’s iFrame.
- [Polaris React](https://polaris.shopify.com/) is a powerful design system and component library that helps developers build high quality, consistent experiences for Shopify merchants.
- [File-based routing](https://github.com/Shopify/shopify-frontend-template-react/blob/main/Routes.jsx) makes creating new pages easier.
- [`@shopify/i18next-shopify`](https://github.com/Shopify/i18next-shopify) is a plugin for [`i18next`](https://www.i18next.com/) that allows translation files to follow the same JSON schema used by Shopify [app extensions](https://shopify.dev/docs/apps/checkout/best-practices/localizing-ui-extensions#how-it-works) and [themes](https://shopify.dev/docs/themes/architecture/locales/storefront-locale-files#usage).

## Getting started

### Requirements

1. You must [download and install Node.js](https://nodejs.org/en/download/) if you don't already have it.
1. You must [create a Shopify partner account](https://partners.shopify.com/signup) if you don’t have one.
1. You must create a store for testing if you don't have one, either a [development store](https://help.shopify.com/en/partners/dashboard/development-stores#create-a-development-store) or a [Shopify Plus sandbox store](https://help.shopify.com/en/partners/dashboard/managing-stores/plus-sandbox-store).

### Installing the template

This template can be installed using your preferred package manager:

Using yarn:

```shell
yarn create @shopify/app --template=node
```

Using npm:

```shell
npm init @shopify/app@latest -- --template=node
```

Using pnpm:

```shell
pnpm create @shopify/app@latest --template=node
```

This will clone the template and install the required dependencies.

#### Local Development

[The Shopify CLI](https://shopify.dev/docs/apps/tools/cli) connects to an app in your Partners dashboard. It provides environment variables, runs commands in parallel, and updates application URLs for easier development.

You can develop locally using your preferred package manager. Run one of the following commands from the root of your app.

Using yarn:

```shell
yarn dev
```

Using npm:

```shell
npm run dev
```

Using pnpm:

```shell
pnpm run dev
```

Open the URL generated in your console. Once you grant permission to the app, you can start development.

## Deployment

### Application Storage

This template uses [SQLite](https://www.sqlite.org/index.html) to store session data. The database is a file called `database.sqlite` which is automatically created in the root. This use of SQLite works in production if your app runs as a single instance.

The database that works best for you depends on the data your app needs and how it is queried. You can run your database of choice on a server yourself or host it with a SaaS company. Here’s a short list of databases providers that provide a free tier to get started:

| Database   | Type             | Hosters                                                                                                                                                                                                                               |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MySQL      | SQL              | [Digital Ocean](https://www.digitalocean.com/try/managed-databases-mysql), [Planet Scale](https://planetscale.com/), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/mysql) |
| PostgreSQL | SQL              | [Digital Ocean](https://www.digitalocean.com/try/managed-databases-postgresql), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/postgres)                                   |
| Redis      | Key-value        | [Digital Ocean](https://www.digitalocean.com/try/managed-databases-redis), [Amazon MemoryDB](https://aws.amazon.com/memorydb/)                                                                                                        |
| MongoDB    | NoSQL / Document | [Digital Ocean](https://www.digitalocean.com/try/managed-databases-mongodb), [MongoDB Atlas](https://www.mongodb.com/atlas/database)                                                                                                  |

To use one of these, you need to change your session storage configuration. To help, here’s a list of [SessionStorage adapter packages](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

### Build

The frontend is a single page app. It requires the `SHOPIFY_API_KEY`, which you can find on the page for your app in your partners dashboard. Paste your app’s key in the command for the package manager of your choice:

Using yarn:

```shell
cd web/frontend/ && SHOPIFY_API_KEY=REPLACE_ME yarn build
```

Using npm:

```shell
cd web/frontend/ && SHOPIFY_API_KEY=REPLACE_ME npm run build
```

Using pnpm:

```shell
cd web/frontend/ && SHOPIFY_API_KEY=REPLACE_ME pnpm run build
```

You do not need to build the backend.

## Hosting

When you're ready to set up your app in production, you can follow [our deployment documentation](https://shopify.dev/docs/apps/deployment/web) to host your app on a cloud provider like [Heroku](https://www.heroku.com/) or [Fly.io](https://fly.io/).

When you reach the step for [setting up environment variables](https://shopify.dev/docs/apps/deployment/web#set-env-vars), you also need to set the variable `NODE_ENV=production`.

## Known issues

### Hot module replacement and Firefox

When running the app with the CLI in development mode on Firefox, you might see your app constantly reloading when you access it.
That happened in previous versions of the CLI, because of the way HMR websocket requests work.

We fixed this issue with v3.4.0 of the CLI, so after updating it, you can make the following changes to your app's `web/frontend/vite.config.js` file:

1. Change the definition `hmrConfig` object to be:

   ```js
   const host = process.env.HOST
     ? process.env.HOST.replace(/https?:\/\//, "")
     : "localhost";

   let hmrConfig;
   if (host === "localhost") {
     hmrConfig = {
       protocol: "ws",
       host: "localhost",
       port: 64999,
       clientPort: 64999,
     };
   } else {
     hmrConfig = {
       protocol: "wss",
       host: host,
       port: process.env.FRONTEND_PORT,
       clientPort: 443,
     };
   }
   ```

1. Change the `server.host` setting in the configs to `"localhost"`:

   ```js
   server: {
     host: "localhost",
     ...
   ```

### I can't get past the ngrok "Visit site" page

When you’re previewing your app or extension, you might see an ngrok interstitial page with a warning:

```text
You are about to visit <id>.ngrok.io: Visit Site
```

If you click the `Visit Site` button, but continue to see this page, then you should run dev using an alternate tunnel URL that you run using tunneling software.
We've validated that [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/run-tunnel/trycloudflare/) works with this template.

To do that, you can [install the `cloudflared` CLI tool](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/), and run:

```shell
# Note that you can also use a different port
cloudflared tunnel --url http://localhost:3000
```

Out of the logs produced by cloudflare you will notice a https URL where the domain ends with `trycloudflare.com`. This is your tunnel URL. You need to copy this URL as you will need it in the next step.

```shell
2022-11-11T19:57:55Z INF Requesting new quick Tunnel on trycloudflare.com...
2022-11-11T19:57:58Z INF +--------------------------------------------------------------------------------------------+
2022-11-11T19:57:58Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2022-11-11T19:57:58Z INF |  https://randomly-generated-hostname.trycloudflare.com                                     |
2022-11-11T19:57:58Z INF +--------------------------------------------------------------------------------------------+
```

Below you would replace `randomly-generated-hostname` with what you have copied from the terminal. In a different terminal window, navigate to your app's root and with the URL from above you would call:

```shell
# Using yarn
yarn dev --tunnel-url https://randomly-generated-hostname.trycloudflare.com:3000
# or using npm
npm run dev --tunnel-url https://randomly-generated-hostname.trycloudflare.com:3000
# or using pnpm
pnpm dev --tunnel-url https://randomly-generated-hostname.trycloudflare.com:3000
```

## Developer resources

- [Introduction to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [App authentication](https://shopify.dev/docs/apps/auth)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [Shopify API Library documentation](https://github.com/Shopify/shopify-api-js#readme)
- [Getting started with internationalizing your app](https://shopify.dev/docs/apps/best-practices/internationalization/getting-started)
  - [i18next](https://www.i18next.com/)
    - [Configuration options](https://www.i18next.com/overview/configuration-options)
  - [react-i18next](https://react.i18next.com/)
    - [`useTranslation` hook](https://react.i18next.com/latest/usetranslation-hook)
    - [`Trans` component usage with components array](https://react.i18next.com/latest/trans-component#alternative-usage-components-array)
  - [i18n-ally VS Code extension](https://marketplace.visualstudio.com/items?itemName=Lokalise.i18n-ally)
