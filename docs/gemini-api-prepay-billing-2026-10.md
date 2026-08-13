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
