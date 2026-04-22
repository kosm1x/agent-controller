/**
 * Cinema prompts library — v7.4 S2a.
 *
 * Static catalog of camera modifiers, lighting styles, and mood archetypes
 * used by the storyboard pipeline to enrich per-scene image prompts beyond
 * bare "keyword search" strings. Same shape as
 * `src/tools/builtin/ads-references/creative-frameworks.ts` from v7.3 P4a
 * (non-LLM, non-mutating reference data).
 *
 * Adopted from public cinematography vocabulary. Not proprietary.
 */

export interface CinemaCameraModifier {
  id: string;
  label: string;
  tagline: string;
  /** Short descriptor appended to the LLM image prompt. */
  prompt_fragment: string;
  /** When this modifier is most appropriate. */
  best_for: string[];
}

export interface CinemaLightingStyle {
  id: string;
  label: string;
  tagline: string;
  prompt_fragment: string;
  best_for: string[];
}

export interface CinemaMoodArchetype {
  id: string;
  label: string;
  tagline: string;
  prompt_fragment: string;
  best_for: string[];
}

export const CAMERA_MODIFIERS: readonly CinemaCameraModifier[] = [
  {
    id: "wide-establishing",
    label: "Wide establishing shot",
    tagline: "Full scene context, low angle, ~24mm",
    prompt_fragment: "wide establishing shot, 24mm lens, slight low angle",
    best_for: ["Opening scene", "Setting context"],
  },
  {
    id: "medium-interview",
    label: "Medium interview shot",
    tagline: "Subject head and shoulders, 50mm",
    prompt_fragment: "medium shot, 50mm lens, eye level, subject centered",
    best_for: ["Talking head", "Testimonial"],
  },
  {
    id: "close-up-emotion",
    label: "Close-up emotion",
    tagline: "Tight framing on face, 85mm, shallow depth",
    prompt_fragment:
      "close-up portrait, 85mm lens, shallow depth of field, eyes in focus",
    best_for: ["Emotional beat", "Transformation scene"],
  },
  {
    id: "dutch-angle-tension",
    label: "Dutch angle",
    tagline: "Tilted frame for unease or dynamism",
    prompt_fragment: "dutch angle composition, ~15° tilt, dynamic tension",
    best_for: ["Problem statement", "Conflict beat"],
  },
  {
    id: "top-down-flatlay",
    label: "Top-down flatlay",
    tagline: "Bird's eye over arranged objects, 35mm",
    prompt_fragment:
      "top-down flatlay, 35mm lens, evenly spaced objects, matte surface",
    best_for: ["Product showcase", "Process explanation"],
  },
  {
    id: "over-shoulder-pov",
    label: "Over-the-shoulder POV",
    tagline: "Frame from behind subject looking forward",
    prompt_fragment:
      "over-the-shoulder POV, 50mm lens, subject silhouette in foreground",
    best_for: ["Audience identification", "First-person setup"],
  },
  {
    id: "extreme-wide-landscape",
    label: "Extreme wide landscape",
    tagline: "Tiny subject in vast environment, 16mm",
    prompt_fragment:
      "extreme wide shot, 16mm lens, small subject in vast landscape",
    best_for: ["Scale contrast", "Ambition scene"],
  },
  {
    id: "macro-detail",
    label: "Macro detail",
    tagline: "Extreme close-up on texture, 100mm macro",
    prompt_fragment:
      "macro photography, 100mm lens, 1:1 magnification, fine texture detail",
    best_for: ["Craft showcase", "Quality claim"],
  },
  {
    id: "handheld-verite",
    label: "Handheld vérité",
    tagline: "Subtle camera shake, documentary feel",
    prompt_fragment:
      "handheld cinematography, subtle motion, documentary style, natural light",
    best_for: ["Behind-the-scenes", "Authenticity beat"],
  },
  {
    id: "tracking-dolly",
    label: "Tracking dolly",
    tagline: "Smooth lateral motion following action",
    prompt_fragment:
      "smooth dolly tracking shot, steady motion parallel to subject",
    best_for: ["Journey narrative", "Process flow"],
  },
  {
    id: "zoom-in-reveal",
    label: "Zoom-in reveal",
    tagline: "Slow optical zoom into detail",
    prompt_fragment: "slow zoom into detail, revealing hidden element",
    best_for: ["Discovery beat", "Product feature highlight"],
  },
  {
    id: "aerial-drone",
    label: "Aerial drone",
    tagline: "High-altitude descending shot",
    prompt_fragment:
      "aerial drone footage, descending shot, ~200m altitude, golden hour",
    best_for: ["Scale setup", "Location establishing"],
  },
  {
    id: "static-locked-off",
    label: "Static locked-off",
    tagline: "Tripod-mounted, no camera motion",
    prompt_fragment:
      "static tripod shot, locked-off composition, no camera motion",
    best_for: ["Interview", "Testimonial", "Product beauty"],
  },
  {
    id: "rack-focus",
    label: "Rack focus",
    tagline: "Shift focus from foreground to background",
    prompt_fragment:
      "rack focus pull, foreground-to-background transition, 85mm",
    best_for: ["Revelation beat", "Shift of attention"],
  },
  {
    id: "tilt-shift-miniature",
    label: "Tilt-shift miniature",
    tagline: "Selective focus for miniature effect",
    prompt_fragment:
      "tilt-shift effect, narrow focus plane, miniature aesthetic",
    best_for: ["Playful tone", "Stylized visualization"],
  },
  {
    id: "slow-motion",
    label: "Slow motion",
    tagline: "120-240fps captured, played at 24fps",
    prompt_fragment: "slow motion 120fps, emphasizing fluid motion",
    best_for: ["Impact beat", "Product in action"],
  },
  {
    id: "timelapse",
    label: "Timelapse",
    tagline: "Accelerated time, long exposure",
    prompt_fragment:
      "timelapse photography, compressed time, smooth motion blur",
    best_for: ["Process summary", "Transformation over time"],
  },
  {
    id: "split-diopter",
    label: "Split diopter",
    tagline: "Two planes in sharp focus simultaneously",
    prompt_fragment:
      "split diopter lens, two focal planes simultaneously sharp",
    best_for: ["Comparison beat", "Dual subject framing"],
  },
  {
    id: "crane-reveal",
    label: "Crane reveal",
    tagline: "Rising camera exposing wider scene",
    prompt_fragment:
      "crane shot rising from low to high, revealing full environment",
    best_for: ["Grand reveal", "Scope amplification"],
  },
  {
    id: "profile-silhouette",
    label: "Profile silhouette",
    tagline: "Side profile against bright background",
    prompt_fragment: "profile silhouette, bright rim light, dark subject shape",
    best_for: ["Mysterious tone", "Anonymous testimonial"],
  },
];

