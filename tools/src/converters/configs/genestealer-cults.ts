import { registerFaction, type FactionConfig } from "../faction-config.js";

const genestealerCults: FactionConfig = {
  sourceFactionId: "GC",
  factionId: "genestealer-cults",
  factionName: "Genestealer Cults",
  factionAbilityName: "Cult Ambush",
  factionRuleId: "cult-ambush",
  factionKeywords: ["Genestealer Cults"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "acolyte-hybrids-with-autopistols": [
      { name: "Acolyte Leader", profile_name: "Acolyte Hybrid", min: 1, max: 1, default_weapon_ids: ["leaders-cult-weapons"], is_leader_model: true },
      { name: "Acolyte Hybrid", min: 4, max: 9, default_weapon_ids: ["autopistol", "cult-claws-and-knife"], is_leader_model: false },
    ],
    "acolyte-hybrids-with-hand-flamers": [
      { name: "Acolyte Leader", profile_name: "Acolyte Hybrid", min: 1, max: 1, default_weapon_ids: ["leaders-cult-weapons"], is_leader_model: true },
      { name: "Acolyte Hybrid", min: 4, max: 9, default_weapon_ids: ["hand-flamer", "cult-claws-and-knife"], is_leader_model: false },
    ],
    "hybrid-metamorphs": [
      { name: "Metamorph Leader", profile_name: "Hybrid Metamorph", min: 1, max: 1, default_weapon_ids: ["leaders-cult-weapons"], is_leader_model: true },
      { name: "Hybrid Metamorph", min: 4, max: 9, default_weapon_ids: ["autopistol", "metamorph-mutations-strike"], is_leader_model: false },
    ],
    "neophyte-hybrids": [
      { name: "Neophyte Leader", profile_name: "Neophyte Hybrid", min: 1, max: 1, default_weapon_ids: ["anointed-pistol", "power-weapon"], is_leader_model: true },
      { name: "Neophyte Hybrid", min: 9, max: 19, default_weapon_ids: ["hybrid-firearm", "close-combat-weapon"], is_leader_model: false },
    ],
    "atalan-jackals": [
      { name: "Atalan Leader", profile_name: "Atalan Jackal", min: 1, max: 1, default_weapon_ids: ["atalan-small-arms", "atalan-power-weapon"], is_leader_model: true },
      { name: "Atalan Jackal", min: 3, max: 7, default_weapon_ids: ["atalan-small-arms", "close-combat-weapon"], is_leader_model: false },
      { name: "Atalan Wolfquad", min: 1, max: 2, default_weapon_ids: ["heavy-stubber", "close-combat-weapon"], is_leader_model: false },
    ],
  },
};

registerFaction(genestealerCults);

export default genestealerCults;
