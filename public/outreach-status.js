/* ══════════════════════════════════════════════════════════════════════
   Exhibitor Outreach — what one contact's badge and email cell say.

   The status itself is decided on the server (outreach.js contactStatus:
   sent → drafted → no_draft → email_locked → no_email), the same truth the
   KPIs count. This only names it for people:

     sent          Sent            (the app delivered it)
                   Marked sent     (recorded by hand as sent outside SKQ)
     drafted       Drafted
     no_draft      Not drafted     (has an address, nothing written yet)
     email_locked  Email not revealed   (Apollo holds one; a reveal costs a credit)
     no_email      Email unavailable    (a reveal was made and Apollo had none)
                   No email             (nothing to reveal)

   revealState is the page's own record of a reveal in flight or failed,
   which the server does not know about: 'pending' | 'failed' | undefined.

   Pure and shared: loaded by the page (window.xoStatus) and required by the
   node test suite.
   ══════════════════════════════════════════════════════════════════════ */
(function (root) {
  const BADGES = {
    sent:         { label: "Sent",               cls: "xo-st-green" },
    marked_sent:  { label: "Marked sent",        cls: "xo-st-green-l" },
    drafted:      { label: "Drafted",            cls: "xo-st-blue" },
    no_draft:     { label: "Not drafted",        cls: "xo-st-purple" },
    email_locked: { label: "Email not revealed", cls: "xo-st-amber" },
    unavailable:  { label: "Email unavailable",  cls: "xo-st-grey" },
    no_email:     { label: "No email",           cls: "xo-st-grey" },
  };

  function contactBadge(c) {
    const s = c && c.status;
    if (s === "sent") return c.last_sent_source === "manual" ? BADGES.marked_sent : BADGES.sent;
    if (s === "no_email" && c.email_lookup_status === "not_available") return BADGES.unavailable;
    return BADGES[s] || { label: String(s || "Unknown"), cls: "xo-st-grey" };
  }

  /* The email cell. kind drives the markup; the page renders it. */
  function emailState(c, revealState) {
    if (c && c.has_email) return { kind: "email", email: String(c.email || "").trim() };
    if (revealState === "pending") return { kind: "pending", label: "Revealing…" };
    if (revealState === "failed") return { kind: "failed", label: "Reveal failed" };
    if (c && c.revealable) return { kind: "locked", label: "Email not revealed" };
    if (c && c.email_lookup_status === "not_available") return { kind: "unavailable", label: "Email unavailable" };
    return { kind: "none", label: "No email" };
  }

  /* Which buttons a contact offers. Reveal and Draft are separate: a reveal
     never opens the drafter, and Draft is only offered once an address is
     held. Retry is the reveal action again. */
  function contactActions(c, revealState) {
    const s = c && c.status;
    if (revealState === "pending") return [];
    if (s === "no_draft") return [{ act: "draft", label: "Draft email", primary: true }, { act: "mark", label: "Mark sent" }];
    if (s === "drafted") return [{ act: "draft", label: "View/Edit draft", primary: true }, { act: "mark", label: "Mark sent" }];
    if (s === "sent") {
      const a = [{ act: "draft", label: "View emails" }];
      if (c.last_sent_source === "manual") a.push({ act: "undo", label: "Undo sent" });
      return a;
    }
    if (s === "email_locked") {
      return [revealState === "failed"
        ? { act: "reveal", label: "Retry", primary: true }
        : { act: "reveal", label: "Reveal email", primary: true }];
    }
    return [];
  }

  const api = { BADGES, contactBadge, emailState, contactActions };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.xoStatus = api;
})(typeof window !== "undefined" ? window : globalThis);
