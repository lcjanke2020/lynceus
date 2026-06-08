// stateful-app variant — gives the session-resume L4 scenario real,
// app-originated state to export and restore.
//
// On load the page materializes a user preference into localStorage
// (user_pref="dark") if it isn't already there, so export_storage_state
// deterministically captures one origin's localStorage (origins:1) — the agent
// never has to seed it via raw evaluate. The "logged-in" session itself is a
// cookie named session_token (seeded by the agent via set_cookies): a freshly
// launched browser has no cookies, so the session is genuinely gone until the
// saved storageState is restored. The page reports both so navigation is
// observable, but the cookie is the clean "gone → restored" signal (the page
// never regenerates cookies, only the localStorage default).

const PREF_KEY = "user_pref";

if (localStorage.getItem(PREF_KEY) === null) {
  localStorage.setItem(PREF_KEY, "dark");
}

const statusEl = document.getElementById("status");
if (statusEl) statusEl.textContent = `user_pref: ${localStorage.getItem(PREF_KEY)}`;

const loggedIn = /(^|;\s*)session_token=/.test(document.cookie);
const sessionEl = document.getElementById("session");
if (sessionEl) sessionEl.textContent = `session: ${loggedIn ? "logged-in" : "logged-out"}`;
