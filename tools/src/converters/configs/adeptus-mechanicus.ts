import { registerFaction, type FactionConfig } from "../faction-config.js";

const adeptusMechanicus: FactionConfig = {
  sourceFactionId: "AdM",
  factionId: "adeptus-mechanicus",
  factionName: "Adeptus Mechanicus",
  factionAbilityName: "Doctrina Imperatives",
  factionRuleId: "doctrina-imperatives",
  factionKeywords: ["Imperium", "Adeptus Mechanicus"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "skitarii-rangers": [
      { name: "Ranger Alpha", profile_name: "Skitarii Ranger", min: 1, max: 1, default_weapon_ids: ["mechanicus-pistol", "alpha-combat-weapon"], is_leader_model: true },
      { name: "Skitarii Ranger", min: 9, max: 9, default_weapon_ids: ["galvanic-rifle", "close-combat-weapon"], is_leader_model: false },
    ],
    "skitarii-vanguard": [
      { name: "Vanguard Alpha", profile_name: "Skitarii Vanguard", min: 1, max: 1, default_weapon_ids: ["mechanicus-pistol", "alpha-combat-weapon"], is_leader_model: true },
      { name: "Skitarii Vanguard", min: 9, max: 9, default_weapon_ids: ["radium-carbine", "close-combat-weapon"], is_leader_model: false },
    ],
    "sicarian-infiltrators": [
      { name: "Sicarian Princeps", profile_name: "Sicarian Infiltrator", min: 1, max: 1, default_weapon_ids: ["stubcarbine", "power-weapon"], is_leader_model: true },
      { name: "Sicarian Infiltrator", min: 4, max: 9, default_weapon_ids: ["stubcarbine", "power-weapon"], is_leader_model: false },
    ],
    "sicarian-ruststalkers": [
      { name: "Sicarian Princeps", profile_name: "Sicarian Ruststalker", min: 1, max: 1, default_weapon_ids: ["transonic-blades-and-chordclaw"], is_leader_model: true },
      { name: "Sicarian Ruststalker", min: 4, max: 9, default_weapon_ids: ["transonic-blades-and-chordclaw"], is_leader_model: false },
    ],
    "pteraxii-skystalkers": [
      { name: "Pteraxii Alpha", profile_name: "Pteraxii Skystalker", min: 1, max: 1, default_weapon_ids: ["flechette-blaster", "taser-goad"], is_leader_model: true },
      { name: "Pteraxii Skystalker", min: 4, max: 9, default_weapon_ids: ["flechette-carbine", "close-combat-weapon"], is_leader_model: false },
    ],
    "pteraxii-sterylizors": [
      { name: "Pteraxii Alpha", profile_name: "Pteraxii Sterylizor", min: 1, max: 1, default_weapon_ids: ["flechette-blaster", "taser-goad"], is_leader_model: true },
      { name: "Pteraxii Sterylizor", min: 4, max: 9, default_weapon_ids: ["phosphor-torch", "pteraxii-talons"], is_leader_model: false },
    ],
    "serberys-raiders": [
      { name: "Serberys Alpha", profile_name: "Serberys Raider", min: 1, max: 1, default_weapon_ids: ["mechanicus-pistol", "cavalry-sabre-and-clawed-limbs"], is_leader_model: true },
      { name: "Serberys Raider", min: 2, max: 5, default_weapon_ids: ["galvanic-carbine", "cavalry-sabre-and-clawed-limbs"], is_leader_model: false },
    ],
    "serberys-sulphurhounds": [
      { name: "Serberys Alpha", profile_name: "Serberys Sulphurhound", min: 1, max: 1, default_weapon_ids: ["mechanicus-pistol", "cavalry-arc-maul"], is_leader_model: true },
      { name: "Serberys Sulphurhound", min: 2, max: 5, default_weapon_ids: ["sulphur-breath", "clawed-limbs"], is_leader_model: false },
    ],
    "servitor-battleclade": [
      { name: "Servitor Underseer", min: 1, max: 1, default_weapon_ids: ["mechanicus-pistol", "dataspikes"], is_leader_model: true },
      { name: "Combat Servitor", min: 8, max: 8, default_weapon_ids: ["heavy-bolter", "servo-claw"], is_leader_model: false },
    ],
  },
};

registerFaction(adeptusMechanicus);

export default adeptusMechanicus;
