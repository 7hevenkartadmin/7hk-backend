# Razorpay production payment flow

The website and Android app use the same backend payment-session API. The backend calculates the amount, creates the Razorpay Order, verifies capture with Razorpay, and atomically consumes the payment when the grocery order is created.

## Required production configuration

Set these only on the backend:

    RAZORPAY_KEY_ID=rzp_live_...
    RAZORPAY_KEY_SECRET=...
    RAZORPAY_WEBHOOK_SECRET=...

In the Razorpay Dashboard:

1. Enable automatic payment capture.
2. Add https://YOUR_API_HOST/api/v1/webhooks/razorpay as a webhook.
3. Subscribe to payment.authorized, payment.captured, payment.failed, order.paid, and refund.processed.
4. Use a dedicated webhook secret, different from the API key secret.

Production MongoDB must support transactions (Atlas or a replica set). The API intentionally refuses unsafe non-transactional online-order finalisation in production.

## Web and Expo/React Native sequence

### 1. Create or resume a checkout session

    POST /api/v1/payments/razorpay/order
    Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
    Content-Type: application/json

    {
      "items": [
        {
          "productId": "507f1f77bcf86cd799439011",
          "variantId": "507f1f77bcf86cd799439012",
          "quantity": 2
        }
      ],
      "couponCode": "SAVE10",
      "addressId": "507f1f77bcf86cd799439013"
    }

Keep the same idempotency key while retrying this operation. Do not generate a new key after a timeout. The response contains sessionId, public keyId, Razorpay orderId, amountPaise, currency, status, and expiresAt.

Only keyId is sent to clients. The API key secret and webhook secret must never be bundled into the web or Android app.

### 2. Open Razorpay Checkout

For Expo, install react-native-razorpay, create a development/production build with expo prebuild, and pass keyId, orderId, amountPaise, and currency to the native checkout. The native SDK does not run inside Expo Go.

### 3. Verify the checkout callback

    POST /api/v1/payments/razorpay/verify
    Content-Type: application/json

    {
      "paymentSessionId": "internal session id",
      "razorpay_order_id": "order_...",
      "razorpay_payment_id": "pay_...",
      "razorpay_signature": "64-character signature"
    }

The backend verifies the signature using the Razorpay Order ID stored in its database and fetches the payment from Razorpay. A session becomes verified only when the payment/order/amount/currency match and the payment is captured.

### 4. Recover from a lost callback or slow capture

    GET /api/v1/payments/razorpay/sessions/:sessionId
    POST /api/v1/payments/razorpay/sessions/:sessionId/reconcile

The reconcile endpoint fetches payments for the Razorpay Order server-to-server. If the status is authorized or processing, wait and retry reconciliation. Never ask the customer to pay again until reconciliation proves the previous session failed.

### 5. Create the grocery order

    POST /api/v1/orders
    Content-Type: application/json

    {
      "items": [{ "productId": "507f1f77bcf86cd799439011", "quantity": 2 }],
      "couponCode": "SAVE10",
      "addressId": "507f1f77bcf86cd799439013",
      "slotId": "507f1f77bcf86cd799439014",
      "paymentMethod": "razorpay",
      "paymentSessionId": "internal session id"
    }

The same payment session can create at most one order. Retrying this request after a network timeout returns the already-created order instead of decrementing inventory, consuming the slot, or charging again.

The server retains the price, coupon, tax, delivery-fee, and item snapshot that was approved at payment time. If an item or saved address becomes permanently unavailable after capture, the backend initiates one full, receipt-idempotent refund and exposes the refund state on the payment session.

## Client rules

- Disable the Pay button while a request is running.
- Persist the idempotency key and sessionId until checkout reaches a terminal state.
- Treat the backend session status as authoritative.
- Never mark an order paid from the SDK callback alone.
- Do not log signatures, API secrets, complete provider payloads, card data, OTPs, or UPI credentials.
- On an ambiguous timeout, reconcile first; do not start a second payment.
