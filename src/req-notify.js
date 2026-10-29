import { REQUISITION_FREQUENCIES } from "./config.js";
import { formatLondon, formatPence } from "./util.js";
import { sendEmail } from "./mailer.js";

// Emails the office whenever someone files a requisition, so a request never
// sits unseen waiting for an admin to happen to open the portal. The email
// carries every field from the form plus a button straight into the admin
// review for that reference.
//
// Recipient defaults to the office and can be pointed elsewhere with the
// REQUISITION_NOTIFY_EMAIL var (see wrangler.jsonc).

const DEFAULT_RECIPIENT = "Office@kharis.org";

const FREQ_LABEL = new Map(REQUISITION_FREQUENCIES.map(f => [f.value, f.label]));
const PER_YEAR = new Map(REQUISITION_FREQUENCIES.map(f => [f.value, f.perYear]));

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// The deep link the office clicks. `?admin` opens the (otherwise unadvertised)
// admin login; `ref` tells the portal which requisition to jump to once the
// passcode is in. Approving still needs the passcode, so forwarding the email
// hands nobody the ability to approve spend.
export function reviewUrl(origin, reference) {
  return `${origin}/requisitions/?admin&ref=${encodeURIComponent(reference)}`;
}

function row(label, value) {
  return `<tr>
    <td style="padding:9px 0;border-bottom:1px solid #ececec;color:#6b6b70;font-size:13px;width:150px;vertical-align:top;">${label}</td>
    <td style="padding:9px 0;border-bottom:1px solid #ececec;color:#1a1c1c;font-size:14px;vertical-align:top;">${value}</td>
  </tr>`;
}

// Build the HTML + plain-text bodies for one requisition. Exported separately
// from the send so it can be rendered and eyeballed without touching SES.
export function renderNewRequisitionEmail(r, link) {
  const quantity = r.quantity || 1;
  const unit = `£${formatPence(r.cost_pence)}`;
  const total = `£${formatPence(r.cost_pence * quantity)}`;
  const recurring = r.kind === "recurring";
  const freqLabel = recurring ? (FREQ_LABEL.get(r.frequency) || r.frequency || "") : "";
  const perYear = recurring ? (PER_YEAR.get(r.frequency) || 0) : 0;

  // One unit: showing "1 × £49.99" adds nothing over "£49.99".
  const amountLine = quantity > 1
    ? `<strong style="font-size:20px;">${total}</strong>
       <span style="color:#6b6b70;font-size:13px;">&nbsp;(${quantity} &times; ${unit})</span>`
    : `<strong style="font-size:20px;">${total}</strong>`;

  const rows = [
    row("Item", esc(r.item)),
    row("Quantity", String(quantity)),
    row(recurring ? "Amount each time" : "Amount", amountLine),
    recurring ? row("Recurring", `${esc(freqLabel)}${perYear ? ` &middot; £${formatPence(r.cost_pence * quantity * perYear)} / year` : ""}`) : "",
    row("What it's for", esc(r.category)),
    row("Requested by", esc(r.requestor)),
    row("Approver", esc(r.approver)),
    r.item_url ? row("Link to item", `<a href="${esc(r.item_url)}" style="color:#5d3fd3;word-break:break-all;">${esc(r.item_url)}</a>`) : "",
    row("Best value", r.value_checked
      ? "&#10003; Requestor confirmed they considered alternatives"
      : "<span style=\"color:#e11d48;\">Not confirmed</span>"),
    r.notes ? row("Notes", esc(r.notes).replace(/\n/g, "<br />")) : "",
    row("Reference", `<strong>${esc(r.reference)}</strong>`),
    row("Submitted", esc(formatLondon(r.created_at)))
  ].filter(Boolean).join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#fafafa;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ececec;border-radius:8px;padding:28px;">
    <p style="margin:0 0 4px;color:#6b6b70;font-size:12px;letter-spacing:.06em;text-transform:uppercase;">Spurgeon's Centre</p>
    <h2 style="margin:0 0 6px;color:#5d3fd3;font-size:20px;">New venue uplift requisition</h2>
    <p style="margin:0 0 20px;color:#6b6b70;font-size:14px;">
      ${esc(r.requestor)} has requested <strong style="color:#1a1c1c;">${total}</strong> for
      ${esc(r.item)}. It is <strong>pending</strong> until someone reviews it.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
      ${rows}
    </table>

    <p style="text-align:center;margin:28px 0 8px;">
      <a href="${esc(link)}" style="background:#5d3fd3;color:#ffffff;padding:13px 30px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Review this requisition
      </a>
    </p>
    <p style="margin:0 0 4px;text-align:center;color:#6b6b70;font-size:12px;">
      You'll be asked for the requisitions admin passcode.
    </p>
    <p style="word-break:break-all;color:#5d3fd3;font-size:11px;text-align:center;margin:0;">${esc(link)}</p>

    <hr style="margin:26px 0 14px;border:none;border-top:1px solid #ececec;" />
    <p style="margin:0;font-size:12px;color:#6b6b70;">
      Sent automatically by the Spurgeon's Centre requisitions form. Please don't reply to this address.
    </p>
  </div>
</body></html>`;

  // Labels padded to a fixed column so the values line up; a multi-line value
  // (notes) is indented to sit under the column rather than back at the margin.
  const PAD = 18;
  const line = (label, value) => {
    const head = (label + ":").padEnd(PAD);
    return head + String(value).replace(/\r?\n/g, "\n" + " ".repeat(PAD));
  };

  const text = [
    `New venue uplift requisition — ${r.reference}`,
    ``,
    line("Item", r.item),
    line("Quantity", quantity),
    line(recurring ? "Amount each time" : "Amount",
      `${total}${quantity > 1 ? ` (${quantity} x ${unit})` : ""}`),
    recurring ? line("Recurring", `${freqLabel}${perYear ? ` — £${formatPence(r.cost_pence * quantity * perYear)} / year` : ""}`) : null,
    line("What it's for", r.category),
    line("Requested by", r.requestor),
    line("Approver", r.approver),
    r.item_url ? line("Link to item", r.item_url) : null,
    line("Best value", r.value_checked ? "Confirmed — requestor considered alternatives" : "Not confirmed"),
    r.notes ? line("Notes", r.notes) : null,
    line("Submitted", formatLondon(r.created_at)),
    ``,
    `Review it (admin passcode required):`,
    link
  ].filter(v => v !== null).join("\n");

  const subject = `Requisition ${r.reference}: ${total} — ${r.item}`;
  return { subject, html, text };
}

// Fire-and-forget from ctx.waitUntil: the requisition is already saved, so a
// bounced or misconfigured SES must never turn a successful submission into an
// error for the person filling in the form. Failures are logged instead.
export async function notifyNewRequisition(env, requisition, origin) {
  const to = env.REQUISITION_NOTIFY_EMAIL || DEFAULT_RECIPIENT;
  const { subject, html, text } = renderNewRequisitionEmail(requisition, reviewUrl(origin, requisition.reference));
  try {
    await sendEmail(env, { to, subject, html, text });
  } catch (err) {
    console.error(`Requisition ${requisition.reference}: office notification failed —`, err && err.message ? err.message : err);
  }
}
