import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { authUrl, getGoogleConfig } from "@/lib/google/api";
import { GOOGLE_STATE_COOKIE } from "@/features/google/constants";

/** Starts "Connect Google Calendar": sends the user to Google's consent screen. */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const config = getGoogleConfig();
  if (!config) return NextResponse.redirect(`${origin}/settings?google=not_configured#google-calendar`);
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(`${origin}/login?next=/settings`);

  const state = randomBytes(24).toString("base64url");
  const response = NextResponse.redirect(authUrl(config, origin, state));
  response.cookies.set(GOOGLE_STATE_COOKIE, `${state}.${user.id}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/api/google",
    maxAge: 600,
  });
  return response;
}
