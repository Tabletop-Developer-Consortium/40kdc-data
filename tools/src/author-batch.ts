/**
 * DSL stub authoring engine (#21) — batched, subscription-billed, two-phase.
 *
 * Empty-modifier ability stubs (`{type:"stat-modifier", modifier:{}}` and kin)
 * are authored into real DSL from their 10e-archive source rule. The work is a
 * pile of discrete, stateless, structured LLM calls, so we run them as batched
 * `claude -p --json-schema` invocations on the Claude subscription rather than
 * spawning a full agent per ability (the agent fan-out's per-call system-prompt
 * + tool-loop overhead is ~50-100x the useful work). Assembly and schema
 * validation are pure TS — the model only classifies and judges.
 *
 *   author-input/<faction>.json  (datasheet-resolved rules, from author-input.ts)
 *     ── classify ──▶  flat slot-forms        (batched claude -p)
 *     ── assemble ──▶  full ability entries    (TS: effect + scope, no LLM)
 *     ── validate ──▶  AJV against the schema   (TS — rejects invented enums)
 *     ── verify  ──▶  fidelity verdict          (batched claude -p, scope-aware)
 *     ─────────────▶  data/_audit/proposed/<faction>.json
 *
 * Two modes:
 *   propose  (default) — write proposals; never touch live data.
 *   apply              — splice gated proposals into live abilities.json. Only
 *                        rewrites entries that are STILL empty-modifier stubs,
 *                        so re-running is safe and authored work is never
 *                        clobbered. Gate defaults: schema-valid + verifier-
 *                        faithful + confidence≠low + not complex-flagged.
 *
 * Usage:
 *   npx tsx tools/src/author-batch.ts propose <faction|--all> [--batch N] [--model M]
 *   npx tsx tools/src/author-batch.ts apply   <faction|--all> [--min-confidence high|medium]
 *                                                              [--include-complex] [--dry-run]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createValidator } from "./schema-loader.js";
import { hasEmptyModifier } from "./audit-coverage.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DATA_ROOT = resolve(__dirname, "../../data");
const INPUT_DIR = resolve(DATA_ROOT, "_audit", "author-input");
const ENRICHMENT_ROOT = resolve(DATA_ROOT, "enrichment");
const OUT_DIR = resolve(DATA_ROOT, "_audit", "proposed");
const ABILITY_SCHEMA_ID = "https://40kdc.dev/schemas/enrichment/ability-dsl/ability.schema.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const readJSON = (p: string): Json => JSON.parse(readFileSync(p, "utf-8"));
const writeJSON = (p: string, v: Json): void => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
/** Stable digest of a stub's source rule — the resume key (rule changed ⇒ re-propose). */
const srcHash = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

const PARAMETERLESS = new Set(["deep-strike", "fallback-and-act", "fight-first", "fight-last", "shoot-on-death", "fight-on-death"]);

export interface Proposal {
  ability_id: string;
  name: string;
  faction: string;
  effect_type?: string;
  complex?: boolean;
  confidence?: "high" | "medium" | "low";
  schema_valid: boolean;
  proposed_effect?: Json;
  proposed_scope?: Json;
  /** Ability-level behavior the repair pass inferred (passive/activated/reactive/aura). */
  proposed_behavior?: string;
  /** Optional ability-level fields inferred by the repair pass. Explicit null removes a stale field. */
  proposed_trigger?: Json | null;
  proposed_usage?: Json | null;
  proposed_applies_to?: Json | null;
  verdict?: { severity: string; faithful: boolean; issue: string } | null;
  final_faithful: boolean;
  error?: string;
  /** Set by the full-tree repair pass — the effect is a nested tree, not flat-form. */
  repaired?: boolean;
  /** Repair pass flagged this rule as genuinely unencodable (needs hand-authoring). */
  unencodable?: boolean;
  /** Canonical-key lint result (repair pass only). false = invented/out-of-vocab modifier keys. */
  canonical?: boolean;
  /** Digest of the source rule at propose time — lets a resumed run skip unchanged stubs. */
  src_hash?: string;
}


/** Parse the first JSON object from Claude CLI output, ignoring trailing client warnings. */
export function parseClaudeEnvelope(stdout: string): Json {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("response contains no JSON object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i++) {
    const char = stdout[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return JSON.parse(stdout.slice(start, i + 1));
    }
  }
  throw new Error("response contains incomplete JSON");
}
// ─── claude CLI bridge (subscription, structured output) ─────────────

/** One batched, structured `claude -p` call. Resolves to the validated object. */
export function callClaude(system: string, user: string, schema: Json, model: string): Promise<Json> {
  return new Promise((res, rej) => {
    execFile(
      "claude",
      ["-p", user, "--system-prompt", system, "--exclude-dynamic-system-prompt-sections",
       "--json-schema", JSON.stringify(schema), "--output-format", "json", "--model", model],
      { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
      (err, stdout) => {
        if (err && !stdout) return rej(err);
        try {
          const env = parseClaudeEnvelope(stdout);
          if (env.is_error) return rej(new Error(env.result ?? "claude error"));
          if (!env.structured_output) return rej(new Error("no structured_output in response"));
          res(env.structured_output);
        } catch (e) {
          rej(new Error(`parse failed: ${(e as Error).message}; head=${String(stdout).slice(0, 200)}`));
        }
      },
    );
  });
}

// ─── prompts + schemas ───────────────────────────────────────────────

const CLASSIFY_SYSTEM =
  `You translate Warhammer 40k ability rules into a structured DSL. For each ability return one slot-form.\n\n` +
  `effect_type — pick the SINGLE best of:\n` +
  `  stat-modifier {operation:"add"|"subtract"|"set", stat:"A"|"S"|"T"|"Sv"|"AP"|"OC"|"Ld", value:int}\n` +
  `  roll-modifier {operation:"add"|"subtract", roll:"hit"|"wound"|"save"|"charge", value:int}\n` +
  `  re-roll {roll:"hit"|"wound"|"save"|"damage"|"charge"|"advance", subset:"ones"|"all-failures"} for pass/fail dice, or {roll:"advance"|"charge"|"damage", result_scope:"any-result"} when any result can be re-rolled — ONLY combat/movement dice, NOT Battle-shock/Leadership\n` +
  `  leadership-modifier {test:"battle-shock", operation:"re-roll"} or {operation:"add"|"subtract", value:int} — USE for Battle-shock/Leadership rerolls or Ld changes\n` +
  `  mortal-wounds {count:int|"D3"|"D6"} ; feel-no-pain {threshold:int} ; invulnerable-save {invuln_sv:int}\n` +
  `  keyword-grant {keywords:[ "lethal-hits"|"sustained-hits"|"devastating-wounds"|"twin-linked"|... ]} (ARRAY)\n` +
  `  damage-reduction {reduction:int} ; objective-control-modifier {operation,value}|{sticky:true}\n` +
  `  ability-grant {ability_id:"kebab"}|{grant_type:"..."} ; attack-restriction {restriction:"..."}\n` +
  `  cp-gain|cp-refund {amount:int} ; resurrection {count:int|"D3"} ; model-destruction {count:int}\n` +
  `  resource-gain|resource-spend {pool_id:"...", amount:int|"D3"} — faction resources: Miracle Dice→"miracle-dice-pool", Khorne Blessings→"blessings-of-khorne-pool", Pain tokens→"pain-token-pool"\n` +
  `  movement-modifier {move_type,value} ; deep-strike/fallback-and-act/fight-first/fight-last/shoot-on-death/fight-on-death → modifier {}\n\n` +
  `attack_type — "melee"|"ranged" if the rule limits to that attack kind, else "any". (Do NOT encode this as a condition.)\n` +
  `condition_kind — DEFAULT "none". Only set if the rule EXPLICITLY restricts: "phase" (+condition_param = phase name), "vs-keyword" (+param=keyword), ` +
  `"charged", "stationary", "below-half", "below-starting", "attached", "leading". Do NOT add a phase condition just because the ability operates in a phase. ` +
  `If the rule needs a compound/event trigger (e.g. a dice roll, an either/or choice, or "when a friendly VEHICLE is destroyed within 12\\"") set complex=true.\n` +
  `scope_range — EXACTLY one of "self"|"unit"|"attached"|"aura-6"|"aura-9"|"aura-12"|"aura-custom"|"engagement-range"|"any-visible"|"any-on-battlefield"|"terrain-within-range" (a distance from the bearer; NEVER a target like "all-friendly"/"friendly-within-aura"). For an army-wide detachment/faction buff ("all friendly X units"), use "unit". scope_duration — "phase"|"turn"|"battle-round"|"battle"|"until-next-command-phase"|"until-next-battle-round"|"until-start-next-turn"|"one-use"|"permanent".\n` +
  `target — "self"|"unit"|"friendly-within-aura"|"enemy-within-aura"|"attacker"|"defender"|... (only values from the schema enum).\n` +
  `Never copy rule text into any field. Give confidence and a one-sentence reasoning.`;

export const VERIFY_SYSTEM =
  `You judge whether authored DSL faithfully captures a 40k rule. The DSL includes scope {range,duration} — credit the aura/range/duration when it is in scope (do NOT flag "missing 6\\" aura" if scope.range is "aura-6"). ` +
  `Be strict about the core mechanic: wrong effect type, wrong stat/roll, wrong value, a condition the rule does NOT state (phantom), a stated condition that is missing, or modeling a Leadership/Battle-shock re-roll as a combat re-roll. ` +
  `severity "ok" = every stated mechanic, condition, usage/timing gate, target restriction, attack subtype, and scope detail is represented; "minor" = core correct but any secondary stated detail is imperfect; "wrong" = core mechanic wrong. Set faithful=true ONLY with severity "ok"; any omitted or imperfect stated detail requires faithful=false. Return one verdict per ability, echoing its ability_id.`;

const CLASSIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { results: { type: "array", items: {
    type: "object", additionalProperties: false,
    properties: {
      ability_id: { type: "string" }, effect_type: { type: "string" }, target: { type: "string" },
      modifier: { type: "object", additionalProperties: true }, attack_type: { enum: ["any", "melee", "ranged"] },
      condition_kind: { enum: ["none", "phase", "vs-keyword", "charged", "stationary", "below-half", "below-starting", "attached", "leading"] },
      condition_param: { type: ["string", "null"] }, scope_range: { type: "string" }, scope_duration: { type: "string" },
      complex: { type: "boolean" }, confidence: { enum: ["high", "medium", "low"] }, reasoning: { type: "string" },
    },
    required: ["ability_id", "effect_type", "target", "modifier", "attack_type", "condition_kind", "scope_range", "scope_duration", "complex", "confidence", "reasoning"],
  } } },
  required: ["results"],
};

