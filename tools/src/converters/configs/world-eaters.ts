import { registerFaction, type FactionConfig } from "../faction-config.js";

const worldEaters: FactionConfig = {
  sourceFactionId: "WE",
  factionId: "world-eaters",
  factionName: "World Eaters",
  factionAbilityName: "Blessings of Khorne",
  factionRuleId: "blessings-of-khorne",
  factionKeywords: ["Chaos", "Khorne", "World Eaters"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "khorne-berzerkers": [
      { name: "Berzerker Champion", profile_name: "Khorne Berzerker", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "chainblade"], is_leader_model: true },
      { name: "Khorne Berzerker", min: 9, max: 19, default_weapon_ids: ["bolt-pistol", "chainblade"], is_leader_model: false },
    ],
    "jakhals": [
      { name: "Jakhal Pack Leader", profile_name: "Jakhal", min: 1, max: 1, default_weapon_ids: ["autopistol", "jakhal-chainblades"], is_leader_model: true },
      { name: "Dishonoured", profile_name: "Jakhal", min: 1, max: 2, default_weapon_ids: ["mauler-chainblade"], is_leader_model: false },
      { name: "Jakhal", min: 8, max: 17, default_weapon_ids: ["autopistol", "jakhal-chainblades"], is_leader_model: false },
    ],
    "eightbound": [
      { name: "Eightbound Champion", profile_name: "Eightbound", min: 1, max: 1, default_weapon_ids: ["chainblades"], is_leader_model: true },
      { name: "Eightbound", min: 2, max: 5, default_weapon_ids: ["chainblades"], is_leader_model: false },
    ],
    "exalted-eightbound": [
      { name: "Exalted Eightbound Champion", profile_name: "Exalted Eightbound", min: 1, max: 1, default_weapon_ids: ["chainblades"], is_leader_model: true },
      { name: "Exalted Eightbound", min: 2, max: 5, default_weapon_ids: ["chainblades"], is_leader_model: false },
    ],
    "chaos-terminators": [
      { name: "Terminator Champion", profile_name: "World Eaters Terminator", min: 1, max: 1, default_weapon_ids: ["combi-bolter", "accursed-weapon"], is_leader_model: true },
      { name: "Chaos Terminator", profile_name: "World Eaters Terminator", min: 4, max: 4, default_weapon_ids: ["combi-bolter", "accursed-weapon"], is_leader_model: false },
    ],
    "goremongers": [
      { name: "Goremonger Pack Leader", profile_name: "Goremongers", min: 1, max: 1, default_weapon_ids: ["autopistol", "chainblade", "close-combat-weapon"], is_leader_model: true },
      { name: "Goremonger", profile_name: "Goremongers", min: 7, max: 7, default_weapon_ids: ["autopistol", "chainblade", "close-combat-weapon"], is_leader_model: false },
    ],
    "chaos-spawn": [
      { name: "Chaos Spawn", min: 2, max: 2, default_weapon_ids: ["hideous-mutations"], is_leader_model: false },
    ],
  },
};

registerFaction(worldEaters);

export default worldEaters;
