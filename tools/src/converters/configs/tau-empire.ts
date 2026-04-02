import { registerFaction, type FactionConfig } from "../faction-config.js";

const tauEmpire: FactionConfig = {
  sourceFactionId: "TAU",
  factionId: "tau-empire",
  factionName: "T\u2019au Empire",
  factionAbilityName: "For the Greater Good",
  factionRuleId: "for-the-greater-good",
  factionKeywords: ["T\u2019au Empire"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "breacher-team": [
      { name: "Fire Warrior Shas\u2019ui", profile_name: "Fire Warrior", min: 1, max: 1, default_weapon_ids: ["pulse-blaster", "pulse-pistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Fire Warrior", min: 9, max: 9, default_weapon_ids: ["pulse-blaster", "pulse-pistol", "close-combat-weapon"], is_leader_model: false },
    ],
    "strike-team": [
      { name: "Fire Warrior Shas\u2019ui", profile_name: "Fire Warrior", min: 1, max: 1, default_weapon_ids: ["pulse-pistol", "pulse-rifle", "close-combat-weapon"], is_leader_model: true },
      { name: "Fire Warrior", min: 9, max: 9, default_weapon_ids: ["pulse-pistol", "pulse-rifle", "close-combat-weapon"], is_leader_model: false },
    ],
    "pathfinder-team": [
      { name: "Pathfinder Shas\u2019ui", profile_name: "Pathfinder", min: 1, max: 1, default_weapon_ids: ["pulse-carbine", "close-combat-weapon"], is_leader_model: true },
      { name: "Pathfinder", min: 9, max: 9, default_weapon_ids: ["pulse-carbine", "close-combat-weapon"], is_leader_model: false },
    ],
    "kroot-carnivores": [
      { name: "Kroot Trail Shaper", profile_name: "Kroot Carnivore", min: 1, max: 1, default_weapon_ids: ["kroot-rifle", "close-combat-weapon"], is_leader_model: true },
      { name: "Kroot Carnivore", min: 9, max: 19, default_weapon_ids: ["kroot-rifle", "close-combat-weapon"], is_leader_model: false },
    ],
    "kroot-farstalkers": [
      { name: "Kill-Broker", profile_name: "Kroot Farstalker", min: 1, max: 1, default_weapon_ids: ["farstalker-firearm", "close-combat-weapon"], is_leader_model: true },
      { name: "Kroot Farstalker", min: 10, max: 10, default_weapon_ids: ["farstalker-firearm", "close-combat-weapon"], is_leader_model: false },
      { name: "Kroot Hound", min: 1, max: 1, default_weapon_ids: ["ripping-fangs"], is_leader_model: false },
    ],
    "stealth-battlesuits": [
      { name: "Stealth Shas\u2019vre", profile_name: "Stealth Battlesuit", min: 1, max: 1, default_weapon_ids: ["burst-cannon", "battlesuit-fists"], is_leader_model: true },
      { name: "Stealth Battlesuit", min: 4, max: 4, default_weapon_ids: ["burst-cannon", "battlesuit-fists"], is_leader_model: false },
    ],
    "vespid-stingwings": [
      { name: "Vespid Strain Leader", profile_name: "Vespid Stingwing", min: 1, max: 1, default_weapon_ids: ["neutron-blaster", "stingwing-claws"], is_leader_model: true },
      { name: "Vespid Stingwing", min: 4, max: 9, default_weapon_ids: ["neutron-blaster", "stingwing-claws"], is_leader_model: false },
    ],
  },
};

registerFaction(tauEmpire);

export default tauEmpire;
