# Frontend audit and cleanup — 2026-10-27

This review covers the active Home, Products, History, Automations, Settings,
Shopify data, billing and placeholder routes, their hooks, component structure,
styles, dependencies and production bundle. Changes preserve the Polaris CDN
and App Bridge integration.

## Findings corrected

| Finding | Correction |
| --- | --- |
| Home search navigated with `?search=` but Products ignored it | Initialize catalog search from the route query; test the handoff and API request |
| Native custom-element pagination and dismiss events used React-style capitalized names | Bind lowercase native `previouspage`, `nextpage` and `dismiss` events; regression-tested |
| Product rows all rerendered on a selection change | Memoize rows, column definitions and their shared selection callback; avoid redundant empty-selection state updates |
| Background product polling disabled table interactions every 30 seconds | Keep the current page interactive during serial background refreshes; regression-tested |
| Shopify-data polling could overlap slow requests | Schedule the next poll after completion, share in-flight reloads and abort/ignore results on unmount |
| Compact density action had no effect | Apply density through a supported Polaris box's padding around the primary product cell |
| Product status UNLISTED appeared as Unknown | Add an explicit Unlisted badge |
| Product links used an extension-style URL in an iframe app | Use `shopify://admin/products/...` and top-level navigation |
| Host-element flex/height/font overrides did not reliably control shadow layouts | Replace with Polaris grids, boxes, headings and stacks in Home, Settings and Automations |
| Automation page forced multiple differently cased width attributes plus `!important` CSS | Keep the supported `inlineSize` prop and responsive Polaris grids |
| Custom HTML search and filter button styling duplicated Polaris controls | Use `s-search-field` and tertiary `s-button`; remove custom control color/border/focus CSS |
| Tutorial preview built a decorative table and inline SVG DOM tree | Use the existing preview image with a Polaris action and concise copy |
| History arrow navigation changed selection without moving focus | Move focus with the active tab; regression-tested |
| Every page and its sample data loaded in the initial bundle | Split routes with React.lazy, add a loading fallback and a page error boundary |
| Demo metrics, automation behavior and billing details could look live | Add clear sample-data notices; retain the live Products catalog |
| Legacy global CSS remained for obsolete product markup | Remove unused selectors and the ineffective table-cell density override |

## Legacy and DOM checks

- No active `@shopify/polaris` / Polaris React import or dependency was found.
- App Bridge React v4 is retained for its supported toast API. It is not the old
  App Bridge v3 provider implementation.
- Products are fetched in server-limited 25-row pages; history is paginated.
  Source inspection found no full-catalog DOM rendering path. Actual shadow-DOM
  size and browser render timings could not be measured in this session.
- Billing, History and Automations modal contents are already conditional on the
  selected dialog; those guards were preserved.
- Small app-owned CSS remains for structural wrappers, overflow, readable long
  titles, native navigation-link focus, and semantic definition lists. Polaris
  owns control styling, typography, card surfaces and most layout.

## Validation and limits

- Frontend interaction tests: 25 pass (11 UI/hook tests, 14 product tests).
- Production Vite build passes, with separate route chunks.
- Initial JavaScript: approximately 330.16 KB before, 249.60 KB after (uncompressed,
  roughly 24% smaller). This is a bundle-size improvement, not a measured browser
  rendering-speed claim. First navigation also downloads its selected route chunk.
- Live Chrome audit was attempted through the computer-use runtime and blocked:
  `Local browser use is disabled in Work settings`. No desktop/mobile screenshot,
  shadow-DOM alignment measurement, console observation or embedded-admin browser
  interaction is claimed. DOM interactions above run in JSDOM with native events.
- Shopify toolkit documentation was consulted. Its component validator could not
  run because the host installation lacks `typescript`; generated UI is verified
  by the frontend build/tests, not claimed to have passed that validator.
- Example pages remain examples; this cleanup does not implement their backend
  business workflows.

Product navigation reference:
https://shopify.dev/docs/api/app-home/latest/apis/user-interface-and-interactions/navigation-api
