import { HttpError } from "./errors.js";
import { hashUid } from "./security.js";

const memoryRecords = new Map();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function cleanMessage(message) {
  if (!message || !["user", "assistant"].includes(message.role)) return null;
  if (typeof message.content !== "string" || message.content.length === 0) return null;
  return { role: message.role, content: message.content };
}

export function trimMessages(messages, maxMessages, maxChars) {
  const clean = messages.map(cleanMessage).filter(Boolean).slice(-maxMessages);
  let total = clean.reduce((sum, item) => sum + item.content.length, 0);
  while (clean.length > 1 && total > maxChars) {
    total -= clean.shift().content.length;
  }
  return clean;
}

class MemoryConversationStore {
  constructor(config) {
    this.ttl = config.conversationTtlSeconds;
  }

  get(key) {
    const record = memoryRecords.get(key);
    if (!record) return [];
    if (record.expiresAt <= nowSeconds()) {
      memoryRecords.delete(key);
      return [];
    }
    return record.messages;
  }

  set(key, messages) {
    memoryRecords.set(key, { messages, expiresAt: nowSeconds() + this.ttl });
  }

  delete(key) {
    memoryRecords.delete(key);
  }
}

export class ConversationStore {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.memory = new MemoryConversationStore(config);
    this.redisEnabled = Boolean(config.redisUrl && config.redisToken);
    this.redisIncomplete = Boolean(config.redisUrl) !== Boolean(config.redisToken);
  }

  key(uid) {
    return `zemux:conversation:${hashUid(uid)}`;
  }

  async redisCommand(command) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetch(this.config.redisUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.redisToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Redis REST HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(`Redis REST: ${payload.error}`);
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async get(uid) {
    const key = this.key(uid);
    let warning = this.redisIncomplete
      ? "Configuration Redis incomplète; historique conservé seulement en mémoire."
      : null;

    if (this.redisEnabled) {
      try {
        const raw = await this.redisCommand(["GET", key]);
        if (raw === null || raw === undefined) {
          return { messages: [], persistent: true, backend: "upstash", warning };
        }
        const parsed = JSON.parse(raw);
        const messages = trimMessages(
          Array.isArray(parsed) ? parsed : [],
          this.config.maxHistoryMessages,
          this.config.maxHistoryChars,
        );
        this.memory.set(key, messages);
        return { messages, persistent: true, backend: "upstash", warning };
      } catch (error) {
        warning = "Redis indisponible; repli temporaire sur la mémoire du serveur.";
        console.warn("Conversation Redis read fallback:", error.message);
      }
    }

    return { messages: this.memory.get(key), persistent: false, backend: "memory", warning };
  }

  async set(uid, messages) {
    const key = this.key(uid);
    const trimmed = trimMessages(messages, this.config.maxHistoryMessages, this.config.maxHistoryChars);
    this.memory.set(key, trimmed);
    let warning = this.redisIncomplete
      ? "Configuration Redis incomplète; historique conservé seulement en mémoire."
      : null;

    if (this.redisEnabled) {
      try {
        await this.redisCommand([
          "SET", key, JSON.stringify(trimmed), "EX", this.config.conversationTtlSeconds,
        ]);
        return { messages: trimmed, persistent: true, backend: "upstash", warning };
      } catch (error) {
        warning = "Redis indisponible; historique conservé temporairement en mémoire.";
        console.warn("Conversation Redis write fallback:", error.message);
      }
    }
    return { messages: trimmed, persistent: false, backend: "memory", warning };
  }

  async clear(uid) {
    const key = this.key(uid);
    this.memory.delete(key);
    if (this.redisEnabled) {
      try {
        await this.redisCommand(["DEL", key]);
        return { persistent: true, backend: "upstash", warning: null };
      } catch (error) {
        return {
          persistent: false,
          backend: "memory",
          warning: "Redis indisponible; suppression effectuée seulement en mémoire.",
        };
      }
    }
    return {
      persistent: false,
      backend: "memory",
      warning: this.redisIncomplete ? "Configuration Redis incomplète." : null,
    };
  }
}

export function resetMemoryStoreForTests() {
  memoryRecords.clear();
}

export function ensureConversationStore(store) {
  if (!store || typeof store.get !== "function" || typeof store.set !== "function") {
    throw new HttpError(500, "storage_configuration_error", "Stockage invalide.");
  }
  return store;
}
