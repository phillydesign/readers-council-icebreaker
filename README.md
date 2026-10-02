# Technical.ly Crossmarket Readers Council

An anonymous, browser-based icebreaker for approximately 30 participants. The host enters one to four questions, each with custom left and right labels. Participants move a slider; a separate presentation screen shows their dots. The host freezes the round to reveal counts and percentages, then advances to the next question.

Uses Lexend Deca throughout, with Lora for italic accents, and the supplied Technical.ly T-circle favicon. Font files and their open-source licenses are bundled under `src/assets/fonts/`; fonts load from the app itself.

Uses the supplied Technical.ly palette: `#0D6B98`, `#084867`, `#022333`, `#A7FFD1`, `#4AFFA0`, `#03E26D`.

## Try the local rehearsal

Requires Node.js 22.12 or newer and pnpm 10.

```sh
pnpm install
pnpm dev
```

Open `http://127.0.0.1:4173`. Choose **Host a session**. The local-only host password is **rehearsal-only-local**. The local database is saved in `.local-data/`; it is not uploaded or shared with Netlify. This rehearsal uses the real app and a local PostgreSQL-compatible database. It does not simulate production network latency or database concurrency.

Use a separate private/incognito browser window for a participant. Tabs in the same browser share an anonymous participant identity. To represent several people, use separate browser profiles/contexts. The QR code points to the current site's address, so the local loopback QR code is not usable from another device; test phones after deployment.

## Put it on Netlify

**This is a full application with server functions and a database. Uploading only the static `dist` folder to Netlify Drop will not deploy the voting backend.** Use Netlify's repository-connected deployment.

1. Check that your Netlify account is on a **credit-based plan** with Netlify Database available. A legacy plan may need a change; check your account before switching. Usage is subject to your plan's function, request and database charges.
2. Put the contents of this `readers-council` folder in a Git repository, then import that repository into Netlify. If this folder is inside a larger repository, set the Netlify **base directory** to `readers-council`.
3. Set the **build command** to `pnpm build` and **publish directory** to `dist`. The included `netlify.toml` sets these and the function directory automatically. Use Node.js 22 (at least 22.12).
4. Before the event, set a Netlify environment variable named **HOST_PASSWORD** to a unique passphrase of at least 16 characters. Give it the **Functions** scope if your plan offers scope controls. Keep it private; do not put it in a URL, repository or participant chat. Redeploy after setting/changing it.
5. Deploy from the repository. The included `@netlify/database` dependency enables provisioning, and Netlify applies the SQL migration under `netlify/database/migrations/`. Confirm that the deploy succeeded and a database appears under **Data & Storage → Database**.
6. Open the resulting HTTPS address. Sign in through **Host a session**, create a rehearsal room and test the host, presentation and participant views on separate devices.

No separate Supabase account, participant accounts, API keys in the browser or paid custom domain are required by this implementation. It uses Netlify Functions and Netlify Database. Do not set production `HOST_PASSWORD` to the local rehearsal password.

Platform references, checked Oct. 2, 2026:

- [Netlify Database setup](https://docs.netlify.com/build/data-and-storage/netlify-database/getting-started/)
- [Automatic database migrations](https://docs.netlify.com/build/data-and-storage/netlify-database/migrations/)
- [Database plan eligibility and billing](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/)

## Run a session

1. Open the host page and enter one to four questions. Each question needs its own left and right endpoint labels. Question wording is entered in the app, never changed in code.
2. Create the room on the event day. Rooms expire 48 hours after creation. Keep the host tab open or save its room address to return during that period.
3. Open the presentation link in another tab/window. Share **that window** in your video meeting, keeping the host controls private.
4. Paste the participant link in meeting chat. Display the QR code for people who want to use a second device. Participants join without names or email addresses.
5. Click **Open voting**. Invite participants to move the slider. The slider allows nuance while skipping the exact midpoint, so each response chooses a side. Merely joining is not a response.
6. Give a short verbal countdown, then click **Freeze responses**. The app counts the last position each participant successfully saved before the server closed voting. Unsaved movements cannot be counted; participants see their save status.
7. Discuss the results, then go to the next question and open voting again. Finish the session after the last question to stop background updates. Close event tabs when done.

The left side is 0–49 and the right side is 51–100. Final results contain only left and right, and every response counts toward one side. Exact midpoint requests from an older browser version are saved at 51; midpoint responses in previously saved rooms count toward the right without changing the saved records. Percentages use the number of responses, not everyone who joined. Each new round starts without a response. Responses remain associated with an anonymous dot if a participant refreshes or briefly loses connection.

The shared screen requests updated positions about twice a second while voting is open and animates dots between positions. Actual delay also includes participants' internet connections and Netlify/database latency. This version uses short polling, not a continuous WebSocket stream. Rehearse on the deployed URL before relying on the motion during an event.

## Anonymous participation and room access

The app asks for no names, email addresses or locations. It generates a random participant token saved in the browser and stores only its hash on the server, with a random dot ID. The token lets a refreshed browser reuse its response. Opening another browser/device can create another dot; this is an icebreaker, not a verified election.

Anyone with a room's join link/code can view its anonymous positions and participate. Share the link with your invited group. Only the host password authorizes creation and control of rooms. Host login tokens expire after 12 hours. Server-side login throttling uses a keyed hash of the requester IP, not the raw IP. Hosting providers may retain their own standard connection logs.

Rooms become inaccessible after 48 hours. Expired rooms and their responses are deleted when a host next creates a room; expiration is not a scheduled deletion guarantee. A room has an 80-browser safeguard. No analytics or advertising scripts are included.

## Verification and remaining rehearsal

```sh
pnpm test
pnpm build
```

The production build and 12 automated test entries passed locally, including left/right-only results, compatibility with saved rooms, the position-based color gradient, and a fourth question. The browser preview could not be opened because the desktop app could not verify its browser security policy; visual browser checks and deployed-device rehearsal remain outstanding.

Integration tests use the actual application handler and local PostgreSQL-compatible storage. They cover anonymous joining, 30 voters, host authorization, custom questions, stale responses, freeze behavior, question transitions, two-sided totals, midpoint normalization and compatibility with previously saved results. Local tests do not establish production load capacity or actual Netlify latency. Before the convening, verify the deployed room from several devices, refresh a participant, try a brief disconnect and run all four rounds. Check Netlify's usage dashboard after rehearsal.

## Project layout

- `src/`: participant, host and presentation screens.
- `server/core.mjs`: validation, authorization and session behavior.
- `netlify/functions/api.mjs`: Netlify request handler and database transactions.
- `netlify/database/migrations/`: versioned database schema.
- `scripts/`: build and persistent local rehearsal.
- `tests/`: workflow checks.

Vote transactions hold a shared room lock. Freeze takes an exclusive lock and tallies accepted responses in that same transaction. Per-participant sequence numbers reject older updates, and host version checks prevent double-clicks or stale tabs from skipping questions. Browser storage holds only the anonymous access token and local UI state; the database is authoritative for sessions and results.
