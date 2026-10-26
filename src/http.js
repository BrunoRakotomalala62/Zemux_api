import crypto from "node:crypto";

export function requestId(req) {
  const incoming = req.headers?.["x-request-id"];
  if (typeof incoming === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}

export function setCommonHeaders(res, id) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Request-Id", id);
}

export function applyCors(req, res, allowedOrigins) {
  const origin = req.headers?.origin;
  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-API-Key, X-Request-Id",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object") return req.body;
    if (typeof req.body === "string") {
      if (Buffer.byteLength(req.body) > maxBytes) {
        const error = new Error("request_too_large");
        error.code = "REQUEST_TOO_LARGE";
        throw error;
      }
      return JSON.parse(req.body);
    }
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("request_too_large");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function requestUrl(req) {
  const host = req.headers?.host || "localhost";
  const protocol = req.headers?.["x-forwarded-proto"] || "http";
  return new URL(req.url || "/api", `${protocol}://${host}`);
}
