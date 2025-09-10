/*
theme-snippet.js
Drop this snippet into your theme JavaScript where you handle the "Customize / Buy Now" action.
Assumes you have an HTMLCanvasElement (canvasEl) that contains the final preview.
*/
async function addCustomJerseyToCart(canvasEl, price='499.00') {
  try {
    // Resize or reduce quality if needed to save upload size
    const dataUrl = canvasEl.toDataURL('image/jpeg', 0.8);
    const base64 = dataUrl.split(',')[1];

    const resp = await fetch('/api/create-custom-product', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ title: 'Custom Jersey', imageBase64: base64, price })
    });
    const json = await resp.json();
    if (!json.success) {
      alert('Create failed: ' + (json.message || 'unknown'));
      return;
    }
    const variantId = json.variantId;
    if (!variantId) {
      alert('No variant id returned');
      return;
    }

    // Add to cart via AJAX
    const addResp = await fetch('/cart/add.js', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ id: variantId, quantity: 1 })
    });
    const addJson = await addResp.json();

    // Redirect to checkout
    window.location.href = '/checkout';
  } catch (err) {
    console.error('addCustomJerseyToCart error', err);
    alert('Something went wrong: ' + err.message);
  }
}