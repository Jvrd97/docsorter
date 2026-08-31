/** Категории и известные отправители. Правится руками — модель обязана выбрать из списка. */

export const CATEGORIES = [
  "Чеки и расходы",
  "Страховка",
  "Налоги",
  "Банк и финансы",
  "Договоры",
  "Медицина",
  "Жильё и аренда",
  "Работа и доходы",
  "Транспорт и авто",
  "Учёба и квалификация",
  "Государство и визы",
  "Связь и подписки",
  "Гарантии и покупки",
  "Прочее",
] as const;

export const FALLBACK_CATEGORY = "Прочее";

export const KNOWN_SENDERS = [
  "o2", "Vodafone", "Telekom", "Volksbank", "Sparkasse", "Deutsche Bank",
  "Commerzbank", "N26", "DKB", "PayPal", "Allianz", "Techniker Krankenkasse",
  "AOK", "Barmer", "HUK-Coburg", "Jobcenter", "Agentur für Arbeit", "Finanzamt",
  "Bundesdruckerei", "Ausländerbehörde", "ARD ZDF Beitragsservice",
  "Deutsche Post", "Amazon", "REWE", "Lidl", "Aldi", "Edeka", "dm", "Rossmann",
  "E.ON", "Praxis 360° Mensch",
] as const;

export const ENTITY_KINDS = [
  "iban", "contract_no", "customer_no", "case_no", "tax_id",
  "invoice_no", "person", "org", "email", "phone", "address", "other",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Нормализация для точного сопоставления: без пробелов, дефисов и регистра. */
export function normalizeEntity(value: string): string {
  return value.toUpperCase().replace(/[\s\-./]/g, "").trim();
}
