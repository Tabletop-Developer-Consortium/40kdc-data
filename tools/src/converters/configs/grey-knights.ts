import { registerFaction, type FactionConfig } from "../faction-config.js";

const greyKnights: FactionConfig = {
  sourceFactionId: "GK",
  factionId: "grey-knights",
  factionName: "Grey Knights",
  factionAbilityName: "Gate of Infinity",
  factionRuleId: "gate-of-infinity",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Grey Knights"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "brotherhood-terminator-squad": [
      { name: "Justicar", profile_name: "Terminator", min: 1, max: 1, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: true },
      { name: "Terminator", min: 3, max: 9, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: false },
    ],
    "interceptor-squad": [
      { name: "Justicar", profile_name: "Interceptor", min: 1, max: 1, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: true },
      { name: "Interceptor", min: 4, max: 9, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: false },
    ],
    "paladin-squad": [
      { name: "Paragon", profile_name: "Paladin", min: 1, max: 1, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: true },
      { name: "Paladin", min: 3, max: 9, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: false },
    ],
    "purgation-squad": [
      { name: "Justicar", profile_name: "Purgator", min: 1, max: 1, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: true },
      { name: "Purgator", min: 4, max: 9, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: false },
    ],
    "purifier-squad": [
      { name: "Knight of the Flame", profile_name: "Purifier", min: 1, max: 1, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: true },
      { name: "Purifier", min: 4, max: 9, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: false },
    ],
    "strike-squad": [
      { name: "Justicar", profile_name: "Grey Knight", min: 1, max: 1, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: true },
      { name: "Grey Knight", min: 4, max: 9, default_weapon_ids: ["storm-bolter", "nemesis-force-weapon"], is_leader_model: false },
    ],
  },
};

registerFaction(greyKnights);

export default greyKnights;
