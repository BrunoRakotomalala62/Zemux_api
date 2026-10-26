import { HttpError } from "./errors.js";

function upstreamMessage(payload, fallback) {
  const raw = payload?.error?.message || payload?.detail?.message || payload?.message || fallback;
  return String(raw).replace(/[\r\n]+/g, " ").slice(0, 700);
}

function contentToText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export class ZenMuxClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  assertConfigured() {
    if (!this.config.zenmuxApiKey) {
      throw new HttpError(
        503,
        "zenmux_key_missing",
        "ZENMUX_API_KEY n'est pas configurée sur le serveur.",
      );
    }
  }

  async chat({ messages, images = [], model = this.config.model }) {
    this.assertConfigured();
    const selectedModel = String(model || this.config.model).trim().toLowerCase();
    const allowedModels = Array.isArray(this.config.models)
      ? this.config.models
      : [this.config.model];
    if (!allowedModels.includes(selectedModel)) {
      throw new HttpError(
        400,
        "invalid_model",
        "Le client ZenMux refuse tout modèle absent de la liste blanche gratuite.",
        { details: { allowed_models: [...allowedModels] } },
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);
    const historical = messages.slice(0, -1);
    const latest = messages.at(-1);
    const upstreamMessages = [
      { role: "system", content: this.config.systemPrompt },
      ...historical,
      images.length
        ? {
            role: "user",
            content: [
              { type: "text", text: latest.content },
              ...images.map((image) => ({
                type: "image_url",
                image_url: { url: image.dataUrl },
              })),
            ],
          }
        : latest,
    ];

    let response;
    try {
      response = await this.fetch(`${this.config.zenmuxBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.zenmuxApiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "HTTP-Referer": "https://site-gratuit-dynamique.vercel.app/",
          "X-Title": "Bruno Chat - Zemux API",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: upstreamMessages,
          reasoning_effort: this.config.reasoningEffort,
          max_completion_tokens: this.config.maxCompletionTokens,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      throw new HttpError(
        timedOut ? 504 : 502,
        timedOut ? "zenmux_timeout" : "zenmux_unreachable",
        timedOut
          ? "Le service ZenMux a dépassé le délai autorisé."
          : "Le service ZenMux est momentanément inaccessible.",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { message: raw };
    }

    if (!response.ok) {
      const message = upstreamMessage(payload, `Erreur ZenMux HTTP ${response.status}`);
      if (response.status === 429) {
        throw new HttpError(429, "zenmux_rate_limited", message);
      }
      if (response.status === 402) {
        throw new HttpError(402, "zenmux_balance_required", message);
      }
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(
          502,
          "zenmux_authentication_failed",
          "La clé ZenMux configurée sur le serveur est refusée.",
        );
      }
      if (response.status === 404) {
        throw new HttpError(502, "zenmux_model_unavailable", message);
      }
      throw new HttpError(502, "zenmux_error", message);
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const answer = contentToText(choice?.message?.content);
    if (!answer) {
      throw new HttpError(
        502,
        "zenmux_empty_response",
        "ZenMux n'a pas renvoyé de réponse finale. Réessayez dans quelques secondes.",
      );
    }

    return {
      answer,
      model: payload.model || selectedModel,
      usage: payload.usage || null,
      finishReason: choice?.finish_reason || null,
      generationId: payload.id || null,
    };
  }
}
