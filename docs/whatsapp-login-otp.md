# WhatsApp login OTP

This flow is shared by the storefront and Android app. Login OTPs use the
`LOGIN` purpose and the `WHATSAPP` channel. Order-delivery OTPs are a separate
future flow: they use the `DELIVERY` purpose and the `IN_APP` channel and must
not reuse these routes or Meta messages.

## Local development

Set `NODE_ENV=development`, `WHATSAPP_PROVIDER=console`, and
`OTP_WORKER_ENABLED=true`. Request an OTP normally, then read the generated
code from the backend terminal. The console provider masks the phone number and
uses the same Redis challenge, expiry, resend cooldown, attempt limit, and
verification routes as Meta delivery. It is rejected by production environment
validation, where `WHATSAPP_PROVIDER=meta` remains mandatory.

## Meta setup

1. Create and approve the authentication template described in
   `meta-whatsapp-auth-template.json` for the WhatsApp Business Account.
2. Configure the `META_*` and `WHATSAPP_PROVIDER=meta` environment variables
   listed in `.env.example`.
3. Configure the exact public HTTPS callback URL from
   `WHATSAPP_PUBLIC_CALLBACK_URL` in Meta. It must identify the deployed route,
   for example:

   `https://api.example.com/api/v1/webhooks/whatsapp`

4. Complete Meta's GET verification challenge. The callback accepts
   `hub.mode=subscribe` only when `hub.verify_token` exactly matches
   `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`, then returns `hub.challenge` as plain
   text.
5. Subscribe the WhatsApp Business Account to the `messages` webhook field.
6. Keep `META_WHATSAPP_APP_SECRET` private. Every callback POST must include a
   valid `X-Hub-Signature-256` computed over the exact raw request bytes. The
   backend rejects an invalid signature before parsing statuses or changing
   correlation/delivery state.

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
- Production provider and webhook logs must use request IDs and sanitized error
  codes, not OTPs, phone numbers, access tokens, message bodies, or webhook
  payloads. The development-only console provider intentionally prints the OTP
  with only the final four phone digits and must never be selected in production.
- For the expected load (at most about 10,000 users per month), one Redis-backed
  queue worker on the single application server is sufficient. Redis remains
  required for atomic verification, rate limits, queue durability, and delivery
  state.

## Deployment smoke test and readiness evidence

Use exactly one operator-approved, allow-listed test number before opening
production traffic. Configure it as `WHATSAPP_SMOKE_TEST_ALLOWLISTED_PHONE` in
the deployment environment; do not pass a target number on the command line or
write it into evidence, logs, or terminal output.

1. Request an OTP and confirm the response `data` contains only
   `expiresInSeconds` and `resendAfterSeconds`. It contains no response token.
2. Capture timestamped evidence of a Meta-originated callback reaching the
   exact configured public HTTPS callback URL. A local request is insufficient.
3. Capture timestamped evidence that Meta's GET verification challenge succeeds
   with the configured verification token.
4. Confirm through Meta Dashboard or the Meta API that the WhatsApp Business
   Account is subscribed to the `messages` webhook field.
5. During the allow-listed OTP flow, accept a status callback with a valid
   signature over the exact raw body and confirm its sanitized diagnostic
   contains the originating request ID.
6. Send an invalid-signature callback and confirm HTTP 401 with unchanged
   correlation and delivery state.
7. Verify the OTP once, verify that an old OTP fails after resend, and confirm
   application logs and monitoring contain no complete phone, OTP, credential,
   token, cookie, message body, provider payload, or raw webhook body.

Record the five callback checks through a trusted deployment collector. The
collector must derive its facts from Meta configuration, correlated backend
diagnostics, and before/after callback state rather than accepting operator
booleans. It must create a unique UUID `WHATSAPP_CALLBACK_READINESS_RUN_ID` for
each attempt and bind the evidence to the configured environment, deployment ID,
callback URL, and `WHATSAPP_CALLBACK_EVIDENCE_PRODUCER_ID`.

Configure the collector's Ed25519 public verification key as the base64 DER
`WHATSAPP_CALLBACK_EVIDENCE_PUBLIC_KEY`. The corresponding private signing key
must not be available to the gate or operator process and must never be stored in
the repository, evidence, logs, command arguments, or terminal output. The gate
contains no generic signing helper and cannot create passing evidence; it only
verifies artifacts emitted by the independently trusted collector. Signed
evidence is valid for at most ten minutes, and every check timestamp must fall
between its signed `issuedAt` and `expiresAt` values.

The evidence contains only version and run bindings, an allow-list confirmation,
and these named checks: `metaOriginatedReachability`,
`verificationChallenge`, `messageEventSubscription`,
`validSignedCorrelatedStatus`, and
`invalidSignatureRejectedWithoutMutation`. Valid-status evidence also requires
the sanitized request ID, and invalid-signature evidence requires HTTP 401 and
`stateChanged: false`. Do not put the test number, private signing key, or any
secret or payload in this file. Do not hand-edit or self-attest deployed facts:
any change after signing invalidates public-key signature verification.

Run the noninteractive repository gate after configuring the readiness names
shown in `.env.example`:

```sh
npm run verify:whatsapp-callback-readiness -- --evidence ./callback-evidence.json
```

The command performs no Meta request and sends no message. It atomically records
the authenticated run ID under `WHATSAPP_CALLBACK_EVIDENCE_REPLAY_DIRECTORY`,
so reused evidence is rejected. It also rejects unsigned, tampered, stale,
future-dated, overlong-window, or incorrectly bound evidence. It exits nonzero
and prints only sanitized failed-check names with environment/deployment/run
identifiers until all five checks pass. Repository tests do not complete Meta
setup; an operator must collect and authenticate these deployed facts before
callback readiness can be declared.

Production login completion requires a transaction-capable MongoDB deployment.
Set `REQUIRE_INTEGRATION_FIXTURES=true` in required CI and pre-production test
jobs so validation fails if Redis or transaction-capable MongoDB is unavailable.
Local developer runs may leave it false and receive explicit fixture skips.
