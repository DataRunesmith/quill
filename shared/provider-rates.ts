// Konservativa, UPPSKATTADE max-meddelanden-per-minut per leverantör — till
// skillnad från dygnsgränserna i app/src/mail-credentials.ts (som är
// empiriskt verifierade) finns ingen officiellt dokumenterad burst-/
// genomströmningsgräns för något av dessa konsumentkonton. Värdena nedan är
// medvetet försiktiga gissningar för att undvika tillfälliga block vid en
// skarp rusning av mejl, inte en bekräftad siffra. Justera nedåt om
// leverantören börjar svara med tillfälliga rate-limit-fel trots detta.
export const MESSAGES_PER_MINUTE: Record<string, number> = {
  gmail: 20,
  outlook: 30,
  icloud: 20,
  yahoo: 20,
  microsoft_graph: 30,
  generic: 10, // okänd leverantör — anta minst tolerant
};

export function messagesPerMinuteFor(provider: string): number {
  return MESSAGES_PER_MINUTE[provider] ?? MESSAGES_PER_MINUTE.generic;
}
