import { getConfig, FREE_MODEL } from "./config.js";
import { asHttpError, HttpError } from "./errors.js";
import {
  applyCors,
  readJsonBody,
  requestId,
  requestUrl,
  sendJson,
  setCommonHeaders,
} from "./http.js";
import { downloadImageAsDataUrl, parseImageDataUrl } from "./image.js";
import { requireApiToken, validateUid } from "./security.js";
import { ConversationStore, ensureConversationStore } from "./store.js";
import { buildBillingReport, buildUsageReport } from "./token-usage.js";
import { ZenMuxClient } from "./zenmux.js";

let sharedStore;
const rateBuckets = new Map();

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function valueFrom(input, ...names) {
  for (const name of names) {
    const value = firstValue(input[name]);
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "";
}

function truthy(value) {
  return ["1", "true", "yes", "oui", "on"].includes(String(value).toLowerCase());
}

function imageValuesFrom(input) {
  const values = [];
  const append = (value) => {
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  };
  append(input.image);
  append(input.images);
  return values;
}

function clientAddress(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(raw || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

function enforceRateLimit(req, limit) {
  const now = Date.now();
  const key = clientAddress(req);
  const current = rateBuckets.get(key);
  if (!current || now >= current.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60000 });
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    throw new HttpError(
      429,
      "rate_limited",
      `Limite locale atteinte (${limit} requêtes par minute).`,
    );
  }
}

function validateRequestedModel(value) {
  if (!value) return FREE_MODEL;
  const normalized = String(value).trim().toLowerCase();
  const aliases = new Set([
    FREE_MODEL,
    "glm-4.6v-flash-free",
    "glm-4.6v-free",
    "zenmux-free",
    "free",
  ]);
  if (!aliases.has(normalized)) {
    throw new HttpError(
      400,
      "invalid_model",
      `Cette API est verrouillée sur le modèle gratuit ${FREE_MODEL}.`,
    );
  }
  return FREE_MODEL;
}

function publicMetadata(config) {
  return {
    ok: true,
    name: "Zemux API",
    provider: "ZenMux",
    version: "1.0.0",
    endpoint: "/api",
    methods: ["GET", "POST"],
    model: config.model,
    pricing: {
      catalog: "free",
      warning: "La disponibilité et les règles anti-abus restent contrôlées par ZenMux.",
    },
    prompt_parameters: ["zemux", "zenmux", "message", "prompt"],
    conversation: {
      parameter: "uid",
      persistent_when_redis_is_configured: true,
      ttl_seconds: config.conversationTtlSeconds,
    },
    image: {
      parameters: ["image", "images"],
      enabled: config.maxImages > 0,
      max_images: config.maxImages,
      supported_formats: ["PNG", "JPEG", "WebP", "GIF"],
      remote_urls_must_use_https: true,
      data_urls_allowed_in_post: true,
    },
    examples: {
      text: `/api?zemux=Bonjour&uid=123&model=${encodeURIComponent(config.model)}`,
      image: `/api?zemux=Décris%20cette%20image&image=https%3A%2F%2Fexample.com%2Fphoto.jpg&uid=123`,
      reset: "/api?uid=123&reset=1",
    },
  };
}

async function parseInput(req) {
  const url = requestUrl(req);
  const query = Object.fromEntries(url.searchParams.entries());
  if (req.method === "GET") return query;
  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req, 12 * 1024 * 1024);
      return { ...query, ...body };
    } catch (error) {
      if (error.code === "REQUEST_TOO_LARGE") {
        throw new HttpError(413, "request_too_large", "Le corps de la requête est trop volumineux.");
      }
      throw new HttpError(400, "invalid_json", "Le corps JSON est invalide.");
    }
  }
  return query;
}

async function prepareImages(rawImages, config, dependencies) {
  if (rawImages.length > config.maxImages) {
    throw new HttpError(
      400,
      "too_many_images",
      `Cette API accepte au maximum ${config.maxImages} images par requête.`,
    );
  }
  const imageLoader = dependencies.imageLoader ?? downloadImageAsDataUrl;
  const dataParser = dependencies.dataUrlParser ?? parseImageDataUrl;
  return Promise.all(rawImages.map(async (raw) => {
    if (raw.toLowerCase().startsWith("data:")) {
      return dataParser(raw, config.maxImageBytes);
    }
    return imageLoader(raw, config);
  }));
}

