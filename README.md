# Cross-Queue — Demo Home Page

## The problem
When partying with my friends, the music is a must! However, we are split between Apple Music users and Spotify users, which leads to people annoyingly having to ask the host for their phone to add songs to queue if they have another music service as the host

This is a minimal static demo for a home page that lets a host sign in with Spotify or Apple Music and lets guests join via Web Bluetooth.

Files:

- `index.html` — main UI
- `app.css` — styles
- `app.js` — demo logic for OAuth and Bluetooth

Notes and setup

- Spotify: replace `SPOTIFY_CLIENT_ID` in `app.js` and add your app's redirect URI (this page) in the Spotify Developer Dashboard. This demo uses implicit grant for simplicity; for production use Authorization Code flow with a backend.
- Apple Music: include MusicKit JS in the page and set `APPLE_DEVELOPER_TOKEN` in `app.js`. You must generate a developer token using your Apple developer credentials and exchange music user tokens on the backend.
- Web Bluetooth: Web Bluetooth requires HTTPS and a compatible browser (Chrome). Running locally with `localhost` is allowed for dev, but remote testing needs HTTPS.

Run locally

Use a simple static server. From this folder run:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

Next steps

- Add backend endpoints to handle Spotify/Apple token exchange and to manage queue sessions.
- Implement Web Bluetooth GATT protocol between host and guests to exchange queue IDs and join tokens.
