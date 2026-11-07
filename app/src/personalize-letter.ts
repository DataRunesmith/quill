import { escapeHtml } from "../../shared/html";

const GENERIC_ADDRESS_PATTERN =
  /(registrator|registratur|regering|regeringskansli|riksdag|region|kommun|kansli|expedition|sekretariat|info|kontakt|service|post|mail|myndighet|nämnd|namnd|fullmäktige|fullmaktige|styrelse|politiker|ledamot|ordförande|ordforande)/i;

function firstName(fullName: string, email: string): string {
  const localPart = email.split("@", 1)[0] ?? "";
  if (GENERIC_ADDRESS_PATTERN.test(localPart) || GENERIC_ADDRESS_PATTERN.test(fullName)) return "";
  const first = fullName.trim().split(/\s+/)[0] ?? "";
  if (!first || !/^[\p{L}-]{2,40}$/u.test(first)) return "";
  return first
    .toLocaleLowerCase("sv-SE")
    .replace(
      /(^|-)(\p{L})/gu,
      (_match, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase("sv-SE")}`,
    );
}

export function personalizeLetter(
  bodyHtml: string,
  recipientName: string,
  recipientEmail: string,
  introText = "",
): string {
  const name = firstName(recipientName, recipientEmail);
  const greeting = name ? `Hej ${name}!` : "Hej!";
  const safeGreeting = escapeHtml(greeting);
  const normalizedIntro = introText.trim();
  const safeIntro = normalizedIntro ? escapeHtml(normalizedIntro).replace(/\n/g, "<br>") : "";
  const greetingWithIntro = safeIntro ? `${safeGreeting}<br><br>${safeIntro}` : safeGreeting;

  if (/\{GREETING\}/i.test(bodyHtml)) {
    return bodyHtml.replace(/\{GREETING\}/gi, greetingWithIntro);
  }

  // Bakåtkompatibilitet med äldre utkast från tidigare versioner.
  if (/Hej\s+\[förnamn\]!/i.test(bodyHtml)) {
    return bodyHtml.replace(/Hej\s+\[förnamn\]!/gi, greetingWithIntro);
  }

  const introBlock = safeIntro ? `\n<p>${safeIntro}</p>` : "";
  return `<p>${safeGreeting}</p>${introBlock}\n${bodyHtml}`;
}
