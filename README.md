# Shopify Custom Variant Server
This project implements the "create a temporary hidden product with customer's custom preview image" flow so the customized image appears in Shopify Checkout.

## What it does
1. Accepts base64 image from frontend (`/api/create-custom-product`).
2. Uploads image to Shopify Files.
3. Creates an unpublished (hidden) product with the image as product image and a variant whose SKU starts with `CUST-`.
4. Returns `variantId` to frontend.
5. Frontend adds returned variant to `/cart/add.js` and redirects to `/checkout`.
6. On `orders/create` webhook, server finds temporary products (by SKU prefix) and deletes them.

## Files
- `server.js` - main Express server
- `package.json` - dependencies
- `.env.example` - environment variables example
- `theme-snippet.js` - frontend snippet to call server and add variant to cart

## Environment variables
Copy `.env.example` to `.env` and fill values:
```
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=shpat_xxx
SHOPIFY_API_VERSION=2024-07
SHOPIFY_WEBHOOK_SECRET=your_webhook_secret_here
TEMP_SKU_PREFIX=CUST-
PORT=5000
ADMIN_KEY=some-admin-secret
```

## Setup
1. `npm install`
2. `cp .env.example .env` and fill variables.
3. `npm start` (or `npm run dev` with nodemon)
4. Expose server via HTTPS (Render/Heroku/VPS or use ngrok/Cloudflare Tunnel for testing).
5. Create webhook in Shopify admin:
   - Topic: `orders/create`
   - URL: `https://<your-server>/webhooks/orders/create`
   - Enter the webhook secret into `SHOPIFY_WEBHOOK_SECRET`.

## Important notes
- Compress images before upload (use JPEG quality or resize canvas).
- Protect admin cleanup route `/admin/cleanup-temp-products` with `ADMIN_KEY`.
- Track temporary products in a DB if you want stronger guarantees (optional).
- Use rate-limiting and prevent duplicate clicks on frontend.

## Troubleshooting
- If product images not updating in cart: ensure your theme reads variant image (most default themes do).
- If webhook not firing: verify webhook URL and secret, check Shopify webhooks in admin for delivery logs.