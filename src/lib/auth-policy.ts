// Password policy shared by the server (Better Auth options) and the forms (client-side hint
// and pre-check). The server is the authority; the form check only saves a round trip.
export const MIN_PASSWORD_LENGTH = 12;

/** Hidden honeypot field on public forms (rule 27); people never fill it. */
export const HONEYPOT_FIELD = 'website';
