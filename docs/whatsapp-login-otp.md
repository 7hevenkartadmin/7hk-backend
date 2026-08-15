# WhatsApp login OTP

This flow is shared by the storefront and Android app. Login OTPs use the
`LOGIN` purpose and the `WHATSAPP` channel. Order-delivery OTPs are a separate
future flow: they use the `DELIVERY` purpose and the `IN_APP` channel and must
not reuse these routes or Meta messages.

## Meta setup

1. Create and approve the authentication template described in
   `meta-whatsapp-auth-template.json` for the WhatsApp Business Account.
2. Configure the `META_*` and `WHATSAPP_PROVIDER=meta` environment variables
   listed in `.env.example`.
3. Configure this callback in Meta and subscribe the WhatsApp Business Account
   to message events:

   `https://<api-host>/api/v1/webhooks/whatsapp`

4. Use the same private value for Meta's webhook verification token and
   `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`. The backend additionally validates
   every callback's `X-Hub-Signature-256` using `META_WHATSAPP_APP_SECRET`.

The template name and language must exactly match the approved Meta template.
Keep `META_GRAPH_API_VERSION` configurable and set it to a currently supported
Graph API version before deployment.

## Client flow

All examples below show the `data` portion of the normal API response envelope.
The customer client makes no delivery-status requests. Meta delivery callbacks
are processed privately by the backend for short-lived operational diagnostics.

### 1. Request

`POST /api/v1/auth/otp/request`

```json
{ "phone": "+919876543210" }
```

```json
{
  "expiresInSeconds": 300,
  "resendAfterSeconds": 30
}
```

Show the OTP input immediately after this response. A correct OTP is itself
proof that the customer received the WhatsApp message, so login does not wait
for a delivery webhook.

### 2. Resend

After `resendAfterSeconds`, call `POST /api/v1/auth/otp/resend` with the same
phone body. The replacement invalidates the old OTP and starts a fresh expiry
window.

### 3. Verify and keep the session

`POST /api/v1/auth/otp/verify`

```json
{ "phone": "+919876543210", "otp": "123456", "name": "Optional for a new customer" }
```

The response exposes only the user. Authentication tokens are returned as
HttpOnly cookies. The website uses `credentials: include`. The Android HTTP
client must use a persistent, secure cookie jar, accept `Set-Cookie`, and send
the cookies on later API requests. It must never copy session cookies into app
logs or general preferences.

## Operational behavior

- A successful Graph API call means Meta accepted the message; it does not mean
  the phone received it. Webhook status is retained only for backend delivery
  diagnostics and never blocks login.
- Status processing is monotonic, so late or out-of-order callbacks cannot move
  a challenge backwards.
- Verification is atomic and can proceed as soon as the customer has the OTP.
- Provider and webhook logs must use request IDs and sanitized error codes, not
  OTPs, phone numbers, access tokens, message bodies, or webhook payloads.
- For the expected load (at most about 10,000 users per month), one Redis-backed
  queue worker on the single application server is sufficient. Redis remains
  required for atomic verification, rate limits, queue durability, and delivery
  state.

## Deployment smoke test

Use one allow-listed test number before opening production traffic:

1. Request an OTP and confirm the API returns only an opaque token and timing
   metadata.
2. Confirm Meta accepts the template message and that webhook diagnostics
   observe `DELIVERED` or `READ` without generating browser requests.
3. Verify that a correct OTP succeeds exactly once and that an old OTP fails
   after resend.
4. Send an invalid webhook signature and confirm it receives HTTP 401.
5. Confirm neither application logs nor monitoring contain phone numbers, OTPs,
   access tokens, cookies, or raw webhook bodies.
