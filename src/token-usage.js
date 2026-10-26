function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function buildUsageReport(usage) {
  const raw = usage && typeof usage === "object" ? usage : {};
  const input = number(raw.prompt_tokens);
  const output = number(raw.completion_tokens);
  const reasoning = number(raw.completion_tokens_details?.reasoning_tokens);
  const cachedInput = number(raw.prompt_tokens_details?.cached_tokens);
  const total = number(raw.total_tokens) || input + output;
  return {
    input,
    cached_input: cachedInput,
    output,
    reasoning,
    total,
    note: "Les tokens de raisonnement sont déjà inclus dans les tokens de sortie.",
  };
}

export function buildBillingReport(usage) {
  const raw = usage && typeof usage === "object" ? usage : {};
  return {
    catalog_price: "free",
    reported_cost_metadata: raw.cost ?? null,
    reported_cost_details: raw.cost_details ?? null,
    note: "Le catalogue public indique un tarif nul pour ce modèle. Les métadonnées cost sont relayées telles quelles et ne constituent pas une facture.",
  };
}