export const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { results: { type: "array", items: {
    type: "object", additionalProperties: false,
    properties: { ability_id: { type: "string" }, severity: { enum: ["ok", "minor", "wrong"] }, faithful: { type: "boolean" }, issue: { type: "string" } },
    required: ["ability_id", "severity", "faithful", "issue"],
  } } },
  required: ["results"],
};

// ─── full-tree repair prompts + schema ───────────────────────────────
//
// The flat-form classifier (above) emits a single condition + flat leaf, so it
// structurally CANNOT express compound conditions, event triggers, or nested
// effect kinds — every such rule lands in the proposed/ residue with a verifier
// `issue` naming the gap. The repair pass hands the model the FULL DSL grammar
// and asks it to emit the complete nested effect tree, seeded with the existing
// draft + that exact gap. The envelope schema below is intentionally loose (just
// `effect`/`scope` objects); the real gate is AJV against ability.schema, exactly
// as the flat-form path validates `buildEntry` output.

export const REPAIR_SYSTEM =
  `You repair Warhammer 40k ability DSL. You are given a rule and a DRAFT ability that an earlier pass produced. Emit the COMPLETE ability mechanics that fix the verifier's exact gap. The effect tree and scope are required. Return trigger, usage, and applies_to when the rule needs them; use null only to remove a stale draft field. Never copy rule text into any field.\n\n` +
  `An effect node is ONE of:\n` +
  `  • a leaf: {type, target, modifier} — type ∈ [stat-modifier, roll-modifier, re-roll, mortal-wounds, feel-no-pain, invulnerable-save, ward, keyword-grant, movement-modifier, deep-strike, fallback-and-act, fight-first, fight-last, shoot-on-death, fight-on-death, objective-control-modifier, leadership-modifier, damage-reduction, attack-restriction, ability-grant, cp-gain, cp-refund, model-destruction, resurrection, resource-gain, resource-spend, charge-roll-modifier, terrain-area-tag, bs-modifier, engagement-passthrough, detection-range-modifier, hazard-rolls]; target ∈ [self, bearer, unit, attached-unit, attacker, defender, friendly-within-aura, enemy-within-aura, all-friendly, all-enemy]\n` +
  `  • conditional: {type:"conditional", condition, effect}\n` +
  `  • sequence: {type:"sequence", steps:[effect, ...]} — multiple effects that all apply\n` +
  `  • rules-bundle: {type:"rules-bundle", steps:[effect, ...]} — the complete reusable effect set of the containing named ability; grant it elsewhere with ability-grant.modifier {ability_id, rules_bundle:true}\n` +
  `  • choice: {type:"choice", options:[effect, ...], choice_label?} — pick exactly one\n` +
  `  • select-units: {type:"select-units", selector:{owner:"friendly"|"enemy", target_kind?:"unit"|"model", count:1, keywords?:[...], range_inches?:number, visibility_required?:boolean, engagement_relation?:"any"|"engaged-with-bearer"|"not-engaged-with-bearer", eligibility?:condition}, effect} — use this wrapper whenever the rule selects exactly one eligible unit or model; target_kind defaults to "unit", while target_kind:"model" binds nested target:"unit" effects to that selected model; count:1 enforces the one-target binding\n` +
  `  • for-each-unit: {type:"for-each-unit", selector:{owner:"friendly"|"enemy", keywords?:[...], within_inches?:number}, effect} — independently resolve the effect once for every matching unit; keywords are all required\n` +
  `  • dice-gated: {type:"dice-gated", dice:"D6"|..., threshold:int, comparison?:"gte"|"lte"|"gt"|"lt"|"eq", on_success:effect, on_fail?:effect}\n` +
  `  • dice-table: {type:"dice-table", dice:"D3"|"D6", outcomes:[{results:[1,...], effect}, ...]} — one closed die whose outcome rows cover every face exactly once; use this instead of nested dice-gated effects when each face has a different result\n` +
  `  • dice-pool-allocation: {type:"dice-pool-allocation", pool:{count,die}, max_activations:int, options:[{name, requirement:{type:"pair"|"triple"|"single"|"run",min_value:1..6}, effect}, ...]} — ONLY for allocating an already-rolled dice pool by pair/triple/single/run requirements; never use it for an ordinary D6 outcome table\n\n` +
  `A condition is ONE of:\n` +
  `  • simple: {type, parameters:{...}} — ALL params go UNDER "parameters", never as top-level keys (e.g. {"type":"unit-has-keyword","parameters":{"keyword":"VEHICLE"}}, NOT {"type":"unit-has-keyword","keyword":"VEHICLE"}). type ∈ [phase-is{phase}, timing-is{timing}, player-turn-is{turn}, unit-below-starting-strength, unit-below-half-strength, unit-has-keyword{keyword}, unit-model-count{keyword,count_min}, uniform-ranged-loadout{model_keyword?}, all-attacks-target-same-unit{attack_type?}, unit-within-range-of{target_type}, model-is-leader, target-has-keyword{keyword}, charged-this-turn, advanced-this-turn, remained-stationary, is-battle-shocked, has-lost-wounds, was-hit-by-attack{subject?:"self"|"target",attack_type?,weapon_name?,count_min?}, opponent-unit-within-range, within-range-of-objective, attack-is-type{attack_type}, has-fought-this-phase, destroyed-by-attack-type{attack_type}, controls-objective, is-attached, terrain-area-control, engagement-state, territory-control, fights-first, disposition-matches, units-destroyed{side,window,count_min}, units-destroyed-comparison, objective-majority, attack-stat-compare{attacker_stat,comparison:"greater-than"|"less-than"|"greater-or-equal"|"less-or-equal"|"equal",target_stat} (e.g. attack S greater than unit T), made-ingress-move-this-turn]\n` +
  `  • compound: {operator:"and"|"or"|"not", operands:[condition, ...]} — use "not" with ONE operand to negate (e.g. "while not Battle-shocked" → {operator:"not", operands:[{type:"is-battle-shocked"}]}). Nest compounds freely.\n\n` +
  `Encode reactive/event timing with the ability-level trigger when the event vocabulary below has an exact match. Put compound runtime guards in trigger.condition. If no exact event exists, keep the timing as a conditional effect rather than inventing an event. Encode frequency with ability-level usage; do not invent timing condition strings for frequency.\n` +
  `scope = {range, duration}: range ∈ [self, unit, attached, aura-6, aura-9, aura-12, aura-custom, engagement-range, any-visible, any-on-battlefield, terrain-within-range] — this is the COMPLETE list. range is a distance from the bearer and is NEVER a target value: do NOT put "all-friendly"/"friendly-within-aura"/"all-enemy" here (those are effect targets). For an army-wide detachment/faction buff ("all friendly X units"), use range "unit" and express the audience via the effect target / applies_to keywords. duration ∈ [phase, turn, battle-round, battle, until-next-command-phase, until-next-movement-phase, until-next-battle-round, until-start-next-turn, one-use, permanent, attack-sequence, resolution]. Use until-start-next-turn exactly when the rule says "until the start of your next turn"; that is not equivalent to battle-round or until-next-command-phase.\n` +
  `Ability-level trigger is an EVENT OBJECT, never a condition: {event, subject, proximity?:{of,range}, move_types?:["normal"|"advance"|"fall-back"|"charge"], condition?:condition, optional?:boolean, cost?:{cp}, window?:string, binds_event_variable?:string}. event MUST be one of [start-of-phase,end-of-phase,start-of-turn,end-of-turn,stratagem-targeted,ability-target-selected,start-of-opponent-turn,end-of-opponent-turn,start-of-battle-round,start-of-command-phase,declare-battle-formations,post-deployment,unit-set-up,set-up-from-reserves,arrives-from-strategic-reserves,starts-in-strategic-reserves,game-start-in-reserves,deep-strike-setup,reinforcements,normal-move,advance-move,advances,fall-back-move,falls-back,charge-move,end-of-charge-move,charge-declaration,moved-through-terrain,moved-through-tall-terrain,enemy-unit-ended-move,enemy-unit-fell-back,before-hit-roll,after-hit-roll,before-wound-roll,after-wound-roll,before-save-roll,after-save-roll,before-damage-roll,after-damage-roll,before-charge-roll,after-charge-roll,before-advance-roll,after-advance-roll,before-battle-shock,after-battle-shock,on-unit-selected,selected-to-shoot,selected-to-fight,selected-to-advance,after-unit-resolves-attacks,after-scoring-hit,after-enemy-unit-fires,on-unit-destroyed,on-model-destroyed,first-model-destroyed,before-bearer-removed,enemy-unit-destroyed-in-melee,on-damage-allocated,battle-shock-test,leadership-test,desperate-escape-test]. subject MUST be self|bearer|friendly-unit|enemy-unit|any-unit|model-in-bearer. If no canonical event exactly fits, omit trigger and keep the timing as a condition; NEVER put {type,parameters} or {operator,operands} in trigger. usage = {frequency:"once-per-turn"|"once-per-phase"|"once-per-battle-round"|"once-per-command-phase"|"once-per-opponent-turn"|"n-per-battle"|"first-this-battle"|"first-time-this-phase", count?:int, per?:"army"|"unit"|"model"}. There is no once-per-battle frequency: use n-per-battle with count:1. applies_to = {required_keywords?:[...], excluded_keywords?:[...]} for static bearer/datasheet eligibility such as "WARBOSS model only". Do not duplicate a trigger as a timing condition when trigger expresses it exactly.\n` +
  `behavior ∈ [passive, activated, reactive, aura].\n\n` +
  `CANONICAL MODIFIER KEYS — use ONLY the keys listed per type; never invent a key (an unknown key is silently ignored by consumers and corrupts the data):\n` +
  `  stat-modifier.modifier: {stat, operation:"add"|"subtract"|"set", value:int}. stat ∈ [A,S,T,Sv,AP,OC,Ld,M,W,D] ONLY (use "M" for Move, never "Move"/"range"; weapon range is NOT a unit stat). operation:"set" IS allowed for "characteristic of N" rules (e.g. OC of 9). Optional narrowing: attack_type:"melee"|"ranged", weapon_type:"melee"|"ranged", weapon_name:"<weapon>" for a single named weapon, or weapon_keyword:"<ability>" to restrict to weapons with a keyword like "Torrent"/"Blast"/"Pistol". Do NOT use weapon_filter/model_filter.\n` +
  `  roll-modifier.modifier: {roll:"hit"|"wound"|"save"|"charge"|"damage", operation, value}. re-roll.modifier: {roll:"hit"|"wound"|"save"|"charge"|"damage"|"advance"|"surge"|"normal-move-distance", subset:"ones"|"all-failures"} for pass/fail dice, or {roll, result_scope:"any-result"} when the player can re-roll any result (for example an Advance, Surge, or Normal move distance roll). Optional attack_type/weapon_type/weapon_name/weapon_keyword as above.\n` +
  `  keyword-grant.modifier: {keywords:[...]} (array) — combat keywords as written ("Lethal Hits","Sustained Hits 1","Twin-linked"). Optional weapon_type:"melee"|"ranged", weapon_name, weapon_keyword.\n` +
  `  feel-no-pain.modifier:{threshold:int}; damage-reduction.modifier:{reduction:int}; bs-modifier.modifier:{operation,value}; detection-range-modifier.modifier:{operation:"add"|"subtract",value:int}; hazard-rolls.modifier:{engaged_keyword,additional_per_engaged_unit,roll_modifier_if_battle_shocked?}; model-destruction.modifier:{count?:int|dice-expression,model_keyword?:string}; mortal-wounds.modifier may use {dice,per_model:"this"|"target",model_relation?:"engaged-with-target",comparison,threshold,mortal_per_success}; remove-battle-shock has target and no modifier; ability-grant.modifier:{grant_type:"kebab-label",enabled?:boolean} or {ability_id:"entity-id",rules_bundle:true,enabled?:boolean}; use the latter to grant or disable a named reusable rule such as riled-up. objective-control-modifier.modifier:{operation:"add"|"set",value} or {sticky:true}; movement-modifier.modifier uses ONLY {move_type?:"normal"|"advance"|"pile-in"|"consolidation"|"reactive"|"surge"|"redeploy"|"scout"|"infiltrate"|"shoot-and-scoot", distance?:int|dice-expression, passthrough?:["non-titanic-models"|"friendly-vehicles"|"friendly-monsters"|"terrain-le-4"|"tall-terrain"|"all-terrain"], vertical_limit?:int, ignore_vertical?:boolean, replaces_default?:boolean, to_reserves?:boolean, applies_to_moves?:["normal"|"advance"|"fall-back"|"charge"]}. Use distance, NEVER value. deep-strike.modifier:{} (parameterless).\n` +
  `  SCALING ("X per N models/units"): add a sibling \`scaling\`:{per:int, of:"enemy-models-in-range"|"friendly-models-in-range"|"models-in-bearer-unit"|"models-in-or-embarked-in-bearer"|"enemy-units-in-range"|"wounds-lost", within_inches?:int, round?:"down"|"up"} to the leaf and set modifier.value to the PER-INCREMENT amount (e.g. "+2 A per 5 enemy models within 6\\"" → {type:"stat-modifier",...,modifier:{stat:"A",operation:"add",value:2,attack_type:"melee"},scaling:{per:5,of:"enemy-models-in-range",within_inches:6}}). Do NOT flatten the scaling away.\n\n` +
  `dice-gated.comparison ∈ ["gte","lte","gt","lt","eq"] (use "gte" for "on a 2+"). dice e.g. "D6","2D6"; threshold int. on_success/on_fail are effect nodes.\n` +
  `ENCODING THE RESIDUE — these ARE expressible, do not punt on them:\n` +
  `  • "roll a D6, on 2+ <effect>" → dice-gated {dice:"D6", threshold:2, comparison:"gte", on_success:<effect>}.\n` +
  `  • "select one of N abilities/effects" → choice {options:[<effect>,...]}.\n` +
  `  • "re-roll Battle-shock/Leadership tests" → leadership-modifier {test:"battle-shock", operation:"re-roll"} (NOT a combat re-roll).\n` +
  `  • deployment/redeploy ("set up in Strategic Reserves", "set up anywhere >9\\"", "redeploy after deployment") → deep-strike, or ability-grant {grant_type:"<descriptive-kebab>"} for a named deployment rule.\n` +
  `  • "move through terrain" → movement-modifier {target, modifier:{passthrough:["all-terrain"]}}; "move through non-Titanic models" → {passthrough:["non-titanic-models"]}. Do not invent a move_type for traversal permissions.\n` +
  `  • "characteristic of N" → the matching stat/OC modifier with operation:"set".\n` +
  `  • "when/if this unit WAS HIT by one or more attacks" → was-hit-by-attack {subject:"self"} (NOT has-lost-wounds — a hit that is saved still counts). "if an enemy unit was hit by [the bearer's] attacks" (offensive follow-up like grav-pinning) → was-hit-by-attack {subject:"target"}; narrow with attack_type/weapon_name when the rule names the weapon.\n\n` +
  `FIDELITY EXTENSIONS (all fields below are schema-backed; do not replace them with invented modifier keys):\n` +
  `  for-each-unit.selector {owner:"friendly", target_kind:"model", member_of:"bearer-unit", keywords:[...]} filters EACH individual model in the bearer's current unit. Attached-unit keyword unions cannot qualify a Leader that lacks the model keyword. Nested target:"unit" binds to the selected model.\n` +
  `  select-units.selector.reference:"bearer"|"bearer-unit" defines the range/engagement origin. selector.selection_limit:{count,period:"turn"|"phase"|"battle-round"|"battle"} limits EACH selected target across ALL bearers in the army, separately from ability usage.\n` +
  `  A real Leadership test is dice-gated {dice:"2D6",threshold:"leadership",comparison:"gte",test:{kind:"leadership",subject:"unit"|"self"},on_success}. This uses current Leadership and test modifiers/permissions, not a fixed 6 and not Battle-shock. Use {type:"no-effect"} for a no-result dice-table band.\n` +
  `  trigger event:"stratagem-targeted" binds the current use. stratagem-cost-modifier.modifier {operation:"decrease",amount:1,applies_to:"triggering-stratagem-use"} reduces cost before payment (floor 0); it is neither a refund nor set-to-zero. set-to requires set_to. A separate stratagem-targeting-permission {exception:"already-targeted-different-unit-this-phase",stratagem:<id>} grants ONLY the named repeated-use exception.\n` +
  `  trigger event:"ability-target-selected" carries source_ability:{ability_id,owner,keywords}. subject identifies the selected target; source_ability filters the ability and unit that selected it. These are different actors. trigger.proximity.of:"bearer-unit" measures from the bearer's unit.\n` +
  `  unit-within-range-of parameters:{target_type:"friendly-keyword"|"enemy-keyword",keywords:[...],range:<inches>|"engagement",subject:"self"|"unit"|"triggering-unit"} tests all keywords on the SAME nearby unit. within-range-of-objective parameters:{subject:"target"|"unit",controlled_by?:"your-army"|"opponent"} binds range and control to the SAME marker. target-is-visible means visible to the individual attacking model.\n` +
  `  designate-target.select.eligibility can require a hit in the bound triggering attack sequence. applies.attacker_keywords filters individual attacking MODEL keywords, only with to:"attackers-of-target". movement-modifier.after_move is an effect node resolved ONLY if the move is actually made; declining the move never applies its follow-up.\n` +
  `  objective-control-modifier.modifier {sticky:true,retake:"opponent-control-greater-at-phase-end"} retains a marker until the opponent's Level of Control exceeds yours at a phase end. re-roll.modifier.optional:false makes the re-roll mandatory; result_scope:"any-result" is a full re-roll including successful results.\n` +
  `  named-region-state.modifier.producer.additive_extensions can use kind:"unit-proximity",radius_inches,activation:{event:"continuous"},source_gate:{gate_ref,owner:"owner-army",unit_predicate:{faction,keywords}}. This is a continuously updated union of unit-centred areas, not an objective extension. consumer.attack_condition gates BOTH default and qualified effects, not region production. Qualified conditions may compose keyword OR whole-unit region membership. Reuse the current full named-region schema and Power Matrix/Flow of Magic patterns.\n` +
  `  scope.duration:"attack-sequence" expires after the currently selected unit finishes its attacks. "resolution" is this activation only, not once per battle. Do not put army-wide audience predicates in applies_to (reserved for static bearer eligibility).\n` +
  `Set unencodable:true when ANY material claim has no faithful current-schema representation, including in-battle mechanics. Such proposals are blocked from application; record the precise gap in reasoning, never in community_notes. Do not force the rule into a neighboring effect or invent a grant. Give confidence and one-sentence reasoning.`;

