export function normalizeSans(sans) {
  if (Array.isArray(sans)) return sans;

  if (typeof sans === "string") {
    try {
      const parsed = JSON.parse(sans);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {
      // ignore parse error, fallback string
    }

    return sans ? [sans] : [];
  }

  return [];
}
