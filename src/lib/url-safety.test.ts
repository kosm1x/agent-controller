/**
 * Tests for URL safety validation — SSRF protection.
 */

import { describe, it, expect } from "vitest";
import { validateOutboundUrl } from "./url-safety.js";

describe("validateOutboundUrl", () => {
  // --- Should BLOCK ---

  it("blocks localhost", () => {
    expect(validateOutboundUrl("http://localhost/secret")).toMatch(/Blocked/);
  });

  it("blocks 127.0.0.1", () => {
    expect(validateOutboundUrl("http://127.0.0.1/")).toMatch(/Blocked/);
  });

  it("blocks 10.x private range", () => {
    expect(validateOutboundUrl("http://10.0.0.1/admin")).toMatch(/Blocked/);
  });

  it("blocks 172.16.x private range", () => {
    expect(validateOutboundUrl("http://172.16.0.1/")).toMatch(/Blocked/);
  });

  it("blocks 192.168.x private range", () => {
    expect(validateOutboundUrl("http://192.168.1.1/")).toMatch(/Blocked/);
  });

  it("blocks cloud metadata IP", () => {
    expect(
      validateOutboundUrl("http://169.254.169.254/latest/meta-data"),
    ).toMatch(/Blocked/);
  });

  it("blocks metadata hostname", () => {
    expect(validateOutboundUrl("http://metadata.google.internal/")).toMatch(
      /Blocked/,
    );
  });

  it("blocks file:// scheme", () => {
    expect(validateOutboundUrl("file:///etc/passwd")).toMatch(/Blocked/);
  });

  it("blocks ftp:// scheme", () => {
    expect(validateOutboundUrl("ftp://evil.com/payload")).toMatch(/Blocked/);
  });

  it("blocks IPv6 loopback [::1]", () => {
    expect(validateOutboundUrl("http://[::1]/")).toMatch(/Blocked/);
  });

  it("blocks IPv6 unique local fc00:", () => {
    expect(validateOutboundUrl("http://[fc00::1]/")).toMatch(/Blocked/);
  });

  it("blocks IPv6 link-local fe80:", () => {
    expect(validateOutboundUrl("http://[fe80::1]/")).toMatch(/Blocked/);
  });

  it("blocks IPv6-mapped IPv4 loopback", () => {
    expect(validateOutboundUrl("http://[::ffff:127.0.0.1]/")).toMatch(
      /Blocked/,
    );
  });

  it("blocks IPv6-mapped IPv4 metadata", () => {
    expect(validateOutboundUrl("http://[::ffff:169.254.169.254]/")).toMatch(
      /Blocked/,
    );
  });

  it("blocks IPv6-mapped IPv4 private", () => {
    expect(validateOutboundUrl("http://[::ffff:10.0.0.1]/")).toMatch(/Blocked/);
  });

  it("blocks 0.0.0.0", () => {
    expect(validateOutboundUrl("http://0.0.0.0/")).toMatch(/Blocked/);
  });

  it("blocks metadata pathname even on public host", () => {
    expect(
      validateOutboundUrl("http://169.254.169.254/latest/meta-data/iam"),
    ).toMatch(/Blocked/);
  });

  it("blocks instance-data.ec2.internal", () => {
    expect(validateOutboundUrl("http://instance-data.ec2.internal/")).toMatch(
      /Blocked/,
    );
  });

  it("returns error for invalid URL", () => {
    expect(validateOutboundUrl("not-a-url")).toBe("Invalid URL");
  });

  // --- Should ALLOW ---

  it("allows normal HTTPS URL", () => {
    expect(validateOutboundUrl("https://github.com/user/repo")).toBeNull();
  });

  it("allows normal HTTP URL", () => {
    expect(validateOutboundUrl("http://example.com/page")).toBeNull();
  });

  it("allows public IP", () => {
    expect(validateOutboundUrl("http://8.8.8.8/dns")).toBeNull();
  });

  it("allows Jina Reader URL", () => {
    expect(
      validateOutboundUrl("https://r.jina.ai/https://example.com"),
    ).toBeNull();
  });
});