export const LIGHTING_STYLES: readonly CinemaLightingStyle[] = [
  {
    id: "low-key-dramatic",
    label: "Low-key dramatic",
    tagline: "High contrast, deep shadows, single key light",
    prompt_fragment:
      "low-key lighting, single key light, deep shadows, high contrast",
    best_for: ["Conflict beat", "Film noir aesthetic"],
  },
  {
    id: "high-key-commercial",
    label: "High-key commercial",
    tagline: "Bright, even lighting with minimal shadow",
    prompt_fragment:
      "high-key lighting, soft even illumination, minimal shadows, clean background",
    best_for: ["Product packshot", "Cheerful tone"],
  },
  {
    id: "rim-light-separation",
    label: "Rim light separation",
    tagline: "Edge light separating subject from background",
    prompt_fragment:
      "rim light behind subject, edge separation, dark background",
    best_for: ["Hero shot", "Subject isolation"],
  },
  {
    id: "golden-hour-warm",
    label: "Golden hour warm",
    tagline: "Warm sunset color, long shadows, soft contrast",
    prompt_fragment:
      "golden hour lighting, warm tones, long soft shadows, ~5:30pm sun",
    best_for: ["Aspirational tone", "Outdoor scenes"],
  },
  {
    id: "blue-hour-ambient",
    label: "Blue hour ambient",
    tagline: "Cool twilight color, ambient sky light",
    prompt_fragment:
      "blue hour lighting, cool cyan-teal ambient, dusk atmosphere",
    best_for: ["Moody scene", "Transition beat"],
  },
  {
    id: "volumetric-atmospheric",
    label: "Volumetric atmospheric",
    tagline: "Visible light rays through haze or smoke",
    prompt_fragment: "volumetric light rays through atmospheric haze, God rays",
    best_for: ["Revelation scene", "Epic moment"],
  },
  {
    id: "neon-cyberpunk",
    label: "Neon cyberpunk",
    tagline: "Saturated magenta + cyan, urban night",
    prompt_fragment:
      "neon cyberpunk lighting, magenta and cyan, urban night, reflective surfaces",
    best_for: ["Tech-forward brand", "Youth-oriented"],
  },
  {
    id: "window-light-natural",
    label: "Window light natural",
    tagline: "Soft directional daylight through window",
    prompt_fragment: "soft window light, natural daylight, indirect direction",
    best_for: ["Intimate interview", "Documentary feel"],
  },
  {
    id: "product-beauty-soft",
    label: "Product beauty soft",
    tagline: "Softbox + reflector, shadowless product render",
    prompt_fragment:
      "softbox lighting from 45°, bounce card fill, shadowless product",
    best_for: ["Ecommerce", "Clean packshot"],
  },
  {
    id: "candlelight-intimate",
    label: "Candlelight intimate",
    tagline: "Warm flickering low-level illumination",
    prompt_fragment:
      "candlelight warm tungsten glow, 2700K, intimate low-level illumination",
    best_for: ["Cozy beat", "Nostalgic tone"],
  },
  {
    id: "fluorescent-office",
    label: "Fluorescent office",
    tagline: "Flat cold overhead lighting",
    prompt_fragment: "fluorescent office lighting, flat cool 4000K overhead",
    best_for: ["Before-state", "Mundane baseline"],
  },
  {
    id: "stage-performance",
    label: "Stage performance",
    tagline: "Colored spots on dark stage",
    prompt_fragment:
      "stage lighting, colored spotlights, dark surrounding, theatrical",
    best_for: ["Event coverage", "Launch reveal"],
  },
  {
    id: "backlit-silhouette",
    label: "Backlit silhouette",
    tagline: "Strong light behind subject, dark foreground",
    prompt_fragment:
      "backlit silhouette, strong sun or lamp behind subject, dark foreground",
    best_for: ["Mysterious tone", "Abstract depiction"],
  },
  {
    id: "overcast-soft",
    label: "Overcast soft",
    tagline: "Cloudy daylight, shadowless, wraparound",
    prompt_fragment:
      "overcast soft daylight, wraparound shadow-free illumination",
    best_for: ["Natural skin tones", "Portrait work"],
  },
  {
    id: "motivated-practicals",
    label: "Motivated practicals",
    tagline: "Lamps, screens, fires as apparent light sources",
    prompt_fragment:
      "motivated practical lighting, visible lamps or screens as source, realistic",
    best_for: ["Narrative scene", "Environmental storytelling"],
  },
];

