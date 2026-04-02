import { registerFaction, type FactionConfig } from "../faction-config.js";

const aeldari: FactionConfig = {
  sourceFactionId: "AE",
  factionId: "aeldari",
  factionName: "Aeldari",
  factionAbilityName: "Strands of Fate",
  factionRuleId: "strands-of-fate",
  factionKeywords: ["Aeldari"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    // Aspect Warriors with Exarchs (from source data)
    "dire-avengers": [
      { name: "Dire Avenger Exarch", min: 1, max: 1, default_weapon_ids: ["avenger-shuriken-catapult", "close-combat-weapon"], is_leader_model: true },
      { name: "Dire Avenger", min: 4, max: 9, default_weapon_ids: ["avenger-shuriken-catapult", "close-combat-weapon"], is_leader_model: false },
    ],
    "howling-banshees": [
      { name: "Howling Banshee Exarch", min: 1, max: 1, default_weapon_ids: ["shuriken-pistol", "power-sword"], is_leader_model: true },
      { name: "Howling Banshee", min: 4, max: 9, default_weapon_ids: ["shuriken-pistol", "power-sword"], is_leader_model: false },
    ],
    "striking-scorpions": [
      { name: "Striking Scorpion Exarch", min: 1, max: 1, default_weapon_ids: ["scorpion-chainsword", "shuriken-pistol"], is_leader_model: true },
      { name: "Striking Scorpion", min: 4, max: 9, default_weapon_ids: ["scorpion-chainsword", "shuriken-pistol"], is_leader_model: false },
    ],
    "fire-dragons": [
      { name: "Fire Dragon Exarch", min: 1, max: 1, default_weapon_ids: ["dragon-fusion-gun", "close-combat-weapon"], is_leader_model: true },
      { name: "Fire Dragon", min: 4, max: 9, default_weapon_ids: ["dragon-fusion-gun", "close-combat-weapon"], is_leader_model: false },
    ],
    "dark-reapers": [
      { name: "Dark Reaper Exarch", min: 1, max: 1, default_weapon_ids: ["reaper-launcher", "close-combat-weapon"], is_leader_model: true },
      { name: "Dark Reaper", min: 4, max: 9, default_weapon_ids: ["reaper-launcher", "close-combat-weapon"], is_leader_model: false },
    ],
    "swooping-hawks": [
      { name: "Swooping Hawk Exarch", min: 1, max: 1, default_weapon_ids: ["lasblaster", "close-combat-weapon"], is_leader_model: true },
      { name: "Swooping Hawk", min: 4, max: 9, default_weapon_ids: ["lasblaster", "close-combat-weapon"], is_leader_model: false },
    ],
    "warp-spiders": [
      { name: "Warp Spider Exarch", min: 1, max: 1, default_weapon_ids: ["death-spinner", "close-combat-weapon"], is_leader_model: true },
      { name: "Warp Spider", min: 4, max: 9, default_weapon_ids: ["death-spinner", "close-combat-weapon"], is_leader_model: false },
    ],
    "shining-spears": [
      { name: "Shining Spear Exarch", min: 1, max: 1, default_weapon_ids: ["twin-shuriken-catapult", "laser-lance"], is_leader_model: true },
      { name: "Shining Spear", min: 2, max: 5, default_weapon_ids: ["twin-shuriken-catapult", "laser-lance"], is_leader_model: false },
    ],
    // Guardian squads with platforms
    "guardian-defenders": [
      { name: "Guardian Defender", min: 10, max: 10, default_weapon_ids: ["shuriken-catapult", "close-combat-weapon"], is_leader_model: false },
      { name: "Heavy Weapon Platform", min: 1, max: 1, default_weapon_ids: ["bright-lance"], is_leader_model: false },
    ],
    "storm-guardians": [
      { name: "Storm Guardian", min: 10, max: 10, default_weapon_ids: ["shuriken-pistol", "aeldari-power-sword"], is_leader_model: false },
      { name: "Serpent\u2019s Scale Platform", min: 1, max: 1, default_weapon_ids: ["shuriken-catapult"], is_leader_model: false },
    ],
    // Ynnari subfaction units
    "ynnari-incubi": [
      { name: "Klaivex", min: 1, max: 1, default_weapon_ids: ["demiklaives-single-blade"], is_leader_model: true },
      { name: "Incubi", min: 4, max: 9, default_weapon_ids: ["klaive"], is_leader_model: false },
    ],
    "ynnari-kabalite-warriors": [
      { name: "Sybarite", profile_name: "Kabalite Warrior", min: 1, max: 1, default_weapon_ids: ["splinter-pistol", "power-weapon"], is_leader_model: true },
      { name: "Kabalite Warrior", min: 9, max: 9, default_weapon_ids: ["splinter-rifle", "close-combat-weapon"], is_leader_model: false },
    ],
    "ynnari-wyches": [
      { name: "Hekatrix", profile_name: "Wych", min: 1, max: 1, default_weapon_ids: ["splinter-pistol", "power-weapon"], is_leader_model: true },
      { name: "Wych", min: 9, max: 9, default_weapon_ids: ["splinter-pistol", "hekatarii-blade"], is_leader_model: false },
    ],
    "ynnari-reavers": [
      { name: "Arena Champion", profile_name: "Reaver", min: 1, max: 1, default_weapon_ids: ["splinter-pistol", "bladevanes"], is_leader_model: true },
      { name: "Reaver", min: 2, max: 5, default_weapon_ids: ["splinter-pistol", "bladevanes"], is_leader_model: false },
    ],
    // Harlequin Troupe
    "troupe": [
      { name: "Lead Player", profile_name: "Player", min: 1, max: 1, default_weapon_ids: ["shuriken-pistol", "harlequins-blade"], is_leader_model: true },
      { name: "Player", min: 4, max: 11, default_weapon_ids: ["shuriken-pistol", "harlequins-blade"], is_leader_model: false },
    ],
  },
};

registerFaction(aeldari);

export default aeldari;
