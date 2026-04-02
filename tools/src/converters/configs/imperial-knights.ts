import { registerFaction, type FactionConfig } from "../faction-config.js";

const imperialKnights: FactionConfig = {
  sourceFactionId: "QI",
  factionId: "imperial-knights",
  factionName: "Imperial Knights",
  factionAbilityName: "Code Chivalric",
  factionRuleId: "code-chivalric",
  factionKeywords: ["Imperium", "Imperial Knights"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {},
};

registerFaction(imperialKnights);

export default imperialKnights;
