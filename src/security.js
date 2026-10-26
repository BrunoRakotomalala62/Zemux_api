import crypto from "node:crypto";
import net from "node:net";
import { HttpError } from "./errors.js";

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getPresentedApiToken(req) {
  const authorization = req.headers?.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }
  const headerToken = req.headers?.["x-api-key"];
  return Array.isArray(headerToken) ? headerToken[0] : headerToken ?? "";
}

export function requireApiToken(req, configuredToken) {
  if (!configuredToken) return;
  const presented = getPresentedApiToken(req);
  if (!presented || !safeEqual(presented, configuredToken)) {
    throw new HttpError(401, "unauthorized", "Jeton d'accès manquant ou invalide.");
  }
}

function parseIpv4(address) {
  const pieces = address.split(".").map(Number);
  if (pieces.length !== 4 || pieces.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return pieces;
}

function isPrivateIpv4(address) {
  const p = parseIpv4(address);
  if (!p) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) || a >= 224
  );
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

export function isPrivateOrReservedIp(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

export function validateUid(uid) {
  if (typeof uid !== "string" || uid.trim() === "") {
    throw new HttpError(400, "missing_uid", "Le paramètre uid est obligatoire.");
  }
  const normalized = uid.trim();
  if (normalized.length > 128 || !/^[\p{L}\p{N}._:@-]+$/u.test(normalized)) {
    throw new HttpError(
      400,
      "invalid_uid",
      "uid doit contenir 1 à 128 lettres, chiffres ou caractères . _ : @ -.",
    );
  }
  return normalized;
}

export function hashUid(uid) {
  return crypto.createHash("sha256").update(uid).digest("hex");
}