export const REPAIR_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { results: { type: "array", items: {
    type: "object", additionalProperties: false,
    properties: {
      ability_id: { type: "string" },
      effect: { type: "object", additionalProperties: true },
      scope: { type: "object", additionalProperties: true },
      behavior: { type: "string" },
      trigger: { oneOf: [{ type: "object", additionalProperties: true }, { type: "array", items: { type: "object", additionalProperties: true } }, { type: "null" }] },
      usage: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      applies_to: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      unencodable: { type: "boolean" },
      confidence: { enum: ["high", "medium", "low"] },
      reasoning: { type: "string" },
    },
    required: ["ability_id", "effect", "scope", "behavior", "unencodable", "confidence", "reasoning"],
  } } },
  required: ["results"],
};

// ─── assembly (pure TS, no LLM) ──────────────────────────────────────

export function conditionNode(kind: string, param: string | null | undefined): Json | null {
  switch (kind) {
    case "phase": return { type: "phase-is", parameters: { phase: param } };
    case "vs-keyword": return { type: "target-has-keyword", parameters: { keyword: param } };
    case "charged": return { type: "charged-this-turn" };
    case "stationary": return { type: "remained-stationary" };
    case "below-half": return { type: "unit-below-half-strength" };
    case "below-starting": return { type: "unit-below-starting-strength" };
    case "attached": return { type: "is-attached" };
    case "leading": return { type: "model-is-leader" };
    default: return null;
  }
}

