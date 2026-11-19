/**
 * ETH Price Monitor
 *
 * Logs the ETH-USD spot price to the "ETH Monitor" sheet every 15 minutes
 * (via a time-driven trigger on checkETHPrice) and sends an SMS through
 * Twilio when the price crosses any configured threshold.
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

// Alert configuration. Each entry sends one SMS when the price crosses its
// threshold, then stays quiet until the price moves back across the
// threshold (re-arming it), so a price that sits above a threshold doesn't
// text you every run.
const ALERTS = [
  { threshold: 3000, direction: "ABOVE" }, // alert when price >= 3000
  { threshold: 4000, direction: "ABOVE" }, // alert when price >= 4000
];
const COOLDOWN_MINUTES = 60; // min minutes between SMS for the same threshold

/** Entry point, run by the 15-minute time-driven trigger. */
function checkETHPrice() {
  const price = fetchPrice_();
  if (price === null) {
    // Transient API failure — skip this run; the next one is in 15 minutes.
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const props = PropertiesService.getScriptProperties();

  // Work out which alerts just crossed, and re-arm any that un-crossed.
  const due = [];
  for (const alert of ALERTS) {
    const crossed =
      (alert.direction === "ABOVE" && price >= alert.threshold) ||
      (alert.direction === "BELOW" && price <= alert.threshold);
    const key = alertKey_(alert);

    if (crossed) {
      if (!props.getProperty("FIRED_" + key) && cooldownElapsed_(key)) {
        due.push(alert);
      }
    } else if (props.getProperty("FIRED_" + key)) {
      // Price moved back across the threshold — re-arm this alert.
      props.deleteProperty("FIRED_" + key);
    }
  }

  if (due.length === 0) {
    sheet.appendRow([new Date(), price]);
    return;
  }

  // One SMS covers every threshold crossed this run.
  const parts = due.map(function (a) {
    return (a.direction === "ABOVE" ? "above" : "below") + " $" + a.threshold;
  });
  const status = sendSMS_(
    "\u{1F6A8} ETH is " + parts.join(" and ") + ": current price $" + price
  );
  sheet.appendRow([new Date(), price, status]);

  if (status === "ALERT_SENT") {
    const now = String(Date.now());
    for (const alert of due) {
      const key = alertKey_(alert);
      props.setProperty("FIRED_" + key, "1");
      props.setProperty("LAST_ALERT_AT_" + key, now);
    }
  }
}

/**
 * Manual test: run this from the editor to verify Twilio is configured and
 * delivering. Check the execution log for the result.
 */
function sendTestSMS() {
  const result = sendSMS_("Test from ETH Price Monitor - SMS alerts are working");
  Logger.log("Test SMS result: " + result);
}

/** Stable Script Properties key suffix for one alert. */
function alertKey_(alert) {
  return alert.direction + "_" + alert.threshold;
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

/** True if this alert hasn't sent an SMS within the last COOLDOWN_MINUTES. */
function cooldownElapsed_(key) {
  const last = PropertiesService.getScriptProperties().getProperty(
    "LAST_ALERT_AT_" + key
  );
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
