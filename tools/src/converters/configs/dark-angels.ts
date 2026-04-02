import { registerFaction, type FactionConfig } from "../faction-config.js";

const darkAngels: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "dark-angels",
  factionName: "Dark Angels",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "oath-of-moment",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Dark Angels"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Inner Circle Task Force", "Unforgiven Task Force", "Lion\u2019s Blade Task Force", "Wrath of the Rock"],
};

registerFaction(darkAngels);

export default darkAngels;
