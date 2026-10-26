import test from "node:test";
import assert from "node:assert/strict";
import { buildBillingReport, buildUsageReport } from "../src/token-usage.js";

test("le rapport normalise les tokens et ne double pas le raisonnement", () => {
  const usage = buildUsageReport({
    prompt_tokens: 120,
    completion_tokens: 80,
    total_tokens: 200,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 60 },
  });
  assert.deepEqual(usage, {
    input: 120,
    cached_input: 20,
    output: 80,
    reasoning: 60,
    total: 200,
    note: "Les tokens de raisonnement sont déjà inclus dans les tokens de sortie.",
  });
});

test("les métadonnées de coût sont relayées sans les appeler facture", () => {
  const billing = buildBillingReport({ cost: "0.0001", cost_details: { prompt: "0.00001" } });
  assert.equal(billing.catalog_price, "free");
  assert.equal(billing.reported_cost_metadata, "0.0001");
  assert.match(billing.note, /ne constituent pas une facture/);
});
