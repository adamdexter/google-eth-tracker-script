# Google Sheets ETH Price Tracker + SMS Alert

A Google Apps Script, bound to a Google Sheet, that:

- Logs the current ETH-USD spot price (from the Coinbase public API) to a sheet
  every 15 minutes via a time-driven trigger.
- Sends a one-line SMS through Twilio when the price crosses any of the
  configured thresholds, then stays quiet until the price moves back across
  that threshold, so you don't get spammed.
- Records every alert attempt in a `Status` column so delivery problems are
  visible in the sheet instead of failing silently.

## Sheet layout

A single tab named `ETH Monitor` with three columns:

| Timestamp | ETH Price | Status |
|-----------|-----------|--------|
| 11/18/2026 9:20:02 | 1756.965 | |
| ... | ... | `ALERT_SENT` / `ALERT_FAILED (...)` / `ALERT_NOT_SENT (...)` |

The `Status` column is empty for routine price logs and only populated on
alert attempts.

## Setup

1. Create a Google Sheet with a tab named `ETH Monitor` and header row
   `Timestamp | ETH Price | Status`.
2. Open **Extensions → Apps Script** and paste in [`Code.gs`](Code.gs).
3. Configure the constants at the top of the script:
   - `ALERTS` — a list of `{ threshold, direction }` entries, e.g.
     `{ threshold: 3000, direction: "ABOVE" }`. `"ABOVE"` alerts when price
     ≥ threshold, `"BELOW"` when price ≤ threshold. Add as many as you like.
   - `COOLDOWN_MINUTES` — minimum minutes between SMS for the same
     threshold (default 60); this only matters when the price is flapping
     right around a threshold.
4. Add your Twilio credentials as **Script Properties** (never hardcode them —
   see [Security](#security)). In the Apps Script editor:
   **Project Settings (gear icon) → Script Properties → Add script property**:
   - `TWILIO_SID` — your Twilio Account SID
   - `TWILIO_TOKEN` — your Twilio Auth Token
   - `TWILIO_NUMBER` — your Twilio sending number in E.164 format (`+1...`)
   - `MY_PHONE` — the destination number in E.164 format (`+1...`)
5. Add a time-driven trigger: **Triggers (clock icon) → Add Trigger** →
   function `checkETHPrice`, event source *Time-driven*, every 15 minutes.
6. Run `checkETHPrice` once from the editor to grant the OAuth permissions
   (Spreadsheets + external requests).
7. Run `sendTestSMS` from the editor to verify end-to-end SMS delivery; the
   result appears in the execution log (and a test message arrives on your
   phone if everything is configured).

If the Twilio properties are missing, the script still logs prices normally;
an alert that would have fired is recorded as
`ALERT_NOT_SENT (Twilio not configured in Script Properties)`.

Note: sending SMS from a Twilio toll-free number requires completing Twilio's
toll-free verification (use-case description, sample message, and an opt-in
page) before messages will deliver.

## How it works

- `checkETHPrice()` — trigger entry point. Fetches the price, appends a row,
  and runs the alert check. Each alert fires once when its threshold is
  crossed (a `FIRED_<direction>_<threshold>` script property marks it), and
  re-arms automatically when the price moves back across the threshold — so
  a price that sits above a threshold doesn't text you every 15 minutes. If
  one run crosses several thresholds, a single SMS covers all of them.
- `fetchPrice_()` — fetches the Coinbase spot price with
  `muteHttpExceptions` and one retry. On failure it returns `null` and the
  run exits quietly; the next trigger run (15 minutes later) covers the gap.
- `cooldownElapsed_()` — the timestamp of each threshold's last successful
  alert is kept in Script Properties (`LAST_ALERT_AT_<direction>_<threshold>`),
  so the cooldown check is O(1) instead of scanning the whole log sheet
  (which grows by ~96 rows/day and made every run slower).
- `sendSMS_()` — calls Twilio's Messages API and returns a status string
  (`ALERT_SENT`, `ALERT_FAILED (Twilio HTTP 4xx)`, etc.) that is written to
  the sheet. The fired/cooldown properties are only updated on success, so a
  failed send is retried on the next run instead of being swallowed.

## History: what was broken and how it was fixed

The original version of this script (May 2025) had several problems that were
fixed in November 2026:

1. **Alerts crashed exactly when they should have fired.** An early revision
   referenced `COOLDOWN_MINUTES` without defining it. Price logging worked
   (the `appendRow` ran before the alert check), but any run where the price
   crossed the threshold died with
   `ReferenceError: COOLDOWN_MINUTES is not defined` — so the alert window
   was missed entirely. Defining the constant fixed the crash; the rewrite
   also restructured the code so a failure in the alert path can no longer
   lose the price log for that run.
2. **Twilio credentials were hardcoded in the script.** They now live in
   Script Properties, which keeps them out of the code and makes the script
   safe to publish and share.
3. **No error handling on the price fetch.** Transient Coinbase/network
   errors produced failed executions and gaps in the log, and one hung fetch
   ran for 32 minutes before Apps Script killed it. The fetch now mutes HTTP
   exceptions, retries once, and gives up cleanly until the next run.
4. **The cooldown check scanned the entire sheet** (52,000+ rows) on every
   run, scanning bottom-up for the last `ALERT_SENT` marker. It now reads a
   single script property.
5. **Only one alert, in one direction** (price above a single threshold).
   The script now takes a list of alerts, each with its own threshold and
   direction, and each one fires on the crossing and re-arms when the price
   crosses back — instead of re-alerting every hour for as long as the
   price stays past the threshold.

## Security

- **Never commit or hardcode Twilio credentials** (or any API secret) in the
  script — anyone with the SID + auth token can send SMS from your account
  and read your message history. Use Script Properties.
- Be careful sharing ChatGPT/Claude conversation links or screenshots that
  include your code: if the secrets were pasted into the chat, the share link
  exposes them. If that happens, rotate the Twilio auth token in the Twilio
  console immediately.
