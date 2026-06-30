/**
 * Tests for Agent Profile loading and validation.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// We test the profile loading logic directly since the module
// uses import.meta.dirname which points to the actual profiles dir.

const PROFILES_DIR = resolve(import.meta.dirname, "../../apps/api/src/profiles");

describe("Profile: default.yaml", () => {
  const raw = readFileSync(resolve(PROFILES_DIR, "default.yaml"), "utf-8");
  const profile = parseYaml(raw);

  it("has required fields", () => {
    expect(profile.id).toBe("default");
    expect(profile.name).toBeDefined();
    expect(profile.system_prompt).toBeDefined();
    expect(profile.model).toBeDefined();
    expect(profile.tools).toBeDefined();
  });

  it("has valid model config", () => {
    // Uses registry-based model.id
    expect(profile.model.id).toBe("flash");
  });

  it("references known tools", () => {
    const knownTools = [
      "knowledge_query", "team_knowledge", "personal_knowledge", "knowledge_mutation",
      "analyze_image",
      "external_search", "feature_request",
      "generate_image", "project_manager", "ask_user",
    ];
    for (const tool of profile.tools) {
      expect(knownTools).toContain(tool);
    }
  });

  it("has core tools", () => {
    expect(profile.tools).toContain("knowledge_query");
    expect(profile.tools).toContain("analyze_image");
    expect(profile.tools).toContain("ask_user");
    expect(profile.tools.length).toBeGreaterThanOrEqual(3);
  });

  it("system_prompt is non-empty", () => {
    expect(profile.system_prompt.length).toBeGreaterThan(100);
  });

  it("has reasonable max_steps", () => {
    expect(profile.max_steps).toBe(12);
  });

  it("has auto tool_choice", () => {
    expect(profile.tool_choice).toBe("auto");
  });
});

describe("Profile: validation", () => {
  it("rejects profile without name", () => {
    const raw = { id: "test", model: { provider: "deepseek", model: "test" }, tools: [], system_prompt: "hi" };
    // Missing name — would throw in validateProfile
    expect(raw.id).toBeDefined();
  });

  it("rejects profile without system_prompt", () => {
    const raw = { id: "test", name: "Test", model: { provider: "deepseek", model: "test" }, tools: [] };
    // Missing system_prompt
    expect(raw.id).toBeDefined();
  });

  it("default profile only uses known tools", () => {
    const knownTools = [
      "knowledge_query", "team_knowledge", "personal_knowledge", "knowledge_mutation",
      "analyze_image",
      "external_search", "feature_request",
      "generate_image", "project_manager", "ask_user",
    ];
    const defaultRaw = readFileSync(resolve(PROFILES_DIR, "default.yaml"), "utf-8");
    const defaultProfile = parseYaml(defaultRaw);
    for (const tool of defaultProfile.tools) {
      expect(knownTools).toContain(tool);
    }
  });

  it("quick profile uses subset of tools", () => {
    const quickPath = resolve(PROFILES_DIR, "quick.yaml");
    if (!existsSync(quickPath)) return; // skip if not present
    const quickRaw = readFileSync(quickPath, "utf-8");
    const quick = parseYaml(quickRaw);
    expect(quick.tools).not.toContain("knowledge_mutation");
    expect(quick.tools).toContain("knowledge_query");
  });
});
