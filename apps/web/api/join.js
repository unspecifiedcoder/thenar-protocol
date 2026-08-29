/* api/join.js — the one conversion on the page.
 *
 * Validates server side as well as in the browser, because client validation
 * is a courtesy to the user and not a control. Sends through Resend if a key
 * is configured and otherwise fails LOUDLY with the reason, rather than
 * returning a cheerful 200 that quietly drops somebody who wanted to talk.
 */
const FROM = "Thenar <hello@thenar.io>";
const TO = process.env.THENAR_INBOX || "niveshgajengi@gmail.com";

// Deliberately permissive: the job is to catch typos and empty fields, not to
// out-lawyer RFC 5322 and reject somebody's real address.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const name = String(body?.name || "").trim().slice(0, 120);
  const email = String(body?.email || "").trim().slice(0, 200);
  const role = String(body?.role || "").trim().slice(0, 80);
  const note = String(body?.note || "").trim().slice(0, 2000);

  if (!name) return res.status(400).json({ error: "Tell us your name." });
  if (!EMAIL.test(email))
    return res.status(400).json({ error: "That email address does not look right." });

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("join: RESEND_API_KEY is not set on this project");
    return res.status(503).json({
      error: "Our mail is not connected yet. Email hello@thenar.io directly and "
           + "we will pick it up.",
    });
  }

  const text = [
    `Name:  ${name}`,
    `Email: ${email}`,
    `Role:  ${role || "not given"}`,
    "",
    note || "(no message)",
  ].join("\n");

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [TO], reply_to: email,
        subject: `Thenar — ${name}${role ? " · " + role : ""}`,
        text,
      }),
    });
    if (!r.ok) {
      // surface Resend's own reason; a generic failure here is unfixable
      const detail = await r.text();
      console.error("join: resend", r.status, detail);
      return res.status(502).json({
        error: "We could not send that just now. Email hello@thenar.io instead.",
      });
    }
  } catch (e) {
    console.error("join: fetch", e);
    return res.status(502).json({
      error: "We could not reach our mail service. Email hello@thenar.io instead.",
    });
  }

  return res.status(200).json({ ok: true });
}
