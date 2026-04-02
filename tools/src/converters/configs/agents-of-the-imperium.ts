import { registerFaction, type FactionConfig } from "../faction-config.js";

const agentsOfTheImperium: FactionConfig = {
  sourceFactionId: "AoI",
  factionId: "agents-of-the-imperium",
  factionName: "Agents of the Imperium",
  factionAbilityName: "Assigned Agents",
  factionRuleId: "assigned-agents",
  factionKeywords: ["Imperium", "Agents of the Imperium"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "deathwatch-kill-team": [
      { name: "Watch Sergeant", min: 1, max: 1, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: true },
      { name: "Deathwatch Veteran", profile_name: "Deathwatch Veterans", min: 4, max: 9, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "aquila-kill-team": [
      { name: "Watch Sergeant", profile_name: "Deathwatch Veteran", min: 1, max: 1, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: true },
      { name: "Deathwatch Veteran", min: 2, max: 7, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
      { name: "Gravis Veteran", min: 2, max: 2, default_weapon_ids: ["bolt-rifle", "close-combat-weapon"], is_leader_model: false },
    ],
    "rogue-trader-entourage": [
      { name: "Rogue Trader", min: 1, max: 1, default_weapon_ids: ["dartmask", "close-combat-weapon"], is_leader_model: true },
      { name: "Rejuvenat Adept", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
      { name: "Canid", profile_name: "Rejuvenat Adept", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
      { name: "Lectro-Maester", profile_name: "Rejuvenat Adept", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
    "exaction-squad": [
      { name: "Proctor-Exactant", profile_name: "Cyber-mastiff", min: 1, max: 1, default_weapon_ids: ["arbites-shotpistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Exaction Vigilant", profile_name: "Cyber-mastiff", min: 9, max: 9, default_weapon_ids: ["arbites-combat-shotgun", "close-combat-weapon"], is_leader_model: false },
      { name: "Cyber-mastiff", min: 1, max: 1, default_weapon_ids: ["mechanical-bite"], is_leader_model: false },
    ],
    "subductor-squad": [
      { name: "Subductor Proctor", profile_name: "Cyber-mastiff", min: 1, max: 1, default_weapon_ids: ["arbites-shotpistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Subductor", profile_name: "Cyber-mastiff", min: 9, max: 9, default_weapon_ids: ["arbites-shotpistol", "close-combat-weapon"], is_leader_model: false },
      { name: "Cyber-mastiff", min: 1, max: 1, default_weapon_ids: ["mechanical-bite"], is_leader_model: false },
    ],
    "vigilant-squad": [
      { name: "Vigilant Proctor", profile_name: "Cyber-mastiff", min: 1, max: 1, default_weapon_ids: ["arbites-shotpistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Vigilant", profile_name: "Cyber-mastiff", min: 9, max: 9, default_weapon_ids: ["arbites-combat-shotgun", "close-combat-weapon"], is_leader_model: false },
      { name: "Cyber-mastiff", min: 1, max: 1, default_weapon_ids: ["mechanical-bite"], is_leader_model: false },
    ],
    "voidsmen-at-arms": [
      { name: "Voidmaster", profile_name: "Canid", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Voidsman", profile_name: "Canid", min: 4, max: 4, default_weapon_ids: ["lasgun", "close-combat-weapon"], is_leader_model: false },
      { name: "Canid", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
    "sanctifiers": [
      { name: "Missionary", profile_name: "Missionary", min: 1, max: 1, default_weapon_ids: ["holy-fire", "close-combat-weapon"], is_leader_model: true },
      { name: "Miraculist", min: 2, max: 2, default_weapon_ids: ["ministorum-hand-flamer", "close-combat-weapon"], is_leader_model: false },
      { name: "Salvationist", min: 2, max: 2, default_weapon_ids: ["ministorum-flamer", "close-combat-weapon"], is_leader_model: false },
      { name: "Death Cult Assassin", min: 2, max: 2, default_weapon_ids: ["death-cult-blades"], is_leader_model: false },
      { name: "Sanctifier", min: 2, max: 2, default_weapon_ids: ["sanctifier-melee-weapon"], is_leader_model: false },
    ],
  },
};

registerFaction(agentsOfTheImperium);

export default agentsOfTheImperium;
