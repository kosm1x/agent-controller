/**
 * Seed NorthStar files into jarvis_files.
 * Run once: npx tsx scripts/seed-northstar.ts
 */

import { initDatabase, getDatabase } from "../src/db/index.js";
initDatabase("./data/mc.db");
const db = getDatabase();

const files = [
  {
    id: "northstar-index",
    path: "NorthStar/INDEX.md",
    title: "NorthStar — Life Direction",
    qualifier: "always-read",
    priority: 5,
    content: `# NorthStar

My visions, goals, objectives, and tasks. Plain text. The truth.

## Visions
- [Earn financial freedom](visions/earn-financial-freedom.md)
- [Live longer](visions/live-longer.md)

## Unlinked
- [Learn Calculus](objectives/learn-calculus.md) — not tied to any goal yet
`,
  },
  {
    id: "ns-vision-financial",
    path: "NorthStar/visions/earn-financial-freedom.md",
    title: "Vision: Earn financial freedom",
    qualifier: "reference",
    priority: 30,
    content: `# Earn financial freedom
Status: in_progress
Target: 2030-01-17
Description: I should be able to decide when, how and why on everything on my life.

## Goals

### Build a Network of Wellbeing apps
Status: not_started

#### Objectives
- An app for meditation and relaxation (not_started, medium priority)
  - Task: Prototype a guided meditation app module (on_hold, medium)
    Notes: Develop a user-friendly digital tool with audio/visual features for daily stress relief practice.

### Build and monetize a Productivity App
Status: in_progress
Description: Design and build an App that helps people reach their objectives

#### Objectives
- Design and launch a Productivity App [COMPLETED]
  - Task: Make the app go Live [COMPLETED] (due: 2026-01-17)
  - Task: Write the foundation of the Productivity Method [COMPLETED]
  - Task: Fine Tune the code [COMPLETED]
- Launch the app as a service and monetize it (not_started, target: 2026-01-31)
  - Task: Research methodologies for launching a new app and monetize it (in_progress)
    Notes: Researched AARRR Framework — A growth model that outlines the customer lifecycle in SaaS: Acquisition, Activation, Retention, Referral, and Revenue
`,
  },
  {
    id: "ns-vision-longevity",
    path: "NorthStar/visions/live-longer.md",
    title: "Vision: Live longer",
    qualifier: "reference",
    priority: 30,
    content: `# Live longer
Status: in_progress
Target: none
Description: Maximize longevity

## Goals

### Develop Healthspan
Status: in_progress

#### Objectives
- Walk 10 kms per week (in_progress, medium priority)
  - Task: Walk 2 kms in 20 minutes or less [recurring] (in_progress)
- Mental Well-being (not_started, medium priority)
  Description: Created from mind map: Personal Healthspan Development
  - Task: Research Nutrition Fundamentals (on_hold, low priority)
    Description: Created from mind map: Personal Healthspan Development
`,
  },
  {
    id: "ns-obj-calculus",
    path: "NorthStar/objectives/learn-calculus.md",
    title: "Objective: Learn Calculus",
    qualifier: "reference",
    priority: 30,
    content: `# Learn Calculus
Status: in_progress
Priority: medium
Target: 2026-01-31
Description: I need to learn this bitch
Goal: (unlinked)

## Tasks
- Research best books to learn [COMPLETED] (due: 2026-01-14)
`,
  },
];

const stmt = db.prepare(
  `INSERT OR REPLACE INTO jarvis_files (id, path, title, content, tags, qualifier, priority, created_at, updated_at)
   VALUES (?, ?, ?, ?, '["northstar"]', ?, ?, datetime('now'), datetime('now'))`,
);

for (const f of files) {
  stmt.run(f.id, f.path, f.title, f.content, f.qualifier, f.priority);
  console.log(`Created: ${f.path}`);
}
console.log("NorthStar files seeded.");
