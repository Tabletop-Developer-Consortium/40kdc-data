import { registerFaction, type FactionConfig } from "../faction-config.js";

const tyranids: FactionConfig = {
  sourceFactionId: "TYR",
  factionId: "tyranids",
  factionName: "Tyranids",
  factionAbilityName: "Shadow in the Warp",
  factionRuleId: "shadow-in-the-warp",
  factionKeywords: ["Tyranids"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "hyperadapted-raveners": [
      { name: "Ravener Prime", min: 1, max: 1, default_weapon_ids: ["ravener-claws-and-talons"], is_leader_model: true },
      { name: "Ravener", profile_name: "Raveners", min: 4, max: 4, default_weapon_ids: ["ravener-claws-and-talons"], is_leader_model: false },
    ],
    "tyranid-warriors-with-melee-bio-weapons": [
      { name: "Tyranid Prime", profile_name: "Tyranid Warrior", min: 1, max: 1, default_weapon_ids: ["prime-talons"], is_leader_model: true },
      { name: "Tyranid Warrior", min: 2, max: 5, default_weapon_ids: ["dual-boneswords"], is_leader_model: false },
    ],
    "tyranid-warriors-with-ranged-bio-weapons": [
      { name: "Tyranid Prime", profile_name: "Tyranid Warrior", min: 1, max: 1, default_weapon_ids: ["devourer", "scything-talons"], is_leader_model: true },
      { name: "Tyranid Warrior", min: 2, max: 5, default_weapon_ids: ["devourer", "scything-talons"], is_leader_model: false },
    ],
  },
};

registerFaction(tyranids);

export default tyranids;
