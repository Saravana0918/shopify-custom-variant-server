// server.js
// Shopify custom-variant server
// - accepts base64 image -> uploads to Shopify Files
// - creates unpublished product with that image as product image
// - returns variantId for adding to cart
// - webhook to cleanup temporary products after order created
// Debug-friendly: logs full Shopify responses when errors occur.

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // v2 style
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '20mb' })); // allow reasonably large images

const SHOP = process.env.SHOPIFY_STORE; // e.g. "yogireddy.myshopify.com"
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN; // Admin API token (shpat_...)
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const TEMP_SKU_PREFIX = process.env.TEMP_SKU_PREFIX || 'CUST-';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PORT = process.env.PORT || 5000;

if (!SHOP || !TOKEN) {
  console.error('Missing SHOPIFY_STORE or SHOPIFY_ADMIN_API_TOKEN in environment.');
  process.exit(1);
}

/**
 * Debug-friendly Shopify request helper
 * - logs status + raw response when non-OK
 * - throws informative errors including raw body
 */
async function shopifyRequest(path, method = 'GET', body = null) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/${path}`;
  const headers = {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const status = res.status;
  const statusText = res.statusText;
  const raw = await res.text();

  console.log('--- SHOPIFY REQUEST DEBUG ---');
  console.log('URL:', url);
  console.log('METHOD:', method);
  console.log('STATUS:', status, statusText);
  try {
    const parsed = JSON.parse(raw);
    console.log('RESPONSE JSON:', JSON.stringify(parsed, null, 2));
  } catch (e) {
    console.log('RAW RESPONSE BODY (non-JSON):', raw);
  }
  console.log('--- END SHOPIFY DEBUG ---');

  if (!res.ok) {
    // Include raw body in the thrown error for the route handler to return
    throw new Error(`Shopify API error (${status} ${statusText}): ${raw}`);
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Shopify JSON parse error: ${raw}`);
  }
}

/**
 * Upload a base64 attachment to Shopify Files
 * Returns the public file URL
 */
async function uploadFileToShopify(base64, filename) {
  // Keep preview small in logs (don't log raw base64)
  const body = {
    file: {
      attachment: base64,
      filename
    }
  };
  const data = await shopifyRequest('files.json', 'POST', body);
  if (!data || !data.file || !data.file.url) {
    throw new Error('Shopify file upload failed: ' + JSON.stringify(data));
  }
  return data.file.url;
}

/**
 * Create an unpublished product with the uploaded file URL as its image
 */
async function createHiddenProductWithImage({ title = 'Custom Jersey', fileUrl, price = '499.00' }) {
  const body = {
    product: {
      title,
      vendor: "Next Print",
      product_type: "Custom Jersey",
      published: false,
      images: [{ src: fileUrl }],
      variants: [
        {
          option1: "Default",
          price: String(price || '499.00'),
          sku: `${TEMP_SKU_PREFIX}${Date.now()}`
        }
      ]
    }
  };

  const data = await shopifyRequest('products.json', 'POST', body);
  if (!data || !data.product) throw new Error('Failed to create product: ' + JSON.stringify(data));
  return data.product;
}

/**
 * Delete product by id
 */
async function deleteProduct(productId) {
  await shopifyRequest(`products/${productId}.json`, 'DELETE');
}

/**
 * API: create-custom-product
 * Body: { title, imageBase64, price }
 */
app.post('/api/create-custom-product', async (req, res) => {
  try {
    const { title = 'Custom Jersey', imageBase64, price } = req.body;

    console.log('Incoming create-custom-product request:', {
      title,
      price,
      imageBase64Length: imageBase64 ? imageBase64.length : 0
    });

    if (!imageBase64) return res.status(400).json({ success: false, message: 'imageBase64 required' });

    // Create a filename (use .jpg/jpeg for smaller size usually)
    const filename = `custom-${Date.now()}.jpg`;

    console.log('Uploading file to Shopify Files (filename preview):', filename);
    const fileUrl = await uploadFileToShopify(imageBase64, filename);
    console.log('Uploaded file URL:', fileUrl);

    const product = await createHiddenProductWithImage({ title, fileUrl, price });

    const variant = (product.variants && product.variants[0]) || null;
    const variantId = variant && variant.id;
    const sku = variant && variant.sku;

    console.log('Created hidden product:', { productId: product.id, variantId, sku });

    res.json({ success: true, productId: product.id, variantId, sku, fileUrl });
  } catch (err) {
    console.error('create-custom-product error:', err && err.message ? err.message : err);
    // If it's a Shopify API error we included raw body in the message — return that to caller for debugging
    return res.status(500).json({ success: false, message: err.message || String(err) });
  }
});

/**
 * Webhook: orders/create
 * Body: raw JSON (Shopify HMAC verification)
 */
app.post('/webhooks/orders/create', express.raw({ type: 'application/json' }), async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
  if (secret) {
    try {
      const generatedHash = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
      if (!crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmac))) {
        console.warn('Webhook HMAC verification failed.');
        return res.status(401).send('HMAC mismatch');
      }
    } catch (e) {
      console.warn('Webhook HMAC check error', e);
      return res.status(401).send('HMAC check error');
    }
  }

  try {
    const bodyJson = JSON.parse(req.body.toString('utf8'));
    const lineItems = bodyJson.line_items || [];
    const toCleanupProducts = new Set();

    for (const li of lineItems) {
      const sku = li.sku || '';
      if (sku && sku.startsWith(TEMP_SKU_PREFIX)) {
        const variantId = li.variant_id;
        if (variantId) {
          try {
            const vdata = await shopifyRequest(`variants/${variantId}.json`, 'GET');
            if (vdata && vdata.variant && vdata.variant.product_id) {
              toCleanupProducts.add(vdata.variant.product_id);
            }
          } catch (e) {
            console.error('Error fetching variant for cleanup', variantId, e && e.message ? e.message : e);
          }
        }
      }
    }

    for (const pid of Array.from(toCleanupProducts)) {
      try {
        await deleteProduct(pid);
        console.log('Deleted temporary product', pid);
      } catch (e) {
        console.error('Failed to delete product', pid, e && e.message ? e.message : e);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error processing order webhook', err && err.message ? err.message : err);
    res.status(500).send('Error');
  }
});

/**
 * Admin route: manual cleanup (scans unpublished products and deletes those with TEMP_SKU_PREFIX)
 * Protected by x-admin-key header (set ADMIN_KEY env)
 */
app.post('/admin/cleanup-temp-products', express.json(), async (req, res) => {
  try {
    if (ADMIN_KEY && req.get('x-admin-key') !== ADMIN_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const listRes = await shopifyRequest('products.json?limit=250&published_status=unpublished', 'GET');
    const products = listRes.products || [];
    const deleted = [];

    for (const p of products) {
      const shouldDelete = p.variants && p.variants.some(v => v.sku && v.sku.startsWith(TEMP_SKU_PREFIX));
      if (shouldDelete) {
        try {
          await deleteProduct(p.id);
          deleted.push(p.id);
        } catch (e) {
          console.error('Failed to delete product', p.id, e && e.message ? e.message : e);
        }
      }
    }

    res.json({ success: true, deletedCount: deleted.length, deleted });
  } catch (err) {
    console.error('cleanup-temp-products error', err && err.message ? err.message : err);
    res.status(500).json({ success: false, message: err.message || String(err) });
  }
});

/**
 * Health
 */
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'development' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
