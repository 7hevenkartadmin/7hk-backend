# Razorpay production payment flow

The website and Android app use the same backend payment-session API. The backend calculates the amount, creates the Razorpay Order, verifies capture with Razorpay, and atomically consumes the payment when the grocery order is created.

## Required production configuration

Set these only on the backend:

    RAZORPAY_KEY_ID=rzp_live_...
    RAZORPAY_KEY_SECRET=...
    RAZORPAY_WEBHOOK_SECRET=...

`NODE_ENV=production` rejects Test Mode key IDs. Use a rotated `rzp_live_...` key only after the complete staging flow has passed. Never reuse the API key secret as the webhook secret.

In the Razorpay Dashboard:

1. Enable automatic payment capture.
2. Add https://YOUR_API_HOST/api/v1/webhooks/razorpay as a webhook.
3. Subscribe to payment.authorized, payment.captured, payment.failed, order.paid, and refund.processed.
4. Use a dedicated webhook secret, different from the API key secret.
5. Verify the public webhook URL returns `200` for valid events and `401` for an invalid signature.

Plan webhook-secret rotations around pending retries: Razorpay signs a retried older delivery with the secret that was active for that delivery.

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
      "addressId": "507f1f77bcf86cd799439013",
      "slotId": "507f1f77bcf86cd799439014"
    }

Keep the same idempotency key while retrying this operation. Do not generate a new key after a timeout. The response contains sessionId, public keyId, Razorpay orderId, amountPaise, currency, status, and expiresAt.

The backend rejects online totals below 100 paise before creating a provider order or retaining a checkout reservation. Creation is limited to 6 requests per customer per 15 minutes and at most 3 active held sessions. Known idempotency/cart retries are resumed before the active-session count. Clients must display the returned `amountPaise`; they must not calculate or override it.

The active-session count is defense in depth, not a serialized per-customer semaphore. The rate limiter is process-local unless deployment supplies a shared store. Multi-instance deployments must use a shared limiter store; if a mathematically strict concurrent session maximum is required, add transactionally claimed per-user lease slots with a unique `(user, leaseSlot)` index.

Only keyId is sent to clients. The API key secret and webhook secret must never be bundled into the web or Android app.

### 2. Open Razorpay Checkout

For Expo, install react-native-razorpay, create a development/production build with expo prebuild, and pass keyId, orderId, amountPaise, and currency to the native checkout. The native SDK does not run inside Expo Go.

For a native Android application, use the current Razorpay Standard Checkout SDK, set the public `keyId`, and pass the backend response as `order_id`, `amount`, and `currency`. Send the three success callback fields to the shared verification endpoint below. On `onPaymentError`, keep `sessionId`, show a retryable message, and reconcile before creating another session whenever the result is uncertain.

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

`paymentSessionId` is mandatory. It binds the callback to the authenticated customer's internal checkout and prevents a client from asking the server to trust a provider order ID by itself.

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

The server retains the price, coupon, tax, delivery-fee, item, delivery-address, and delivery-window snapshot approved at payment time. Paid finalization recalculates distance from the immutable coordinates, not mutable saved-address fields, and displays the paid slot window rather than later staff edits. If a required snapshot is missing or fulfillment becomes permanently unavailable after capture, the backend initiates one full, receipt-idempotent refund and exposes the refund state on the payment session.

### 6. Abandon a confirmed-unpaid checkout

    POST /api/v1/payments/razorpay/sessions/:sessionId/abandon

Use this when the customer dismisses an unpaid checkout or changes cart, coupon, address, or slot. The backend reconciles `created` sessions before releasing stock, slot, and coupon holds. Never call this as a reset for an authorized, verified, processing, consumed, or refund-state session; reconcile those states instead.

## Client rules

- Disable the Pay button while a request is running.
- Persist the idempotency key and sessionId until checkout reaches a terminal state.
- Treat the backend session status as authoritative.
- Never mark an order paid from the SDK callback alone.
- Do not log signatures, API secrets, complete provider payloads, card data, OTPs, or UPI credentials.
- On an ambiguous timeout, reconcile first; do not start a second payment.
- Treat modal dismissal as cancellation, not failure or success. Reconcile, then abandon only if the backend confirms the session is unpaid. Do not create the grocery order.
- Treat `payment.failed` as an attempted-payment failure. The same Razorpay Order can support another attempt while its inventory reservation remains valid.
- Do not let an Android Activity, web reload, or network loss discard `sessionId` until reconciliation reaches a terminal state.

## Release test matrix

Run these cases with Test Mode credentials on staging before switching to Live Mode:

1. Successful UPI/card payment creates exactly one paid grocery order.
2. Invalid signature returns `400` and creates no order.
3. Modal dismissal creates no order; reconciliation plus abandonment safely releases its holds.
4. Provider decline shows an error and creates no paid order.
5. Client timeout after payment succeeds is recovered through reconciliation without a second payment.
6. Duplicate verification, order-creation, and webhook requests remain idempotent.
7. A captured payment that cannot be fulfilled releases stock, slot, and coupon and enters the automatic refund path.
8. Duplicate and out-of-order webhooks do not regress a captured or consumed payment.
9. Expired unpaid sessions release all reservations.
10. A cancelled paid order is refunded once and its refund webhook updates the order ledger.
11. A stale webhook record left in `processing` is atomically reclaimed after its five-minute lease.
12. A different authenticated customer cannot read, verify, reconcile, abandon, or consume the session.
