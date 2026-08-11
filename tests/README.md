# Backend Test Strategy

This backend uses Node's built-in test runner:

```bash
npm test
```

Useful focused commands:

```bash
npm run test:api
npm run test:services
npm run test:schemas
```

## Current Coverage

- Pricing and payment math
- Coupon discount caps
- Payment cart hash tamper detection
- Razorpay signature verification
- JWT signing, verification, and token hashing
- Role authorization middleware
- Zod request validation for orders, coupons, and delivery slots
- Validation middleware error shape
- API route health, 404, auth guard, validation, and malformed JSON behavior
- Coupon service decisions for active, missing, exhausted, and minimum-order coupons
- Delivery slot service behavior for availability, creation, and atomic reservation
- Mongoose model schemas for product, user, and order invariants
- Product search and operational index declarations
- Global error handler behavior
- SSE stream headers and event formatting
- Realtime event publishers
- Distance calculation for delivery checks
- Environment schema basics

## Why These Tests Exist

These tests protect the highest-risk production paths:

- Money cannot be changed by frontend totals.
- Coupons cannot bypass min/max/date rules.
- Razorpay payloads cannot be blindly trusted.
- Admin/customer role boundaries remain enforced.
- Order and delivery payloads reject unsafe values.
- Coupon and delivery-slot business rules fail with stable error codes.
- SSE realtime events keep a stable wire format.

## Next Test Layers

Add these as the app grows:

- Authenticated API integration tests for order creation, coupon success cases, and admin workflows.
- Database integration tests with a dedicated test MongoDB or mongodb-memory-server for successful order/coupon/admin workflows.
- Frontend component tests with Vitest and React Testing Library.
- End-to-end checkout/admin tests with Playwright.
- Load tests with k6 or Artillery for catalog search, OTP, order creation, and SSE connections.

Keep unit tests fast and deterministic. Put database or network-heavy tests in separate scripts so CI can run the fast suite on every commit.
