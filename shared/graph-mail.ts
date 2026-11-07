// Mailsändning via Microsoft Graph (OAuth) som alternativ till SMTP —
// gratis att registrera (Azure App Registration + publisher-verifiering
// kostar inget, till skillnad från Gmails CASA-granskning som kräver
// betald säkerhetsbedömning). Återanvänder samma Azure-appregistrering som
// "Logga in med Microsoft" (OAUTH_MICROSOFT_CLIENT_ID/SECRET), men begär
// extra scopes (Mail.Send + offline_access) i just detta flöde.

const REDIRECT_URI = "https://__PUBLIC_HOST__/api/oauth-mail/microsoft/callback";
// User.Read krävs för GET /me nedan (hämtar avsändaradressen). openid/email/
// profile ger bara id_token-claims, inte Graph-åtkomst — utan User.Read ger
// /me 403 och kopplingen kraschar med "Kunde inte hämta din e-postadress".
// Alla är user-consentable (inget admin-godkännande).
const MAIL_SEND_SCOPE = "openid email profile offline_access User.Read Mail.Send";

export interface GraphTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  email: string;
}

export function getMicrosoftMailAuthorizeUrl(clientId: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: MAIL_SEND_SCOPE,
    response_mode: "query",
    state,
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function exchangeMicrosoftMailCode(
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<GraphTokens> {
  const tokenResp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
      scope: MAIL_SEND_SCOPE,
    }),
  });
  if (!tokenResp.ok)
    throw new Error(`Kunde inte hämta token från Microsoft: ${await tokenResp.text()}`);
  const data = await tokenResp.json<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>();

  const userResp = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!userResp.ok) throw new Error("Kunde inte hämta din e-postadress från Microsoft Graph");
  const user = await userResp.json<{ mail?: string; userPrincipalName?: string }>();
  const email = user.mail ?? user.userPrincipalName;
  if (!email) throw new Error("Microsoft Graph returnerade ingen e-postadress");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    email,
  };
}

export async function refreshMicrosoftToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const resp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: MAIL_SEND_SCOPE,
    }),
  });
  if (!resp.ok) throw new Error(`Kunde inte förnya Microsoft-token: ${await resp.text()}`);
  const data = await resp.json<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken, // Microsoft roterar inte alltid refresh_token
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export interface GraphMailAttachment {
  filename: string;
  contentType: string;
  bytes: ArrayBuffer;
}

export async function sendGraphMail(
  accessToken: string,
  opts: { to: string; subject?: string; html: string; attachments?: GraphMailAttachment[] },
): Promise<void> {
  const resp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: opts.subject ?? "",
        body: { contentType: "HTML", content: opts.html },
        toRecipients: [{ emailAddress: { address: opts.to } }],
        attachments: (opts.attachments ?? []).map((att) => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: att.filename,
          contentType: att.contentType,
          contentBytes: bytesToBase64(att.bytes),
        })),
      },
      saveToSentItems: true,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Microsoft Graph nekade sändning (${resp.status}): ${await resp.text()}`);
  }
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}
