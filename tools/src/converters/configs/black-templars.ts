import { registerFaction, type FactionConfig } from "../faction-config.js";

const blackTemplars: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "black-templars",
  factionName: "Black Templars",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "templar-vows",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Black Templars"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Wrathful Procession", "Vindication Task Force", "Companions of Vehemence"],
};

registerFaction(blackTemplars);

export default blackTemplars;
