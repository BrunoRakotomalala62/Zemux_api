import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, resetRateLimitsForTests } from "../src/app.js";
import { getConfig, FREE_MODEL, FREE_MODELS } from "../src/config.js";

class FakeStore {
  constructor() { this.records = new Map(); }
  async get(uid) {
    return { messages: this.records.get(uid) ?? [], persistent: true, backend: "test", warning: null };
  }
  async set(uid, messages) {
    this.records.set(uid, messages);
    return { messages, persistent: true, backend: "test", warning: null };
  }
  async clear(uid) {
    this.records.delete(uid);
    return { persistent: true, backend: "test", warning: null };
  }
}

class FakeZenMux {
  constructor() { this.calls = []; }
  async chat(input) {
    this.calls.push(input);
    return {
      answer: `Réponse ${this.calls.length}`,
      model: input.model || FREE_MODEL,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        completion_tokens_details: { reasoning_tokens: 3 },
        cost: "0",
      },
      finishReason: "stop",
      generationId: `gen-${this.calls.length}`,
    };
  }
}

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = "") { this.body += value; },
  };
}

async function invoke(handler, path, options = {}) {
  const req = {
    method: options.method ?? "GET",
    url: path,
    headers: { host: "localhost", "x-forwarded-for": options.ip || "203.0.113.1", ...(options.headers ?? {}) },
    socket: { remoteAddress: options.ip || "203.0.113.1" },
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
  const res = mockResponse();
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body) };
}

function baseConfig(extra = {}) {
  return { ...getConfig({ ZENMUX_API_KEY: "test-key" }), ...extra };
}

test.beforeEach(() => resetRateLimitsForTests());

test("GET /api sans paramètres décrit l'API gratuite", async () => {
  const response = await invoke(createHandler({ config: baseConfig() }), "/api");
  assert.equal(response.status, 200);
  assert.equal(response.json.model, FREE_MODEL);
  assert.equal(response.json.default_model, FREE_MODEL);
  assert.deepEqual(response.json.models.map((item) => item.id), [...FREE_MODELS]);
  assert.equal(response.json.pricing.catalog, "free");
  assert.deepEqual(response.json.methods, ["GET", "POST"]);
});

test("une conversation continue avec le même uid", async () => {
  const store = new FakeStore();
  const zenmux = new FakeZenMux();
  const handler = createHandler({ config: baseConfig(), store, zenmux });
  const first = await invoke(handler, "/api?zemux=Bonjour&uid=123");
  const second = await invoke(handler, "/api?zenmux=Continue&uid=123");
  assert.equal(first.status, 200);
  assert.equal(first.json.model, FREE_MODEL);
  assert.equal(first.json.tokens.request.total, 15);
  assert.equal(first.json.tokens.request.reasoning, 3);
  assert.equal(second.json.answer, "Réponse 2");
  assert.equal(zenmux.calls[1].messages.length, 3);
  assert.equal(zenmux.calls[1].messages[1].role, "assistant");
});

test("POST transmet jusqu'à quatre images data URL au modèle multimodal", async () => {
  const zenmux = new FakeZenMux();
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=";
  const handler = createHandler({ config: baseConfig(), store: new FakeStore(), zenmux });
  const response = await invoke(handler, "/api", {
    method: "POST",
    body: { message: "Compare", uid: "img-1", images: [png, png], reset: true },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.image.count, 2);
  assert.equal(response.json.image.sources[0].type, "data");
  assert.equal(zenmux.calls[0].images.length, 2);
});

test("une URL d'image distante est préparée sans exposer son contenu", async () => {
  const zenmux = new FakeZenMux();
  const handler = createHandler({
    config: baseConfig(),
    store: new FakeStore(),
    zenmux,
    imageLoader: async () => ({
      dataUrl: "data:image/jpeg;base64,/9j/2Q==",
      contentType: "image/jpeg",
      size: 4,
      finalUrl: "https://images.example/photo.jpg",
      sourceType: "url",
    }),
  });
  const response = await invoke(handler, "/api?zemux=Décris&uid=img-url&image=https%3A%2F%2Fimages.example%2Fphoto.jpg");
  assert.equal(response.status, 200);
  assert.equal(response.json.image.sources[0].type, "url");
  assert.equal(response.json.image.sources[0].url, "https://images.example/photo.jpg");
});

test("la liste blanche autorise uniquement les deux modèles gratuits", async () => {
  const zenmux = new FakeZenMux();
  const handler = createHandler({ config: baseConfig(), store: new FakeStore(), zenmux });
  const denied = await invoke(handler, "/api?zemux=Bonjour&uid=123&model=openai%2Fgpt-5");
  const defaultAlias = await invoke(handler, "/api?zemux=Bonjour&uid=124&model=free");
  const dots = await invoke(handler, "/api?zemux=Bonjour&uid=125&model=dots-studio%2Fdots3-note-prev");
  const dotsAlias = await invoke(handler, "/api?zemux=Bonjour&uid=126&model=dots3");
  assert.equal(denied.status, 400);
  assert.equal(denied.json.error.code, "invalid_model");
  assert.deepEqual(denied.json.error.details.allowed_models, [...FREE_MODELS]);
  assert.equal(defaultAlias.status, 200);
  assert.equal(defaultAlias.json.model, FREE_MODEL);
  assert.equal(dots.status, 200);
  assert.equal(dots.json.model, "dots-studio/dots3-note-prev");
  assert.equal(dotsAlias.json.model, "dots-studio/dots3-note-prev");
  assert.equal(zenmux.calls.at(-1).model, "dots-studio/dots3-note-prev");
});

test("ZEMUX_API_TOKEN protège facultativement la route", async () => {
  const handler = createHandler({
    config: baseConfig({ publicApiToken: "secret" }),
    store: new FakeStore(),
    zenmux: new FakeZenMux(),
  });
  const denied = await invoke(handler, "/api?zemux=Bonjour&uid=123");
  const allowed = await invoke(handler, "/api?zemux=Bonjour&uid=123", {
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(denied.status, 401);
  assert.equal(allowed.status, 200);
});

test("la limite locale par minute est appliquée", async () => {
  const handler = createHandler({
    config: baseConfig({ rateLimitPerMinute: 1 }),
    store: new FakeStore(),
    zenmux: new FakeZenMux(),
  });
  const first = await invoke(handler, "/api?zemux=Un&uid=rate-1");
  const second = await invoke(handler, "/api?zemux=Deux&uid=rate-1");
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(second.headers["retry-after"], "60");
});
