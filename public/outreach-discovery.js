/* ══════════════════════════════════════════════════════════════════════
   Exhibitor Outreach — what a row says about automatic contact discovery.

   "0 contacts" used to mean three different things: never searched, searched
   and nobody there, or searched and results held back. The discovery state
   (company_contact_discovery, per CRM company) tells them apart:

     no row, 0 contacts   Apollo not searched
     queued               Queued for contact discovery
     searching            Searching Apollo…
     found                8 contacts · emails not revealed
                          37 contacts · 3 revealed emails
                          (+ "25 of 140 Apollo results checked" · Find more)
     no_results           No contacts found
     needs_review         Contact discovery needs review
     failed               Discovery failed · Retry

   Contact counts come from the canonical contacts (the row's own counts),
   never from the discovery record. Display only: no KPI reads this.

   Pure and shared: loaded by the page (window.xoDiscovery) and required by
   the node test suite.
   ══════════════════════════════════════════════════════════════════════ */
(function (root) {
  const PAGE_SIZE = 25;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  function contactsText(contacts, emailable) {
    return `${plural(contacts, "contact")} · ${emailable ? plural(emailable, "revealed email") : "emails not revealed"}`;
  }

  /**
   * row: an Outreach row (company_id, contacts, emailable, discovery).
   * opts: { enabled: worker switched on, canManage: may queue }.
   * Returns { summary, line, tone, actions:[{kind,label}] }:
   *   summary replaces the "0 direct contacts" line for rows without contacts;
   *   line is an extra status line; actions are queue requests.
   */
  function discoveryView(row, opts) {
    const o = opts || {};
    const out = { summary: null, line: null, tone: "grey", actions: [] };
    if (!row || !row.company_id) return out;
    const d = row.discovery;
    const contacts = Number(row.contacts) || 0;
    const emailable = Number(row.emailable) || 0;
    const act = (kind, label) => { if (o.canManage) out.actions.push({ kind, label }); };
    const say = (text, tone) => {
      out.tone = tone;
      if (contacts === 0) out.summary = text; else out.line = text;
    };
    if (!d) {
      if (contacts === 0) { out.summary = "Apollo not searched"; act("search", "Search Apollo"); }
      return out;
    }
    const paused = o.enabled === false ? " · discovery paused" : "";
    switch (d.status) {
      case "queued": {
        const waiting = d.next_attempt_at && new Date(d.next_attempt_at) > new Date();
        const why = d.last_error_code === "rate_limited" ? " · waiting for Apollo rate limit"
          : d.last_error_code && waiting ? " · will retry" : "";
        say(`Queued for contact discovery${why}${paused}`, "blue");
        break;
      }
      case "searching":
        say("Searching Apollo…", "blue");
        break;
      case "found": {
        const parts = [];
        if (contacts === 0) parts.push("Contacts found, none linked here now");
        if (d.held_count) parts.push(`${d.held_count} held for review`);
        if (d.has_more && d.apollo_total != null) {
          parts.push(`${Math.min(d.pages_fetched * PAGE_SIZE, d.apollo_total)} of ${d.apollo_total} Apollo results checked`);
        }
        out.tone = d.held_count ? "amber" : "green";
        if (contacts === 0) out.summary = parts.join(" · ");
        else out.line = parts.length ? parts.join(" · ") : null;
        if (d.has_more) act("more", "Find more");
        act("refresh", "Refresh contacts");
        break;
      }
      case "no_results":
        say(`No contacts found${d.rejected_count ? ` · ${d.rejected_count} at other organisations discarded` : ""}`, "grey");
        act("refresh", "Refresh contacts");
        break;
      case "needs_review":
        say(`Contact discovery needs review${d.held_count ? ` · ${d.held_count} held` : ""}`, "amber");
        act("refresh", "Refresh contacts");
        break;
      case "failed":
        say("Discovery failed", "red");
        act("retry", "Retry");
        break;
      default:
        say(String(d.status), "grey");
    }
    return out;
  }

  /* Held organisations, for the expanded row: who Apollo returned that could
     not be tied to this company, and why. Names only; no people are stored. */
  const BASIS = {
    similar_name: "similar name", no_org_identity: "no organisation", inconsistent_organizations: "several organisations for one domain",
  };
  function heldText(d) {
    if (!d || !Array.isArray(d.held_orgs) || !d.held_orgs.length) return "";
    return d.held_orgs.slice(0, 6).map((h) => `${h.org || "(no organisation)"} ×${h.n} (${BASIS[h.basis] || h.basis})`).join(", ");
  }

  const api = { discoveryView, contactsText, heldText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.xoDiscovery = api;
})(typeof window !== "undefined" ? window : globalThis);
