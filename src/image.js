import dns from "node:dns/promises";
import https from "node:https";
import { HttpError } from "./errors.js";
import { isPrivateOrReservedIp } from "./security.js";

const SUPPORTED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function hasExpectedImageSignature(buffer, contentType) {
  if (contentType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (contentType === "image/jpeg") {
    return buffer.length >= 3 &&
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (contentType === "image/gif") {
    const signature = buffer.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (contentType === "image/webp") {
    return buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

export function parseImageDataUrl(rawValue, maxBytes) {
  if (typeof rawValue !== "string") {
    throw new HttpError(400, "invalid_image_data", "L'image encodée est invalide.");
  }
  const match = rawValue.match(
    /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i,
  );
  if (!match) {
    throw new HttpError(
      415,
      "unsupported_image_type",
      "Les data URLs doivent contenir une image PNG, JPEG, WebP ou GIF en base64.",
    );
  }

  const contentType = match[1].toLowerCase();
  const encoded = match[2].replace(/\s+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new HttpError(400, "invalid_image_data", "Le contenu base64 de l'image est invalide.");
  }

  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length) {
    throw new HttpError(422, "empty_image", "L'image encodée est vide.");
  }
  if (buffer.length > maxBytes) {
    throw new HttpError(
      413,
      "image_too_large",
      `L'image dépasse la limite de ${maxBytes} octets.`,
    );
  }
  if (!hasExpectedImageSignature(buffer, contentType)) {
    throw new HttpError(
      422,
      "invalid_image_data",
      "Le contenu ne correspond pas au format d'image annoncé.",
    );
  }

  return {
    dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`,
    contentType,
    size: buffer.length,
    finalUrl: null,
    sourceType: "data",
  };
}

function hostAllowed(hostname, allowlist) {
  if (!allowlist.length) return true;
  const host = hostname.toLowerCase();
  return allowlist.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

export function validateImageUrl(rawUrl, allowlist = []) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "invalid_image_url", "L'URL de l'image est invalide.");
  }

  if (parsed.protocol !== "https:") {
    throw new HttpError(
      400,
      "invalid_image_url",
      "Seules les images accessibles en HTTPS sont acceptées.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(
      400,
      "invalid_image_url",
      "Les identifiants intégrés à l'URL sont interdits.",
    );
  }
  if (parsed.port && parsed.port !== "443") {
    throw new HttpError(
      400,
      "invalid_image_url",
      "Seul le port HTTPS standard 443 est accepté.",
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    !hostAllowed(hostname, allowlist)
  ) {
    throw new HttpError(
      400,
      "image_host_not_allowed",
      "L'hôte de l'image n'est pas autorisé.",
    );
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && isPrivateOrReservedIp(hostname)) {
    throw new HttpError(
      400,
      "unsafe_image_url",
      "Les adresses réseau privées ou réservées sont interdites.",
    );
  }
  return parsed;
}

async function resolvePublicAddress(hostname) {
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new HttpError(400, "image_dns_error", "Impossible de résoudre l'hôte de l'image.", {
      cause: error,
    });
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new HttpError(
      400,
      "unsafe_image_url",
      "L'URL de l'image pointe vers un réseau privé ou réservé.",
    );
  }
  return addresses[0];
}

export function createPinnedLookup(address) {
  return (_hostname, options, callback) => {
    // Node 20+ may request every address (`options.all`) when
    // autoSelectFamily is enabled. Respect both callback signatures.
    if (options?.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function getHttpsResponse(url, address, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "image/png,image/jpeg,image/webp,image/gif;q=0.9",
          "Accept-Encoding": "identity",
          "User-Agent": "Zemux-API/1.0 image-fetcher",
        },
        lookup: createPinnedLookup(address),
      },
      resolve,
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("IMAGE_TIMEOUT"));
    });
    request.on("error", reject);
  });
}

async function consumeImage(response, maxBytes) {
  const contentType = String(response.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!SUPPORTED_TYPES.has(contentType)) {
    response.resume();
    throw new HttpError(
      415,
      "unsupported_image_type",
      "Formats acceptés : PNG, JPEG, WebP et GIF.",
    );
  }

  const contentEncoding = String(response.headers["content-encoding"] || "identity");
  if (contentEncoding !== "identity") {
    response.resume();
    throw new HttpError(
      415,
      "encoded_image_not_supported",
      "L'image doit être servie sans compression HTTP supplémentaire.",
    );
  }

  const announcedSize = Number.parseInt(response.headers["content-length"] || "0", 10);
  if (announcedSize > maxBytes) {
    response.resume();
    throw new HttpError(
      413,
      "image_too_large",
      `L'image dépasse la limite de ${maxBytes} octets.`,
    );
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) {
      response.destroy();
      throw new HttpError(
        413,
        "image_too_large",
        `L'image dépasse la limite de ${maxBytes} octets.`,
      );
    }
    chunks.push(chunk);
  }

  if (size === 0) {
    throw new HttpError(422, "empty_image", "L'image téléchargée est vide.");
  }
  return { buffer: Buffer.concat(chunks), contentType, size };
}

export async function downloadImageAsDataUrl(rawUrl, config, redirects = 0) {
  if (redirects > 3) {
    throw new HttpError(400, "too_many_redirects", "Trop de redirections pour l'image.");
  }

  const url = validateImageUrl(rawUrl, config.imageHostAllowlist);
  const address = await resolvePublicAddress(url.hostname);

  let response;
  try {
    response = await getHttpsResponse(url, address, config.imageTimeoutMs);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const isTimeout = error.message === "IMAGE_TIMEOUT";
    throw new HttpError(
      isTimeout ? 504 : 422,
      isTimeout ? "image_timeout" : "image_download_failed",
      isTimeout
        ? "Le téléchargement de l'image a expiré."
        : "Impossible de télécharger l'image.",
      { cause: error },
    );
  }

  const status = response.statusCode || 0;
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = response.headers.location;
    response.resume();
    if (!location) {
      throw new HttpError(422, "invalid_image_redirect", "Redirection d'image invalide.");
    }
    const next = new URL(location, url).toString();
    return downloadImageAsDataUrl(next, config, redirects + 1);
  }

  if (status < 200 || status >= 300) {
    response.resume();
    throw new HttpError(
      422,
      "image_download_failed",
      `Le serveur de l'image a répondu HTTP ${status}.`,
    );
  }

  const { buffer, contentType, size } = await consumeImage(
    response,
    config.maxImageBytes,
  );
  return {
    dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`,
    contentType,
    size,
    finalUrl: url.toString(),
    sourceType: "url",
  };
}
