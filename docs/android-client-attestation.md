# Android client attestation and catalog separation

The official Android app uses the shared API but must never receive Paan Corner catalog, promotion, order, payment-session, support-ticket, or realtime order data. This is a backend policy; hiding controls in React Native is not a security boundary.

## Request contract

Every request made by the official Android app must include:

```http
X-Client-Platform: android
X-Firebase-AppCheck: <fresh Firebase App Check token>
```

Authenticated calls must also include the access token returned by Android login:

```http
Authorization: Bearer <access token>
```

Refresh calls use the refresh token as the Bearer value. The website continues to use its existing HttpOnly cookies and does not need these Android headers.

The backend verifies App Check through Firebase Admin, checks that the verified Firebase App ID exactly matches `FIREBASE_ANDROID_APP_ID`, and binds `clientPlatform=android` into both access and refresh JWTs. An Android session cannot be replayed as a web session, and a web session cannot be upgraded into an Android session by changing a header.

## Firebase and Play Console setup

1. Register the exact Android application in Firebase and connect it to Google Play Integrity.
2. Configure the package name, SHA-256 fingerprints, Play Console cloud project, and allowed Play Integrity responses following Firebase's [Play Integrity provider setup](https://firebase.google.com/docs/app-check/android/play-integrity-provider).
3. Add Firebase App Check to the native Android build and obtain a token before API calls. Follow Firebase's [custom backend request contract](https://firebase.google.com/docs/app-check/android/custom-resource).
4. Give the backend runtime service account only the Firebase App Check Token Verifier role. Prefer workload identity/managed runtime credentials. For a non-managed host, point `GOOGLE_APPLICATION_CREDENTIALS` at a protected service-account file outside the repository; never bundle it in the app.
5. Configure the backend:

```dotenv
ANDROID_APP_CHECK_MODE=enforce
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_ANDROID_APP_ID=1:1234567890:android:abcdef123456
```

Because Firebase App Check uses native Android support, use an Expo development/EAS build that includes the native integration. Expo Go is not the production verification environment. Debug App Check tokens are development-only and must never be allowed in production.

## Safe rollout

1. Configure and test Firebase App Check in a staging project with `ANDROID_APP_CHECK_MODE=monitor`.
2. Publish the Android app version that sends both headers on every API call. Confirm monitor logs contain no missing or invalid attestations. Logs intentionally contain only a reason and request path, never a token.
3. Set the production environment values and deploy with `ANDROID_APP_CHECK_MODE=enforce`. Production configuration fails closed if enforcement or the Firebase identity is missing.
4. Existing web requests remain compatible. Existing Android sessions must log in again because platform-bound tokens are required.

## Enforced backend behavior

- Product/category queries exclude the protected category inside MongoDB queries, including direct ID/slug access, search, recommendations, and homepage shelves.
- Orders and support tickets linked to protected items are excluded at query time. Android create, cancel, payment, and support mutations validate visibility before changing state.
- Paan-referencing banners and coupons are excluded. Restricted-product consent is unavailable to Android.
- Customer realtime order events for protected orders are suppressed.
- Admin, owner, manager, and support accounts cannot authenticate or operate through the Android client identity.
- Hidden direct lookups return generic not-found errors so they do not confirm that a protected item exists.

## Security boundary

`X-Client-Platform` alone is not trusted and is not an anti-spoofing mechanism. Firebase App Check/Play Integrity authenticates the official app instance; session binding prevents a verified Android session from downgrading itself to web.

No backend can prove that an unauthenticated public HTTP request physically originated from an Android device when the caller deliberately omits all Android identity and impersonates the public website. The website is intentionally allowed to show the protected catalog, and an Android phone can use that website. The enforceable production guarantee is therefore: the official Android app's attested traffic and Android-bound sessions never receive the protected data. Do not use an embedded static API key as a substitute; it can be extracted and replayed.
