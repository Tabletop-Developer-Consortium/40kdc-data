import { registerFaction, type FactionConfig } from "../faction-config.js";

const whiteScars: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "white-scars",
  factionName: "White Scars",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "oath-of-moment",
  factionKeywords: ["Imperium", "Adeptus Astartes", "White Scars"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Reclamation Force"],
};

registerFaction(whiteScars);

export default whiteScars;
