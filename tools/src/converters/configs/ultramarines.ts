import { registerFaction, type FactionConfig } from "../faction-config.js";

const ultramarines: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "ultramarines",
  factionName: "Ultramarines",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "oath-of-moment",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Ultramarines"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Blade of Ultramar"],
};

registerFaction(ultramarines);

export default ultramarines;
