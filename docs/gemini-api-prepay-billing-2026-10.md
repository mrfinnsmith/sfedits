# Gemini API billing change: Postpay to Prepay (Oct 12, 2026)

## Email received

- **Date received:** 2026-08-12
- **From:** The Google AI Studio Team
- **Subject:** [Action Required] Update your Gemini API billing in Google AI Studio by Oct 12, 2026

## What the email says

Google AI Studio is transitioning **paid** Gemini API usage from Postpay (billed after usage) to Prepay (buy credits up front).

- Starting **October 12, 2026**, using paid features in the Gemini API requires switching the billing plan on the associated Google AI Studio project to Prepay and purchasing credits.
- If a project uses paid features and does not switch before that date, service is interrupted.
- The change applies only to Gemini API usage in AI Studio. Other GCP services remain on Postpay.
- **"No action is required if you do not currently use paid features in the Gemini API."**

## Impact on sfedits: none expected

sfedits calls the Gemini API in one place, `lib/gemini-pii-check.js`, as a second-opinion check when Presidio flags a post for PII. That code is built around the **free tier**:

- Prefers `gemini-2.5-pro` (free with Google One / AI Pro subscription), falls back to `gemini-2.5-flash` (free tier).
- Uses a plain AI Studio API key (`GEMINI_API_KEY` env var), no billing plan attached.
- Volume is tiny: one small prompt per PII-flagged post.

Since sfedits does not use paid Gemini API features, the email's own terms say no action is required.

## Failure mode if this assessment is wrong

If Google's definition of paid features shifts under the key's project and calls start failing on October 12, the bot degrades gracefully rather than breaking:

- `verifyPIIWithGemini()` returns `'unavailable'` on any API error.
- The bot falls back to blocking the flagged post for manual review in the admin UI.
- Symptom would be more items in the review queue and `unavailable` entries in `data/gemini-pii-checks.log`, not an outage.

## Outcome: the assessment was wrong

The `SFedits` AI Studio project (the one holding the bot's key) was on paid **Tier 1** with a billing account attached, not the free tier, so it was subject to the switch. It was never moved to Prepay. Between Oct 16 and Oct 23 2026, every Gemini call started returning `402 RESOURCE_EXHAUSTED: Your prepayment credits are depleted`, and AI Studio showed the project as "Prepay required".

The fallback behaved as described above: from Oct 23, every Presidio hit (mostly ISSNs read as phone numbers and IDs in citation URLs read as license or passport numbers) was blocked and DMed as a `PII:` alert, several a day, all false positives. The 402 does not appear in the alert itself, only in the bot log and `data/gemini-pii-checks.log` (`status: unavailable`).

Monthly spend on the project was about $0.43 at the time.

## Resolved: credits bought Oct 25, 2026

$20.00 of prepay credits were added to the billing account (`010D07-0C4081-1036DC`) on 2026-10-25. As of 2026-11-01 AI Studio shows Paid Tier 1, Prepay, auto-reload off, and a $19.84 balance. Credits belong to the billing account, so any other Gemini project linked to it draws from the same balance.
