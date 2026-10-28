# Quiz Flash — Multi-teacher edition

Requires Node.js 18+. Run `npm install` and `npm start`, then open http://localhost:3000.

## Features
- Teacher registration and login with salted scrypt password hashes; login tokens held in server RAM and browser sessionStorage.
- Private saved quiz libraries persisted in `data/store.json` (back it up!).
- Any number of concurrently active classroom sessions, each with a unique six-character code, cloned quiz, independent timer, scores, and leaderboard.
- Server-authoritative answer validation; one accepted answer per student per question.
- On student disconnect the server keeps their score in the room leaderboard but marks them offline. They must enter the room code and same name again to return. While offline, quiz is hidden and buttons disabled. Names are an intentionally simple identity mechanism, not secure student authentication.
- Real-time enrolled/online counters and leaderboard broadcasts; PDF results for each room.

## Hosting and limitations
- **Persistent storage:** `data/store.json` is a local file. Configure a persistent volume and set `QUIZ_DATA_FILE` if your host has ephemeral storage. Never commit it to Git.
- **Single Node.js process:** active rooms and login tokens are in memory. Restarting loses live rooms, but saved quizzes/accounts remain. Multi-instance deployment requires shared DB and Socket.IO adapter plus distributed session state.
- **Connectivity caveat:** browsers cannot always detect a network loss immediately. The server will reject stale/disconnected answers; the UI locks when Socket.IO reports disconnect or the browser reports offline. This does not prevent a student from keeping previously displayed quiz text using screenshots or developer tools.
- **Name reclaim:** disconnected students can rejoin with the same name and room code to recover scores. For assessments requiring verified student identity, add authenticated student identities or recovery secrets.
- **Security:** Run behind HTTPS; use a persistent secured directory for account data and consider rate-limiting authentication for public deployments. Teacher tokens expire on server restart or logout. A hardened production service should use database sessions, request throttling and CSRF-safe APIs.
- **Scale:** optimized for one process and modest classroom workloads, not thousands of concurrent devices. Timer and leaderboard are server-authoritative; broadcasting 4 times/second may be adjusted for larger classrooms.

## Per-question student feedback and offline status

At each question reveal or timeout, students who submitted an answer see **Correct answer! +1 point** or **Wrong answer** with the correct choice. Students who did not answer see **no answer submitted**. Answer correctness is not displayed before reveal, and the teacher's projected screen keeps answers hidden. The leaderboard includes all enrolled students with explicit **Online** and **Offline** labels; offline students retain their previous score and can only rejoin by entering their room code and name again. All previously supported multi-teacher and saved-quiz features remain.
