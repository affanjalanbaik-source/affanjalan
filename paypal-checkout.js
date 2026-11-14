'use strict';

// This file is loaded by the Node server into the existing checkout page.
// The only browser-exposed PayPal value is the public client ID.
(() => {
  const $ = (selector) => document.querySelector(selector);
  let paypalLoaded = false;
  let paypalButtonsMounted = false;
  let config;

  const ensureStyles = () => {
    if (document.getElementById('paypal-checkout-styles')) return;
    const style = document.createElement('style');
    style.id = 'paypal-checkout-styles';
    style.textContent = `
      #paypalCheckoutPanel{margin-top:18px;padding:16px;border:1px solid var(--line,#e5e5e5);border-radius:10px;background:#fff}
      #paypalCheckoutPanel h3{margin:0 0 6px;font-size:1rem}
      #paypalCheckoutPanel p{margin:0 0 12px;font-size:.84rem;color:var(--muted,#737373)}
      #paypalButtons{min-height:44px}
      #paypalStatus{margin:10px 0 0;font-size:.85rem}
      #paypalStatus.error{color:var(--red,#d64545)}
      #paypalStatus.success{color:var(--green,#258a55)}
      #paypalSandboxNotice{margin:12px 0 0;padding:10px 12px;background:var(--soft,#f7f7f8);border:1px solid var(--line,#e5e5e5);border-radius:8px;font-size:.78rem;color:var(--muted,#737373)}
      .download-link{display:block;margin-top:8px;text-decoration:underline;overflow-wrap:anywhere}
    `;
    document.head.append(style);
  };

  function cartPayload() {
    let cart = [];
    try { cart = JSON.parse(localStorage.getItem('affan-cart') || '[]'); } catch (_) {}
    if (!Array.isArray(cart)) cart = [];
    return cart.map((item) => ({ beatId: item.beatId, licenseId: item.licenseId, quantity: Math.max(1, Math.min(20, Number(item.qty) || 1)) }));
  }

  function status(message, type = '') {
    const node = $('#paypalStatus');
    if (!node) return;
    node.textContent = message;
    node.className = type;
  }

  async function loadConfig() {
    const response = await fetch('/api/paypal/config', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('PayPal checkout is not configured on this server.');
    config = await response.json();
    if (!config.clientId || config.currency !== 'USD') throw new Error('PayPal USD configuration is incomplete.');
  }

  async function loadSdk() {
    if (paypalLoaded) return;
    await loadConfig();
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&currency=USD&intent=capture&components=buttons&enable-funding=paylater,venmo`;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load the official PayPal Checkout SDK.'));
      document.head.append(script);
    });
    if (!window.paypal?.Buttons) throw new Error('PayPal Checkout SDK is unavailable.');
    paypalLoaded = true;
  }

  function ensureCheckoutPanel() {
    const form = $('#checkoutForm');
    const summary = $('#checkoutItems')?.closest('.panel');
    if (!form || !summary) return null;
    let panel = $('#paypalCheckoutPanel');
    if (panel) return panel;

    panel = document.createElement('section');
    panel.id = 'paypalCheckoutPanel';
    panel.setAttribute('aria-labelledby', 'paypalHeading');
    panel.innerHTML = `
      <h3 id="paypalHeading">Pay with PayPal</h3>
      <p>Continue through PayPal's secure approval experience. Available options are determined by PayPal for your account and country.</p>
      <div id="paypalButtons"></div>
      <div id="paypalStatus" role="status" aria-live="polite"></div>
      <div id="paypalSandboxNotice">Sandbox checkout is active. Use PayPal Sandbox buyer accounts only; no live payment will be collected.</div>
    `;
    form.append(panel);
    const oldSubmit = $('#confirmBtn');
    if (oldSubmit) oldSubmit.hidden = true;
    form.addEventListener('submit', (event) => event.preventDefault());
    return panel;
  }

  async function mountButtons() {
    if (paypalButtonsMounted) return;
    ensureStyles();
    ensureCheckoutPanel();
    const nameInput = $('#customerName');
    const emailInput = $('#customerEmail');
    if (!nameInput?.value.trim() || !emailInput?.checkValidity()) {
      status('Enter your full name and a valid email address before continuing.', 'error');
      (nameInput?.value.trim() ? emailInput : nameInput)?.focus();
      return;
    }

    const buttonRoot = $('#paypalButtons');
    buttonRoot.replaceChildren();
    status('Loading PayPal checkout…');

    try {
      await loadSdk();
      const checkoutCustomer = { name: nameInput.value.trim(), email: emailInput.value.trim() };
      window.paypal.Buttons({
        style: { layout: 'vertical', shape: 'rect', label: 'paypal', tagline: false },
        createOrder: async () => {
          const items = cartPayload();
          if (!items.length) throw new Error('Your cart is empty.');
          const response = await fetch('/api/paypal/orders', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ items, customer: checkoutCustomer })
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || !body.id) throw new Error(body.error || 'Could not create a PayPal order.');
          return body.id;
        },
        onApprove: async (data) => {
          const items = cartPayload();
          status('Verifying payment with PayPal…');
          const response = await fetch(`/api/paypal/orders/${encodeURIComponent(data.orderID)}/capture`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ items, customer: checkoutCustomer })
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || body.status !== 'PAID') throw new Error(body.error || 'Payment has not been verified. No files are available yet.');

          status('Payment verified. Your order is marked paid.', 'success');
          const summary = $('#checkoutItems');
          if (summary) {
            const receipt = document.createElement('p');
            receipt.textContent = `PayPal capture: ${body.captureId}. Save this confirmation for your records.`;
            receipt.className = 'notice';
            summary.append(receipt);
          }
          if (Array.isArray(body.downloads) && body.downloads.length) {
            const links = document.createElement('div');
            body.downloads.forEach((item) => {
              const link = document.createElement('a');
              link.className = 'download-link';
              link.href = item.url;
              link.textContent = `Download ${item.title} (${item.license})`;
              links.append(link);
            });
            $('#paypalCheckoutPanel').append(links);
          } else {
            const note = document.createElement('p');
            note.className = 'notice';
            note.textContent = 'Payment is verified. Secure file delivery is not configured for this demo catalog yet; contact the producer to arrange delivery. No unapproved or unpaid files have been released.';
            $('#paypalCheckoutPanel').append(note);
          }
          localStorage.removeItem('affan-cart');
          window.dispatchEvent(new CustomEvent('affan-cart-updated'));
          const count = document.getElementById('cartCount');
          if (count) count.textContent = '0';
        },
        onCancel: () => status('PayPal approval was cancelled. No payment was captured.', 'error'),
        onError: (error) => {
          console.error('PayPal Checkout error', error);
          status(error?.message || 'PayPal could not complete this checkout. Please try again.', 'error');
        }
      }).render(buttonRoot);
      paypalButtonsMounted = true;
      status('Choose a payment option in PayPal to continue.');
    } catch (error) {
      console.error('PayPal initialization error', error);
      status(error.message || 'PayPal checkout is temporarily unavailable.', 'error');
    }
  }

  function init() {
    const form = $('#checkoutForm');
    if (!form) return;
    ensureStyles();
    ensureCheckoutPanel();
    const submit = $('#confirmBtn');
    if (submit) {
      submit.hidden = false;
      submit.textContent = 'Continue to PayPal';
      submit.addEventListener('click', (event) => {
        event.preventDefault();
        mountButtons();
      });
    }
    window.addEventListener('hashchange', () => {
      if (location.hash === '#checkout') {
        paypalButtonsMounted = false;
        const root = $('#paypalButtons');
        if (root) root.replaceChildren();
        const old = $('#confirmBtn');
        if (old) old.hidden = false;
        status('Enter your name and email, then continue to PayPal.');
      }
    });
    window.addEventListener('affan-cart-updated', () => { paypalButtonsMounted = false; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
