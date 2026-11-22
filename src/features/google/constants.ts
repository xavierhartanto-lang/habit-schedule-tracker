/** Short-lived cookie that ties Google's redirect back to the user who started it. */
export const GOOGLE_STATE_COOKIE = "ws-google-oauth";

/** Messages for ?google=… after returning from Google. */
export const GOOGLE_RETURN_MESSAGES: Record<string, { tone: "success" | "danger"; text: string }> = {
  connected: { tone: "success", text: "Google Calendar connected. Your events are on the calendar." },
  cancelled: { tone: "danger", text: "Google Calendar wasn't connected. You closed the Google screen." },
  missing_scope: { tone: "danger", text: "Google didn't share calendar access. Connect again and tick both calendar boxes." },
  sync_error: { tone: "danger", text: "Connected, but the first import failed. Press Sync now to try again." },
  not_configured: { tone: "danger", text: "Google Calendar isn't set up on this server yet." },
  invalid_client: {
    tone: "danger",
    text: "Google rejected the client ID or secret. In Google Cloud, open your client, add a new secret, paste it into .env.local as GOOGLE_CLIENT_SECRET (no quotes or spaces), restart npm run dev, then connect again.",
  },
  redirect_mismatch: {
    tone: "danger",
    text: "The redirect URI doesn't match. In Google Cloud, add http://localhost:3000/api/google/callback to your client's Authorized redirect URIs.",
  },
  state: { tone: "danger", text: "That sign-in expired or started in another tab. Press Connect again." },
  no_refresh: {
    tone: "danger",
    text: "Google didn't send a long-term key. Remove Whitespace at myaccount.google.com/permissions, then connect again.",
  },
  google_error: { tone: "danger", text: "Google refused the connection. The Terminal running npm run dev shows the exact reason." },
  save_error: { tone: "danger", text: "Couldn't save the connection. Check that the 20261201000000 database update ran in Supabase." },
  error: { tone: "danger", text: "Couldn't connect Google Calendar. Try again." },
};
