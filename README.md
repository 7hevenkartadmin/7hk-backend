# 7Heven Backend API

Modular monolith Express + MongoDB API for the 7Heven grocery product.

## Contract Coverage

- Customer website APIs: auth, profile, addresses, catalog, search/filtering, checkout, order history, status tracking.
- Admin dashboard APIs: products, categories, inventory, customers, orders, reports, analytics.
- Commerce APIs: coupons, delivery slots, invoices, barcode fields, COD and Razorpay payment records.
- Integration hooks: Razorpay verification and mock WhatsApp/order status notifications.
- Scope note: order tracking is status-timeline based as stated in the agreement; real-time GPS tracking is intentionally not implemented.

## Local Setup

```bash
cd backend
copy .env.example .env
npm install
npm run seed
npm run dev
```

The API runs on `http://localhost:5000`.

## Main Endpoint Groups

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/users/me`
- `GET /api/v1/catalog/products`
- `GET /api/v1/catalog/categories`
- `POST /api/v1/orders/quote`
- `POST /api/v1/orders`
- `GET /api/v1/orders/me`
- `PATCH /api/v1/orders/:id/status`
- `POST /api/v1/coupons/apply`
- `GET /api/v1/delivery-slots`
- `POST /api/v1/payments/razorpay/verify`
- `GET /api/v1/reports/dashboard`
- `GET /api/v1/admin/customers`
- `GET /api/v1/admin/inventory/low-stock`

## Security Defaults

- Helmet security headers
- CORS allowlist from env
- Rate limiting
- Mongo query sanitization
- HTTP parameter pollution protection
- Password hashing with bcrypt
- Access and refresh JWTs
- Role-based admin/manager/support authorization
- Zod request validation

## Verification

```bash
npm test
```
