import { registerFaction, type FactionConfig } from "../faction-config.js";

const chaosDaemons: FactionConfig = {
  sourceFactionId: "CD",
  factionId: "chaos-daemons",
  factionName: "Chaos Daemons",
  factionAbilityName: "The Shadow of Chaos",
  factionRuleId: "the-shadow-of-chaos",
  factionKeywords: ["Chaos", "Daemons"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "bloodletters": [
      { name: "Bloodreaper", profile_name: "Bloodletter", min: 1, max: 1, default_weapon_ids: ["hellblade"], is_leader_model: true },
      { name: "Bloodletter", min: 9, max: 9, default_weapon_ids: ["hellblade"], is_leader_model: false },
    ],
    "daemonettes": [
      { name: "Alluress", profile_name: "Daemonette", min: 1, max: 1, default_weapon_ids: ["slashing-claws"], is_leader_model: true },
      { name: "Daemonette", min: 9, max: 9, default_weapon_ids: ["slashing-claws"], is_leader_model: false },
    ],
    "plaguebearers": [
      { name: "Plagueridden", profile_name: "Plaguebearer", min: 1, max: 1, default_weapon_ids: ["plaguesword"], is_leader_model: true },
      { name: "Plaguebearer", min: 9, max: 9, default_weapon_ids: ["plaguesword"], is_leader_model: false },
    ],
    "blue-horrors": [
      { name: "Iridescent Horror", profile_name: "Blue Horror", min: 1, max: 1, default_weapon_ids: ["coruscating-flames"], is_leader_model: true },
      { name: "Blue Horror", min: 9, max: 9, default_weapon_ids: ["coruscating-flames"], is_leader_model: false },
    ],
    "pink-horrors": [
      { name: "Iridescent Horror", profile_name: "Pink Horror", min: 1, max: 1, default_weapon_ids: ["coruscating-flames"], is_leader_model: true },
      { name: "Pink Horror", min: 8, max: 8, default_weapon_ids: ["coruscating-flames"], is_leader_model: false },
      { name: "Brimstone Horror", min: 1, max: 1, default_weapon_ids: ["coruscating-flames"], is_leader_model: false },
    ],
    "seekers": [
      { name: "Heartseeker", profile_name: "Seeker", min: 1, max: 1, default_weapon_ids: ["slashing-claws", "lashing-tongues"], is_leader_model: true },
      { name: "Seeker", min: 4, max: 9, default_weapon_ids: ["slashing-claws", "lashing-tongues"], is_leader_model: false },
    ],
  },
};

registerFaction(chaosDaemons);

export default chaosDaemons;