/** Build the effect node + scope from a flat-form. */
export function assembleEffect(form: Json): { effect: Json; scope: Json } {
  const modifier = PARAMETERLESS.has(form.effect_type) ? {} : { ...(form.modifier ?? {}) };
  if (form.attack_type && form.attack_type !== "any" && ["stat-modifier", "roll-modifier", "re-roll"].includes(form.effect_type)) {
    modifier.attack_type = form.attack_type;
  }
  let effect: Json = { type: form.effect_type, target: form.target, modifier };
  const cond = conditionNode(form.condition_kind, form.condition_param);
  if (cond) effect = { type: "conditional", condition: cond, effect };
  return { effect, scope: { range: form.scope_range, duration: form.scope_duration } };
}

function authoringNote(entry: Json): string {
  const isNonProvisional11e = entry.game_version?.edition === "11th"
    && entry.game_version?.dataslate !== "pre-launch-provisional";
  return isNonProvisional11e
    ? "community-authored from 11e source"
    : "community-authored from 10e source (provisional 11e); see #21";
}

/** Splice the authored effect+scope onto the original entry, preserving metadata. */
export function buildEntry(original: Json, form: Json): Json {
  const { effect, scope } = assembleEffect(form);
  return { ...original, effect, scope, community_notes: authoringNote(original) };
}

const BEHAVIOR_VALUES = new Set(["passive", "activated", "reactive", "aura"]);

