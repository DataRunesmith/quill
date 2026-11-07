export function isIrrelevantRecipientRole(areaType: string, role: string | null): boolean {
  if ((areaType !== "kommun" && areaType !== "region") || !role?.trim()) return false;

  const normalizedRole = role.trim().toLocaleLowerCase("sv-SE");
  return (
    normalizedRole.includes("revisor") ||
    normalizedRole.includes("nämndeman") ||
    normalizedRole.includes("nämndemän") ||
    normalizedRole.includes("vigselförrätt") ||
    normalizedRole.includes("partnerskapsförrätt") ||
    normalizedRole === "god man" ||
    normalizedRole.startsWith("gode män")
  );
}
