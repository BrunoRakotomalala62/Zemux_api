import test from "node:test";
import assert from "node:assert/strict";
import { parseImageDataUrl, validateImageUrl } from "../src/image.js";
import { isPrivateOrReservedIp, validateUid } from "../src/security.js";

test("les réseaux privés et réservés sont bloqués", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.2", "169.254.1.1", "::1", "fd00::1"]) {
    assert.equal(isPrivateOrReservedIp(ip), true, ip);
  }
  assert.equal(isPrivateOrReservedIp("8.8.8.8"), false);
});

test("seules les URL HTTPS publiques sont acceptées", () => {
  assert.equal(validateImageUrl("https://example.com/photo.png").hostname, "example.com");
  assert.throws(() => validateImageUrl("http://example.com/photo.png"));
  assert.throws(() => validateImageUrl("https://localhost/photo.png"));
  assert.throws(() => validateImageUrl("https://127.0.0.1/photo.png"));
});

test("les images data URL sont validées", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=";
  const parsed = parseImageDataUrl(png, 1024);
  assert.equal(parsed.contentType, "image/png");
  assert.equal(parsed.sourceType, "data");
  assert.throws(() => parseImageDataUrl("data:text/plain;base64,SGVsbG8=", 1024));
  assert.throws(() => parseImageDataUrl("data:image/png;base64,SGVsbG8=", 1024));
});

test("uid est strictement validé", () => {
  assert.equal(validateUid("abc-123:test"), "abc-123:test");
  assert.throws(() => validateUid(""));
  assert.throws(() => validateUid("uid avec espaces"));
  assert.throws(() => validateUid("x".repeat(129)));
});