// ─── canonical-key lint ──────────────────────────────────────────────
//
// The full-tree repair model emits the whole effect node, including the open
// `modifier` object. AJV permits any modifier key (additionalProperties:true),
// so an invented key (`weapon_keyword`, `model_filter`, `critical_threshold`)
// passes schema validation — but the cruncher reads ONLY the canonical keys, so
// an ignored filter on an `add` operation silently OVER-APPLIES the buff. The
// verifier can't catch this: it judges the JSON against the rule as a reader,
// not against what the engine honors. This lint is the deterministic gate.
//
// Vocabulary is calibrated to what EXISTING enrichment data actually uses (not
// world-eaters alone): `keywords` array is the dominant keyword-grant form,
// `damage-reduction` uses `reduction`, and `stat` spans the full statline. The
// lint only runs on NEW repair proposals, so strictness can't regress shipped
// data — a rejected proposal just stays residue for hand-authoring.

/** Modifier keys the cruncher / canonical conventions recognise, per leaf type. */
const CANONICAL_MODIFIER_KEYS: Record<string, Set<string>> = {
  // weapon_type/weapon_name are valid narrowing keys (gold uses weapon_name): the
  // cruncher honors weapon_type as a phase gate and fail-safes (unsupported) on
  // weapon_name, so the data can carry them without risking a silent over-apply.
  "stat-modifier": new Set(["stat", "operation", "value", "attack_type", "weapon_type", "weapon_name", "weapon_keyword"]),
  "roll-modifier": new Set(["roll", "operation", "value", "attack_type", "weapon_type", "weapon_name", "weapon_keyword", "critical_on", "uses", "context"]),
  "re-roll": new Set(["roll", "subset", "result_scope", "attack_type", "weapon_type", "weapon_name", "weapon_keyword", "max_rerolls", "uses", "context", "optional"]),
  "keyword-grant": new Set(["keyword", "keywords", "weapon_type", "weapon_name", "weapon_keyword"]),
  "bs-modifier": new Set(["operation", "value", "attack_type"]),
  "feel-no-pain": new Set(["threshold"]),
  "damage-reduction": new Set(["reduction", "amount"]),
};
const CANONICAL_STATS = new Set(["A", "S", "T", "Sv", "AP", "OC", "Ld", "M", "W", "D", "Damage", "BS", "WS"]);
const CANONICAL_ROLLS = new Set([
  "hit",
  "wound",
  "save",
  "charge",
  "damage",
  "advance",
  "surge",
  "normal-move-distance",
  "any",
  "all",
]);
const CANONICAL_SUBSETS = new Set(["ones", "all-failures"]);
const CANONICAL_RESULT_SCOPES = new Set(["any-result"]);
const CANONICAL_ATTACK_TYPES = new Set(["melee", "ranged"]);
const CANONICAL_PHASES = new Set(["command", "movement", "shooting", "charge", "fight"]);
const CANONICAL_PLAYER_TURNS = new Set(["your", "your-turn", "own", "opponent", "opponent-turn"]);
const CANONICAL_CONDITION_CHILD_KEYS = new Set([
  "condition",
  "eligibility",
  "attack_condition",
  "qualified_condition",
  "requires",
]);

/**
 * Walk an effect tree and flag any cruncher-interpreted leaf whose modifier
 * carries an unknown key or an out-of-vocabulary stat/roll/subset/attack_type.
 * Non-interpreted leaf types (ability-grant, movement-modifier, …) are left
 * permissive — they don't reach the damage path, so an unknown key there is a
 * consistency nit, not a silent-corruption risk.
 */
export function lintCanonical(effect: Json): { canonical: boolean; issues: string[] } {
  const issues: string[] = [];
  // A simple condition is {type, parameters?, negated?}; every param lives UNDER
  // `parameters`. The cruncher reads condition.parameters.* only, and AJV doesn't
  // forbid stray top-level keys, so a param placed top-level (e.g.
  // {type:"unit-has-keyword", keyword:"X"}) silently makes the condition
  // unevaluatable — the buff never fires. Existing data is 680 nested / 0 top-level.
  const visitCondition = (c: Json): void => {
    if (!c || typeof c !== "object") return;
    if (Array.isArray(c)) {
      c.forEach(visitCondition);
      return;
    }
    if (Array.isArray(c.operands)) return c.operands.forEach(visitCondition); // compound {operator, operands}
    if (typeof c.type === "string") {
      for (const k of Object.keys(c)) if (k !== "type" && k !== "parameters" && k !== "negated") issues.push(`condition ${c.type}: param "${k}" must live under "parameters"`);
      if (c.type === "phase-is" && !CANONICAL_PHASES.has(String(c.parameters?.phase))) {
        issues.push(`condition phase-is: unknown phase "${String(c.parameters?.phase)}"`);
      }
      if (c.type === "player-turn-is" && !CANONICAL_PLAYER_TURNS.has(String(c.parameters?.turn))) {
        issues.push(`condition player-turn-is: unknown turn "${String(c.parameters?.turn)}"`);
      }
    }
  };
  const visit = (node: Json): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const type = node.type as string | undefined;
    const allow = type ? CANONICAL_MODIFIER_KEYS[type] : undefined;
    if (allow && node.modifier && typeof node.modifier === "object") {
      const m = node.modifier as Record<string, unknown>;
      for (const k of Object.keys(m)) if (!allow.has(k)) issues.push(`${type}: non-canonical modifier key "${k}"`);
      if (type === "stat-modifier" && m.stat != null && !CANONICAL_STATS.has(String(m.stat))) issues.push(`stat-modifier: unknown stat "${String(m.stat)}"`);
      if ((type === "roll-modifier" || type === "re-roll") && m.roll != null && !CANONICAL_ROLLS.has(String(m.roll))) issues.push(`${type}: unknown roll "${String(m.roll)}"`);
      if (m.subset != null && !CANONICAL_SUBSETS.has(String(m.subset))) issues.push(`${type}: unknown subset "${String(m.subset)}"`);
      if (m.result_scope != null && !CANONICAL_RESULT_SCOPES.has(String(m.result_scope))) issues.push(`${type}: unknown result_scope "${String(m.result_scope)}"`);
      if (type === "re-roll" && (m.subset != null) === (m.result_scope != null)) {
        issues.push(`${type}: modifier must carry exactly one of subset or result_scope`);
      }
      if (m.attack_type != null && !CANONICAL_ATTACK_TYPES.has(String(m.attack_type))) issues.push(`${type}: unknown attack_type "${String(m.attack_type)}"`);
    }
    // Traverse every nested object rather than naming current wrapper fields.
    // The effect schema is intentionally extensible; a new wrapper must not
    // create an unchecked path to a cruncher-interpreted leaf.
    for (const [key, child] of Object.entries(node)) {
      if (CANONICAL_CONDITION_CHILD_KEYS.has(key)) visitCondition(child);
      visit(child);
    }
  };
  visit(effect);
  return { canonical: issues.length === 0, issues };
}

/**
 * Splice a pre-formed nested effect tree (from the repair pass) onto the original
 * entry. Unlike {@link buildEntry} the LLM owns the whole tree, so we only graft
 * `effect`/`scope`/`behavior` and the citation — never the flat-form assembly.
 * `behavior` is an ability-level field; only set it when the model returned a
 * valid enum value (an invalid one would just fail AJV and lose the whole entry).
 */
export function buildRepairedEntry(
  original: Json,
  effect: Json,
  scope: Json,
  behavior?: string,
  fields: { trigger?: Json | null; usage?: Json | null; applies_to?: Json | null } = {},
): Json {
  const entry: Json = { ...original, effect, scope, community_notes: authoringNote(original) };
  if (behavior && BEHAVIOR_VALUES.has(behavior)) entry.behavior = behavior;
  for (const key of ["trigger", "usage", "applies_to"] as const) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    if (fields[key] == null) delete entry[key];
    else entry[key] = fields[key];
  }
  return entry;
}

// ─── apply gate ──────────────────────────────────────────────────────

export interface GateOpts { minConfidence: "high" | "medium"; includeComplex: boolean }

/**
 * A verdict is gateable only when the verifier explicitly found the proposal
 * faithful with no omissions. The persisted summary must agree, but cannot
 * replace the verifier's detailed result.
 */
function isFaithfulVerdict(verdict: Proposal["verdict"]): boolean {
  if (!verdict || verdict.faithful !== true) return false;
  return verdict.severity === "ok";
}

