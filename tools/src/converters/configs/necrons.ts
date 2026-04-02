import { registerFaction, type FactionConfig } from "../faction-config.js";

const necrons: FactionConfig = {
  sourceFactionId: "NEC",
  factionId: "necrons",
  factionName: "Necrons",
  factionAbilityName: "Reanimation Protocols",
  factionRuleId: "reanimation-protocols",
  factionKeywords: ["Necrons"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "the-silent-king": [
      { name: "Szarekh", min: 1, max: 1, default_weapon_ids: ["sceptre-of-eternal-glory"], is_leader_model: true },
      { name: "Triarchal Menhir", min: 2, max: 2, default_weapon_ids: ["annihilator-beam"], is_leader_model: false },
    ],
  },
};

registerFaction(necrons);

export default necrons;
