/**
 * Signal Intelligence ritual task template.
 *
 * Runs at 6:00 AM daily, before the morning briefing (7:00 AM).
 * Scans multiple sources for relevant signals, scores them by relevance
 * to active projects and interests, and stores a structured digest.
 *
 * Inspired by DevPulse signal intelligence architecture:
 * - Collection is mechanical (web_search, rss_read, exa_search)
 * - Scoring uses relevance × risk multiplier
 * - Synthesis uses the fast runner (sequential tool chain)
 *
 * The morning briefing can then reference the digest via user_fact_list.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createSignalIntelligence(dateLabel: string): TaskSubmission {
  return {
    title: `Signal intelligence — ${dateLabel}`,
    description: `You are Jarvis, Fede's strategic intelligence analyst. Execute the daily signal intelligence scan.

## Objective

Scan the web for signals relevant to Fede's active projects and interests.
Store a structured digest that the morning briefing can reference.

## Step 0: Check the Intelligence Depot first

Call intel_query with hours=24 to get signals already collected by the depot (earthquakes, weather alerts, FX rates, crypto prices, geopolitical articles, cyber vulnerabilities, breaking news). Also call intel_alert_history with hours=24 for any FLASH/PRIORITY alerts. Use depot data as your PRIMARY signal source — only supplement with web searches for gaps.

## Step 1: Gather context

Call user_fact_list to retrieve:
- Active projects (category "projects") — these define what's relevant
- Any existing signal preferences (category "intelligence")

## Step 2: Collect signals (3 parallel scans — supplement depot data)

Run these searches to cover different signal types:

### A. Industry & tech trends
Use exa_search with category "news" and start_published_date set to yesterday's date (${dateLabel} minus 1 day):
- "AI agents autonomous systems production deployment" (include_text: true)
- "LLM tool calling function calling improvements" (include_text: true)

### B. Project-relevant signals
Use web_search for each active project area:
- CRM: "AI CRM WhatsApp business automation 2026"
- Media/advertising: "programmatic advertising Mexico media sales trends"
- Voice AI: "voice AI phone agents real-time conversation"
Adapt queries based on what you find in user_fact_list.

### C. Competitive intelligence
Use exa_search with category "company":
- "AI agent orchestrator platform startup" (competitors to agent-controller)
- "WhatsApp CRM AI Latin America" (competitors to CRM-Azteca)

## Step 3: Score and filter

For each signal found, assess:
- **Relevance** (0-10): How directly does this relate to an active project or interest?
- **Risk level**: CRITICAL (immediate action needed), HIGH (this week), MEDIUM (monitor), LOW (informational)
- **Risk multiplier**: CRITICAL=2.0, HIGH=1.5, MEDIUM=1.0, LOW=0.5
- **Priority score** = relevance × risk_multiplier

Keep only signals with priority score >= 5.0. Aim for 5-10 top signals.

## Step 4: Store digest

Call user_fact_set with:
- category: "intelligence"
- key: "signal_digest_${dateLabel}"
- value: JSON with structure:
  {
    "date": "${dateLabel}",
    "signals": [
      {
        "title": "...",
        "source_url": "...",
        "summary": "one sentence",
        "relevance": 8,
        "risk": "HIGH",
        "priority": 12.0,
        "project": "which project this relates to",
        "action": "suggested next step"
      }
    ],
    "meta": {
      "sources_scanned": number,
      "signals_found": number,
      "signals_kept": number
    }
  }

## Step 5: Send digest via email

Send the digest via gmail_send to fede@eurekamd.net with subject "🔍 Señales del día — ${dateLabel}".

Format the email body in Spanish:

**Señales de Inteligencia — ${dateLabel}**

🔴 **Señales Críticas** (acción inmediata)
- [signal title] — [summary] | Relevancia: X/10
  → Acción: [suggested action]
  → Fuente: [url]

🟠 **Señales Altas** (esta semana)
- ...

🟡 **Señales Medias** (monitorear)
- ...

📊 **Meta**: X fuentes escaneadas, Y señales encontradas, Z retenidas.

IMPORTANT:
- Do NOT fabricate signals. Every signal must come from an actual search result.
- If a search returns no useful results, skip it. Quality over quantity.
- Prefer actionable intelligence over general news.
- Do NOT write to the journal.`,
    agentType: "fast",
    tools: [
      "user_fact_list",
      "user_fact_set",
      "web_search",
      "web_read",
      "exa_search",
      "rss_read",
      "gmail_send",
      "memory_search",
      "intel_query",
      "intel_alert_history",
    ],
    requiredTools: ["exa_search", "user_fact_set", "gmail_send"],
  };
}
