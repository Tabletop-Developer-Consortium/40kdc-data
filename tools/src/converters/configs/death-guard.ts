import { registerFaction, type FactionConfig } from "../faction-config.js";

const deathGuard: FactionConfig = {
  sourceFactionId: "DG",
  factionId: "death-guard",
  factionName: "Death Guard",
  factionAbilityName: "Nurgle\u2019s Gift (Aura)",
  factionRuleId: "nurgles-gift",
  factionKeywords: ["Chaos", "Nurgle", "Death Guard"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "plague-marines": [
      { name: "Plague Champion", profile_name: "Plague Marine", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "plague-knives"], is_leader_model: true },
      { name: "Plague Marine", min: 4, max: 9, default_weapon_ids: ["boltgun", "plague-knives"], is_leader_model: false },
    ],
    "blightlord-terminators": [
      { name: "Blightlord Champion", profile_name: "Blightlord Terminator", min: 1, max: 1, default_weapon_ids: ["combi-bolter", "bubotic-blade"], is_leader_model: true },
      { name: "Blightlord Terminator", min: 2, max: 9, default_weapon_ids: ["combi-bolter", "bubotic-blade"], is_leader_model: false },
    ],
    "deathshroud-terminators": [
      { name: "Deathshroud Champion", profile_name: "Deathshroud Terminator", min: 1, max: 1, default_weapon_ids: ["plaguespurt-gauntlet", "manreaper-strike"], is_leader_model: true },
      { name: "Deathshroud Terminator", min: 2, max: 5, default_weapon_ids: ["plaguespurt-gauntlet", "manreaper-strike"], is_leader_model: false },
    ],
    "chaos-spawn": [
      { name: "Chaos Spawn", min: 2, max: 2, default_weapon_ids: ["hideous-mutations"], is_leader_model: false },
    ],
  },
};

registerFaction(deathGuard);

export default deathGuard;
