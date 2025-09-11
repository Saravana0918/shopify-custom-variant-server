// server.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '25mb' }));

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const TEMP_SKU_PREFIX = process.env.TEMP_SKU_PREFIX || 'CUST-';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PORT = process.env.PORT || 5000;

if (!SHOP || !TOKEN) {
  console.error('Missing SHOPIFY_STORE or SHOPIFY_ADMIN_API_TOKEN in environment.');
  process.exit(1);
}

/**
 * Simple REST helper (with debug)
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
  const text = await res.text();

  console.log('--- SHOPIFY REST DEBUG ---');
  console.log('URL:', url);
  console.log('METHOD:', method);
  console.log('STATUS:', status);
  try { console.log('RESPONSE JSON:', JSON.stringify(JSON.parse(text), null, 2)); }
  catch (e) { console.log('RAW RESPONSE:', text); }
  console.log('--- END REST DEBUG ---');

  if (!res.ok) throw new Error(`Shopify API error (${status}): ${text}`);
  try { return JSON.parse(text); } catch (e) { throw new Error('Shopify parse error: ' + text); }
}

/**
 * GraphQL helper for Shopify
 */
async function shopifyRequestGraphQL(query, variables = {}) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await res.text();
  console.log('--- SHOPIFY GRAPHQL DEBUG ---');
  console.log('QUERY:', query.replace(/\s+/g,' ').trim().slice(0,500)); // brief
  console.log('VARS:', JSON.stringify(variables ? Object.keys(variables) : variables));
  try { console.log('GRAPHQL RAW RESPONSE PREVIEW:', text.slice(0,1000)); }
  catch(e) { console.log('GRAPHQL RAW RESPONSE unreadable'); }
  console.log('--- END GRAPHQL DEBUG ---');

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Shopify GraphQL parse error: ' + text);
  }
}

/**
 * Upload base64 image using GraphQL fileCreate.
 * Use originalSource="data:image/jpeg;base64,..." (or image/png).
 * Returns publicly accessible URL (preview.image.url or GenericFile.url)
 */
async function uploadFileToShopify(base64, filename) {
  // Build data URI (use jpeg by default). If your canvas uses png, use image/png.
  const dataUri = `data:image/jpeg;base64,${base64}`;

  const query = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          __typename
          ... on GenericFile { id url }
          ... on MediaImage { id preview { image { url } } }
        }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    files: [
      {
        originalSource: dataUri,
        filename: filename,
        // optional: contentType: "IMAGE",
        // optional: alt: filename
      }
    ]
  };

  const json = await shopifyRequestGraphQL(query, variables);

  if (json.errors && json.errors.length) {
    throw new Error('GraphQL errors: ' + JSON.stringify(json.errors));
  }

  const fc = json.data && json.data.fileCreate;
  if (!fc) throw new Error('fileCreate missing in GraphQL response: ' + JSON.stringify(json));

  if (fc.userErrors && fc.userErrors.length) {
    throw new Error('GraphQL userErrors: ' + JSON.stringify(fc.userErrors));
  }

  const files = fc.files || [];
  for (const f of files) {
    if (!f) continue;
    if (f.__typename === 'MediaImage' && f.preview && f.preview.image && f.preview.image.url) {
      return f.preview.image.url;
    }
    if (f.__typename === 'GenericFile' && f.url) {
      return f.url;
    }
  }

  throw new Error('File upload returned no usable URL: ' + JSON.stringify(json));
}


/**
 * Create unpublished product with the uploaded file as image
 */
