/**
 * User fact tools — agent-accessible tools to persist and retrieve
 * personal facts about the user.
 *
 * These facts are always injected into the prompt, so once stored
 * the LLM will never forget them.
 */

import type { Tool } from "../types.js";
import {
  setUserFact,
  getUserFacts,
  deleteUserFact,
} from "../../db/user-facts.js";

// ---------------------------------------------------------------------------
// user_fact_set
// ---------------------------------------------------------------------------

export const userFactSetTool: Tool = {
  name: "user_fact_set",
  definition: {
    type: "function",
    function: {
      name: "user_fact_set",
      description: `Store or update a personal fact about the user. Facts persist permanently and are ALWAYS included in your context — once stored, you will never forget them.

USE WHEN:
- The user shares personal information: age, name, birthday, location, family
- The user states aspirations, values, work ethic, life philosophy
- The user corrects a previous fact ("actually I'm 32, not 30")
- The user shares preferences that should persist forever (language, communication style)
- The user shares health data, routines, or habits they want tracked

CATEGORIES (use these exact strings):
- "personal" — age, birthday, full name, location, family, nationality
- "preferences" — communication preferences, language, formatting, AI interaction style
- "work" — job role, company, projects, professional goals, work ethic
- "health" — health goals, routines, metrics, dietary preferences
- "philosophy" — life values, aspirations, mindset, mottos, beliefs

TIPS:
- Use specific keys: "age", "birthday", "work_ethic", "main_aspiration"
- Keep values concise but complete
- If the user corrects a fact, update it (same category+key overwrites)
- PROACTIVELY save facts — don't wait for the user to ask you to remember`,
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["personal", "preferences", "work", "health", "philosophy"],
            description: "Fact category.",
          },
          key: {
            type: "string",
            description:
              'Fact identifier within the category. Use snake_case. Examples: "age", "birthday", "work_ethic", "main_aspiration", "dietary_preference".',
          },
          value: {
            type: "string",
            description:
              "The fact value. Be concise but complete. Include units where applicable.",
          },
        },
        required: ["category", "key", "value"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const category = args.category as string;
    const key = args.key as string;
    const value = args.value as string;

    setUserFact(category, key, value, "conversation");

    return `Fact stored: [${category}] ${key} = ${value}. This will be included in all future conversations.`;
  },
};

// ---------------------------------------------------------------------------
// user_fact_list
// ---------------------------------------------------------------------------

export const userFactListTool: Tool = {
  name: "user_fact_list",
  definition: {
    type: "function",
    function: {
      name: "user_fact_list",
      description: `List all stored personal facts about the user, optionally filtered by category.

USE WHEN:
- The user asks "what do you know about me?"
- You need to verify what facts are already stored before saving new ones
- The user wants to review or audit their stored profile`,
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["personal", "preferences", "work", "health", "philosophy"],
            description: "Optional category filter. Omit to list all facts.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const category = args.category as string | undefined;
    const facts = getUserFacts(category);

    if (facts.length === 0) {
      return category
        ? `No facts stored in category "${category}".`
        : "No user facts stored yet.";
    }

    return facts
      .map(
        (f) =>
          `[${f.category}] ${f.key}: ${f.value} (updated: ${f.updated_at})`,
      )
      .join("\n");
  },
};

// ---------------------------------------------------------------------------
// user_fact_delete
// ---------------------------------------------------------------------------

export const userFactDeleteTool: Tool = {
  name: "user_fact_delete",
  definition: {
    type: "function",
    function: {
      name: "user_fact_delete",
      description: `Delete a stored personal fact. Use when the user explicitly asks to remove a fact or when a fact is no longer accurate and should be removed rather than updated.`,
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["personal", "preferences", "work", "health", "philosophy"],
            description: "Fact category.",
          },
          key: {
            type: "string",
            description: "Fact key to delete.",
          },
        },
        required: ["category", "key"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const category = args.category as string;
    const key = args.key as string;

    const deleted = deleteUserFact(category, key);
    return deleted
      ? `Fact deleted: [${category}] ${key}`
      : `No fact found: [${category}] ${key}`;
  },
};
