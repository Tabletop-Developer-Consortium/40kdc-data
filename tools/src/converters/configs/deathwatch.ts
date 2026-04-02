import { registerFaction, type FactionConfig } from "../faction-config.js";

const deathwatch: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "deathwatch",
  factionName: "Deathwatch",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "mission-tactics",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Deathwatch"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Black Spear Task Force", "Shadowmark Talon"],
};

registerFaction(deathwatch);

export default deathwatch;
