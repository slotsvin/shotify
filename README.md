# Shotify

Play 60-second clips (or 30-second previews) from your Spotify playlists. Pick a playlist, optionally add an in-between sound between tracks. Built for **web hosting** (e.g. AWS, or a physical server); you use your own site URL as the Spotify redirect URI.

**Special thanks — all credit goes to [Jack Hanington](https://jackhanington.com/).** This project was vibe coded with Jack.

---

## What you need

- **Node.js** (v18 or newer) and **npm**
- A **Spotify account**
- **Spotify Developer app** (Client ID and redirect URI) — see below
- A **host** for the built app (AWS S3 + CloudFront, EC2, physical server, etc.) and a **public URL** for that site (used as redirect URI)

---

## Spotify setup

Shotify uses Spotify’s Web API and (when available) the Web Playback SDK. You must register an app in the Spotify Developer Dashboard and set a redirect URI to match where the app is served.

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in.
2. **Create an app**: “Create app” → name it (e.g. “Shotify”).
3. **Redirect URI**: Add the URL where your app will live, plus `/callback`:
   - **Production (your website):** e.g. `https://yourdomain.com/callback` or `https://shotify.yourdomain.com/callback`  
     Add this exact URL in the app’s “Redirect URIs” in Settings.
   - **Local dev:** e.g. `http://127.0.0.1:5173/callback` (Spotify does not allow `localhost`; use `127.0.0.1`).  
     Add this too if you run the app locally.
4. Copy the **Client ID** from the app’s “Settings” and put it in your `.env` (see below).
5. No “Client Secret” is needed (PKCE flow).

---

## Environment variables (.env)

Create a `.env` file in the project root (you can copy `.env.example`):

```env
VITE_SPOTIFY_CLIENT_ID=your_spotify_client_id_here
VITE_SPOTIFY_REDIRECT_URI=https://yourdomain.com/callback
```

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SPOTIFY_CLIENT_ID` | Yes | Client ID from your [Spotify Developer app](https://developer.spotify.com/dashboard). |
| `VITE_SPOTIFY_REDIRECT_URI` | Yes | Must **exactly** match a redirect URI in the Spotify app. Use your **site URL** + `/callback` (e.g. `https://yourdomain.com/callback`). For local dev use `http://127.0.0.1:5173/callback`. |

Values are read at **build time** by Vite (the `VITE_` prefix is required). Use the production URI when building for AWS/server; use the local URI when running `npm run dev` locally.

---

## Command line

### First-time setup

```bash
npm install
```

Then add your `.env` with `VITE_SPOTIFY_CLIENT_ID` and `VITE_SPOTIFY_REDIRECT_URI` (your website callback URL for production, or `http://127.0.0.1:5173/callback` for local dev).

### Run locally (dev)

```bash
npm run dev
```

Starts the Vite dev server and opens the app in your browser. For this to work, your Spotify app must list `http://127.0.0.1:5173/callback` as a redirect URI, and `.env` should use that same value for `VITE_SPOTIFY_REDIRECT_URI`.

### Build for production (AWS / server)

```bash
npm run build
```

Output is in **`dist/`**. Deploy the contents of `dist/` to your host:

- **AWS:** e.g. S3 bucket (static website or origin for CloudFront), or serve from an EC2/ECS app.
- **Physical server:** e.g. nginx/Apache document root pointing at `dist/`, or any static file server.

Ensure your **site URL** (e.g. `https://yourdomain.com`) is the one you added in Spotify as a redirect URI, and that `VITE_SPOTIFY_REDIRECT_URI` in `.env` when you built is exactly that URL + `/callback`.

### Other commands

| Command | Description |
|---------|-------------|
| `npm run preview` | Serve the built `dist/` locally (after `npm run build`). |
| `npm run lint` | Run ESLint. |
| `npm run test` | Run tests in watch mode. |
| `npm run test:run` | Run tests once. |

---

## In-between sounds

Optional sounds between each track are loaded from **`src/content/sounds/`**. Add audio files (e.g. `.mp3`) there; they appear in the “Between songs” dropdown by filename (without extension). No config file needed — the app discovers them at build time.

---

## Tech stack

- **Frontend:** React 19, TypeScript, Vite 7  
- **Auth:** Spotify PKCE (no client secret)  
- **Playback:** Spotify Web Playback SDK (60s from 45s) or 30s preview URLs

---

## Publish this repo to GitHub

The project is already under git with an initial commit. To push it to a new GitHub repo named **shotify**:

1. On [GitHub](https://github.com/new), create a **new repository** named **shotify**. Do **not** add a README, .gitignore, or license (the project already has them).
2. In this folder, add the remote and push (replace `YOUR_USERNAME` with your GitHub username):

   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/shotify.git
   git branch -M main
   git push -u origin main
   ```
