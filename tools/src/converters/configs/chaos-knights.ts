import { registerFaction, type FactionConfig } from "../faction-config.js";

const chaosKnights: FactionConfig = {
  sourceFactionId: "QT",
  factionId: "chaos-knights",
  factionName: "Chaos Knights",
  factionAbilityName: "Harbingers of Dread",
  factionRuleId: "harbingers-of-dread",
  factionKeywords: ["Chaos", "Chaos Knights"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {},
};

registerFaction(chaosKnights);

export default chaosKnights;
