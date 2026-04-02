import { registerFaction, type FactionConfig } from "../faction-config.js";

const bloodAngels: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "blood-angels",
  factionName: "Blood Angels",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "the-red-thirst",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Blood Angels"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Angelic Inheritors", "The Lost Brethren", "The Angelic Host", "Rage-cursed Onslaught"],
};

registerFaction(bloodAngels);

export default bloodAngels;
