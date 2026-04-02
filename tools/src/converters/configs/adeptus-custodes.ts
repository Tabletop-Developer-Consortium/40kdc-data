import { registerFaction, type FactionConfig } from "../faction-config.js";

const adeptusCustodes: FactionConfig = {
  sourceFactionId: "AC",
  factionId: "adeptus-custodes",
  factionName: "Adeptus Custodes",
  factionAbilityName: "Martial Ka\u2019tah",
  factionRuleId: "martial-katah",
  factionKeywords: ["Imperium", "Adeptus Custodes"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {},
};

registerFaction(adeptusCustodes);

export default adeptusCustodes;
