import { registerFaction, type FactionConfig } from "../faction-config.js";

const crimsonFists: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "crimson-fists",
  factionName: "Crimson Fists",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "oath-of-moment",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Crimson Fists"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Liberator Assault Group"],
};

registerFaction(crimsonFists);

export default crimsonFists;
