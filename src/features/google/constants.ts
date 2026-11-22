/** Short-lived cookie that ties Google's redirect back to the user who started it. */
export const GOOGLE_STATE_COOKIE = "ws-google-oauth";

/** Messages for ?google=… after returning from Google. */
export const GOOGLE_RETURN_MESSAGES: Record<string, { tone: "success" | "danger"; text: string }> = {
  connected: { tone: "success", text: "Google Calendar connected. Your events are on the calendar." },
  cancelled: { tone: "danger", text: "Google Calendar wasn't connected. You closed the Google screen." },
  missing_scope: { tone: "danger", text: "Google didn't share calendar access. Connect again and tick the calendar box." },
  sync_error: { tone: "danger", text: "Connected, but the first import failed. Press Sync now to try again." },
  not_configured: { tone: "danger", text: "Google Calendar isn't set up on this server yet." },
  error: { tone: "danger", text: "Couldn't connect Google Calendar. Try again." },
};
