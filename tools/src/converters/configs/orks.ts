import { registerFaction, type FactionConfig } from "../faction-config.js";

const orks: FactionConfig = {
  sourceFactionId: "ORK",
  factionId: "orks",
  factionName: "Orks",
  factionAbilityName: "Waaagh!",
  factionRuleId: "waaagh",
  factionKeywords: ["Orks"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "boyz": [
      { name: "Boss Nob", min: 1, max: 1, default_weapon_ids: ["slugga", "choppa"], is_leader_model: true },
      { name: "Boy", min: 9, max: 19, default_weapon_ids: ["slugga", "choppa"], is_leader_model: false },
    ],
    "beast-snagga-boyz": [
      { name: "Beast Snagga Nob", min: 1, max: 1, default_weapon_ids: ["slugga", "choppa"], is_leader_model: true },
      { name: "Beast Snagga Boy", min: 9, max: 19, default_weapon_ids: ["slugga", "choppa"], is_leader_model: false },
    ],
    "kommandos": [
      { name: "Boss Nob", min: 1, max: 1, default_weapon_ids: ["slugga", "power-klaw"], is_leader_model: true },
      { name: "Kommando", min: 9, max: 9, default_weapon_ids: ["slugga", "choppa"], is_leader_model: false },
    ],
    "gretchin": [
      { name: "Runtherd", min: 1, max: 1, default_weapon_ids: ["slugga", "close-combat-weapon"], is_leader_model: true },
      { name: "Gretchin", min: 10, max: 21, default_weapon_ids: ["grot-blasta", "close-combat-weapon"], is_leader_model: false },
    ],
    "stormboyz": [
      { name: "Boss Nob", min: 1, max: 1, default_weapon_ids: ["slugga", "choppa"], is_leader_model: true },
      { name: "Stormboy", min: 4, max: 9, default_weapon_ids: ["slugga", "choppa"], is_leader_model: false },
    ],
    "tankbustas": [
      { name: "Boss Nob", min: 1, max: 1, default_weapon_ids: ["rokkit-launcha", "close-combat-weapon"], is_leader_model: true },
      { name: "Tankbusta", min: 5, max: 5, default_weapon_ids: ["rokkit-launcha", "close-combat-weapon"], is_leader_model: false },
    ],
    "warbikers": [
      { name: "Boss Nob on Warbike", min: 1, max: 1, default_weapon_ids: ["slugga", "choppa"], is_leader_model: true },
      { name: "Warbiker", min: 2, max: 5, default_weapon_ids: ["dakkagun", "close-combat-weapon"], is_leader_model: false },
    ],
    "squighog-boyz": [
      { name: "Nob on Smasha Squig", min: 1, max: 1, default_weapon_ids: ["slugga", "big-choppa"], is_leader_model: true },
      { name: "Squighog Boy", min: 3, max: 7, default_weapon_ids: ["saddlegit-weapons", "squighog-jaws"], is_leader_model: false },
    ],
    "ghazghkull-thraka": [
      { name: "Ghazghkull Thraka", min: 1, max: 1, default_weapon_ids: ["gork-klaw-and-mork-klaw"], is_leader_model: true },
      { name: "Makari", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
    "meganobz": [
      { name: "Meganob with Mega-Shoota", profile_name: "Meganob", min: 1, max: 1, default_weapon_ids: ["kombi-weapon", "power-klaw"], is_leader_model: true },
      { name: "Meganob", min: 1, max: 5, default_weapon_ids: ["kombi-weapon", "power-klaw"], is_leader_model: false },
    ],
    "nobz": [
      { name: "Boss Nob", profile_name: "Nob", min: 1, max: 1, default_weapon_ids: ["slugga", "power-klaw"], is_leader_model: true },
      { name: "Nob", min: 4, max: 9, default_weapon_ids: ["slugga", "choppa"], is_leader_model: false },
    ],
    "burna-boyz": [
      { name: "Spanner", profile_name: "Burna Boy", min: 1, max: 1, default_weapon_ids: ["kustom-mega-blasta", "close-combat-weapon"], is_leader_model: true },
      { name: "Burna Boy", min: 4, max: 9, default_weapon_ids: ["burna", "close-combat-weapon"], is_leader_model: false },
    ],
    "lootas": [
      { name: "Spanner", profile_name: "Loota", min: 1, max: 1, default_weapon_ids: ["kustom-mega-blasta", "close-combat-weapon"], is_leader_model: true },
      { name: "Loota", min: 4, max: 9, default_weapon_ids: ["deffgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "flash-gitz": [
      { name: "Kaptin", profile_name: "Flash Git", min: 1, max: 1, default_weapon_ids: ["snazzgun", "choppa"], is_leader_model: true },
      { name: "Flash Git", min: 4, max: 9, default_weapon_ids: ["snazzgun", "choppa"], is_leader_model: false },
    ],
  },
};

registerFaction(orks);

export default orks;
