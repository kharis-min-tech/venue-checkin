import { AwsClient } from "aws4fetch";

// Transactional email via AWS SES v2 (REST), signed with aws4fetch. This
// mirrors the mailer in the kairos project (packages/utils/src/mailer.ts) so
// both send from the same verified identity, noreply@kharis.org.
//
// Credentials arrive per-request on `env` (Workers never expose secrets at
// module load), so nothing is cached across requests except the AwsClient,
// which is keyed on the access key id and holds no request state.
//
// When the AWS keys are absent — local dev without SES — sending is skipped
// with a log line instead of throwing, so the requisitions form still works
// end to end on `npm run dev`.

const DEFAULT_REGION = "eu-west-2";
const DEFAULT_FROM = '"Kharis Church" <noreply@kharis.org>';

let _client = null;
let _clientKey = "";

function getAwsClient(env) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID || "";
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY || "";
  const region = env.AWS_REGION || DEFAULT_REGION;
  if (!accessKeyId || !secretAccessKey) return null;

  const key = `${accessKeyId}:${region}`;
  if (_client && _clientKey === key) return _client;
  _client = new AwsClient({ accessKeyId, secretAccessKey, region, service: "ses" });
  _clientKey = key;
  return _client;
}

// True when SES is configured. Callers use this to stay quiet in local dev.
export function isMailerLive(env) {
  return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

// Send one HTML email. Throws on an SES error so the caller can log it; every
// caller here sends from ctx.waitUntil, so a failure never fails the request.
export async function sendEmail(env, { to, subject, html, text, replyTo }) {
  const aws = getAwsClient(env);
  if (!aws) {
    console.log(`Email (dev mode — AWS creds absent, not sent): to=${to} subject=${subject}`);
    return false;
  }

  const region = env.AWS_REGION || DEFAULT_REGION;
  const body = {
    FromEmailAddress: env.EMAIL_FROM || DEFAULT_FROM,
    Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: html, Charset: "UTF-8" },
          ...(text ? { Text: { Data: text, Charset: "UTF-8" } } : {})
        }
      }
    }
  };
  if (replyTo) body.ReplyToAddresses = Array.isArray(replyTo) ? replyTo : [replyTo];
  if (env.SES_CONFIGURATION_SET) body.ConfigurationSetName = env.SES_CONFIGURATION_SET;

  const res = await aws.fetch(`https://email.${region}.amazonaws.com/v2/email/outbound-emails`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`SES send failed (${res.status}): ${detail}`);
  }
  return true;
}
