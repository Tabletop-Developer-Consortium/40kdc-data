import { registerFaction, type FactionConfig } from "../faction-config.js";

const thousandSons: FactionConfig = {
  sourceFactionId: "TS",
  factionId: "thousand-sons",
  factionName: "Thousand Sons",
  factionAbilityName: "Cabal of Sorcerers",
  factionRuleId: "cabal-of-sorcerers",
  factionKeywords: ["Chaos", "Tzeentch", "Thousand Sons"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "rubric-marines": [
      { name: "Aspiring Sorcerer", min: 1, max: 1, default_weapon_ids: ["inferno-bolt-pistol", "force-weapon"], is_leader_model: true },
      { name: "Rubric Marine", min: 4, max: 9, default_weapon_ids: ["inferno-boltgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "scarab-occult-terminators": [
      { name: "Scarab Occult Sorcerer", min: 1, max: 1, default_weapon_ids: ["inferno-combi-bolter", "force-weapon"], is_leader_model: true },
      { name: "Scarab Occult Terminator", min: 4, max: 9, default_weapon_ids: ["inferno-combi-bolter", "prosperine-khopesh"], is_leader_model: false },
    ],
    "tzaangors": [
      { name: "Twistbray", profile_name: "Tzaangor", min: 1, max: 1, default_weapon_ids: ["autopistol", "tzaangor-blades"], is_leader_model: true },
      { name: "Tzaangor", min: 9, max: 19, default_weapon_ids: ["autopistol", "tzaangor-blades"], is_leader_model: false },
    ],
    "chaos-spawn": [
      { name: "Chaos Spawn", min: 2, max: 2, default_weapon_ids: ["hideous-mutations"], is_leader_model: false },
    ],
  },
};

registerFaction(thousandSons);

export default thousandSons;
