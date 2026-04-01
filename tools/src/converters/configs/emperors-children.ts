import { registerFaction, type FactionConfig } from "../faction-config.js";

const emperorsChildren: FactionConfig = {
  sourceFactionId: "EC",
  factionId: "emperors-children",
  factionName: "Emperor\u2019s Children",
  factionAbilityName: "Thrill Seekers",
  factionRuleId: "thrill-seekers",
  factionKeywords: ["Chaos", "Slaanesh", "Emperor\u2019s Children"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "noise-marines": [
      { name: "Noise Champion", profile_name: "Noise Marine", min: 1, max: 1, default_weapon_ids: ["sonic-blaster", "close-combat-weapon"], is_leader_model: true },
      { name: "Noise Marine", min: 5, max: 5, default_weapon_ids: ["sonic-blaster", "close-combat-weapon"], is_leader_model: false },
    ],
    "tormentors": [
      { name: "Obsessionist", profile_name: "Tormentor", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "power-sword"], is_leader_model: true },
      { name: "Tormentor", min: 4, max: 9, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "infractors": [
      { name: "Obsessionist", profile_name: "Infractor", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "power-sword"], is_leader_model: true },
      { name: "Infractor", min: 4, max: 9, default_weapon_ids: ["bolt-pistol", "duelling-sabre"], is_leader_model: false },
    ],
    "flawless-blades": [
      { name: "Flawless Champion", profile_name: "Flawless Blades", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "blissblade"], is_leader_model: true },
      { name: "Flawless Blade", profile_name: "Flawless Blades", min: 2, max: 5, default_weapon_ids: ["bolt-pistol", "blissblade"], is_leader_model: false },
    ],
    "chaos-terminators": [
      { name: "Terminator Champion", profile_name: "Chaos Terminator", min: 1, max: 1, default_weapon_ids: ["combi-bolter", "accursed-weapon"], is_leader_model: true },
      { name: "Chaos Terminator", min: 4, max: 4, default_weapon_ids: ["combi-bolter", "accursed-weapon"], is_leader_model: false },
    ],
    "chaos-spawn": [
      { name: "Chaos Spawn", min: 2, max: 2, default_weapon_ids: ["hideous-mutations"], is_leader_model: false },
    ],
  },
};

registerFaction(emperorsChildren);

export default emperorsChildren;
