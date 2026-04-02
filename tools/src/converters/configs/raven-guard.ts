import { registerFaction, type FactionConfig } from "../faction-config.js";

const ravenGuard: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "raven-guard",
  factionName: "Raven Guard",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "oath-of-moment",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Raven Guard"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Company of Hunters"],
};

registerFaction(ravenGuard);

export default ravenGuard;
