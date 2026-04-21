import { describe, it, expect } from "vitest";
import {
  validateManifest,
  manifestDuration,
  type VideoCompositionManifest,
} from "./composition-protocol.js";

function baseManifest(): VideoCompositionManifest {
  return {
    version: 1,
    title: "Test",
    template: "portrait",
    fps: 30,
    language: "es",
    scenes: [
      { index: 0, durationSec: 5, text: "Scene 1" },
      { index: 1, durationSec: 3, text: "Scene 2" },
    ],
  };
}

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    expect(() => validateManifest(baseManifest())).not.toThrow();
  });

  it("rejects unsupported version", () => {
    const m = baseManifest();
    (m as unknown as { version: number }).version = 2;
    expect(() => validateManifest(m)).toThrow(/unsupported version/);
  });

  it("rejects empty title", () => {
    const m = baseManifest();
    m.title = "";
    expect(() => validateManifest(m)).toThrow(/title is required/);
  });

  it("rejects title over 200 chars", () => {
    const m = baseManifest();
    m.title = "x".repeat(201);
    expect(() => validateManifest(m)).toThrow(/exceeds 200 chars/);
  });

  it("rejects invalid fps", () => {
    const m = baseManifest();
    (m as unknown as { fps: number }).fps = 48;
    expect(() => validateManifest(m)).toThrow(/unsupported fps/);
  });

  it("rejects empty scene list", () => {
    const m = baseManifest();
    m.scenes = [];
    expect(() => validateManifest(m)).toThrow(/non-empty array/);
  });

  it("rejects scene count over 120", () => {
    const m = baseManifest();
    m.scenes = Array.from({ length: 121 }, (_, i) => ({
      index: i,
      durationSec: 1,
      text: `s${i}`,
    }));
    expect(() => validateManifest(m)).toThrow(/exceeds 120/);
  });

  it("rejects scene with mismatched index", () => {
    const m = baseManifest();
    m.scenes[1].index = 5;
    expect(() => validateManifest(m)).toThrow(/has index=5/);
  });

  it("rejects scene with non-positive duration", () => {
    const m = baseManifest();
    m.scenes[0].durationSec = 0;
    expect(() => validateManifest(m)).toThrow(/invalid durationSec/);
  });

  it("rejects scene with duration over 60s", () => {
    const m = baseManifest();
    m.scenes[0].durationSec = 61;
    expect(() => validateManifest(m)).toThrow(/exceeds 60s cap/);
  });

  it("rejects scene with empty text", () => {
    const m = baseManifest();
    m.scenes[0].text = "";
    expect(() => validateManifest(m)).toThrow(/missing text/);
  });
});

describe("manifestDuration", () => {
  it("sums scene durations", () => {
    const m = baseManifest();
    expect(manifestDuration(m)).toBe(8);
  });
});

describe("validateManifest — v7.4 S1 Round-1 C1 (imagePath injection)", () => {
  it("rejects imagePath outside allowlist prefix", () => {
    const m = baseManifest();
    m.scenes[0].imagePath = "/etc/passwd";
    expect(() => validateManifest(m)).toThrow(/imagePath fails safety/);
  });

  it("rejects imagePath with path traversal", () => {
    const m = baseManifest();
    m.scenes[0].imagePath = "/tmp/video-jobs/../../etc/shadow";
    expect(() => validateManifest(m)).toThrow(/imagePath fails safety/);
  });

  it("rejects imagePath with newline concat-file injection", () => {
    const m = baseManifest();
    m.scenes[0].imagePath = "/tmp/video-jobs/ok.jpg\nfile '/etc/shadow'";
    expect(() => validateManifest(m)).toThrow(/imagePath fails safety/);
  });

  it("rejects imagePath with single-quote injection", () => {
    const m = baseManifest();
    m.scenes[0].imagePath = "/tmp/video-jobs/a'; rm -rf / ;'.jpg";
    expect(() => validateManifest(m)).toThrow(/imagePath fails safety/);
  });

  it("rejects relative imagePath", () => {
    const m = baseManifest();
    m.scenes[0].imagePath = "video-jobs/ok.jpg";
    expect(() => validateManifest(m)).toThrow(/imagePath fails safety/);
  });

  it("accepts imagePath under /tmp/video-jobs/ allowlist", () => {
    const m = baseManifest();
    m.scenes[0].imagePath = "/tmp/video-jobs/abc12345/scene-000.jpg";
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("accepts imagePath under /tmp/video-backgrounds/ allowlist", () => {
    const m = baseManifest();
    m.scenes[0].imagePath = "/tmp/video-backgrounds/ocean.jpg";
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects imagePath with embedded null byte (Round-2 n1)", () => {
    const m = baseManifest();
    m.scenes[0].imagePath = "/tmp/video-jobs/ok\0.jpg";
    expect(() => validateManifest(m)).toThrow(/imagePath fails safety/);
  });
});

describe("validateManifest — v7.4 S1 Round-1 M1 (full-field validation)", () => {
  it("rejects null/non-object manifest", () => {
    expect(() =>
      validateManifest(null as unknown as VideoCompositionManifest),
    ).toThrow(/must be an object/);
  });

  it("rejects invalid language", () => {
    const m = baseManifest();
    m.language = "";
    expect(() => validateManifest(m)).toThrow(/language is required/);
    m.language = "x".repeat(17);
    expect(() => validateManifest(m)).toThrow(/language exceeds 16/);
  });

  it("rejects invalid voice field", () => {
    const m = baseManifest();
    m.voice = "x".repeat(81);
    expect(() => validateManifest(m)).toThrow(/voice invalid/);
  });

  it("rejects bad backgroundAsset", () => {
    const m = baseManifest();
    m.backgroundAsset = "/etc/passwd";
    expect(() => validateManifest(m)).toThrow(/backgroundAsset fails safety/);
  });

  it("rejects non-integer or zero brandProfileId", () => {
    const m = baseManifest();
    m.brandProfileId = 0;
    expect(() => validateManifest(m)).toThrow(/brandProfileId must be/);
    m.brandProfileId = 1.5;
    expect(() => validateManifest(m)).toThrow(/brandProfileId must be/);
  });

  it("rejects scene imageQuery that is too long", () => {
    const m = baseManifest();
    m.scenes[0].imageQuery = "x".repeat(501);
    expect(() => validateManifest(m)).toThrow(/imageQuery invalid/);
  });

  it("rejects scene transitionDurationSec out of (0, 5]", () => {
    const m = baseManifest();
    m.scenes[0].transitionDurationSec = 0;
    expect(() => validateManifest(m)).toThrow(/transitionDurationSec/);
    m.scenes[0].transitionDurationSec = 6;
    expect(() => validateManifest(m)).toThrow(/transitionDurationSec/);
  });
});
