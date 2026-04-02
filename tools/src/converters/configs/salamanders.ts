import { registerFaction, type FactionConfig } from "../faction-config.js";

const salamanders: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "salamanders",
  factionName: "Salamanders",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "oath-of-moment",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Salamanders"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Forgefather\u2019s Seekers"],
};

registerFaction(salamanders);

export default salamanders;
