import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getGoogleConnection, saveGoogleConnection } from "@/lib/db/google";
import { GoogleApiError, canWrite, emailFromIdToken, exchangeCode, getGoogleConfig } from "@/lib/google/api";
import { decryptToken, encryptToken } from "@/lib/google/crypto";
import { GOOGLE_STATE_COOKIE } from "@/features/google/constants";
import { syncGoogleCalendar } from "@/features/google/server/sync";

/**
 * Google sends the user back here after the consent screen. Checks the
 * state cookie, stores the encrypted tokens, runs the first import, and
 * returns to Settings.
 */
export async function GET(request: NextRequest) {
  const { origin, searchParams } = request.nextUrl;
  const back = (result: string) => {
    const res = NextResponse.redirect(`${origin}/settings?google=${result}#google-calendar`);
    res.cookies.set(GOOGLE_STATE_COOKIE, "", { path: "/api/google", maxAge: 0 });
    return res;
  };

  const config = getGoogleConfig();
  if (!config) return back("not_configured");
  if (searchParams.get("error")) return back("cancelled");

  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(`${origin}/login?next=/settings`);

  const cookie = request.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? "";
  const [state, cookieUser] = cookie.split(".");
  const code = searchParams.get("code");
  if (!code || !state || state !== searchParams.get("state") || cookieUser !== user.id) return back("state");

  try {
    const tokens = await exchangeCode(config, origin, code);
    if (!tokens.scope?.includes("calendar.readonly")) return back("missing_scope");
    // Google only sends a refresh token on first consent; keep the old one otherwise.
    let refreshToken = tokens.refresh_token ? encryptToken(tokens.refresh_token, config.clientSecret) : null;
    if (!refreshToken) {
      const existing = await getGoogleConnection(user.id);
      if (existing && decryptToken(existing.refresh_token, config.clientSecret)) refreshToken = existing.refresh_token;
    }
    if (!refreshToken) return back("no_refresh");

    await saveGoogleConnection(user.id, {
      email: emailFromIdToken(tokens.id_token),
      refreshToken,
      accessToken: encryptToken(tokens.access_token, config.clientSecret),
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      canWrite: canWrite(tokens.scope),
    });
  } catch (e) {
    console.error("[google-callback]", e);
    if (e instanceof GoogleApiError && (e.code === "invalid_client" || e.code === "unauthorized_client")) return back("invalid_client");
    if (e instanceof GoogleApiError && e.code === "redirect_uri_mismatch") return back("redirect_mismatch");
    if (e instanceof GoogleApiError) return back("google_error");
    return back("save_error");
  }

  const sync = await syncGoogleCalendar(user.id, { force: true });
  return back(sync.status === "error" ? "sync_error" : "connected");
}
