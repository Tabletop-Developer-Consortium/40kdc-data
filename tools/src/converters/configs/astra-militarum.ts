import { registerFaction, type FactionConfig } from "../faction-config.js";

const astraMilitarum: FactionConfig = {
  sourceFactionId: "AM",
  factionId: "astra-militarum",
  factionName: "Astra Militarum",
  factionAbilityName: "Voice of Command",
  factionRuleId: "voice-of-command",
  factionKeywords: ["Imperium", "Astra Militarum"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "cadian-shock-troops": [
      { name: "Cadian Sergeant", profile_name: "Cadian Shock Trooper", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Cadian Shock Trooper", min: 9, max: 19, default_weapon_ids: ["lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "catachan-jungle-fighters": [
      { name: "Catachan Sergeant", profile_name: "Catachan Jungle Fighter", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Catachan Jungle Fighter", min: 9, max: 19, default_weapon_ids: ["lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "death-korps-of-krieg": [
      { name: "Watchmaster", profile_name: "Death Korps Trooper", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Death Korps Trooper", min: 9, max: 19, default_weapon_ids: ["lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "kasrkin": [
      { name: "Kasrkin Sergeant", profile_name: "Kasrkin", min: 1, max: 1, default_weapon_ids: ["hot-shot-laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Kasrkin", min: 9, max: 9, default_weapon_ids: ["hot-shot-lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "tempestus-scions": [
      { name: "Tempestor", profile_name: "Tempestus Scion", min: 1, max: 1, default_weapon_ids: ["hot-shot-laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Tempestus Scion", min: 4, max: 9, default_weapon_ids: ["hot-shot-lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "tempestus-aquilons": [
      { name: "Tempestor", profile_name: "Tempestus Aquilon", min: 1, max: 1, default_weapon_ids: ["hot-shot-laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Tempestus Aquilon", min: 9, max: 9, default_weapon_ids: ["hot-shot-lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "death-riders": [
      { name: "Ridemaster", min: 1, max: 1, default_weapon_ids: ["laspistol", "death-rider-hunting-lance"], is_leader_model: true },
      { name: "Death Rider", min: 4, max: 9, default_weapon_ids: ["laspistol", "death-rider-hunting-lance"], is_leader_model: false },
    ],
    "krieg-combat-engineers": [
      { name: "Krieg Engineer Watchmaster", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Krieg Combat Engineer", min: 4, max: 9, default_weapon_ids: ["lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "krieg-heavy-weapons-squad": [
      { name: "Fire Coordinator", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Heavy Weapons Gunner", min: 3, max: 3, default_weapon_ids: ["heavy-bolter", "close-combat-weapon"], is_leader_model: false },
    ],
    // Command squads (multi-model from source)
    "cadian-command-squad": [
      { name: "Cadian Commander", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Cadian Veteran Guardsman", min: 4, max: 4, default_weapon_ids: ["lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "catachan-command-squad": [
      { name: "Catachan Commander", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Veteran Guardsman", min: 4, max: 4, default_weapon_ids: ["lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "krieg-command-squad": [
      { name: "Lord Commissar", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Veteran Guardsman", min: 5, max: 5, default_weapon_ids: ["lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "militarum-tempestus-command-squad": [
      { name: "Tempestor Prime", min: 1, max: 1, default_weapon_ids: ["hot-shot-laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Tempestus Scion", min: 4, max: 4, default_weapon_ids: ["hot-shot-lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "gaunts-ghosts": [
      { name: "Ibram Gaunt", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "power-sword"], is_leader_model: true },
      { name: "Oan Mkoll", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: false },
      { name: "Hlaine Larkin", profile_name: "Oan Mkoll", min: 1, max: 1, default_weapon_ids: ["long-las", "close-combat-weapon"], is_leader_model: false },
      { name: "Elim Rawne", profile_name: "Oan Mkoll", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: false },
      { name: "Brin Milo", profile_name: "Oan Mkoll", min: 1, max: 1, default_weapon_ids: ["lasgun", "close-combat-weapon"], is_leader_model: false },
      { name: "Try Again Bragg", profile_name: "Oan Mkoll", min: 1, max: 1, default_weapon_ids: ["autocannon", "close-combat-weapon"], is_leader_model: false },
    ],
    "attilan-rough-riders": [
      { name: "Rough Rider Sergeant", profile_name: "Attilan Rough Rider", min: 1, max: 1, default_weapon_ids: ["laspistol", "hunting-lance"], is_leader_model: true },
      { name: "Attilan Rough Rider", min: 4, max: 9, default_weapon_ids: ["laspistol", "hunting-lance"], is_leader_model: false },
    ],
  },
};

registerFaction(astraMilitarum);

export default astraMilitarum;
