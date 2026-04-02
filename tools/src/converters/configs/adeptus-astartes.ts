import { registerFaction, type FactionConfig } from "../faction-config.js";

const adeptusAstartes: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "adeptus-astartes",
  factionName: "Adeptus Astartes",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "oath-of-moment",
  factionKeywords: ["Imperium", "Adeptus Astartes"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    // Crusader Squad (Black Templars)
    "crusader-squad": [
      { name: "Sword Brother", profile_name: "Initiate", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "power-weapon"], is_leader_model: true },
      { name: "Initiate", min: 5, max: 11, default_weapon_ids: ["bolt-pistol", "close-combat-weapon"], is_leader_model: false },
      { name: "Neophyte", min: 4, max: 8, default_weapon_ids: ["bolt-pistol", "close-combat-weapon"], is_leader_model: false },
    ],
    // Deathwatch Kill Teams
    "deathwatch-veterans": [
      { name: "Watch Sergeant", min: 1, max: 1, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: true },
      { name: "Deathwatch Veteran", profile_name: "Deathwatch Veterans", min: 4, max: 9, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "decimus-kill-team": [
      { name: "Watch Sergeant", profile_name: "Deathwatch Veteran", min: 1, max: 1, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: true },
      { name: "Deathwatch Veteran", min: 2, max: 7, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
      { name: "Gravis Veteran", min: 2, max: 2, default_weapon_ids: ["bolt-rifle", "close-combat-weapon"], is_leader_model: false },
    ],
    "talonstrike-kill-team": [
      { name: "Kill Team Intercessor with Jump Pack", min: 5, max: 10, default_weapon_ids: ["bolt-rifle", "close-combat-weapon"], is_leader_model: false },
      { name: "Kill Team Heavy Intercessor with Jump Pack", min: 5, max: 5, default_weapon_ids: ["heavy-bolt-rifle", "close-combat-weapon"], is_leader_model: false },
    ],
    // Outrider Squad with optional ATV
    "outrider-squad": [
      { name: "Outrider Sergeant", profile_name: "Outrider", min: 1, max: 1, default_weapon_ids: ["heavy-bolt-pistol", "astartes-chainsword"], is_leader_model: true },
      { name: "Outrider", min: 2, max: 5, default_weapon_ids: ["heavy-bolt-pistol", "astartes-chainsword"], is_leader_model: false },
      { name: "Invader ATV", min: 0, max: 1, default_weapon_ids: ["onslaught-gatling-cannon"], is_leader_model: false },
    ],
    // Space Wolves units
    "wolf-guard-headtakers": [
      { name: "Wolf Guard Headtaker", min: 3, max: 12, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
      { name: "Hunting Wolf", profile_name: "Hunting Wolves", min: 0, max: 2, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
    "wolf-scouts": [
      { name: "Wolf Scout Pack Leader", profile_name: "Wolf Scout", min: 1, max: 1, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: true },
      { name: "Wolf Scout", min: 4, max: 10, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
      { name: "Hunting Wolf", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
    // Character companions
    "chaplain-grimaldus": [
      { name: "Chaplain Grimaldus", min: 1, max: 1, default_weapon_ids: ["plasma-pistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Cenobyte Servitor", min: 3, max: 3, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
    "wardens-of-ultramar": [
      { name: "Veteran Sergeant Metaurus", profile_name: "Veteran Sergeant Metaurus", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Lucia Vestha", profile_name: "Lucia Vestha", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "close-combat-weapon"], is_leader_model: false },
      { name: "Victrix Guard", profile_name: "Veteran Sergeant Metaurus", min: 4, max: 4, default_weapon_ids: ["bolt-pistol", "close-combat-weapon"], is_leader_model: false },
    ],
  },
  detachmentFilter: [
    "Gladius Task Force",
    "Ironstorm Spearhead",
    "1st Company Task Force",
    "Firestorm Assault Force",
    "Vanguard Spearhead",
    "Stormlance Task Force",
    "Anvil Siege Force",
    "Librarius Conclave",
    "Orbital Assault Force",
    "Godhammer Assault Force",
    "Spearpoint Task Force",
  ],
};

registerFaction(adeptusAstartes);

export default adeptusAstartes;