export const MOOD_ARCHETYPES: readonly CinemaMoodArchetype[] = [
  {
    id: "aspirational-uplift",
    label: "Aspirational uplift",
    tagline: "Hopeful, forward-moving, warm palette",
    prompt_fragment:
      "aspirational mood, warm tones, hopeful forward motion, bright horizon",
    best_for: ["Brand manifesto", "Transformation promise"],
  },
  {
    id: "gritty-authentic",
    label: "Gritty authentic",
    tagline: "Unfiltered, textured, documentary realism",
    prompt_fragment:
      "gritty authentic mood, unfiltered textures, documentary realism",
    best_for: ["Founder story", "Blue-collar tone"],
  },
  {
    id: "ethereal-dreamlike",
    label: "Ethereal dreamlike",
    tagline: "Soft focus, pastel palette, gauzy atmosphere",
    prompt_fragment:
      "ethereal dreamlike mood, soft focus, pastel palette, gauzy haze",
    best_for: ["Wellness", "Beauty", "Aspirational lifestyle"],
  },
  {
    id: "minimalist-clinical",
    label: "Minimalist clinical",
    tagline: "White space, precise geometry, no ornamentation",
    prompt_fragment:
      "minimalist clinical aesthetic, white space, precise geometry, no ornamentation",
    best_for: ["Tech", "SaaS", "Medical"],
  },
  {
    id: "nostalgic-warm",
    label: "Nostalgic warm",
    tagline: "Film grain, faded color, analog era",
    prompt_fragment:
      "nostalgic analog mood, film grain, faded colors, 35mm feel",
    best_for: ["Heritage brand", "Throwback campaign"],
  },
  {
    id: "dramatic-cinematic",
    label: "Dramatic cinematic",
    tagline: "Anamorphic framing, teal-orange grade",
    prompt_fragment:
      "dramatic cinematic mood, anamorphic 2.39:1 framing, teal-orange color grade",
    best_for: ["Launch hero", "Brand film"],
  },
  {
    id: "playful-energetic",
    label: "Playful energetic",
    tagline: "Saturated color, fast cuts, bouncy motion",
    prompt_fragment:
      "playful energetic mood, saturated colors, bouncy motion, upbeat tempo",
    best_for: ["Youth brand", "Food/CPG", "Mobile app"],
  },
  {
    id: "luxurious-refined",
    label: "Luxurious refined",
    tagline: "Slow pacing, rich materials, gold accents",
    prompt_fragment:
      "luxurious refined mood, slow deliberate pacing, rich materials, gold accents",
    best_for: ["Premium", "Hospitality", "Jewelry"],
  },
  {
    id: "urgent-tactical",
    label: "Urgent tactical",
    tagline: "Fast cuts, red accents, countdown pacing",
    prompt_fragment:
      "urgent tactical mood, fast cuts, red accents, countdown pacing",
    best_for: ["Sale promotion", "Limited-time offer"],
  },
  {
    id: "meditative-calm",
    label: "Meditative calm",
    tagline: "Long takes, neutral palette, ambient sound",
    prompt_fragment:
      "meditative calm mood, long takes, neutral earth palette, ambient stillness",
    best_for: ["Wellness", "Meditation app", "Retreat brand"],
  },
];

/**
 * Sanity invariant — all `prompt_fragment` strings must not contain `{{…}}`
 * placeholder syntax, which would be re-substituted by the storyboard
 * pipeline's prompt chain.
 */
export function validateCatalogs(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const placeholderRx = /\{\{[^}]*\}\}/;
  for (const m of [
    ...CAMERA_MODIFIERS,
    ...LIGHTING_STYLES,
    ...MOOD_ARCHETYPES,
  ]) {
    if (placeholderRx.test(m.prompt_fragment)) {
      errors.push(`placeholder syntax in ${m.id}: ${m.prompt_fragment}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
