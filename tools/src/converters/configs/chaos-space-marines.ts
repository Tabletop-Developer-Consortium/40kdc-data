import { registerFaction, type FactionConfig } from "../faction-config.js";

const chaosSpaceMarines: FactionConfig = {
  sourceFactionId: "CSM",
  factionId: "chaos-space-marines",
  factionName: "Chaos Space Marines",
  factionAbilityName: "Dark Pacts",
  factionRuleId: "dark-pacts",
  factionKeywords: ["Chaos", "Heretic Astartes"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "legionaries": [
      { name: "Aspiring Champion", profile_name: "Legionary", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "accursed-weapon"], is_leader_model: true },
      { name: "Legionary", min: 4, max: 9, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "chosen": [
      { name: "Chosen Champion", profile_name: "Chosen", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "accursed-weapon"], is_leader_model: true },
      { name: "Chosen", min: 4, max: 9, default_weapon_ids: ["bolt-pistol", "accursed-weapon"], is_leader_model: false },
    ],
    "chaos-terminator-squad": [
      { name: "Terminator Champion", profile_name: "Chaos Terminator", min: 1, max: 1, default_weapon_ids: ["combi-bolter", "accursed-weapon"], is_leader_model: true },
      { name: "Chaos Terminator", min: 4, max: 9, default_weapon_ids: ["combi-bolter", "accursed-weapon"], is_leader_model: false },
    ],
    "cultist-mob": [
      { name: "Cultist Champion", profile_name: "Cultist", min: 1, max: 1, default_weapon_ids: ["autopistol", "brutal-assault-weapon"], is_leader_model: true },
      { name: "Cultist", min: 9, max: 19, default_weapon_ids: ["autogun", "close-combat-weapon"], is_leader_model: false },
    ],
    "accursed-cultists": [
      { name: "Torment", min: 1, max: 3, default_weapon_ids: ["hideous-mutations"], is_leader_model: false },
      { name: "Mutant", min: 5, max: 13, default_weapon_ids: ["blasphemous-appendages"], is_leader_model: false },
    ],
    "havocs": [
      { name: "Havoc Champion", profile_name: "Havoc", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "accursed-weapon"], is_leader_model: true },
      { name: "Havoc", min: 4, max: 4, default_weapon_ids: ["lascannon", "close-combat-weapon"], is_leader_model: false },
    ],
    "raptors": [
      { name: "Raptor Champion", profile_name: "Raptor", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "accursed-weapon"], is_leader_model: true },
      { name: "Raptor", min: 4, max: 9, default_weapon_ids: ["bolt-pistol", "close-combat-weapon"], is_leader_model: false },
    ],
    "warp-talons": [
      { name: "Warp Talon Champion", profile_name: "Warp Talon", min: 1, max: 1, default_weapon_ids: ["warp-talon-claws"], is_leader_model: true },
      { name: "Warp Talon", min: 4, max: 9, default_weapon_ids: ["warp-talon-claws"], is_leader_model: false },
    ],
    "chaos-bikers": [
      { name: "Biker Champion", profile_name: "Chaos Biker", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "accursed-weapon"], is_leader_model: true },
      { name: "Chaos Biker", min: 2, max: 5, default_weapon_ids: ["combi-bolter", "close-combat-weapon"], is_leader_model: false },
    ],
    "nemesis-claw": [
      { name: "Nemesis Champion", profile_name: "Nemesis Claw", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "accursed-weapon"], is_leader_model: true },
      { name: "Nemesis Claw", min: 4, max: 9, default_weapon_ids: ["bolt-pistol", "close-combat-weapon"], is_leader_model: false },
    ],
    "red-corsairs-raiders": [
      { name: "Corsair Champion", profile_name: "Red Corsair", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "accursed-weapon"], is_leader_model: true },
      { name: "Red Corsair", min: 4, max: 9, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "traitor-guardsmen-squad": [
      { name: "Traitor Sergeant", profile_name: "Traitor Guardsman", min: 1, max: 1, default_weapon_ids: ["laspistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Traitor Guardsman", min: 9, max: 9, default_weapon_ids: ["lasgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "fellgor-beastmen": [
      { name: "Fellgor Mangler", profile_name: "Fellgor Beastman", min: 1, max: 1, default_weapon_ids: ["autopistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Fellgor Beastman", min: 9, max: 9, default_weapon_ids: ["autopistol", "close-combat-weapon"], is_leader_model: false },
    ],
    "chaos-spawn": [
      { name: "Chaos Spawn", min: 2, max: 2, default_weapon_ids: ["hideous-mutations"], is_leader_model: false },
    ],
    // Character units with companions
    "dark-apostle": [
      { name: "Dark Apostle", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "accursed-crozius"], is_leader_model: true },
      { name: "Dark Disciple", min: 2, max: 2, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
    "dark-commune": [
      { name: "Cult Demagogue", min: 1, max: 1, default_weapon_ids: ["autopistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Blessed Blade", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
      { name: "Mindwitch", profile_name: "Cult Demagogue", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
      { name: "Iconarch", profile_name: "Cult Demagogue", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
      { name: "Accursed Mutant", profile_name: "Blessed Blade", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
    "fabius-bile": [
      { name: "Fabius Bile", min: 1, max: 1, default_weapon_ids: ["xyclos-needler", "chirurgeon"], is_leader_model: true },
      { name: "Surgeon Acolyte", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
    "masters-of-the-maelstrom": [
      { name: "Katar Garrix", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: true },
      { name: "The Enforcer", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
      { name: "Corsair", profile_name: "Katar Garrix", min: 3, max: 3, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "traitor-enforcer": [
      { name: "Traitor Enforcer", min: 1, max: 1, default_weapon_ids: ["autopistol", "close-combat-weapon"], is_leader_model: true },
      { name: "Traitor Ogryn", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
  },
};

registerFaction(chaosSpaceMarines);

export default chaosSpaceMarines;
