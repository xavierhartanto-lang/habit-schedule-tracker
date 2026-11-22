export type GoogleCalendarChoice = {
  id: string;
  name: string;
  color: string | null;
  primary: boolean;
  selected: boolean;
  lifeAreaId: string | null;
};

export type GoogleStatus =
  | { state: "not_configured" | "needs_migration" | "unavailable" | "disconnected" }
  | {
      state: "connected";
      email: string | null;
      lastSyncedAt: string | null;
      lastError: string | null;
      calendars: GoogleCalendarChoice[];
    };