/** Whether a proposal is safe to apply automatically. */
export function passesGate(p: Proposal, opts: GateOpts): boolean {
  if (!p.schema_valid || !p.final_faithful || !isFaithfulVerdict(p.verdict) || p.unencodable) return false;
  if (p.confidence === "low") return false;
  if (opts.minConfidence === "high" && p.confidence !== "high") return false;
  // A repaired proposal IS the full nested tree, so `complex` no longer means
  // "couldn't express it" — the AJV + verifier gate already proved it expresses
  // the rule faithfully. It must also clear the canonical-key lint so an invented
  // modifier key can't silently over-apply. The complex-exclusion only applies to
  // flat-form output.
  if (p.repaired) return p.canonical !== false;
  if (p.complex && !opts.includeComplex) return false;
  return true;
}

/** Default apply fills structural stubs; replacing authored effects requires --reauthor. */
export function canReplaceEffect(proposal: Proposal, effect: Json, opts: GateOpts & { reauthor: boolean }): boolean {
  return passesGate(proposal, opts) && (opts.reauthor || hasEmptyModifier(effect));
}

// ─── batching helpers ────────────────────────────────────────────────

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/**
 * Run `fn` over `items` with at most `limit` in flight. Items are independent
 * `claude -p` batches, so this collapses ~N sequential round-trips to N/limit.
 * `limit = 1` is exactly the old sequential behaviour. Tasks settle in completion
 * order; `fn` must place its own result (these callers push/index into a shared array).
 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

const classifyUserPrompt = (items: Json[]): string =>
  `Classify each ability below. Return results[] (one per ability, echo its ability_id):\n\n` +
  items.map((it) => `- ability_id: ${it.ability_id}\n  name: ${it.name}\n  rule: ${it.src?.description ?? "(none)"}`).join("\n");

export const verifyUserPrompt = (entries: { ability_id: string; rule: string; effect: Json; scope: Json; behavior?: string; trigger?: Json; usage?: Json; applies_to?: Json }[]): string =>
  `Judge each authored DSL against its rule. Return results[] (one per ability, echo its ability_id):\n\n` +
  entries.map((e) => `- ability_id: ${e.ability_id}\n  rule: ${e.rule}\n  authored: ${JSON.stringify({ effect: e.effect, scope: e.scope, behavior: e.behavior, trigger: e.trigger, usage: e.usage, applies_to: e.applies_to })}`).join("\n");

export const repairUserPrompt = (items: { ability_id: string; rule: string; draft: Json; issue: string }[]): string =>
  `Repair each ability's DSL. Emit the full effect tree + scope + behavior and any trigger, usage, or applies_to fields needed to fix the stated gap. Return results[] (one per ability, echo its ability_id):\n\n` +
  items.map((it) =>
    `- ability_id: ${it.ability_id}\n  rule: ${it.rule || "(none)"}\n  draft_ability: ${JSON.stringify(it.draft ?? null)}\n  gap_to_fix: ${it.issue || "(verifier produced no issue — re-author faithfully from the rule)"}`,
  ).join("\n\n");

// ─── propose ─────────────────────────────────────────────────────────

interface ProposeOpts { batch: number; model: string; fresh?: boolean; concurrency?: number; stubsOnly?: boolean }

async function proposeFaction(faction: string, opts: ProposeOpts, validate: (x: unknown) => boolean): Promise<Json> {
  const inputPath = resolve(INPUT_DIR, `${faction}.json`);
  if (!existsSync(inputPath)) return { faction, skipped: "no author-input" };
  const original = new Map<string, Json>();
  for (const a of readJSON(resolve(ENRICHMENT_ROOT, faction, "abilities.json")) as Json[]) original.set(a.ability_id, a);
  const input = readJSON(inputPath)
    .filter((e: Json) => e.resolved)
    .filter((e: Json) => !opts.stubsOnly || hasEmptyModifier(original.get(e.ability_id)?.effect));
  if (input.length === 0) return { faction, skipped: opts.stubsOnly ? "no resolved stubs" : "no resolved source rules" };
  // Resume: reuse prior proposals whose source rule is unchanged (skip errored ones so
  // they get retried). A checkpoint is written after every batch, so an interrupted run
  // loses at most the batch in flight. `--fresh` forces a full re-propose.
  const outPath = resolve(OUT_DIR, `${faction}.json`);
  mkdirSync(OUT_DIR, { recursive: true });
  const prior = new Map<string, Proposal>();
  if (!opts.fresh && existsSync(outPath)) for (const p of readJSON(outPath) as Proposal[]) prior.set(p.ability_id, p);

  const proposals: Proposal[] = [];
  const pending: Json[] = [];
  const hashById = new Map<string, string>();
  for (const it of input) {
    const h = srcHash(it.src?.description ?? "");
    hashById.set(it.ability_id, h);
    const prev = prior.get(it.ability_id);
    if (prev && !prev.error && prev.src_hash === h) proposals.push(prev);
    else pending.push(it);
  }
  const resumed = proposals.length;
  if (resumed > 0) process.stderr.write(`  ${faction}: resuming — ${resumed} kept, ${pending.length} to (re)propose\n`);
  const checkpoint = (): void => writeJSON(outPath, proposals);

  await mapLimit(chunk(pending, opts.batch), opts.concurrency ?? 1, async (batch) => {
    let forms: Json[];
    try {
      ({ results: forms } = await callClaude(CLASSIFY_SYSTEM, classifyUserPrompt(batch), CLASSIFY_SCHEMA, opts.model));
    } catch (e) {
      // One flaky call shouldn't sink the run — record the batch as errored and move on.
      process.stderr.write(`  ${faction}: classify batch failed (${(e as Error).message.slice(0, 80)}) — skipping ${batch.length}\n`);
      for (const it of batch) proposals.push({ ability_id: it.ability_id, name: it.name, faction, schema_valid: false, final_faithful: false, error: "classify call failed" });
      checkpoint();
      return;
    }
    const byId = new Map<string, Json>(forms.map((f: Json) => [f.ability_id, f]));

    const built: { it: Json; form: Json; entry: Json; schemaValid: boolean }[] = [];
    for (const it of batch) {
      const form = byId.get(it.ability_id);
      const orig = original.get(it.ability_id);
      if (!form || !orig) {
        proposals.push({ ability_id: it.ability_id, name: it.name, faction, schema_valid: false, final_faithful: false, error: !form ? "no classification" : "no original entry" });
        continue;
      }
      const entry = buildEntry(orig, form);
      built.push({ it, form, entry, schemaValid: validate(entry) });
    }

    const toVerify = built.filter((b) => b.schemaValid);
    const verdicts = new Map<string, Json>();
    if (toVerify.length > 0) {
      try {
        const { results } = await callClaude(VERIFY_SYSTEM,
          verifyUserPrompt(toVerify.map((b) => ({ ability_id: b.it.ability_id, rule: b.it.src?.description ?? "", effect: b.entry.effect, scope: b.entry.scope }))),
          VERIFY_SCHEMA, opts.model);
        for (const v of results) verdicts.set(v.ability_id, v);
      } catch (e) {
        // Verify failure → leave verdicts null (proposal kept, just not auto-gateable).
        process.stderr.write(`  ${faction}: verify batch failed (${(e as Error).message.slice(0, 80)})\n`);
      }
    }

    for (const b of built) {
      const verdict = verdicts.get(b.it.ability_id) ?? null;
      proposals.push({
        ability_id: b.it.ability_id, name: b.it.name, faction,
        effect_type: b.form.effect_type, complex: b.form.complex, confidence: b.form.confidence,
        schema_valid: b.schemaValid,
        proposed_effect: b.entry.effect,
        proposed_scope: b.entry.scope,
        verdict,
        final_faithful: b.schemaValid && isFaithfulVerdict(verdict),
      });
    }
    for (const p of proposals) if (p.src_hash == null) p.src_hash = hashById.get(p.ability_id);
    process.stderr.write(`  ${faction}: ${proposals.length}/${input.length}\n`);
    checkpoint();
  });

  checkpoint();
  return {
    faction, total: proposals.length,
    schema_valid: proposals.filter((p) => p.schema_valid).length,
    faithful: proposals.filter((p) => p.final_faithful).length,
    gateable: proposals.filter((p) => passesGate(p, { minConfidence: "medium", includeComplex: false })).length,
  };
}

// ─── repair (full-tree pass over the residue) ────────────────────────

interface RepairOpts { batch: number; model: string; types?: Set<string>; concurrency?: number }

/**
 * Re-author the complex residue in proposed/<faction>.json as full nested DSL.
 * Reuses the propose pipeline shape — classify(→repair)/assemble/AJV/verify —
 * but the model emits the whole effect tree and we seed it with the existing
 * draft + the verifier's gap. Updates the proposals in place (matched by
 * ability_id), tagging each `repaired:true`; the already-gateable and the errored
 * entries are left untouched.
 */
