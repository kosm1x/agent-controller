/**
 * Classifier unit tests.
 * Tests the heuristic scoring and agent type routing.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classify,
  hostOnlyTools,
  isCodingTask,
  referencesExternalWebTarget,
  needsHeavyReasoning,
  isStrategyRelayOrReadback,
  targetsForeignRepo,
  referencesForeignProject,
  referencesJarvisSelfDev,
  isFanOutTask,
} from "./classifier.js";
import type {
  RunnerStats,
  KeywordOutcomeRow,
  FeedbackStats,
} from "../db/task-outcomes.js";

describe("classifier", () => {
  it("should classify short simple tasks as fast", () => {
    const result = classify({
      title: "Disk usage",
      description: "Show disk usage",
    });
    expect(result.agentType).toBe("fast");
    expect(result.score).toBeLessThan(3);
    expect(result.explicit).toBe(false);
  });

  it("a task whose toolset is host-only never routes to the nanoclaw sandbox — coding text or not (swarm task c5e6b0f9, 2026-09-03)", () => {
    // Swarm child: the planner's goal text tripped the coding heuristic
    // ("create/write … document/file"), the child inherited the root's
    // Google Workspace + KB toolset, and the sandbox has none of it.
    const hostTools = ["gdocs_read_full", "gdocs_write", "jarvis_file_write"];
    const codingShaped = {
      title: "[Swarm] Write the action plan file for fases 9-11",
      description:
        "Create the document from the source Google Doc and write the file with the plan.",
    };
    expect(classify(codingShaped).agentType).toBe("nanoclaw"); // baseline: text alone
    const guarded = classify({ ...codingShaped, tools: hostTools });
    expect(guarded.agentType).not.toBe("nanoclaw");
    expect(guarded.explicit).toBe(false);

    // Score-path exit (isolation keywords) is guarded too.
    const isolation = {
      title: "Run in container",
      description:
        "Execute this task in a sandbox environment with proper isolation",
    };
    expect(classify(isolation).agentType).toBe("nanoclaw");
    expect(classify({ ...isolation, tools: hostTools }).agentType).toBe(
      "heavy",
    );

    // A toolset the sandbox DOES register keeps the sandbox route.
    expect(
      classify({ ...codingShaped, tools: ["shell_exec", "file_edit", "grep"] })
        .agentType,
    ).toBe("nanoclaw");
  });

  it("hostOnlyTools is allow-by-membership — an unknown tool is host-only (safe direction)", () => {
    expect(hostOnlyTools(undefined)).toEqual([]);
    expect(hostOnlyTools(["shell_exec", "file_read", "jarvis_dev"])).toEqual(
      [],
    );
    expect(
      hostOnlyTools(["shell_exec", "gdocs_read", "brand_new_tool"]),
    ).toEqual(["gdocs_read", "brand_new_tool"]);
  });

  it("should classify isolation keywords as nanoclaw", () => {
    const result = classify({
      title: "Run in container",
      description:
        "Execute this task in a sandbox environment with proper isolation",
    });
    expect(result.agentType).toBe("nanoclaw");
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.score).toBeLessThan(6);
  });

  it("should classify multi-step (non-coding) tasks as heavy", () => {
    // Coding multi-step tasks now route to the nanoclaw sandbox; a multi-step
    // NON-coding task (analysis/strategy across scopes, in parallel) → heavy.
    const result = classify({
      title: "Market positioning review",
      description:
        "Evaluate our market positioning across all regional segments, working the strategic options in parallel, then recommend a prioritized roadmap.",
    });
    expect(result.agentType).toBe("heavy");
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  it("should classify parallelizable tasks as swarm", () => {
    const result = classify({
      title: "Full audit",
      description:
        "Audit all 12 service modules for security. Check multiple files across all services. Each module independently reviewed in parallel.",
    });
    expect(result.agentType).toBe("swarm");
    expect(result.score).toBeGreaterThanOrEqual(9);
  });

  it("should respect explicit agent_type override", () => {
    const result = classify({
      title: "Simple task",
      description: "Very short",
      agentType: "heavy",
    });
    expect(result.agentType).toBe("heavy");
    expect(result.explicit).toBe(true);
    expect(result.score).toBe(-1);
  });

  it("should treat auto as non-explicit", () => {
    const result = classify({
      title: "Simple task",
      description: "Very short",
      agentType: "auto",
    });
    expect(result.explicit).toBe(false);
    expect(result.agentType).toBe("fast");
  });

  it("should boost score with tags", () => {
    const simple = classify({
      title: "Task",
      description: "A task",
    });
    const withTags = classify({
      title: "Task",
      description: "A task",
      tags: ["complex", "research"],
    });
    expect(withTags.score).toBeGreaterThan(simple.score);
  });

  it("should boost score for critical priority", () => {
    const normal = classify({
      title: "Task",
      description: "A moderate length task description for testing",
    });
    const critical = classify({
      title: "Task",
      description: "A moderate length task description for testing",
      priority: "critical",
    });
    expect(critical.score).toBe(normal.score + 1);
  });

  it("should account for description length", () => {
    const shortDesc = classify({
      title: "Task",
      description: "Short",
    });
    const longDesc = classify({
      title: "Task",
      description: Array(201).fill("word").join(" "),
    });
    expect(longDesc.score).toBeGreaterThan(shortDesc.score);
  });

  // Model tier tests
  it("should recommend flash model for simple tasks", () => {
    const result = classify({
      title: "Disk usage",
      description: "Show disk usage",
    });
    expect(result.modelTier).toBe("flash");
  });

  it("should recommend capable model for architecture tasks", () => {
    const result = classify({
      title: "Review auth",
      description:
        "Review the authentication architecture and suggest improvements",
    });
    expect(result.modelTier).toBe("capable");
  });

  it("should recommend standard model for medium complexity", () => {
    const result = classify({
      title: "Weekly summary",
      description: Array(101).fill("word").join(" "),
    });
    expect(result.modelTier).toBe("standard");
  });

  it("should assign flash tier for short messaging tasks", () => {
    const result = classify({
      title: "Chat: hola",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
    expect(result.modelTier).toBe("flash");
  });

  it("should assign capable tier for research messaging tasks", () => {
    const result = classify({
      title: "Chat: Investiga las tendencias del mercado de AI en 2026",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
    expect(result.modelTier).toBe("capable");
  });

  it("should assign standard tier for medium messaging tasks", () => {
    const result = classify({
      title: "Chat: Necesito que me ayudes con un correo para el cliente",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
    expect(result.modelTier).toBe("standard");
  });

  it("should assign capable tier when user message has architecture signals", () => {
    const result = classify({
      title: "Chat: Analiza el rendimiento del pipeline y hazme un audit",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
    expect(result.modelTier).toBe("capable");
  });

  it("should set standard model tier for explicit overrides", () => {
    const result = classify({
      title: "Simple task",
      description: "Very short",
      agentType: "heavy",
    });
    expect(result.modelTier).toBe("standard");
  });

  // 2026-05-06 regression — task b59dbab6 fired a 52-word ranking question,
  // routed to flash, fabricated 1500 words of farmacia rankings without
  // calling the DENUE API. New high-stakes-data tier-upgrade keywords cover
  // the prompt patterns that should never be answered without DB access.
  it("should tier up to capable for greenfield site-selection prompts (regression b59dbab6)", () => {
    const result = classify({
      title: "Top farmacias greenfield CDMX",
      description:
        "Dame el top 10 de AGEBs en CDMX para abrir una farmacia greenfield. Output narrativo, una decisión de site-selection.",
    });
    expect(result.modelTier).toBe("capable");
    expect(result.reason).toContain("high-stakes data prompt");
  });

  it("should tier up to capable for ranking-de-X prompts in Spanish", () => {
    const result = classify({
      title: "Ranking municipios pharma",
      description: "Dame el ranking de municipios para abrir farmacia",
    });
    expect(result.modelTier).toBe("capable");
  });

  it("should tier up to capable for 'qué AGEB / colonia' wh-questions", () => {
    const result = classify({
      title: "AGEB selection",
      description: "Qué AGEB es la mejor para abrir un local en Iztapalapa",
    });
    expect(result.modelTier).toBe("capable");
  });

  it("should NOT tier up to capable for routine non-data tasks", () => {
    const result = classify({
      title: "Disk usage",
      description: "Show disk usage of /var/log",
    });
    expect(result.modelTier).toBe("flash");
  });

  // ----- Coding → nanoclaw sandbox, challenging → heavy (2026-06-19) -----
  // All coding tasks run containerized (nanoclaw = sandboxed Prometheus PER);
  // genuinely challenging non-coding requests get heavy's PER loop; else fast.
  it("routes a build/ship coding chat to nanoclaw (regression 6511)", () => {
    const result = classify({
      title:
        "Chat: Haz un plan para el cambio 3. Execute, test, audit, commit a...",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
    expect(result.reason).toContain("coding task");
  });

  it("routes a code-authoring chat (verb+noun) to nanoclaw", () => {
    const result = classify({
      title: "Chat: implement the retry endpoint and add a test",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("routes a refactor chat to nanoclaw (strong solo coding signal)", () => {
    const result = classify({
      title: "Chat: refactoriza el módulo de auth",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("routes a challenging non-coding chat to heavy", () => {
    const result = classify({
      title: "Chat: analiza nuestra estrategia comercial y recomienda pasos",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("heavy");
    expect(result.reason).toContain("challenging");
  });

  // ----- Strategy noun as the SOLE heavy cue: relay/readback stays on fast (2026-09-05) -----
  // Tasks 9246 ("Escribe la estrategia en un google doc para revisarla") and 9244
  // ("Cual es la estrategia de draft con 10 jugadores?") ran on heavy for 4.3/3.6 min
  // ($3.43/$4.31) to relay a strategy already in the KB. Genuine design still escalates.
  // Cases marked qa-* come from the 2026-09-05 qa-auditor FAIL (C1–C3, W1–W5, R3).
  describe("strategy relay/readback (2026-09-05)", () => {
    const chat = (title: string) =>
      classify({
        title,
        description: "You are Jarvis, a strategic AI assistant...",
        tags: ["messaging"],
      });

    it.each([
      "Chat: Escribe la estrategia en un google doc para revisarla",
      "Chat: Cual es la estrategia de draft con 10 jugadores?",
      "Chat: Pon la estrategia en el KB",
      "Chat: Manda la estrategia por email a Javier",
      "Chat: Resume la estrategia del draft",
      "Chat: Guarda la estrategia de precios en un doc",
      "Chat: Put the roadmap into a Google Doc for review",
      "Chat: What's the strategy for week 1?",
      // qa-W1: greeting / vocative / politeness lead-in, opener in a later clause
      "Chat: Hola Jarvis, cual es la estrategia de draft con 10 jugadores?",
      "Chat: Buenos días. Cuál es la estrategia de draft?",
      "Chat: Can you show me the strategy for week 1?",
      "Chat: por favor dame la estrategia",
      // qa-W2: clitic suffixes past JS's ASCII-only \b
      "Chat: Envíame la estrategia por email",
      "Chat: Mándame la estrategia por correo",
      "Chat: Guárdala en el KB, la estrategia",
      // qa-W3: "en general" / "el desarrollo" are not design verbs
      "Chat: Muéstrame en general la estrategia del draft",
      // qa-W4: EN "by"
      "Chat: Send me the roadmap by email",
      // R2-C3: accent moves under a clitic — every relay stem in its real spelling
      "Chat: Compártela por telegram, la estrategia",
      "Chat: Pégala en el doc, la estrategia",
      "Chat: Cópiala al KB, la estrategia",
      "Chat: Expórtala a un doc, la estrategia",
      "Chat: Transcríbela en una nota, la estrategia",
      "Chat: Vuélcala en el doc, la estrategia",
      "Chat: Súbela al drive, la estrategia",
      // R2-C1/W3: "Envía la" and a destination's own article are not indefinite nouns
      "Chat: Envía la estrategia por correo a Javier",
      "Chat: Envía la estrategia al KB",
      "Chat: Escribe en un doc la estrategia de precios",
      "Chat: Guárdala en un doc, la estrategia",
      "Chat: Jarvis, muéstrame la estrategia",
      // purpose infinitive / "for review" are not rework requests
      "Chat: Escribe la estrategia en un doc para revisarla después",
      "Chat: Put the strategy into a doc for review",
      // R3-W2/W3/W4: noun/adjective homographs of rework verbs are not work requests
      "Chat: Dame la estrategia de draft con los mejores jugadores",
      "Chat: Manda la estrategia de mejora continua por correo",
      "Chat: Send me the strategy update by email",
      "Chat: Send me the strategy changes by email",
      "Chat: Put the updated strategy in the doc", // existence adjective allowed
      "Chat: Mándame la última estrategia por correo",
      "Chat: Put the roadmap into a doc for final review",
      "Chat: Save the strategy in the doc for later review",
      // R3-W5: punctuation/emoji-only first clause after the lead-in strip
      "Chat: Hola Jarvis 👋. Dame la estrategia",
      "Chat: Gracias. Dame la estrategia",
      // R3 info: status questions are readbacks
      "Chat: Cómo va la estrategia del draft?",
      "Chat: How is the strategy going?",
      // participles / non-evaluative adjectives after the noun are still relays
      "Chat: Mándame la estrategia completa por correo",
      "Chat: Manda la estrategia actualizada por correo",
      "Chat: Pon la estrategia corregida en el doc",
      "Chat: Send me the strategy update by email, please",
      // noun phrase first, then the relay verb
      "Chat: La estrategia de precios, mándamela por correo",
      "Chat: Dame la estrategia para ganar el draft",
      // benign comma fragments: participle, recipient, politeness, appositive
      "Chat: Manda la estrategia, revisada, por correo",
      "Chat: Manda la estrategia por correo, a Javier",
      "Chat: Send me the strategy by email, thanks",
      "Chat: Manda la estrategia por e-mail", // "e" is only a conjunction before i-/hi-
      // the requester is the destination
      "Chat: Mándame la estrategia de contenido para Instagram",
      "Chat: Envíame la estrategia",
      // prepositional fragments within the two-token cap stay benign
      "Chat: Manda la estrategia por correo, con los precios actualizados",
      "Chat: Manda la estrategia por correo, para revisarla después",
      "Chat: Pon la estrategia en el doc, en PDF",
      "Chat: Pon la estrategia al final del doc",
      // R8-W2: sequencing adverbs outside the post-comma slot are not second actions
      "Chat: Manda la estrategia por correo primero",
      "Chat: Primero mándame la estrategia por correo",
      "Chat: Send me the strategy first",
      "Chat: Pon la estrategia primero en el doc",
      // R9-W1/W2: every lead-in / requester / idiom member pinned
      "Chat: Ya mándame la estrategia por correo",
      "Chat: Antes que nada mándame la estrategia",
      "Chat: First of all, send me the strategy",
      "Chat: Share me the strategy",
      "Chat: Forward me the strategy by email",
      "Chat: Pass me the strategy by email",
      "Chat: Pon la estrategia al principio del doc",
      // object after a pronoun or after the destination phrase
      "Chat: Escribe en un google doc la estrategia de precios",
      "Chat: Send us the strategy by email",
      // R11: every slot closed, head anchored at both ends — these exercise the slots
      "Chat: Pon la estrategia en el doc de precios", // destination + "de X"
      "Chat: Muéstrame de nuevo la estrategia", // closed adverb between opener and noun
      "Chat: Show me again the strategy",
      "Chat: Manda la estrategia a Telegram", // brand = destination, not a recipient
      "Chat: Send the strategy to Google Docs",
      "Chat: Dame la estrategia 🙏", // trailing emoji is not text
      "Chat: Put the roadmap into a Google Doc for a final review", // purpose with det + adjective
      "Chat: Send me the strategy summary by email", // EN compound noun after the head
    ])(
      "relay/readback of an EXISTING strategy stays on fast, capable tier: %s",
      (title) => {
        expect(isStrategyRelayOrReadback(title)).toBe(true);
        expect(needsHeavyReasoning(title)).toBe(false);
        const r = chat(title);
        expect(r.agentType).toBe("fast");
        expect(r.reason).toContain("strategy relay/readback"); // qa-R2: scoreable
        expect(r.modelTier).toBe("capable"); // qa-W5: never flash on a demoted readback
      },
    );

    it.each([
      "Chat: Diseña una estrategia de draft para 10 equipos",
      "Chat: Crea una nueva estrategia de contenido para TikTok",
      "Chat: Escribe una estrategia de contenido para TikTok", // indefinite → formulate
      "Chat: Redacta la hoja de ruta 2027 del producto", // redactar = compose
      "Chat: Compara la estrategia A con la estrategia B",
      "Chat: Cuál será nuestra estrategia para el draft?", // future tense = formulate
      "Chat: El premio de este Fantasy es de 10k USD. Necesito que establezcas un plan para generar la mayor diferencia competitiva. ¿Cuál será nuestra estrategia?",
      "Chat: analiza nuestra estrategia comercial y recomienda pasos",
      // qa-C1: a destination is not an intent — indefinite noun + destination = design
      "Chat: Escribe una estrategia de contenido para TikTok en un google doc",
      "Chat: Haz una estrategia de draft y ponla en el KB",
      "Chat: Redacta la hoja de ruta 2027 del producto en un doc",
      // qa-C2: readback openers with an indefinite / undetermined noun = formulate
      "Chat: Dame una estrategia para ganar el draft",
      "Chat: Give me a strategy to win the league",
      "Chat: Muéstrame una estrategia para el draft",
      "Chat: Dime qué estrategia deberíamos seguir para el draft",
      "Chat: Dame la mejor estrategia para el draft", // evaluative adjective = formulate
      "Chat: Escribe la nueva estrategia en un doc",
      // qa-C3: design verb + relay destination in ONE message — pins DESIGN_TARGETS_STRATEGY
      "Chat: Diseña la estrategia y ponla en un doc",
      "Chat: Define la estrategia y guárdala en el KB",
      // qa-R3: "hoja de ruta" is the noun, not a destination sheet
      "Chat: Pon la estrategia del 2027 en la hoja de ruta",
      // R2-W1: a benign first clause must not license the real work in the second
      "Chat: Muéstrame la estrategia de precios y compárala con la de la competencia",
      "Chat: What is our strategy for Q4 and how should we adapt it?",
      "Chat: Dame la estrategia y dime qué deberíamos cambiar para el draft",
      "Chat: Resume la estrategia y luego arma el plan de ejecución",
      // R2-W2: rework verbs are design, whatever the destination
      "Chat: Ajusta la estrategia de precios y ponla en el doc",
      "Chat: Revisa la estrategia y mándamela por correo",
      "Chat: Optimiza la estrategia y súbela al drive",
      "Chat: Actualiza la estrategia con los nuevos datos y ponla en el doc",
      "Chat: Muéstrame opciones de estrategia y recomienda una",
      // R3-W1: pins first-clause-only readback — an unlisted design verb opens sentence 1,
      // a readback-shaped sentence 2 must not license the demotion
      "Chat: Rehaz la estrategia desde cero. Dame el doc con lo que salga",
      // R3-W2/W3: the same homographs in imperative position ARE work requests
      "Chat: Cambia la estrategia y ponla en el doc",
      "Chat: Mejora la estrategia y guárdala en el KB",
      "Chat: Review the strategy and send it by email",
      "Chat: Update the strategy with the new data and put it in the doc",
      // R4-C1: an adverb/object between the imperative homograph and its article
      "Chat: Revisa bien la estrategia y mándamela por correo",
      "Chat: Mejora un poco la estrategia y ponla en el doc",
      "Chat: Ajusta un par de cosas en la estrategia y mándamela por correo",
      "Chat: Cambia todo en la estrategia y ponla en el doc",
      "Chat: Review carefully the strategy and send it by email",
      "Chat: Update pricing in the strategy and put it in the doc",
      // R4-W1: rework verbs that were missing from the list
      "Chat: Rehaz la estrategia desde cero y ponla en el doc",
      "Chat: Corrige la estrategia y mándamela por correo",
      "Chat: Reescribe la estrategia y guárdala en el KB",
      "Chat: Simplifica la estrategia y ponla en el doc",
      "Chat: Agrega dos jugadores a la estrategia y ponla en el doc",
      "Chat: Rewrite the strategy and put it in the doc",
      "Chat: Expand the strategy and save it to the KB",
      // R4-W2: periphrastic future is a formulate request, like "cuál será"
      "Chat: Cómo va a ser la estrategia del draft?",
      "Chat: Cómo va a quedar la estrategia de precios?",
      "Chat: How is the strategy going to change for Q4?",
      // R4-W3: "pero adaptada" asks for the adaptation
      "Chat: Dame la misma estrategia pero adaptada al draft de 2027",
      // first-clause-only readback, pinned with an UNLISTED verb in clause 1
      "Chat: Descarta la estrategia actual. Dame la estrategia",
      // allow-by-shape (R5): coordination and subordination are unknown work
      "Chat: Pon la estrategia y el arma secreta en el doc",
      "Chat: Manda la estrategia por correo cuando la mejores",
      "Chat: Pon la estrategia en el doc si la cambias",
      "Chat: Manda la estrategia por correo una vez que la completes",
      "Chat: Manda la estrategia por correo, pero primero mejora precios",
      "Chat: Send me the strategy after tweaking it",
      // allow-by-shape (R5): an unlisted verb in first position is unknown work
      "Chat: Reformula la estrategia y ponla en el doc",
      "Chat: Replantea la estrategia y mándamela por correo",
      "Chat: Pule la estrategia y mándamela por correo",
      "Chat: Vuelve a hacer la estrategia y ponla en el doc",
      "Chat: Rethink the strategy and put it in the doc",
      "Chat: Please double-check the strategy and send it by email",
      "Chat: Tweak the strategy and save it to the KB",
      "Chat: La estrategia, revísala y mándamela por correo",
      "Chat: Redesign the strategy and put it in the doc",
      // evaluative adjective glued to the noun ⇒ formulate
      "Chat: Dame la estrategia óptima para el draft",
      "Chat: Dame la estrategia ganadora para el draft",
      "Chat: Give me the winning strategy for the draft",
      // gerund = second action
      "Chat: Manda la estrategia por correo mejorando los precios",
      // R8-W4: a bare "del" names the SOURCE, not a destination
      "Chat: Escribe la estrategia del doc",
      // R9-C1: the object is not the strategy itself ⇒ analysis, not readback/relay
      "Chat: Send me your best thinking on the strategy",
      "Chat: Send me your recommendation on the strategy",
      "Chat: Share me your view on the strategy",
      "Chat: Mándame tu opinión sobre la estrategia por correo",
      "Chat: Dame tu recomendación sobre la estrategia",
      "Chat: Tell me what you would change in the strategy",
      "Chat: Give me your read on the strategy",
      "Chat: Show me the gaps in the strategy",
      "Chat: Dame los riesgos de la estrategia",
      "Chat: Dime cuál es el desarrollo de la estrategia", // object = "el desarrollo" (was a fast pin until R9)
      // R6-C1: a comma-joined second imperative is a second action
      "Chat: Manda la estrategia por correo, mejora los precios primero",
      "Chat: Pon la estrategia en el doc, agrégale dos jugadores",
      "Chat: Mándame la estrategia por correo, ponle los precios nuevos",
      "Chat: Escribe la estrategia en un doc, hazla desde cero",
      "Chat: Dame la estrategia, arma el plan de precios",
      "Chat: Send me the strategy by email, add the new prices",
      "Chat: Put the strategy in the doc, rewrite the pricing section",
      // R6-C2: disjunctive / copulative coordinators
      "Chat: Dame la estrategia o arma el plan de precios",
      "Chat: Give me the strategy or draft a new one",
      "Chat: Manda la estrategia por correo e incluye precios nuevos",
      "Chat: Manda la estrategia por correo ni bien la termines",
      // R6-W1: pins the single-sentence check (clause 1 alone would pass the shape)
      "Chat: Dame la estrategia. Rehaz el plan de precios.",
      // R6-W2: pins RELAY_SHAPE's start anchor
      "Chat: Rehaz la estrategia, mándamela por correo",
      // R6-W3: "from scratch" is a closed two-token formulate marker
      "Chat: Escribe la estrategia desde cero en un doc",
      "Chat: Write the strategy from scratch in a doc",
      // R7-C1: a discourse-marker-led second imperative after a comma
      "Chat: Manda la estrategia por correo, de paso ajusta precios",
      "Chat: Mándame la estrategia por correo, de paso actualiza los precios",
      "Chat: Pon la estrategia en el doc, al final agrégale los precios",
      "Chat: Dame la estrategia, por cierto arma el plan de precios",
      "Chat: Dame la estrategia, para empezar arma el plan",
      "Chat: Manda la estrategia por correo, al final rehazla",
      "Chat: Manda la estrategia por correo, con precios nuevos ponla al día",
      "Chat: Send me the strategy by email, by the way add prices",
      "Chat: Put the strategy in the doc, in addition rewrite pricing",
      // R7-C1: a clitic-bearing imperative hides behind an innocent preposition
      "Chat: Manda la estrategia por correo, en serio ajústala",
      "Chat: Manda la estrategia por correo, en serio hazla bien",
      // R8-C1: the appositive fragment carries the same cap
      "Chat: Manda la estrategia por correo, la estrategia de precios ponla al día",
      "Chat: Pon la estrategia en el doc, la estrategia del 2027 rehazla",
      "Chat: Send me the strategy by email, the strategy for pricing rewrite it",
      // R8-W1: pins the discourse-marker class (only the marker blocks this one)
      "Chat: Manda la estrategia por correo, de paso ajusta",
      // R8-W3: vosotros imperative + clitic
      "Chat: Manda la estrategia por correo, en serio revisadla",
      // R10-C1: a noun in the opener slack is analysis, not a readback
      "Chat: Dame riesgos de la estrategia",
      "Chat: Show me risks in the strategy",
      "Chat: What's wrong with the strategy?",
      "Chat: Tell me alternatives to the strategy",
      // R10-C2: the object after a fronted destination must be the strategy itself
      "Chat: Escribe en el doc mejoras a la estrategia",
      "Chat: Write in the doc improvements to the strategy",
      "Chat: Manda por correo cambios a la estrategia",
      // R10-C3: the clitic branch is anchored — only politeness + tail may follow
      "Chat: Ponla al día en el doc, la estrategia",
      "Chat: Escríbela de nuevo en el doc, la estrategia",
      "Chat: Pásala a limpio en el doc, la estrategia",
      "Chat: Mándamela por correo con los cambios a la estrategia",
      // R11: the tail after the noun is closed — accompaniment reads as a change
      "Chat: Escribe la estrategia con mejoras en el doc",
      "Chat: Manda la estrategia con tus cambios por correo",
      "Chat: Manda la estrategia con el ajuste de precios por correo", // was a fast pin R3–R10
      "Chat: Send the strategy with fixes to the doc",
      "Chat: Dame la estrategia con mejoras",
      "Chat: Cuál es la estrategia sin los riesgos",
      "Chat: Escribe la estrategia en el doc con mis comentarios",
      // R11: a purpose infinitive must be consumption ("para revisarla" is a fast pin)
      "Chat: Escribe la estrategia en el doc para mejorarla",
      "Chat: Escribe la estrategia para mejorarla en el doc",
      // R11: the fronted noun phrase is bound to the same shape
      "Chat: La estrategia con mejoras, mándamela por correo",
      // R11: a "con" phrase inside the topic needs a number or a definite article
      "Chat: Escribe la estrategia de precios con tus cambios en el doc",
      "Chat: Escribe la estrategia de precios con mejoras en el doc",
      // R11: a relative clause on the noun is not a complement (closes the R7 queue item)
      "Chat: Envíame la estrategia que propongas",
      "Chat: Manda la estrategia de precios que propongas por correo",
      // R11: a recipient is a capitalised name, not any token ("a limpio", "a mejorar")
      "Chat: Manda la estrategia a mejorar por correo",
      // R11: an unlisted word after the destination is unknown ⇒ heavy (conservative)
      "Chat: Escribe en el doc nuevo la estrategia",
    ])("design / reasoning still escalates to heavy: %s", (title) => {
      expect(isStrategyRelayOrReadback(title)).toBe(false);
      expect(needsHeavyReasoning(title)).toBe(true);
      const r = chat(title);
      expect(r.agentType).toBe("heavy");
      expect(r.reason).toContain("challenging");
    });

    it("the guard only applies when the strategy noun is the SOLE cue", () => {
      // strategy noun + "a fondo" (deep) → two cues → heavy even with a relay destination
      expect(
        needsHeavyReasoning(
          "Chat: Escribe a fondo la estrategia en un google doc",
        ),
      ).toBe(true);
      // no strategy noun at all → guard is inert, ordinary fast reason
      expect(
        isStrategyRelayOrReadback("Chat: Escribe el resumen en un google doc"),
      ).toBe(false);
      expect(chat("Chat: Escribe el resumen en un google doc").reason).toBe(
        "messaging task → fast",
      );
    });

    it("kill switch: MESSAGING_HEAVY_ESCALATION=false sends everything to fast with the plain reason", () => {
      vi.stubEnv("MESSAGING_HEAVY_ESCALATION", "false");
      try {
        expect(chat("Chat: Diseña una estrategia de draft").agentType).toBe(
          "fast",
        );
        expect(chat("Chat: Pon la estrategia en el KB").reason).toBe(
          "messaging task → fast",
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("keeps a bare 'commit and push' chat on fast (host git op, not authoring)", () => {
    const result = classify({
      title: "Chat: commit and push",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
  });

  // ----- Truncated-title \bPR\b misroute (UUUU investment question, 2026-07-06) -----
  // The router truncates chat titles to 60 chars for display; a mid-word cut split
  // a Spanish word ("precio"→"pr") into a token that the case-INSENSITIVE \bPR\b
  // pattern (pull-request abbrev) matched, misrouting a plain question into the
  // nanoclaw sandbox where it failed with "[Task failed]". Two fixes: \bPR\b is now
  // case-SENSITIVE, and messaging classifies on the untruncated `detectionText`.
  // See feedback_truncated_title_pr_misroute.
  it("keeps a truncated 'precio'→'pr' chat OFF nanoclaw (the UUUU bug, fix A)", () => {
    const result = classify({
      title:
        "Chat: Hace tiempo revisamos la tesis de inversión para UUUU. Su pr...",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging", "telegram"],
    });
    expect(result.agentType).toBe("fast");
  });

  it("still detects a REAL 'PR' (uppercase) as coding → nanoclaw", () => {
    const result = classify({
      title: "Chat: revisa el PR #42 y haz merge a main",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("does NOT treat a lowercase 'pr' token as a coding signal", () => {
    const result = classify({
      title: "Chat: dame el pr de ventas de este mes",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
  });

  // fix B discrimination: title and detectionText must classify DIFFERENTLY so the
  // test fails if classify() ever reverts to detecting on the truncated title.
  it("detectionText OVERRIDES a coding-looking title (title→nanoclaw, full→fast)", () => {
    const shared = {
      // Uppercase "PR" in the (truncated) title WOULD route to nanoclaw on its own…
      title: "Chat: revisa el PR de accion...",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging", "telegram"],
    };
    // control: title alone (no detectionText) → nanoclaw
    expect(classify(shared).agentType).toBe("nanoclaw");
    // …but the untruncated message is a benign price question → fast
    expect(
      classify({
        ...shared,
        detectionText: "revisa el precio de la acción de UUUU hoy",
      }).agentType,
    ).toBe("fast");
  });

  it("detectionText SURFACES coding hidden past the title's 60-char cut", () => {
    const shared = {
      // Benign-looking truncated title → fast on its own…
      title: "Chat: oye una cosa rápida sobre el proyecto que...",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    };
    // control: title alone → fast
    expect(classify(shared).agentType).toBe("fast");
    // …but the full message asks for code work → nanoclaw
    expect(
      classify({
        ...shared,
        detectionText:
          "oye una cosa rápida sobre el proyecto que necesito: implementa el endpoint de retry y agrega un test",
      }).agentType,
    ).toBe("nanoclaw");
  });

  // ----- Foreign-repo git ops stay on the HOST, never nanoclaw (2026-06-20) -----
  // The nanoclaw sandbox only mounts /root/claude/mission-control. A git/file op on
  // a sibling repo (e.g. the Williams Journal) routed to nanoclaw silently never
  // lands on the host — the W25 journal publish regression.
  it("keeps a journal git-commit task OFF nanoclaw (foreign repo → host)", () => {
    const result = classify({
      title: "Git commit W25 journal",
      description:
        "git_commit en /root/claude/thewilliamsradar-journal: staged files = " +
        "[pages/w25-2026.md], commit message = feat: publish W25. Luego git_push a origin main.",
    });
    expect(result.agentType).not.toBe("nanoclaw");
    expect(result.agentType).toBe("fast");
  });

  it("still routes a mission-control coding task to nanoclaw (control)", () => {
    const result = classify({
      title: "git commit the fix in /root/claude/mission-control/src/scope.ts",
      description: "tighten the EMAIL_SEND_RE regex and push",
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  // ----- EXTERNAL-website code tasks stay OFF nanoclaw (2026-06-26) -----
  // "código" is a verb-blind strong signal, so an extract/read task whose subject
  // is code FROM an external site scored coding->nanoclaw — but the sandbox mounts
  // ONLY mission-control, so it had nothing to author and failed with 0 output.
  // Keyed on the OUT-OF-SANDBOX target (URL / domain / rendered-content phrasing),
  // NOT read-vs-author. Misroute: task e77ed5b7 "Extrae el código y traduce al
  // español lo que se visualiza" (re wilab.io) -> nanoclaw -> 0 output, failed 43s.
  it("keeps the wilab.io extract-and-translate chat OFF nanoclaw (external -> host)", () => {
    const result = classify({
      title: "Chat: Extrae el código y traduce al español lo que se visualiza",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).not.toBe("nanoclaw");
  });

  it("keeps an 'extrae el código de wilab.io' chat OFF nanoclaw (domain -> host)", () => {
    const result = classify({
      title: "Chat: extrae el código de la demo de wilab.io",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).not.toBe("nanoclaw");
  });

  // Regression guard (qa-C1 false-positive class): a real AUTHORING task in
  // Spanish — incl. compound "show-me-and-fix-it" with accented clitic
  // imperatives — has NO external signal, so it must STILL reach nanoclaw.
  it("still routes 'muéstrame el código y arréglalo' to nanoclaw (local authoring)", () => {
    const result = classify({
      title: "Chat: muéstrame el código y arréglalo",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("still routes 'explica y mejora el código' to nanoclaw (local, no external)", () => {
    const result = classify({
      title: "Chat: explica y mejora el código del checkout",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("still routes code PORTING (traduce a TypeScript) to nanoclaw (authoring)", () => {
    const result = classify({
      title: "Chat: traduce este código de Python a TypeScript",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("still routes 'build a client for https://stripe.com' to nanoclaw (LOCAL code)", () => {
    const result = classify({
      title: "Chat: implementa un cliente para la API de https://stripe.com",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  // Unit-level: the predicate (external signal + not-local + not-authoring).
  it("referencesExternalWebTarget: external read vs local authoring", () => {
    // external website code, no authoring -> true
    expect(
      referencesExternalWebTarget(
        "Extrae el código y traduce al español lo que se visualiza",
      ),
    ).toBe(true);
    expect(referencesExternalWebTarget("extrae el código de wilab.io")).toBe(
      true,
    );
    // local / no external signal -> false (qa-C1: these stay on nanoclaw)
    expect(referencesExternalWebTarget("muéstrame el código y arréglalo")).toBe(
      false,
    );
    expect(referencesExternalWebTarget("explica y mejora el código")).toBe(
      false,
    );
    expect(referencesExternalWebTarget("explica el código de auth.ts")).toBe(
      false,
    );
    // external URL but an AUTHORING verb (writes local code) -> false
    expect(
      referencesExternalWebTarget(
        "implementa un cliente para https://stripe.com",
      ),
    ).toBe(false);
    // external URL but a LOCAL file named too (editing local code) -> false
    expect(
      referencesExternalWebTarget("arregla el fetch a https://x.com en api.ts"),
    ).toBe(false);
    // qa-W1: external phrase + a MISSED authoring verb (accent clitic / list gap)
    // must still rescue → false (stays nanoclaw).
    expect(
      referencesExternalWebTarget(
        "muéstrame el código de la página de checkout y arréglalo",
      ),
    ).toBe(false);
    expect(
      referencesExternalWebTarget("mejora el código del sitio de checkout"),
    ).toBe(false);
    expect(
      referencesExternalWebTarget("explica el código de la demo y optimízalo"),
    ).toBe(false);
    // qa-W2: a bare-domain URL with a code-extension path is EXTERNAL, not a
    // local file → true.
    expect(
      referencesExternalWebTarget("extrae el código de example.com/app.js"),
    ).toBe(true);
  });

  it("still routes 'muéstrame el código de la página y arréglalo' to nanoclaw (qa-W1)", () => {
    const result = classify({
      title: "Chat: muéstrame el código de la página de checkout y arréglalo",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  // ----- Jarvis self-dev chats stay OFF nanoclaw (2026-07-14) -----
  // jarvis_dev/worktree/KB work is HOST-only since the P1 worktree split; a
  // self-dev chat routed to the sandbox grinds ~10 min until the no-op/scope
  // fallback rescues it (tasks 7529 + 7532 — two 10-min detours in one day).
  describe("referencesJarvisSelfDev", () => {
    it("matches the real misrouted messages from 2026-07-14", () => {
      expect(
        referencesJarvisSelfDev(
          "Chat: Continúa JME Phase 2 — lee el review en jme-plan-v2.md antes de tocar código y haz las correciones al plan.",
        ),
      ).toBe(true);
      expect(
        referencesJarvisSelfDev(
          "Chat: Relee jme-plan-v2.md — la sección 'Review de Phase 2 (2026-07-14)' es nueva",
        ),
      ).toBe(true);
    });

    it("matches worktree path, KB tree, jarvis/* branches, jarvis_dev", () => {
      expect(
        referencesJarvisSelfDev(
          "commit en /root/claude/mission-control-jarvis",
        ),
      ).toBe(true);
      expect(referencesJarvisSelfDev("actualiza jarvis-kb/projects")).toBe(
        true,
      );
      expect(
        referencesJarvisSelfDev(
          "abre PR de jarvis/feat/jme-phase2-consolidator",
        ),
      ).toBe(true);
      expect(referencesJarvisSelfDev("usa jarvis_dev action=pr")).toBe(true);
    });

    it("does NOT match ordinary mission-control coding chats", () => {
      expect(
        referencesJarvisSelfDev("implement the retry endpoint and add a test"),
      ).toBe(false);
      expect(
        referencesJarvisSelfDev("arregla el bug del scheduler en router.ts"),
      ).toBe(false);
      // 'jme' must be word-bounded — no false hit inside other tokens
      expect(referencesJarvisSelfDev("revisa el pipeline de jmeter")).toBe(
        false,
      );
    });

    it("routes a self-dev coding chat to a HOST runner, not nanoclaw", () => {
      const result = classify({
        title:
          "Chat: Continúa JME Phase 2 — lee el review en jme-plan-v2.md antes...",
        description: "You are Jarvis, a strategic AI assistant...",
        tags: ["messaging"],
      });
      expect(result.agentType).not.toBe("nanoclaw");
    });

    it("a path-shaped false positive still lands on a HOST runner (safe degradation)", () => {
      // `src/jarvis/feat/component.ts` matches the branch-namespace marker —
      // an accepted FP because the fall-through is a host runner that can
      // still do the work via the jarvis_dev worktree (loses only isolation).
      const result = classify({
        title: "Chat: refactor src/jarvis/feat/component.ts and add a test",
        description: "You are Jarvis, a strategic AI assistant...",
        tags: ["messaging"],
      });
      expect(result.agentType).not.toBe("nanoclaw");
      expect(["fast", "heavy", "swarm"]).toContain(result.agentType);
    });

    it("keeps a plain mc coding chat on nanoclaw (guard does not over-fire)", () => {
      const result = classify({
        title: "Chat: implement the retry endpoint and add a test",
        description: "You are Jarvis, a strategic AI assistant...",
        tags: ["messaging"],
      });
      expect(result.agentType).toBe("nanoclaw");
    });
  });

  // ----- Sibling repo named (no path) stays OFF nanoclaw (2026-06-24) -----
  // Operators name a project, not a path: "termina la landing de EurekaMS" → the
  // path-literal targetsForeignRepo guard can't fire, the task wrongly hit the
  // mission-control-only nanoclaw sandbox, and the agent confabulated edits to mc's
  // OWN source. referencesForeignProject closes the named case.
  describe("referencesForeignProject", () => {
    it("matches a named non-mc project (slug ≥4 chars, word boundary)", () => {
      expect(
        referencesForeignProject("termina la landing de EurekaMS", [
          "eurekams",
        ]),
      ).toBe(true);
      expect(
        referencesForeignProject("fix the bug in solera-leads", [
          "solera-leads",
        ]),
      ).toBe(true);
    });
    it("does NOT match a substring inside a larger token", () => {
      expect(
        referencesForeignProject("rerun eurekamsxyz pipeline", ["eurekams"]),
      ).toBe(false);
    });
    it("ignores short slugs (<4 chars) to avoid spurious collisions", () => {
      expect(referencesForeignProject("add a cms feature", ["cms"])).toBe(
        false,
      );
    });
    it("returns false on empty/undefined name list", () => {
      expect(
        referencesForeignProject("termina la landing de EurekaMS", []),
      ).toBe(false);
      expect(
        referencesForeignProject("termina la landing de EurekaMS", undefined),
      ).toBe(false);
    });
    it("does NOT match a mission-control coding task (no foreign name present)", () => {
      expect(
        referencesForeignProject("fix the regex in classifier.ts and push", [
          "eurekams",
        ]),
      ).toBe(false);
    });
  });

  it("keeps a NAMED-project coding chat OFF nanoclaw (EurekaMS landing → host)", () => {
    // The exact 2026-06-24 incident: a landing-site coding task with no /root/claude
    // path, only the project name. With foreignProjectNames resolved, it must NOT
    // route to the mission-control-only sandbox.
    const result = classify({
      title:
        "Chat: Usa shell exec y tus herramientas de código para terminar la landing de EurekaMS",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
      foreignProjectNames: ["eurekams"],
    });
    expect(result.agentType).not.toBe("nanoclaw");
  });

  it("WITHOUT a resolved name list, behavior is unchanged (backward compat)", () => {
    // Same task, no foreignProjectNames passed → prior behavior (still nanoclaw).
    // Proves the new guard is purely additive and the dispatcher's resolution is
    // what activates it.
    const result = classify({
      title:
        "Chat: usa shell exec para terminar la landing, crea branch y haz commit",
      description: "You are Jarvis...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("keeps a messaging journal task OFF nanoclaw when the path is in the title", () => {
    // Messaging tasks classify on the TITLE only (description is persona-inflated).
    // When the sibling-repo path is visible in the title, the guard still fires.
    const result = classify({
      title: "Chat: git commit en /root/claude/thewilliamsradar-journal y push",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).not.toBe("nanoclaw");
  });

  it("GAP CLOSED: a path-less journal-commit messaging chat stays on the host", () => {
    // Was the qa W1 residual: "commit the journal repo" named no absolute path, so
    // the foreign-repo guard couldn't fire and it landed on nanoclaw (silent-fail).
    // Closed 2026-06-20 by dropping lone "repo" from STRONG_CODING_PATTERNS — a bare
    // "repo" mention is too weak a coding signal. With no git/filename/verb×noun
    // signal, this is no longer a coding task → it stays on `fast` (host), where the
    // git_* tools can actually reach the repo. Genuine coding ("fix the repo bug",
    // "git commit …") still routes via the remaining strong/verb×noun signals.
    const result = classify({
      title: "Chat: commit the journal repo and push to origin",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).not.toBe("nanoclaw");
    expect(result.agentType).toBe("fast");
  });

  it("keeps a 'guarda en el repo' KB-save chat OFF nanoclaw (silent-save regression)", () => {
    // Task 6548 (2026-06-20): "Guarda esto en el repo y marca las cadenas como
    // target" was forced to nanoclaw by the lone word "repo", which can't reach the
    // KB → 0 tool calls, nothing saved. A save-to-KB chat must stay on the host
    // (fast), where jarvis_file_write/project_update exist.
    const result = classify({
      title: "Chat: Guarda esto en el repo y marca las cadenas como target",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).not.toBe("nanoclaw");
    expect(result.agentType).toBe("fast");
  });

  it("treats 'repo' as non-coding (lone OR verb-paired) — real code work has a specific noun", () => {
    // "repo" is neither a strong signal nor a coding noun: in chat it's ambiguous
    // between a git repo and the KB. A verb×repo paraphrase ("agrega esto al repo")
    // is the same silent-save class as the original bug → must stay off nanoclaw.
    expect(isCodingTask("guarda esto en el repo")).toBe(false);
    expect(isCodingTask("agrega esto al repo")).toBe(false);
    expect(isCodingTask("add this note to the repo")).toBe(false);
    // Genuine code work still routes via a specific noun / strong signal:
    expect(isCodingTask("fix the bug in the repo")).toBe(true); // bug
    expect(isCodingTask("rename the branch")).toBe(true); // branch
    expect(isCodingTask("git commit and push the fix")).toBe(true); // git
  });

  describe("targetsForeignRepo", () => {
    it("flags /root/claude sibling repos as foreign", () => {
      expect(
        targetsForeignRepo(
          "git_commit en /root/claude/thewilliamsradar-journal",
        ),
      ).toBe(true);
      expect(
        targetsForeignRepo("cd /root/claude/williams-entry-radar && git add"),
      ).toBe(true);
      expect(
        targetsForeignRepo("edit /root/claude/crm-azteca/src/index.ts"),
      ).toBe(true);
    });

    it("does NOT flag the mission-control checkout", () => {
      expect(targetsForeignRepo("/root/claude/mission-control")).toBe(false);
      expect(
        targetsForeignRepo("edit /root/claude/mission-control/src/scope.ts"),
      ).toBe(false);
    });

    it("does NOT flag a bare ellipsis or pathless text", () => {
      expect(targetsForeignRepo("filesystem access at /root/claude/...")).toBe(
        false,
      );
      expect(targetsForeignRepo("just refactor the auth module")).toBe(false);
    });
  });

  it("keeps a plain chat on fast", () => {
    const result = classify({
      title: "Chat: cómo va el día?",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
  });
});

describe("classifier — coding/heavy routing predicates (2026-06-19)", () => {
  afterEach(() => {
    delete process.env.MESSAGING_HEAVY_ESCALATION;
    delete process.env.MESSAGING_SWARM_ESCALATION;
  });

  it("isCodingTask: code authoring → true; host git ops / prose / strategy → false", () => {
    expect(isCodingTask("Chat: refactoriza el módulo")).toBe(true);
    expect(isCodingTask("implement the endpoint and write a test")).toBe(true);
    expect(
      isCodingTask("Chat: haz un plan y ejecuta el cambio, luego commit"),
    ).toBe(
      true, // build×ship co-occurrence
    );
    expect(isCodingTask("git rebase onto main and merge")).toBe(true);
    expect(isCodingTask("commit and push")).toBe(false); // lone ship verbs = host git op
    expect(isCodingTask("write an email to the client")).toBe(false);
    expect(isCodingTask("build a 2027 commercial strategy")).toBe(false);
  });

  it("isCodingTask: ES 'comité' false-positive guard still holds", () => {
    expect(isCodingTask("implementa el plan del comité de marketing")).toBe(
      false,
    );
  });

  it("isCodingTask: incremental edits sandbox (C1 — no coding escapes the invariant)", () => {
    expect(isCodingTask("fix the login flow")).toBe(true);
    expect(isCodingTask("rename the function")).toBe(true);
    expect(isCodingTask("bump the dependency")).toBe(true);
    expect(isCodingTask("add a column to the users table")).toBe(true);
    expect(isCodingTask("tighten the regex in scope.ts")).toBe(true); // filename
    expect(isCodingTask("update users.sql")).toBe(true); // filename
    expect(isCodingTask("optimize the query")).toBe(true);
    expect(isCodingTask("modifica el endpoint de auth")).toBe(true);
    expect(isCodingTask("remove the import in config.ts")).toBe(true);
    expect(isCodingTask("wire up the webhook handler")).toBe(true);
    expect(isCodingTask("patch the vulnerability")).toBe(true);
    expect(isCodingTask("migrate the schema")).toBe(true);
    expect(isCodingTask("delete the route")).toBe(true);
  });

  it("isCodingTask: non-coding 'merge'/'build+deploy' prose stays out of the sandbox", () => {
    expect(isCodingTask("merge the two spreadsheets")).toBe(false); // polysemous merge
    expect(isCodingTask("build a strategy and deploy the team")).toBe(false); // build×ship prose
    expect(isCodingTask("create a report for the client")).toBe(false);
  });

  it("needsHeavyReasoning: architecture/strategy/multi-step → true; bare research → false", () => {
    expect(needsHeavyReasoning("redesign the architecture")).toBe(true);
    expect(needsHeavyReasoning("diseña la estrategia 2027")).toBe(true);
    expect(needsHeavyReasoning("analiza el mercado y recomienda pasos")).toBe(
      true,
    );
    expect(needsHeavyReasoning("compare the options and pick one")).toBe(true);
    expect(needsHeavyReasoning("investiga las tendencias de AI")).toBe(false); // bare research
    expect(needsHeavyReasoning("cómo estás?")).toBe(false);
  });

  it("INVARIANT: a non-messaging (auto) coding task is containerized → nanoclaw", () => {
    const result = classify({
      title: "Debug the slot-finder script",
      description: "There is a bug in the module; debug and patch the code.",
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("kill switch: MESSAGING_HEAVY_ESCALATION=false reverts a coding chat to fast", () => {
    process.env.MESSAGING_HEAVY_ESCALATION = "false";
    const result = classify({
      title: "Chat: refactoriza el módulo de auth",
      description: "...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
  });

  it("kill switch does NOT affect non-messaging coding (invariant holds)", () => {
    process.env.MESSAGING_HEAVY_ESCALATION = "false";
    const result = classify({
      title: "Refactor the auth module",
      description: "...",
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  // ----- Fan-out chats → swarm (2026-06-20; swarm validated end-to-end) -----
  it("isFanOutTask: produce-verb + per-item quantifier → true; single/read → false", () => {
    expect(isFanOutTask("Abre un archivo para cada prospecto")).toBe(true);
    expect(isFanOutTask("crea un reporte por cada cadena")).toBe(true);
    expect(isFanOutTask("for each chain, generate a profile")).toBe(true);
    expect(isFanOutTask("guarda un resumen para cada prospecto")).toBe(true);
    // read/summarize "each" — no produce verb → not fan-out
    expect(isFanOutTask("explícame cada función")).toBe(false);
    expect(isFanOutTask("dame un resumen de cada reunión")).toBe(false);
    // single artifact, no quantifier (task 6550 must stay fast)
    expect(isFanOutTask("Guarda el reporte de top 10 cadenas en el repo")).toBe(
      false,
    );
    expect(isFanOutTask("crea un archivo de prospectos")).toBe(false);
    // W3 (qa 2026-06-20): analysis verbs are NOT producers (→ heavy, not swarm)
    expect(isFanOutTask("analiza cada reunión del trimestre")).toBe(false);
    expect(isFanOutTask("investiga cada competidor")).toBe(false);
    // W3: "todos los" is a single-artifact-covering-a-collection, not per-item
    expect(isFanOutTask("crea un resumen de todos los puntos")).toBe(false);
  });

  it("routes a fan-out chat to swarm (parallel per-item)", () => {
    const result = classify({
      title: "Chat: Abre un archivo para cada prospecto y enriquécelo",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("swarm");
  });

  it("a single 'guarda en el repo' chat stays on fast (not swarm)", () => {
    const result = classify({
      title: "Chat: Guarda el reporte de top 10 cadenas en el repo",
      description: "...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
  });

  it("MESSAGING_SWARM_ESCALATION=false → fan-out falls back to heavy (not fast)", () => {
    process.env.MESSAGING_SWARM_ESCALATION = "false";
    const result = classify({
      title: "Chat: crea un reporte por cada cadena de retail",
      description: "...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("heavy");
  });

  it("MESSAGING_HEAVY_ESCALATION=false reverts a fan-out chat all the way to fast", () => {
    process.env.MESSAGING_HEAVY_ESCALATION = "false";
    const result = classify({
      title: "Chat: crea un reporte por cada cadena de retail",
      description: "...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
  });
});

// ---------------------------------------------------------------------------
// Outcome adjustment tests (mock DB for these)
// ---------------------------------------------------------------------------

describe("classifier outcome adjustments", () => {
  function makeStats(overrides: Partial<RunnerStats>[]): RunnerStats[] {
    return overrides.map((o) => ({
      ran_on: "fast",
      total: 20,
      successes: 18,
      avg_duration_ms: 5000,
      success_rate: 0.9,
      avg_cost_usd: 0.01,
      ...o,
    }));
  }

  async function classifyWith(
    stats: RunnerStats[],
    keywords: KeywordOutcomeRow[],
    input: { title: string; description: string },
    feedbackStats: FeedbackStats[] = [],
  ) {
    vi.resetModules();
    vi.doMock("../db/task-outcomes.js", () => ({
      queryRunnerStats: () => stats,
      queryOutcomesByKeywords: () => keywords,
      queryFeedbackQuality: () => feedbackStats,
    }));
    const { classify: c } = await import("./classifier.js");
    return c(input);
  }

  it("should return 0 adjustment with insufficient data", async () => {
    const result = await classifyWith(makeStats([{ total: 5 }]), [], {
      title: "Test",
      description: "task",
    });
    expect(result.score).toBeLessThan(3);
  });

  it("should pull score down when fast has high success rate", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 50, successes: 48, success_rate: 0.96 },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("prefer fast");
  });

  it("should push score up when fast has low success rate", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 20, successes: 8, success_rate: 0.4 },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("try heavier");
  });

  it("should detect heavy duration anomaly", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 30, success_rate: 0.7 },
        {
          ran_on: "heavy",
          total: 10,
          avg_duration_ms: 8000,
          success_rate: 0.8,
        },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("over-classified");
  });

  it("should penalize expensive low-success runners", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 30, success_rate: 0.7 },
        { ran_on: "heavy", total: 10, success_rate: 0.3, avg_cost_usd: 0.1 },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("costly");
  });

  it("should nudge toward runner that succeeds on similar tasks", async () => {
    const similar: KeywordOutcomeRow[] = [
      { task_id: "t1", ran_on: "nanoclaw", success: 1, duration_ms: 5000 },
      { task_id: "t2", ran_on: "nanoclaw", success: 1, duration_ms: 6000 },
      { task_id: "t3", ran_on: "nanoclaw", success: 1, duration_ms: 4000 },
      { task_id: "t4", ran_on: "fast", success: 0, duration_ms: 3000 },
    ];
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 30, success_rate: 0.7 },
        { ran_on: "nanoclaw", total: 10, success_rate: 0.8 },
      ]),
      similar,
      {
        title: "Quarterly numbers",
        description: "tally the quarterly numbers across regions",
      },
    );
    expect(result.reason).toContain("similar tasks");
  });

  it("should clamp total adjustment to [-3, +4]", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 50, success_rate: 0.95 },
        {
          ran_on: "heavy",
          total: 10,
          avg_duration_ms: 5000,
          success_rate: 0.3,
        },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.score).toBeGreaterThanOrEqual(-3);
  });

  it("should nudge score up when fast+flash has high negative rate", async () => {
    const fbStats: FeedbackStats[] = [
      {
        ran_on: "fast",
        model_tier: "flash",
        total: 10,
        negative_count: 3,
        negative_rate: 0.3,
      },
    ];
    const result = await classifyWith(
      makeStats([{ ran_on: "fast", total: 30, success_rate: 0.7 }]),
      [],
      { title: "Test", description: "task" },
      fbStats,
    );
    expect(result.reason).toContain("tier upgrade");
  });

  it("should not nudge when feedback data is insufficient", async () => {
    const result = await classifyWith(
      makeStats([{ ran_on: "fast", total: 30, success_rate: 0.7 }]),
      [],
      { title: "Test", description: "task" },
      [], // no feedback stats
    );
    expect(result.reason).not.toContain("tier upgrade");
  });
});

// Usability plan Phase 4.5: "turn budget is the harness's problem" — a long
// coding chat must never land on the fast runner (that's where the operator
// had to type "No agotes tus turnos"). Classification pins the routing; the
// fast-runner auto-resume (4.3) is the safety net for whatever slips through.
describe("Phase 4.5 — long coding chat routes off the fast runner", () => {
  it("routes 'implementa el endpoint y corre los tests' to nanoclaw", () => {
    const result = classify({
      title: "Chat: Implementa el endpoint de previews y corre los tests",
      description: "Chat: Implementa el endpoint de previews y corre los tests",
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("routes a plan→ship chat to nanoclaw even without a code noun", () => {
    const result = classify({
      title: "Chat: Haz un plan para el cambio y ejecútalo con commit",
      description: "Chat: Haz un plan para el cambio y ejecútalo con commit",
    });
    expect(result.agentType).toBe("nanoclaw");
  });
});
