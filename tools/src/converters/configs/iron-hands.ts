import { registerFaction, type FactionConfig } from "../faction-config.js";

const ironHands: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "iron-hands",
  factionName: "Iron Hands",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "oath-of-moment",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Iron Hands"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Hammer of Avernii"],
};

registerFaction(ironHands);

export default ironHands;