async function repairFaction(faction: string, opts: RepairOpts, validate: (x: unknown) => boolean): Promise<Json> {
  const proposalsPath = resolve(OUT_DIR, `${faction}.json`);
  if (!existsSync(proposalsPath)) return { faction, skipped: "no proposals — run propose first" };
  const proposals: Proposal[] = readJSON(proposalsPath);
  const gate = { minConfidence: "medium" as const, includeComplex: false };

  // Residue = not already auto-appliable, not a hard error. Phase A narrows to
  // the cruncher-relevant leaf types via --types.
  const targets = proposals
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => !passesGate(p, gate) && !p.error)
    .filter(({ p }) => !opts.types || (p.effect_type != null && opts.types.has(p.effect_type)));
  if (targets.length === 0) return { faction, skipped: "no matching residue" };

  // Source rules (the gap the draft must close) + originals (metadata + AJV).
  const inputPath = resolve(INPUT_DIR, `${faction}.json`);
  const srcById = new Map<string, string>();
  if (existsSync(inputPath)) for (const e of readJSON(inputPath) as Json[]) if (e.src?.description) srcById.set(e.ability_id, e.src.description);
  const original = new Map<string, Json>();
  for (const a of readJSON(resolve(ENRICHMENT_ROOT, faction, "abilities.json")) as Json[]) original.set(a.ability_id, a);

  let done = 0;
  await mapLimit(chunk(targets, opts.batch), opts.concurrency ?? 1, async (batch) => {
    let results: Json[];
    try {
      ({ results } = await callClaude(REPAIR_SYSTEM,
        repairUserPrompt(batch.map(({ p }) => {
          const orig = original.get(p.ability_id) ?? {};
          return {
            ability_id: p.ability_id,
            rule: srcById.get(p.ability_id) ?? "",
            draft: {
              effect: p.proposed_effect,
              scope: p.proposed_scope ?? orig.scope,
              behavior: p.proposed_behavior ?? orig.behavior,
              trigger: Object.prototype.hasOwnProperty.call(p, "proposed_trigger") ? p.proposed_trigger : orig.trigger,
              usage: Object.prototype.hasOwnProperty.call(p, "proposed_usage") ? p.proposed_usage : orig.usage,
              applies_to: Object.prototype.hasOwnProperty.call(p, "proposed_applies_to") ? p.proposed_applies_to : orig.applies_to,
            },
            issue: p.verdict?.issue ?? "",
          };
        })),
        REPAIR_SCHEMA, opts.model));
    } catch (e) {
      process.stderr.write(`  ${faction}: repair batch failed (${(e as Error).message.slice(0, 80)}) — skipping ${batch.length}\n`);
      return;
    }
    const byId = new Map<string, Json>(results.map((r: Json) => [r.ability_id, r]));

    const built: { idx: number; p: Proposal; r: Json; entry: Json; schemaValid: boolean; canonical: boolean }[] = [];
    for (const { p, idx } of batch) {
      const r = byId.get(p.ability_id);
      const orig = original.get(p.ability_id);
      if (!r || !orig) continue; // model dropped it / live entry gone — leave the proposal as-is
      const fields: { trigger?: Json | null; usage?: Json | null; applies_to?: Json | null } = {};
      for (const key of ["trigger", "usage", "applies_to"] as const) {
        if (Object.prototype.hasOwnProperty.call(r, key)) fields[key] = r[key];
      }
      const entry = buildRepairedEntry(orig, r.effect, r.scope, r.behavior, fields);
      built.push({ idx, p, r, entry, schemaValid: validate(entry), canonical: lintCanonical(r.effect).canonical });
    }

    // Verify only what can still pass the gate — a non-canonical entry can't, so
    // don't spend a verify call on it.
    const toVerify = built.filter((b) => b.schemaValid && b.canonical);
    const verdicts = new Map<string, Json>();
    if (toVerify.length > 0) {
      try {
        const { results: vs } = await callClaude(VERIFY_SYSTEM,
          verifyUserPrompt(toVerify.map((b) => ({
            ability_id: b.p.ability_id,
            rule: srcById.get(b.p.ability_id) ?? "",
            effect: b.entry.effect,
            scope: b.entry.scope,
            behavior: b.entry.behavior,
            trigger: b.entry.trigger,
            usage: b.entry.usage,
            applies_to: b.entry.applies_to,
          }))),
          VERIFY_SCHEMA, opts.model);
        for (const v of vs) verdicts.set(v.ability_id, v);
      } catch (e) {
        process.stderr.write(`  ${faction}: repair-verify batch failed (${(e as Error).message.slice(0, 80)})\n`);
      }
    }

    for (const b of built) {
      const verdict = verdicts.get(b.p.ability_id) ?? null;
      const behavior = b.r.behavior && BEHAVIOR_VALUES.has(b.r.behavior) ? b.r.behavior : undefined;
      proposals[b.idx] = {
        ...b.p,
        confidence: b.r.confidence ?? b.p.confidence,
        schema_valid: b.schemaValid,
        canonical: b.canonical,
        proposed_effect: b.entry.effect,
        proposed_scope: b.entry.scope,
        proposed_behavior: behavior,
        proposed_trigger: b.entry.trigger ?? null,
        proposed_usage: b.entry.usage ?? null,
        proposed_applies_to: b.entry.applies_to ?? null,
        verdict,
        final_faithful: b.schemaValid && b.canonical && isFaithfulVerdict(verdict),
        repaired: true,
        unencodable: !!b.r.unencodable,
      };
    }
    done += batch.length;
    process.stderr.write(`  ${faction}: repaired ${done}/${targets.length}\n`);
    writeJSON(proposalsPath, proposals); // checkpoint — partial repairs survive an interruption
  });

  writeJSON(proposalsPath, proposals);
  const repaired = proposals.filter((p) => p.repaired);
  return {
    faction, attempted: targets.length,
    now_faithful: repaired.filter((p) => p.final_faithful).length,
    non_canonical: repaired.filter((p) => p.canonical === false).length,
    unencodable: repaired.filter((p) => p.unencodable).length,
    gateable: proposals.filter((p) => passesGate(p, gate)).length,
  };
}

// ─── apply ───────────────────────────────────────────────────────────

interface ApplyOpts extends GateOpts { dryRun: boolean; reauthor: boolean }

/** Splice gated proposals into live abilities; authored entries require explicit reauthor mode. */
function applyFaction(faction: string, opts: ApplyOpts): Json {
  const proposalsPath = resolve(OUT_DIR, `${faction}.json`);
  if (!existsSync(proposalsPath)) return { faction, skipped: "no proposals — run propose first" };
  const proposals: Proposal[] = readJSON(proposalsPath);
  const abilitiesPath = resolve(ENRICHMENT_ROOT, faction, "abilities.json");
  if (!existsSync(abilitiesPath)) return { faction, skipped: "no live abilities.json" };
  const abilities: Json[] = readJSON(abilitiesPath);
  const byId = new Map<string, Json>(abilities.map((a) => [a.ability_id, a]));

  let applied = 0;
  const skipped: { id: string; why: string }[] = [];
  for (const p of proposals) {
    const entry = byId.get(p.ability_id);
    if (!entry) { skipped.push({ id: p.ability_id, why: "gone" }); continue; }
    if (!canReplaceEffect(p, entry.effect, opts)) {
      skipped.push({ id: p.ability_id, why: passesGate(p, opts) ? "not-a-stub" : "gate" });
      continue;
    }
    entry.effect = p.proposed_effect;
    entry.scope = p.proposed_scope;
    if (p.proposed_behavior && BEHAVIOR_VALUES.has(p.proposed_behavior)) entry.behavior = p.proposed_behavior;
    for (const [proposalKey, entryKey] of [
      ["proposed_trigger", "trigger"],
      ["proposed_usage", "usage"],
      ["proposed_applies_to", "applies_to"],
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(p, proposalKey)) continue;
      if (p[proposalKey] == null) delete entry[entryKey];
      else entry[entryKey] = p[proposalKey];
    }
    entry.community_notes = authoringNote(entry);
    applied++;
  }
  if (!opts.dryRun && applied > 0) writeJSON(abilitiesPath, abilities);
  return { faction, applied, skipped_gate: skipped.filter((s) => s.why === "gate").length, skipped_other: skipped.filter((s) => s.why !== "gate").length, dry_run: opts.dryRun };
}

