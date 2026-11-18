aveysocial - setup

1. Supabase > SQL Editor: paste schema.sql and run it (safe to re-run after updates).
2. (Testing) Authentication > Providers > Email: turn off "Confirm email".
3. Upload the folder (index.html, style.css, app.js, sw.js, manifest.webmanifest, icons) to an HTTPS host
   such as Netlify, Vercel or GitHub Pages.

Notifications when the app is closed (optional):
4. Open tools/vapid-keys.html in your browser and click "Generate keys".
5. Paste the PUBLIC key into app.js  (const VAPID_PUBLIC_KEY = '...').
6. In a terminal inside this folder (after supabase login / supabase link --project-ref hrqlwxltwhlfrkkvlaun):
     supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
     supabase functions deploy notify --no-verify-jwt
7. Open the site and tap "Turn on" in the notification banner.
   iPhone/iPad: first use Share > Add to Home Screen (iOS 16.4 or newer), then open it from the home screen.

Files and photos sent in a chat (paperclip button, drag and drop, or paste) go directly from one device to the
other over WebRTC. They are never uploaded to Supabase. Both people must be online. Stories, profile photos and
voice messages still use the Supabase storage bucket "chat-images".
