import { registerFaction, type FactionConfig } from "../faction-config.js";

const imperialFists: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "imperial-fists",
  factionName: "Imperial Fists",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "oath-of-moment",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Imperial Fists"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Bastion Task Force", "Emperor\u2019s Shield"],
};

registerFaction(imperialFists);

export default imperialFists;
