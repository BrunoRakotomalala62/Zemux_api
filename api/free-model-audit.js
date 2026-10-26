import { createHash, timingSafeEqual } from "node:crypto";

// Temporary, narrowly scoped audit endpoint. Only the SHA-256 digest is stored;
// the one-time token itself is never committed. This route expires automatically.
const AUDIT_TOKEN_SHA256 = "acc210d8dd76a380dd3c68808976965e055141f9121105a2506e5cbfc8800187";
const EXPIRES_AT_SECONDS = 1792978023;
const BASE_URL = "https://zenmux.ai/api/v1";

const MODELS = Object.freeze({
  "atria-asi/atria-dawn": new Set(["text"]),
  "inclusionai/ling-3.1-flash": new Set(["text"]),
  "dots-studio/dots3-note-prev": new Set(["text", "vision"]),
  "sapiens-ai/agnes-2.5-flash": new Set(["text", "vision"]),
  "z-ai/glm-4.7-flash-free": new Set(["text"]),
  "z-ai/glm-4.6v-flash-free": new Set(["text", "vision"]),
  "inclusionai/ming-image-0.1-design": new Set(["image-chat", "image-api"]),
  "inclusionai/ming-image-0.1-design-layer": new Set(["layer-chat"]),
});

function authorized(req) {
  const supplied = String(req.headers["x-audit-token"] || "");
  const actual = createHash("sha256").update(supplied).digest();
  const expected = Buffer.from(AUDIT_TOKEN_SHA256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function summarize(value, key = "", depth = 0) {
  if (depth > 8) return "[depth omitted]";
  if (typeof value === "string") {
    if (key === "b64_json") return { base64_image: true, characters: value.length };
    if (/^data:image\//i.test(value)) {
      const comma = value.indexOf(",");
      return {
        data_image: true,
        media_type: value.slice(5, comma > 0 ? value.indexOf(";") : 40),
        characters: value.length,
      };
    }
    return value.length > 700 ? `${value.slice(0, 700)}… [${value.length} chars]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => summarize(item, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, summarize(child, childKey, depth + 1)]),
    );
  }
  return value;
}

function requestFor(model, mode, image) {
  if (mode === "text") {
    return {
      path: "/chat/completions",
      payload: {
        model,
        messages: [{ role: "user", content: "Réponds uniquement FREE-MODEL-OK." }],
        max_completion_tokens: 512,
      },
    };
  }
  if (mode === "vision") {
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(String(image || ""))) {
      throw new Error("Une image data URL PNG/JPEG/WebP/GIF est requise.");
    }
    return {
      path: "/chat/completions",
      payload: {
        model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Quel animal stylisé vois-tu ? Réponds en un mot." },
            { type: "image_url", image_url: { url: image } },
          ],
        }],
        max_completion_tokens: 512,
      },
    };
  }
  if (mode === "image-chat") {
    return {
      path: "/chat/completions",
      payload: {
        model,
        messages: [{
          role: "user",
          content: "Une icône minimaliste d'un soleil orange sur fond bleu, absolument aucun texte.",
        }],
        modalities: ["image"],
        output_format: "png",
      },
    };
  }
  if (mode === "image-api") {
    return {
      path: "/images/generations",
      payload: {
        model,
        prompt: "Une icône minimaliste d'un soleil orange sur fond bleu, absolument aucun texte.",
        n: 1,
        output_format: "png",
      },
    };
  }
  if (mode === "layer-chat") {
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(String(image || ""))) {
      throw new Error("Une image data URL PNG/JPEG/WebP/GIF est requise.");
    }
    return {
      path: "/chat/completions",
      payload: {
        model,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: image } },
            { type: "text", text: "Decompose this image into 2 layers. Number of layers: 2. Layer 1: background. Layer 2: foreground animal." },
          ],
        }],
        modalities: ["image"],
        output_format: "png",
      },
    };
  }
  throw new Error("Mode d'audit inconnu.");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (Date.now() / 1000 > EXPIRES_AT_SECONDS) {
    return res.status(410).json({ ok: false, error: "audit_expired" });
  }
  if (!authorized(req)) return res.status(404).json({ ok: false, error: "not_found" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!process.env.ZENMUX_API_KEY) {
    return res.status(503).json({ ok: false, error: "zenmux_key_missing_in_this_environment" });
  }

  try {
    const body = await parseBody(req);
    const model = String(body.model || "");
    const mode = String(body.mode || "");
    if (!MODELS[model]?.has(mode)) {
      return res.status(400).json({ ok: false, error: "model_or_mode_not_allowed" });
    }
    const request = requestFor(model, mode, body.image);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55_000);
    const started = Date.now();
    let upstream;
    try {
      upstream = await fetch(`${BASE_URL}${request.path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ZENMUX_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "HTTP-Referer": "https://site-gratuit-dynamique.vercel.app/",
          "X-Title": "Bruno Chat - Free Model Audit",
        },
        body: JSON.stringify(request.payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const elapsed_ms = Date.now() - started;
    const contentType = upstream.headers.get("content-type") || "";
    const raw = await upstream.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { payload = { raw: raw.slice(0, 1000), raw_characters: raw.length }; }
    return res.status(200).json({
      ok: upstream.ok,
      audited_model: model,
      audited_mode: mode,
      upstream_status: upstream.status,
      elapsed_ms,
      content_type: contentType,
      result: summarize(payload),
    });
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return res.status(timeout ? 504 : 400).json({
      ok: false,
      error: timeout ? "audit_timeout" : "audit_failed",
      message: String(error?.message || error).slice(0, 500),
    });
  }
}
