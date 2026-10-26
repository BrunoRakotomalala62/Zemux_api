import test from "node:test";
import assert from "node:assert/strict";
import { getConfig, FREE_MODEL, FREE_MODELS } from "../src/config.js";
import { ZenMuxClient } from "../src/zenmux.js";

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("le client utilise le modèle gratuit par défaut et transmet les images", async () => {
  let sent;
  let sentHeaders;
  const client = new ZenMuxClient(getConfig({ ZENMUX_API_KEY: "test" }), {
    fetch: async (_url, options) => {
      sent = JSON.parse(options.body);
      sentHeaders = options.headers;
      return jsonResponse(200, {
        id: "gen-test",
        model: FREE_MODEL,
        choices: [{ message: { content: "Un chat" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });
  const result = await client.chat({
    messages: [{ role: "user", content: "Décris" }],
    images: [{ dataUrl: "data:image/png;base64,AAAA" }],
  });
  assert.equal(sent.model, FREE_MODEL);
  assert.equal(sent.messages[1].content[1].type, "image_url");
  assert.match(sentHeaders["X-Title"], /^[\x20-\x7E]+$/);
  assert.equal(result.answer, "Un chat");
  assert.equal(result.generationId, "gen-test");
});

test("le client route Dots3 et refuse tout modèle hors liste blanche", async () => {
  let sent;
  const dots = "dots-studio/dots3-note-prev";
  const client = new ZenMuxClient(getConfig({ ZENMUX_API_KEY: "test" }), {
    fetch: async (_url, options) => {
      sent = JSON.parse(options.body);
      return jsonResponse(200, {
        model: dots,
        choices: [{ message: { content: "Réponse Dots" }, finish_reason: "stop" }],
      });
    },
  });
  const result = await client.chat({
    model: dots,
    messages: [{ role: "user", content: "Bonjour" }],
  });
  assert.deepEqual([...FREE_MODELS], [FREE_MODEL, dots]);
  assert.equal(sent.model, dots);
  assert.equal(result.model, dots);
  assert.equal(result.answer, "Réponse Dots");
  await assert.rejects(
    client.chat({
      model: "openai/gpt-5",
      messages: [{ role: "user", content: "Bonjour" }],
    }),
    (error) => error.code === "invalid_model" && error.status === 400,
  );
});

test("le raisonnement interne n'est jamais utilisé comme réponse", async () => {
  const client = new ZenMuxClient(getConfig({ ZENMUX_API_KEY: "test" }), {
    fetch: async () => jsonResponse(200, {
      choices: [{ message: { content: "Réponse finale", reasoning: "raisonnement privé" }, finish_reason: "stop" }],
    }),
  });
  assert.equal((await client.chat({ messages: [{ role: "user", content: "Bonjour" }] })).answer, "Réponse finale");
});

test("une clé absente est refusée avant tout appel réseau", async () => {
  const client = new ZenMuxClient(getConfig({}), { fetch: async () => { throw new Error("ne doit pas être appelé"); } });
  await assert.rejects(
    client.chat({ messages: [{ role: "user", content: "Bonjour" }] }),
    (error) => error.code === "zenmux_key_missing" && error.status === 503,
  );
});

test("les erreurs de solde ZenMux sont normalisées", async () => {
  const client = new ZenMuxClient(getConfig({ ZENMUX_API_KEY: "test" }), {
    fetch: async () => jsonResponse(402, { error: { message: "balance required" } }),
  });
  await assert.rejects(
    client.chat({ messages: [{ role: "user", content: "Bonjour" }] }),
    (error) => error.code === "zenmux_balance_required" && error.status === 402,
  );
});
