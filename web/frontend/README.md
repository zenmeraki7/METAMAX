# Shopify React Frontend App

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE.md)

This repository is the frontend for Shopify’s app starter templates. **You probably don’t want to use this repository directly**, but rather through one of the templates and the [Shopify CLI](https://github.com/Shopify/shopify-cli).

## Developer resources

CI tests Node.js 22 and 24. Use npm and commit `package-lock.json` whenever
dependencies change; CI installs dependencies with `npm ci`.

The frontend is a Git submodule. Commit frontend source and lockfile changes in
the submodule, then commit its updated revision in the parent repository so a
recursive checkout includes the same frontend that was tested locally.

- [Introduction to Shopify apps](https://shopify.dev/apps/getting-started)
  - [App authentication](https://shopify.dev/apps/auth)
- [Shopify CLI command reference](https://shopify.dev/apps/tools/cli/app)
- [Shopify API Library documentation](https://github.com/Shopify/shopify-node-api/tree/main/docs)

## License

This repository is available as open source under the terms of the [MIT License](https://opensource.org/licenses/MIT).
