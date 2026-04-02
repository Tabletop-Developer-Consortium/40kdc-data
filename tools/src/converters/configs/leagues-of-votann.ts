import { registerFaction, type FactionConfig } from "../faction-config.js";

const leaguesOfVotann: FactionConfig = {
  sourceFactionId: "LoV",
  factionId: "leagues-of-votann",
  factionName: "Leagues of Votann",
  factionAbilityName: "Prioritised Efficiency",
  factionRuleId: "prioritised-efficiency",
  factionKeywords: ["Leagues of Votann"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "hearthkyn-warriors": [
      { name: "Theyn", profile_name: "Hearthkyn Warrior", min: 1, max: 1, default_weapon_ids: ["theyns-pistol", "theyns-melee-weapon"], is_leader_model: true },
      { name: "Hearthkyn Warrior", min: 9, max: 9, default_weapon_ids: ["autoch-pattern-bolt-pistol", "close-combat-weapon"], is_leader_model: false },
    ],
    "einhyr-hearthguard": [
      { name: "Hesyr", profile_name: "Einhyr Hearthguard", min: 1, max: 1, default_weapon_ids: ["etacarn-plasma-gun", "concussion-gauntlet"], is_leader_model: true },
      { name: "Einhyr Hearthguard", min: 4, max: 9, default_weapon_ids: ["etacarn-plasma-gun", "concussion-gauntlet"], is_leader_model: false },
    ],
    "brokhyr-iron-master": [
      { name: "Brôkhyr Iron-master", min: 1, max: 1, default_weapon_ids: ["graviton-rifle", "graviton-hammer"], is_leader_model: true },
      { name: "Ironkin Assistant", min: 3, max: 3, default_weapon_ids: ["las-beam-cutter", "close-combat-weapon"], is_leader_model: false },
      { name: "E-COG", min: 1, max: 1, default_weapon_ids: ["plasma-torch", "close-combat-weapon"], is_leader_model: false },
    ],
    "grimnyr": [
      { name: "Grimnyr", min: 1, max: 1, default_weapon_ids: ["ancestral-wrath-witchfire", "ancestral-ward-stave"], is_leader_model: true },
      { name: "CORV", min: 2, max: 2, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
  },
};

registerFaction(leaguesOfVotann);

export default leaguesOfVotann;
