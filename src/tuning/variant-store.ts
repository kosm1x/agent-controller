/**
 * SandboxConfig serialization — bridges the in-memory Map/RegExp types
 * with the JSON string stored in tune_variants.config_json.
 */

import type { SandboxConfig, ScopePattern } from "./types.js";

interface SerializedSandbox {
  toolDescriptionOverrides?: Record<string, string>;
  scopePatternOverrides?: Array<{ source: string; group: string }>;
}

export function serializeSandbox(config: SandboxConfig): string {
  const obj: SerializedSandbox = {};

  if (config.toolDescriptionOverrides?.size) {
    obj.toolDescriptionOverrides = Object.fromEntries(
      config.toolDescriptionOverrides,
    );
  }

  if (config.scopePatternOverrides?.length) {
    obj.scopePatternOverrides = config.scopePatternOverrides.map((p) => ({
      source: p.pattern.source,
      group: p.group,
    }));
  }

  return JSON.stringify(obj);
}

export function deserializeSandbox(json: string): SandboxConfig {
  const obj = JSON.parse(json) as SerializedSandbox;
  const config: SandboxConfig = {};

  if (obj.toolDescriptionOverrides) {
    config.toolDescriptionOverrides = new Map(
      Object.entries(obj.toolDescriptionOverrides),
    );
  }

  if (obj.scopePatternOverrides?.length) {
    config.scopePatternOverrides = obj.scopePatternOverrides.map(
      (p): ScopePattern => ({
        pattern: new RegExp(p.source, "i"),
        group: p.group,
      }),
    );
  }

  return config;
}
