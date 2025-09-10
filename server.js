// server.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const bodyParser = require('body-parser');

const app = express();
app.use(express.json({ limit: '15mb' }));

const SHOP = process.env.SHOPIFY_STORE; // e.g. "yogireddy.myshopify.com"
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN; // admin token with write_products, write_files
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const TEMP_SKU_PREFIX = process.env.TEMP_SKU_PREFIX || 'CUST-';

if (!SHOP || !TOKEN) {
  console.error('Missing SHOPIFY_STORE or SHOPIFY_ADMIN_API_TOKEN in environment.');
  process.exit(1);
}

async function shopifyRequest(path, method = 'GET', body = null) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/${path}`;
  const headers = {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { throw new Error(`Shopify JSON parse error: ${text}`); }
}

async function uploadFileToShopify(base64, filename) {
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
          price: price,
          sku: `${TEMP_SKU_PREFIX}${Date.now()}`
        }
      ]
    }
  };

  const data = await shopifyRequest('products.json', 'POST', body);
  if (!data || !data.product) throw new Error('Failed to create product: ' + JSON.stringify(data));
  return data.product;
}

async function deleteProduct(productId) {
  await shopifyRequest(`products/${productId}.json`, 'DELETE');
}

app.post('/api/create-custom-product', async (req, res) => {
  try {
    const { title = 'Custom Jersey', imageBase64, price } = req.body;

    if (!imageBase64) return res.status(400).json({ success: false, message: 'imageBase64 required' });

    const filename = `custom-${Date.now()}.jpg`;
    const fileUrl = await uploadFileToShopify(imageBase64, filename);

    const product = await createHiddenProductWithImage({ title, fileUrl, price });

    const variantId = product.variants && product.variants[0] && product.variants[0].id;
    res.json({ success: true, productId: product.id, variantId, sku: product.variants[0].sku, fileUrl });
  } catch (err) {
    console.error('create-custom-product error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/webhooks/orders/create', express.raw({ type: 'application/json' }), async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
  if (secret) {
    const generatedHash = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
    if (!crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmac))) {
      console.warn('Webhook HMAC verification failed.');
      return res.status(401).send('HMAC mismatch');
    }
  }

  try {
    const bodyJson = JSON.parse(req.body.toString('utf8'));
    const lineItems = bodyJson.line_items || [];
    const toCleanupProducts = [];

    for (const li of lineItems) {
      const sku = li.sku || '';
      if (sku && sku.startsWith(TEMP_SKU_PREFIX)) {
        const variantId = li.variant_id;
        if (variantId) {
          try {
            const vdata = await shopifyRequest(`variants/${variantId}.json`, 'GET');
            if (vdata && vdata.variant && vdata.variant.product_id) {
              toCleanupProducts.push(vdata.variant.product_id);
            }
          } catch (e) {
            console.error('Error fetching variant for cleanup', variantId, e);
          }
        }
      }
    }

    for (const pid of toCleanupProducts) {
      try {
        await deleteProduct(pid);
        console.log('Deleted temporary product', pid);
      } catch (e) {
        console.error('Failed to delete product', pid, e);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error processing order webhook', err);
    res.status(500).send('Error');
  }
});

app.post('/admin/cleanup-temp-products', express.json(), async (req, res) => {
  try {
    const ADMIN_KEY = process.env.ADMIN_KEY || '';
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
          console.error('Failed to delete product', p.id, e);
        }
      }
    }

    res.json({ success: true, deletedCount: deleted.length, deleted });
  } catch (err) {
    console.error('cleanup-temp-products error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));