export function createHandler(dependencies = {}) {
  return async function handler(req, res) {
    const id = requestId(req);
    const config = dependencies.config ?? getConfig();
    setCommonHeaders(res, id);
    applyCors(req, res, config.allowedOrigins);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (!["GET", "POST"].includes(req.method)) {
        res.setHeader("Allow", "GET, POST, OPTIONS");
        throw new HttpError(405, "method_not_allowed", "Utilisez GET ou POST.");
      }

      requireApiToken(req, config.publicApiToken);
      const input = await parseInput(req);
      const prompt = valueFrom(input, "zemux", "zenmux", "message", "prompt").trim();
      const rawUid = valueFrom(input, "uid").trim();
      const shouldReset = truthy(valueFrom(input, "reset"));

      if (!prompt && !rawUid && !shouldReset) {
        sendJson(res, 200, { ...publicMetadata(config), request_id: id });
        return;
      }

      const uid = validateUid(rawUid);
      const store = ensureConversationStore(
        dependencies.store ??
        (sharedStore ??= new ConversationStore(config, { fetch: dependencies.fetch })),
      );

      if (shouldReset) {
        const cleared = await store.clear(uid);
        if (!prompt) {
          sendJson(res, 200, {
            ok: true,
            request_id: id,
            uid,
            reset: true,
            conversation: cleared,
          });
          return;
        }
      }

      if (!prompt) {
        throw new HttpError(
          400,
          "missing_prompt",
          "Le paramètre zemux, zenmux, message ou prompt est obligatoire.",
        );
      }
      if (prompt.length > config.maxPromptChars) {
        throw new HttpError(
          413,
          "prompt_too_large",
          `Le message dépasse ${config.maxPromptChars} caractères.`,
        );
      }

      validateRequestedModel(valueFrom(input, "model"));
      enforceRateLimit(req, config.rateLimitPerMinute);
      const rawImages = imageValuesFrom(input);
      const images = await prepareImages(rawImages, config, dependencies);
      const history = await store.get(uid);
      const messages = [...history.messages, { role: "user", content: prompt }];
      const client = dependencies.zenmux ?? new ZenMuxClient(config, { fetch: dependencies.fetch });
      const completion = await client.chat({ messages, images });
      const saved = await store.set(uid, [
        ...messages,
        { role: "assistant", content: completion.answer },
      ]);

      const tokenReport = buildUsageReport(completion.usage);
      sendJson(res, 200, {
        ok: true,
        request_id: id,
        uid,
        model: completion.model || config.model,
        answer: completion.answer,
        usage: completion.usage,
        tokens: {
          request: tokenReport,
          note: tokenReport.note,
        },
        billing: buildBillingReport(completion.usage),
        finish_reason: completion.finishReason,
        generation_id: completion.generationId,
        image: images.length
          ? {
              analyzed: true,
              count: images.length,
              total_bytes: images.reduce((sum, image) => sum + image.size, 0),
              sources: images.map((image, index) => ({
                index,
                type: image.sourceType || (image.finalUrl ? "url" : "data"),
                url: image.finalUrl,
                content_type: image.contentType,
                bytes: image.size,
              })),
            }
          : null,
        conversation: {
          message_count: saved.messages.length,
          persistent: saved.persistent,
          backend: saved.backend,
          ttl_seconds: config.conversationTtlSeconds,
          warning: saved.warning || history.warning || null,
        },
      });
    } catch (error) {
      const normalized = asHttpError(error);
      if (normalized.status >= 500) {
        console.error(`[${id}] ${normalized.code}:`, normalized.cause?.message || normalized.message);
      }
      if (normalized.status === 429) res.setHeader("Retry-After", "60");
      sendJson(res, normalized.status, {
        ok: false,
        request_id: id,
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details ? { details: normalized.details } : {}),
        },
      });
    }
  };
}

export function resetRateLimitsForTests() {
  rateBuckets.clear();
}