// Replace old createHiddenProductWithImage and remove uploadFileToShopify usage
async function createHiddenProductWithImage({ title = 'Custom Jersey', imageBase64, price = '499.00' }) {
  // imageBase64 must be pure base64 (no data: prefix). Shopify expects "attachment" = base64 string.
  const body = {
    product: {
      title,
      vendor: "Next Print",
      product_type: "Custom Jersey",
      published: false,
      images: [
        {
          attachment: imageBase64 // <-- pass base64 directly here
          // optionally you can pass "alt" or "filename" as separate metafields after creation
        }
      ],
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
 * Delete product
 */
async function deleteProduct(productId) {
  await shopifyRequest(`products/${productId}.json`, 'DELETE');
}

/**
 * API: create-custom-product
 */
app.post('/api/create-custom-product', async (req, res) => {
  try {
    const { title = 'Custom Jersey', imageBase64, price } = req.body;

    console.log('Incoming create-custom-product request:', { title, price, imageBase64Length: imageBase64 ? imageBase64.length : 0 });

    if (!imageBase64) return res.status(400).json({ success: false, message: 'imageBase64 required' });

    // NOTE: imageBase64 must be the raw base64 string WITHOUT data:image/... prefix.
    // If you have a data URL (data:image/png;base64,AAA...) strip the prefix:
    // const rawBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const rawBase64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

    const product = await createHiddenProductWithImage({ title, imageBase64: rawBase64, price });

    const variant = (product.variants && product.variants[0]) || null;
    const variantId = variant && variant.id;
    const sku = variant && variant.sku;
    const imageSrc = (product.images && product.images[0] && (product.images[0].src || product.images[0].attachment)) || null;

    res.json({ success: true, productId: product.id, variantId, sku, image: imageSrc, product });
  } catch (err) {
    console.error('create-custom-product error:', err && err.message ? err.message : err);
    res.status(500).json({ success: false, message: err.message || String(err) });
  }
});


/**
 * Webhook: orders/create (raw body, HMAC verify)
 */
app.post('/webhooks/orders/create', express.raw({ type: 'application/json' }), async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
  if (secret) {
    try {
      const gen = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
      if (!crypto.timingSafeEqual(Buffer.from(gen), Buffer.from(hmac))) {
        console.warn('Webhook HMAC verification failed.');
        return res.status(401).send('HMAC mismatch');
      }
    } catch (e) {
      console.warn('Webhook HMAC error', e);
      return res.status(401).send('HMAC error');
    }
  }

  try {
    const bodyJson = JSON.parse(req.body.toString('utf8'));
    const lineItems = bodyJson.line_items || [];
    const toCleanup = new Set();

    for (const li of lineItems) {
      const sku = li.sku || '';
      if (sku && sku.startsWith(TEMP_SKU_PREFIX)) {
        const variantId = li.variant_id;
        if (variantId) {
          try {
            const vdata = await shopifyRequest(`variants/${variantId}.json`, 'GET');
            if (vdata && vdata.variant && vdata.variant.product_id) {
              toCleanup.add(vdata.variant.product_id);
            }
          } catch (e) {
            console.error('Error fetching variant', variantId, e);
          }
        }
      }
    }

    for (const pid of Array.from(toCleanup)) {
      try { await deleteProduct(pid); console.log('Deleted temporary product', pid); }
      catch (e) { console.error('Failed delete', pid, e); }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook processing error', err);
    res.status(500).send('Error');
  }
});

/**
 * Admin cleanup route
 */
app.post('/admin/cleanup-temp-products', express.json(), async (req, res) => {
  try {
    if (ADMIN_KEY && req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const listRes = await shopifyRequest('products.json?limit=250&published_status=unpublished', 'GET');
    const products = listRes.products || [];
    const deleted = [];

    for (const p of products) {
      const shouldDelete = p.variants && p.variants.some(v => v.sku && v.sku.startsWith(TEMP_SKU_PREFIX));
      if (shouldDelete) {
        try { await deleteProduct(p.id); deleted.push(p.id); } catch (e) { console.error('Failed delete', p.id, e); }
      }
    }

    res.json({ success: true, deletedCount: deleted.length, deleted });
  } catch (err) {
    console.error('cleanup error', err);
    res.status(500).json({ success: false, message: err.message || String(err) });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'production' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
