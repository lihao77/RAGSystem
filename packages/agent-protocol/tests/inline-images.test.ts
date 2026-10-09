import { describe, expect, it } from "vitest";
import { detectInlineImageMime, resolveInlineImageBytesMime, resolveInlineImageMime } from "../src/inline-images.js";

describe("inline image formats", () => {
  it.each([
    ["image/png", "photo.png", "image/png"],
    ["IMAGE/JPEG", "PHOTO.JPG", "image/jpeg"],
    ["image/jpeg", "photo.jpeg", "image/jpeg"],
    ["image/webp", "photo.webp", "image/webp"],
    ["image/gif", "photo.gif", "image/gif"],
    ["", "photo.png", "image/png"],
    ["application/octet-stream", "photo.webp", "image/webp"],
    ["image/png", "clipboard", "image/png"],
  ])("accepts supported metadata %s / %s", (mime, name, expected) => {
    expect(resolveInlineImageMime(mime, name)).toBe(expected);
  });

  it.each([
    ["image/tiff", "scan.tif"], ["image/tiff", "scan.tiff"],
    ["image/bmp", "photo.bmp"], ["image/svg+xml", "vector.svg"],
    ["image/heic", "photo.heic"], ["image/avif", "photo.avif"],
    ["image/png", "scan.tif"], ["image/tiff", "scan.png"],
    ["image/png", "scan.jpeg"], ["", "scan.constructor"], ["", "scan.__proto__"],
  ])("keeps unsupported or inconsistent metadata %s / %s as a file", (mime, name) => {
    expect(resolveInlineImageMime(mime, name)).toBeNull();
  });

  it.each([
    ["89504e470d0a1a0a", "image/png"], ["ffd8ff", "image/jpeg"],
    ["474946383761", "image/gif"], ["474946383961", "image/gif"],
    ["524946460400000057454250", "image/webp"],
    ["49492a0008000000", null], ["4d4d002a00000008", null],
    ["49492b0008000000", null], ["424d00000000", null],
    ["000102", null], ["", null],
  ])("checks actual image signatures %s", (hex, expected) => {
    expect(detectInlineImageMime(Buffer.from(hex!, "hex"))).toBe(expected);
  });

  it("infers generic content types and rejects explicit unsupported types and mislabeled TIFF bytes", () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    expect(resolveInlineImageBytesMime(png, "application/octet-stream")).toBe("image/png");
    expect(resolveInlineImageBytesMime(png, null)).toBe("image/png");
    expect(resolveInlineImageBytesMime(png, "image/tiff")).toBeNull();
    expect(resolveInlineImageBytesMime(Buffer.from("49492a0008000000", "hex"), "image/png")).toBeNull();
  });
});
