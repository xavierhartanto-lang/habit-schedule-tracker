import { describe, expect, it } from "vitest";
import { cleanEmail, emailSubject, rawEmail, validateOutgoingEmail } from "../email";

describe("outgoing email", () => {
  it("keeps one address and refuses a list", () => {
    expect(cleanEmail("Email Coach <Coach@School.edu>")).toBe("coach@school.edu");
    expect(cleanEmail("a@x.com and b@y.com")).toBeNull();
    expect(cleanEmail("my coach")).toBeNull();
  });

  it("requires a subject and a message", () => {
    expect(validateOutgoingEmail({ to: "coach@school.edu", subject: "Late to practice", body: "I'll be about 15 minutes late." }).ok).toBe(true);
    expect(validateOutgoingEmail({ to: "coach", subject: "Hi", body: "Hello" }).ok).toBe(false);
    expect(validateOutgoingEmail({ to: "coach@school.edu", subject: "  ", body: "Hello" }).ok).toBe(false);
    expect(emailSubject(null, "I'll be late today.\nThanks")).toBe("I'll be late today.");
  });

  it("builds a plain-text message for Gmail", () => {
    const raw = Buffer.from(rawEmail({ to: "coach@school.edu", subject: "Late", body: "I'll be late." }), "base64url").toString("utf8");
    expect(raw).toContain("To: coach@school.edu");
    expect(raw).toContain("Subject: Late");
    expect(raw.endsWith("I'll be late.")).toBe(true);
    expect(raw).not.toContain("From:");
  });
});
