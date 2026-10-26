import test from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/config.js";
import { ConversationStore, resetMemoryStoreForTests, trimMessages } from "../src/store.js";

test.beforeEach(() => resetMemoryStoreForTests());

test("le stockage mémoire conserve une conversation par uid", async () => {
  const store = new ConversationStore(getConfig({ ZENMUX_API_KEY: "test" }));
  await store.set("abc", [{ role: "user", content: "Bonjour" }]);
  const result = await store.get("abc");
  assert.equal(result.messages[0].content, "Bonjour");
  assert.equal(result.backend, "memory");
});

test("les messages anciens sont supprimés selon les limites", () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message-${i}` }));
  const trimmed = trimMessages(messages, 4, 1000);
  assert.equal(trimmed.length, 4);
  assert.equal(trimmed[0].content, "message-4");
});

test("clear efface l'historique", async () => {
  const store = new ConversationStore(getConfig({ ZENMUX_API_KEY: "test" }));
  await store.set("abc", [{ role: "user", content: "Bonjour" }]);
  await store.clear("abc");
  assert.deepEqual((await store.get("abc")).messages, []);
});