// ─── review (cluster proposals into shape-families) ──────────────────

/** Load every faction's proposals (skips the ad-hoc damage-batch scratch file). */
function loadAllProposals(): Proposal[] {
  if (!existsSync(OUT_DIR)) return [];
  return readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".json") && f !== "damage-batch.json")
    .flatMap((f) => readJSON(resolve(OUT_DIR, f)) as Proposal[]);
}

/** Write a shape-family clustered REVIEW.md — gateable vs the complex residue, grouped for templating. */
function review(): Json {
  const all = loadAllProposals();
  const gate = { minConfidence: "medium" as const, includeComplex: false };
  const gateable = all.filter((p) => passesGate(p, gate));
  const residue = all.filter((p) => !passesGate(p, gate) && !p.error);

  const byType = (ps: Proposal[]): [string, number][] =>
    Object.entries(ps.reduce<Record<string, number>>((m, p) => ((m[p.effect_type ?? "?"] = (m[p.effect_type ?? "?"] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);

  // Cross-faction name dupes among the residue — author once, fan to all members.
  const byName = new Map<string, Proposal[]>();
  for (const p of residue) (byName.get(p.name) ?? byName.set(p.name, []).get(p.name)!).push(p);
  const shared = [...byName.entries()].filter(([, ps]) => new Set(ps.map((p) => p.faction)).size > 1)
    .map(([name, ps]) => ({ name, type: ps[0].effect_type, factions: [...new Set(ps.map((p) => p.faction))] }))
    .sort((a, b) => b.factions.length - a.factions.length);

  const L: string[] = [
    "# DSL stub authoring — review",
    "",
    `Generated by \`author-batch review\`. ${all.length} proposals across ${new Set(all.map((p) => p.faction)).size} factions.`,
    "",
    `- **schema-valid:** ${all.filter((p) => p.schema_valid).length}`,
    `- **verifier-faithful:** ${all.filter((p) => p.final_faithful).length}`,
    `- **complex-flagged:** ${all.filter((p) => p.complex).length}`,
    `- **auto-appliable (gate: valid+faithful+conf≠low+not-complex):** ${gateable.length}`,
    "",
    "## Auto-appliable now — by faction",
    "",
    ...Object.entries(gateable.reduce<Record<string, number>>((m, p) => ((m[p.faction] = (m[p.faction] ?? 0) + 1), m), {})).sort().map(([f, n]) => `- \`${f}\`: ${n}`),
    "",
    "Apply with: `npm run author:apply -- <faction|--all> --dry-run` then drop `--dry-run`.",
    "",
    "## Complex residue — by shape family (author a template per family)",
    "",
    ...byType(residue).map(([t, n]) => `- **${t}** — ${n}`),
    "",
    "## Cross-faction shared shapes (author once, fan to all members)",
    "",
    ...(shared.length ? shared.map((s) => `- **${s.name}** (\`${s.type}\`) → ${s.factions.join(", ")}`) : ["_(none found)_"]),
    "",
  ];
  writeFileSync(resolve(OUT_DIR, "REVIEW.md"), L.join("\n") + "\n");
  return { total: all.length, gateable: gateable.length, residue: residue.length, shared_shapes: shared.length };
}

// ─── main ────────────────────────────────────────────────────────────

function factionList(arg: string, dir: string): string[] {
  return arg === "--all"
    ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "damage-batch.json").map((f) => f.replace(/\.json$/, "")).sort()
    : [arg];
}
const flag = (argv: string[], name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const target = argv[1];
  if (mode === "review") {
    console.log(JSON.stringify(review(), null, 2));
    console.error(`\nWrote ${resolve(OUT_DIR, "REVIEW.md")}`);
    return;
  }
  if (!["propose", "repair", "apply"].includes(mode) || !target) {
    console.error("Usage:\n  author-batch propose <faction|--all> [--batch N] [--model M] [--concurrency N] [--fresh] [--stubs-only]\n  author-batch repair  <faction|--all> [--types t1,t2] [--batch N] [--model M] [--concurrency N]\n  author-batch apply   <faction|--all> [--min-confidence high|medium] [--include-complex] [--reauthor] [--dry-run]\n  author-batch review");
    process.exit(1);
  }

  if (mode === "propose") {
    const ajv = createValidator();
    const validateFn = ajv.getSchema(ABILITY_SCHEMA_ID);
    if (!validateFn) throw new Error(`ability schema not loaded: ${ABILITY_SCHEMA_ID}`);
    const validate = (x: unknown): boolean => !!validateFn(x);
    const opts: ProposeOpts = { batch: Number(flag(argv, "--batch")) || 15, model: flag(argv, "--model") ?? "claude-haiku-4-5", fresh: argv.includes("--fresh"), concurrency: Number(flag(argv, "--concurrency")) || 1, stubsOnly: argv.includes("--stubs-only") };
    const summary: Json[] = [];
    for (const f of factionList(target, INPUT_DIR)) {
      try {
        summary.push(await proposeFaction(f, opts, validate));
      } catch (e) {
        process.stderr.write(`  ${f}: FAILED (${(e as Error).message.slice(0, 100)})\n`);
        summary.push({ faction: f, error: (e as Error).message });
      }
    }
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (mode === "repair") {
    const ajv = createValidator();
    const validateFn = ajv.getSchema(ABILITY_SCHEMA_ID);
    if (!validateFn) throw new Error(`ability schema not loaded: ${ABILITY_SCHEMA_ID}`);
    const validate = (x: unknown): boolean => !!validateFn(x);
    const typesArg = flag(argv, "--types");
    const opts: RepairOpts = {
      batch: Number(flag(argv, "--batch")) || 8,
      model: flag(argv, "--model") ?? "claude-sonnet-4-6",
      types: typesArg ? new Set(typesArg.split(",").map((t) => t.trim()).filter(Boolean)) : undefined,
      concurrency: Number(flag(argv, "--concurrency")) || 1,
    };
    const summary: Json[] = [];
    for (const f of factionList(target, OUT_DIR)) {
      try {
        summary.push(await repairFaction(f, opts, validate));
      } catch (e) {
        process.stderr.write(`  ${f}: FAILED (${(e as Error).message.slice(0, 100)})\n`);
        summary.push({ faction: f, error: (e as Error).message });
      }
    }
    console.log(JSON.stringify(summary, null, 2));
    const unenc = summary.reduce((n, s) => n + (s.unencodable ?? 0), 0);
    const faithful = summary.reduce((n, s) => n + (s.now_faithful ?? 0), 0);
    const noncanon = summary.reduce((n, s) => n + (s.non_canonical ?? 0), 0);
    console.error(`\nrepair: ${faithful} now faithful, ${noncanon} non-canonical (gate-blocked), ${unenc} flagged unencodable (need hand-authoring).`);
    return;
  }

  // apply
  const opts: ApplyOpts = {
    minConfidence: flag(argv, "--min-confidence") === "high" ? "high" : "medium",
    includeComplex: argv.includes("--include-complex"),
    dryRun: argv.includes("--dry-run"),
    reauthor: argv.includes("--reauthor"),
  };
  const summary = factionList(target, OUT_DIR).map((f) => applyFaction(f, opts));
  console.log(JSON.stringify(summary, null, 2));
  const total = summary.reduce((n, s) => n + (s.applied ?? 0), 0);
  console.error(`\n${opts.dryRun ? "[dry-run] would apply" : "applied"} ${total} entr${total === 1 ? "y" : "ies"}.`);
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]).replace(/\.\w+$/, "") === fileURLToPath(import.meta.url).replace(/\.\w+$/, "");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
