# iPad studio publisher

The studio at `/publisher.html` is set up as the iPad path. It uses the same Supabase Edge Function as the Android publisher, so Cloudinary, GitHub, and Instagram secrets stay server-side.

## Install from Safari

1. Open `https://www.thechroniclesofafilm.com/publisher.html` on the iPad.
2. Tap Share, then Add to Home Screen.
3. Open `studio` from the Home Screen.
4. Enter the private publisher token once in settings.

The publisher page has its own PWA manifest, so the Home Screen app launches straight back into `/publisher.html` instead of the public homepage.

## Local testing

```sh
npm run publisher
```

Then open the local `/studio` route on the iPad over the same network, or use the hosted `/publisher.html` page after deployment.

## Native shell option

A native iPad app can use the same web bundle through Capacitor iOS. That is a packaging step, not a different studio:

```sh
npm install @capacitor/ios
npm run studio:prepare-web
npx cap add ios
npx cap sync ios
npx cap open ios
```

Build and signing then happen in Xcode.
