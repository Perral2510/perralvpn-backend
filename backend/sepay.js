const { SePayPgClient } = require('sepay-pg-node');

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function getSepayConfig() {
  const merchantId = String(process.env.SEPAY_MERCHANT_ID || '').trim();
  const secretKey = String(process.env.SEPAY_SECRET_KEY || '').trim();
  if (!merchantId || !secretKey) return null;
  const env = process.env.SEPAY_ENV === 'production' ? 'production' : 'sandbox';
  const frontendOrigin = normalizeOrigin(process.env.FRONTEND_ORIGIN || process.env.PUBLIC_FRONTEND_URL);
  if (!frontendOrigin) throw new Error('FRONTEND_ORIGIN is required for SePay callback URLs');
  return { merchantId, secretKey, env, frontendOrigin };
}

function getSepayCheckout(order, user) {
  const config = getSepayConfig();
  if (!config) return null;

  const client = new SePayPgClient({
    env: config.env,
    merchant_id: config.merchantId,
    secret_key: config.secretKey,
    checkout_version: 'v1',
  });
  const orderId = encodeURIComponent(order.id);
  const fields = client.checkout.initOneTimePaymentFields({
    operation: 'PURCHASE',
    payment_method: process.env.SEPAY_PAYMENT_METHOD || 'BANK_TRANSFER',
    order_invoice_number: order.id,
    order_amount: Number(order.total),
    currency: 'VND',
    order_description: `PERRALVPN - ${order.id}`,
    customer_id: String(user?.user_id_code || user?.id || ''),
    success_url: `${config.frontendOrigin}/#/payment-result?status=success&order=${orderId}`,
    error_url: `${config.frontendOrigin}/#/payment-result?status=error&order=${orderId}`,
    cancel_url: `${config.frontendOrigin}/#/payment-result?status=cancel&order=${orderId}`,
    custom_data: JSON.stringify({ orderId: order.id }),
  });

  return {
    checkoutUrl: client.checkout.initCheckoutUrl(),
    fields,
  };
}

function getSepayIpnSecret() {
  return String(process.env.SEPAY_IPN_SECRET_KEY || process.env.SEPAY_SECRET_KEY || '').trim();
}

module.exports = { getSepayCheckout, getSepayIpnSecret };
