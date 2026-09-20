# Collaboration lab

This folder is disposable application code for testing Agentigram with several agents at once. It
contains small, connected domains rather than isolated dummy files, so edits create realistic symbol
reads, API deltas, import-graph impact and typecheck failures.

Suggested independent tasks:

- Catalog: add categories or product archival in `catalog/`.
- Inventory: add reservation release and low-stock warnings in `inventory/`.
- Pricing: add coupons, taxes or rule ordering in `pricing/`.
- Orders: add payment transitions or cancellation in `orders/`.
- Shipping: add express service levels in `shipping/`.
- Presentation: change receipts and order views in `notifications/` and `ui/`.
- Analytics: add revenue grouping in `analytics/`.

Useful intentional collision seams:

- Change `Money.cents` in `shared/money.ts`; pricing, shipping, receipts and UI are affected.
- Change `Product.price` in `catalog/product.ts`; catalog fixtures and pricing collide.
- Change `OrderStatus` in `orders/types.ts`; analytics, receipts and UI consume it.
- Change `QuoteLine` in `pricing/types.ts`; the pricing engine and order service consume it.
- Change `StockItem.reserved` in `inventory/types.ts`; reservation and pricing availability collide.

Run `pnpm --filter @agentigram/demo-repo test` and
`pnpm --filter @agentigram/demo-repo typecheck` after each experiment.
