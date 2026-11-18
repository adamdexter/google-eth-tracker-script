/**
 * ETH Price Monitor
 *
 * Logs the ETH-USD spot price to the "ETH Monitor" sheet every 15 minutes
 * (via a time-driven trigger on checkETHPrice) and sends an SMS through
 * Twilio when the price crosses a configured threshold.
 *
 * Twilio credentials are read from Script Properties — never hardcode them.
 * Set these in the Apps Script editor under Project Settings (gear icon) →
 * Script Properties:
 *   TWILIO_SID      Twilio Account SID
 *   TWILIO_TOKEN    Twilio Auth Token
 *   TWILIO_NUMBER   Your Twilio sending number, E.164 format (+1...)
 *   MY_PHONE        The destination number, E.164 format (+1...)
 */

const COINBASE_API = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
const SHEET_NAME = "ETH Monitor";

// Alert configuration.
const ALERT_THRESHOLD = 4000;    // USD
const ALERT_DIRECTION = "ABOVE"; // "ABOVE" = alert when price >= threshold,
                                 // "BELOW" = alert when price <= threshold
const COOLDOWN_MINUTES = 60;     // minimum minutes between alerts

/** Entry point, run by the 15-minute time-driven trigger. */
function checkETHPrice() {
  const price = fetchPrice_();
  if (price === null) {
    // Transient API failure — skip this run; the next one is in 15 minutes.
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);

  const crossed =
    (ALERT_DIRECTION === "ABOVE" && price >= ALERT_THRESHOLD) ||
    (ALERT_DIRECTION === "BELOW" && price <= ALERT_THRESHOLD);

  if (!crossed || !cooldownElapsed_()) {
    sheet.appendRow([new Date(), price]);
    return;
  }

  const verb = ALERT_DIRECTION === "ABOVE" ? "above" : "below";
  const status = sendSMS_(
    "\u{1F6A8} ETH is " + verb + " $" + ALERT_THRESHOLD + ": current price $" + price
  );
  sheet.appendRow([new Date(), price, status]);

  if (status === "ALERT_SENT") {
    PropertiesService.getScriptProperties().setProperty(
      "LAST_ALERT_AT",
      String(Date.now())
    );
  }
}

/** Fetches the ETH-USD spot price from Coinbase. Returns null on failure. */
function fetchPrice_() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = UrlFetchApp.fetch(COINBASE_API, { muteHttpExceptions: true });
      if (response.getResponseCode() === 200) {
        const price = parseFloat(JSON.parse(response.getContentText()).data.amount);
        if (!isNaN(price)) {
          return price;
        }
      }
    } catch (e) {
      // Network error — fall through and retry once.
    }
    Utilities.sleep(2000);
  }
  return null;
}

/** True if no alert was sent within the last COOLDOWN_MINUTES. */
function cooldownElapsed_() {
  const last = PropertiesService.getScriptProperties().getProperty("LAST_ALERT_AT");
  if (!last) {
    return true;
  }
  return (Date.now() - Number(last)) / 60000 > COOLDOWN_MINUTES;
}

/**
 * Sends an SMS via Twilio. Returns a status string that gets logged to the
 * sheet's Status column, so delivery problems are visible in the sheet
 * instead of failing silently.
 */
function sendSMS_(message) {
  const props = PropertiesService.getScriptProperties();
  const sid = props.getProperty("TWILIO_SID");
  const token = props.getProperty("TWILIO_TOKEN");
  const from = props.getProperty("TWILIO_NUMBER");
  const to = props.getProperty("MY_PHONE");

  if (!sid || !token || !from || !to) {
    return "ALERT_NOT_SENT (Twilio not configured in Script Properties)";
  }

  try {
    const response = UrlFetchApp.fetch(
      "https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json",
      {
        method: "post",
        payload: { To: to, From: from, Body: message },
        headers: {
          Authorization: "Basic " + Utilities.base64Encode(sid + ":" + token)
        },
        muteHttpExceptions: true
      }
    );
    const code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      return "ALERT_SENT";
    }
    return "ALERT_FAILED (Twilio HTTP " + code + ")";
  } catch (e) {
    return "ALERT_FAILED (" + e + ")";
  }
}
