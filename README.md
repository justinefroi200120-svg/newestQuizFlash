# Quiz Flash v3 — PostgreSQL + Student Accounts

Teacher and student accounts, saved quizzes, and submitted answer history now use **PostgreSQL** instead of a local JSON file. Each teacher has isolated quiz libraries and independent live rooms. Students log in, enter room code and display name, then answer questions and review their history. Correct answers are not disclosed until the respective question ends. Offline participants remain on the leaderboard. Teacher participant removal, server-side scoring, PDF results, and connection protection remain available.

## Render setup

1. Create a **Render Postgres** database (or use `render.yaml` via Render Blueprint; check actual pricing and free-tier availability in your Render dashboard).
2. Create a Node web service pointing at this repository. Build command: `npm install`. Start command: `npm start`.
3. Set `DATABASE_URL` to your database's **internal PostgreSQL URL** using the environment-variable settings. **Never commit the connection string**.
4. If your provider requires TLS for the supplied URL, set `DATABASE_SSL=true`. Render internal database connections commonly do not require TLS.
5. Deploy. On startup, tables and the index are created automatically. Open your deployed site, register a teacher, create and save a quiz, then create a room. Students must register/login before joining.

## Local development

Install Node.js 20+, run `npm install`, then set `DATABASE_URL` to a PostgreSQL connection string, and run `npm start`. The server exits with an error if PostgreSQL is not configured or unavailable.

## Operational notes

- PostgreSQL persists **users, saved quizzes, and answered questions** across app restarts. Existing `data/store.json` is **not automatically migrated**; old teacher accounts and quizzes need manual import. Old password hashes use the same scrypt format but a migration tool is not included.
- Active quiz rooms, timers, participation and scores still live **in application memory**. Deploy **one server instance only**, and do not expect active rooms to survive restarts, deploys, or free-service sleep. Historical submitted answers remain in PostgreSQL. A shared session database / Redis adapter is recommended for scaling.
- Student answer history shows up to the latest 500 submitted answers. Scores in the leaderboard are live memory values, separate from the historical results.
- Students must log in and explicitly re-enter their join code after each disconnection. Teacher removal blocks their **account** from rejoining that room (not just the display name).
- Passwords are salted and hashed with Node's scrypt; auth tokens are kept in application memory and browser sessionStorage, so users must log in again after a server restart.
- Student answer history is accessible to the student and only correct answers from completed/revealed questions are shown. Questions answered but not yet revealed are marked pending.
- If the app has a public deployment, use HTTPS and implement stronger measures (rate limiting, durable server sessions, CSRF protections where applicable, audit logging, data retention policies, student privacy notice) before broad production use.
- If previously registered users used the JSON-storage edition, those accounts will not automatically appear in PostgreSQL.

## Smoke testing

Test with Teacher A, Teacher B, Student A and Student B using separate browsers/devices; verify room isolation, teacher login, saving quizzes, student history persistence after server restart, correct/wrong feedback after reveal, offline labels, re-entry after reconnection, and participant removal.
