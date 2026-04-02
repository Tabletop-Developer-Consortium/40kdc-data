import { registerFaction, type FactionConfig } from "../faction-config.js";

const drukhari: FactionConfig = {
  sourceFactionId: "DRU",
  factionId: "drukhari",
  factionName: "Drukhari",
  factionAbilityName: "Power from Pain",
  factionRuleId: "power-from-pain",
  factionKeywords: ["Aeldari", "Drukhari"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "incubi": [
      { name: "Klaivex", min: 1, max: 1, default_weapon_ids: ["demiklaives-single-blade"], is_leader_model: true },
      { name: "Incubi", min: 4, max: 9, default_weapon_ids: ["klaive"], is_leader_model: false },
    ],
    "kabalite-warriors": [
      { name: "Sybarite", profile_name: "Kabalite Warrior", min: 1, max: 1, default_weapon_ids: ["splinter-pistol", "power-weapon"], is_leader_model: true },
      { name: "Kabalite Warrior", min: 9, max: 9, default_weapon_ids: ["splinter-rifle", "close-combat-weapon"], is_leader_model: false },
    ],
    "wyches": [
      { name: "Hekatrix", profile_name: "Wych", min: 1, max: 1, default_weapon_ids: ["splinter-pistol", "power-weapon"], is_leader_model: true },
      { name: "Wych", min: 9, max: 9, default_weapon_ids: ["splinter-pistol", "hekatarii-blade"], is_leader_model: false },
    ],
    "wracks": [
      { name: "Acothyst", profile_name: "Wrack", min: 1, max: 1, default_weapon_ids: ["stinger-pistol", "power-weapon"], is_leader_model: true },
      { name: "Wrack", min: 4, max: 9, default_weapon_ids: ["twin-torturers-tools"], is_leader_model: false },
    ],
    "hellions": [
      { name: "Helliarch", profile_name: "Hellion", min: 1, max: 1, default_weapon_ids: ["splinter-pistol", "stunclaw"], is_leader_model: true },
      { name: "Hellion", min: 4, max: 9, default_weapon_ids: ["splinter-pods", "hellglaive"], is_leader_model: false },
    ],
    "reavers": [
      { name: "Arena Champion", profile_name: "Reaver", min: 1, max: 1, default_weapon_ids: ["splinter-pistol", "bladevanes"], is_leader_model: true },
      { name: "Reaver", min: 2, max: 5, default_weapon_ids: ["splinter-pistol", "bladevanes"], is_leader_model: false },
    ],
    "scourges-with-heavy-weapons": [
      { name: "Solarite", profile_name: "Scourge", min: 1, max: 1, default_weapon_ids: ["blast-pistol", "power-weapon"], is_leader_model: true },
      { name: "Scourge", min: 4, max: 4, default_weapon_ids: ["shardcarbine", "close-combat-weapon"], is_leader_model: false },
    ],
    "scourges-with-shardcarbines": [
      { name: "Solarite", profile_name: "Scourge", min: 1, max: 1, default_weapon_ids: ["blast-pistol", "power-weapon"], is_leader_model: true },
      { name: "Scourge", min: 4, max: 4, default_weapon_ids: ["shardcarbine", "close-combat-weapon"], is_leader_model: false },
    ],
    "mandrakes": [
      { name: "Nightfiend", profile_name: "Mandrake", min: 1, max: 1, default_weapon_ids: ["baleblast", "glimmersteel-blade"], is_leader_model: true },
      { name: "Mandrake", min: 4, max: 9, default_weapon_ids: ["baleblast", "glimmersteel-blade"], is_leader_model: false },
    ],
  },
};

registerFaction(drukhari);

export default drukhari;
