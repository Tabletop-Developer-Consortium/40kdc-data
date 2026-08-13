package wh40kdc

import "testing"

const headerlessEventExport = `Participant
Team
Orks
Recon (1995 points)
Taktikal Brigade (3 Detachment Points)

1995 points

BATTLELINE

Squighog Boyz (270 points)
    • Leader: Beastboss on Squigosaur
    • 2x Nob on Smasha Squig
        ◦ 2x Big choppa
    • 6x Squighog Boy
        ◦ 6x Stikka
`

func TestHeaderlessEventPreambleAndAttachmentCount(t *testing.T) {
	parsed, err := gwHeaderlessAdapter.parse(headerlessEventExport)
	if err != nil {
		t.Fatal(err)
	}
	if getStr(parsed, "name") != "Recon" || asInt(parsed["declared_limit"]) != 1995 {
		t.Fatalf("title = %q (%v points)", getStr(parsed, "name"), parsed["declared_limit"])
	}
	if getStr(parsed, "faction_raw_name") != "Orks" {
		t.Fatalf("faction = %q", getStr(parsed, "faction_raw_name"))
	}
	detachments := getList(parsed, "detachment_raw_names")
	if len(detachments) != 1 || detachments[0] != "Taktikal Brigade" {
		t.Fatalf("detachments = %#v", detachments)
	}
	units := getList(parsed, "units")
	if len(units) != 1 {
		t.Fatalf("units = %d", len(units))
	}
	unit := units[0].(map[string]any)
	if getStr(unit, "raw_name") != "Squighog Boyz" || asInt(unit["model_count"]) != 8 {
		t.Fatalf("unit = %#v", unit)
	}
	for _, itemAny := range getList(unit, "wargear") {
		if getStr(itemAny.(map[string]any), "raw_name") == "Beastboss on Squigosaur" {
			t.Fatal("attachment relation leaked into wargear")
		}
	}
}
