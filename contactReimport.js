/* ═══════════════════════════════════════════════════════════════════════════
   What an Apollo SEARCH may change on a contact we already hold.

   Apollo's people search is obfuscated: masked surnames ("Fu***s"), no email,
   a payload of yes/no flags. A contact may since have been revealed (a paid
   people/match), corrected by hand, or confirmed to have no address. A later
   search that finds the same person must never undo any of that — otherwise
   the next reveal pays again for an address already bought, or a real name
   turns back into "Fu***s".

   So a re-import can only FILL IN, never downgrade:
     • email / email_source      only when we have no usable address yet
     • email_lookup_status       only ever raised to 'found' with a new address;
                                 'found' and 'not_available' are never reset
     • has_email                 only ever set to true
     • names                     only when missing, or when ours is masked and
                                 Apollo's is not
     • apollo_raw_json           only when we hold none (a reveal's payload is
                                 richer than any search payload)
     • apollo_person_id / linkedin_url   only when missing
     • company / company_id / source     never — a search does not re-link or
                                 re-label an existing contact
     • title, department, seniority, location, confidence, relevance
                                 refreshed (they describe the person now)

   Pure: returns the fields to pass to updateContact(); omitted keys are kept.
   ═══════════════════════════════════════════════════════════════════════════ */

const isMaskedName = (s) => /\*/.test(String(s || ''));
const usableEmail = (e) => /^[^\s@()]+@[^\s@()]+\.[^\s@()]+$/.test(String(e || '').trim());
const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';

function safeApolloReimport(existing, incoming) {
  const out = {};
  // Descriptive fields: a newer search may refresh them.
  for (const k of ['job_title', 'department', 'seniority', 'address', 'confidence', 'relevance']) {
    if (filled(incoming[k])) out[k] = incoming[k];
  }
  // Identity links: fill gaps only.
  if (filled(incoming.apollo_person_id) && !filled(existing.apollo_person_id)) out.apollo_person_id = incoming.apollo_person_id;
  if (filled(incoming.linkedin_url) && !filled(existing.linkedin_url)) out.linkedin_url = incoming.linkedin_url;
  // Names: never replace a real name with a masked one.
  if (filled(incoming.full_name)
    && (!filled(existing.full_name) || (isMaskedName(existing.full_name) && !isMaskedName(incoming.full_name)))) {
    out.full_name = incoming.full_name;
    if (filled(incoming.first_name)) out.first_name = incoming.first_name;
    if (filled(incoming.last_name)) out.last_name = incoming.last_name;
  }
  // Email: only into an empty slot, and then the lookup is 'found'.
  if (usableEmail(incoming.email) && !usableEmail(existing.email)) {
    out.email = String(incoming.email).trim();
    out.email_source = incoming.email_source || 'apollo_search';
    out.email_lookup_status = 'found';
    out.has_email = true;
  } else if (incoming.has_email === true && !existing.has_email) {
    out.has_email = true;          // Apollo says an address exists; never set this back to false
  }
  if (filled(incoming.apollo_raw_json) && !filled(existing.apollo_raw_json)) out.apollo_raw_json = incoming.apollo_raw_json;
  return out;
}

module.exports = { safeApolloReimport, isMaskedName, usableEmail };
