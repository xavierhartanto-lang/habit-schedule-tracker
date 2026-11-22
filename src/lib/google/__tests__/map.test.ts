import { describe, expect, it } from "vitest";
import { htmlToText, mapGoogleEvent, staleIds, syncWindow } from "../map";
import { decryptToken, encryptToken } from "../crypto";

const LA = { userTimeZone: "America/Los_Angeles" };

describe("mapGoogleEvent", () => {
  it("keeps the exact instant of a timed event and its zone", () => {
    const e = mapGoogleEvent(
      {
        id: "abc",
        summary: "  Debate practice ",
        htmlLink: "https://www.google.com/calendar/event?eid=x",
        start: { dateTime: "2026-11-24T16:00:00-08:00", timeZone: "America/Los_Angeles" },
        end: { dateTime: "2026-11-24T17:30:00-08:00", timeZone: "America/Los_Angeles" },
      },
      LA,
    );
    expect(e).toMatchObject({
      externalId: "abc",
      title: "Debate practice",
      startsAt: "2026-11-25T00:00:00.000Z",
      endsAt: "2026-11-25T01:30:00.000Z",
      allDay: false,
      timezone: "America/Los_Angeles",
      externalUrl: "https://www.google.com/calendar/event?eid=x",
    });
  });

  it("stores all-day events as local midnight to midnight in the user's zone", () => {
    const e = mapGoogleEvent({ id: "d", summary: "Thanksgiving", start: { date: "2026-11-26" }, end: { date: "2026-11-27" } }, LA);
    expect(e).toMatchObject({ allDay: true, startsAt: "2026-11-26T08:00:00.000Z", endsAt: "2026-11-27T08:00:00.000Z", timezone: "America/Los_Angeles" });
  });

  it("skips cancelled, declined, working-location and birthday events", () => {
    const base = { id: "x", start: { dateTime: "2026-11-24T16:00:00Z" }, end: { dateTime: "2026-11-24T17:00:00Z" } };
    expect(mapGoogleEvent({ ...base, status: "cancelled" }, LA)).toBeNull();
    expect(mapGoogleEvent({ ...base, attendees: [{ self: true, responseStatus: "declined" }] }, LA)).toBeNull();
    expect(mapGoogleEvent({ ...base, eventType: "workingLocation" }, LA)).toBeNull();
    expect(mapGoogleEvent({ ...base, eventType: "birthday" }, LA)).toBeNull();
    expect(mapGoogleEvent({ ...base, attendees: [{ self: true, responseStatus: "accepted" }] }, LA)).not.toBeNull();
  });

  it("names untitled events Busy and gives zero-length events 15 minutes", () => {
    const e = mapGoogleEvent({ id: "p", start: { dateTime: "2026-11-24T16:00:00Z" }, end: { dateTime: "2026-11-24T16:00:00Z" } }, LA);
    expect(e?.title).toBe("Busy");
    expect(e?.endsAt).toBe("2026-11-24T16:15:00.000Z");
  });

  it("clips long text to the database limits", () => {
    const e = mapGoogleEvent(
      { id: "l", summary: "a".repeat(300), location: "b".repeat(300), description: "c".repeat(3000), start: { date: "2026-11-24" }, end: { date: "2026-11-25" } },
      LA,
    );
    expect(e?.title.length).toBe(200);
    expect(e?.location?.length).toBe(200);
    expect(e?.notes?.length).toBe(2000);
  });

  it("drops links that aren't https", () => {
    const e = mapGoogleEvent({ id: "j", htmlLink: "javascript:alert(1)", start: { date: "2026-11-24" }, end: { date: "2026-11-25" } }, LA);
    expect(e?.externalUrl).toBeNull();
  });
});

describe("htmlToText", () => {
  it("keeps words and line breaks", () => {
    expect(htmlToText("Bring <b>cleats</b><br>Field 3 &amp; 4<ul><li>Water</li></ul>")).toBe("Bring cleats\nField 3 & 4\n• Water");
  });
});

describe("sync bookkeeping", () => {
  it("finds rows that are gone from Google", () => {
    expect(staleIds([{ id: "1", externalId: "a" }, { id: "2", externalId: "b" }], new Set(["a"]))).toEqual(["2"]);
  });

  it("covers two weeks back and six months ahead", () => {
    const now = new Date("2026-11-22T00:00:00Z");
    const w = syncWindow(now);
    expect(w.from.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(w.to.getTime() - now.getTime()).toBe(183 * 86_400_000);
  });
});

describe("token encryption", () => {
  it("round-trips and refuses a different secret", () => {
    const sealed = encryptToken("1//refresh-token", "secret-a");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("refresh-token");
    expect(decryptToken(sealed, "secret-a")).toBe("1//refresh-token");
    expect(decryptToken(sealed, "secret-b")).toBeNull();
    expect(decryptToken("garbage", "secret-a")).toBeNull();
  });
});
