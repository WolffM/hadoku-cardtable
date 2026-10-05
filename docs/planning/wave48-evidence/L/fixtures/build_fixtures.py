import sys, os, json
sys.path.insert(0, os.path.dirname("/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/w48-manager/docs/planning/deck-selection/tools/x"))
sys.path.insert(0, "/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/w48-manager/docs/planning/deck-selection/tools")
import analyze

LEGACY_2010 = {
  "year": 2010, "start": "2010-07-16", "end": "2010-10-01",
  "format": "Legacy (M11)",
  "sets": "LEA, LEB, 2ED, ARN, ATQ, 3ED, LEG, DRC94, DRK, PHPR, FEM, 4ED, ICE, CHR, HML, ALL, MIR, VIS, 5ED, POR, WTH, TMP, STH, EXO, PO2, USG, ATH, ULG, 6ED, UDS, S99, PTK, MMQ, BRB, NMS, S00, PCY, BTD, INV, PLS, 7ED, APC, ODY, DKM, TOR, JUD, ONS, LGN, SCG, 8ED, MRD, DST, 5DN, CHK, BOK, SOK, 9ED, RAV, GPT, DIS, CSP, TSP, TSB, PLC, FUT, 10E, MED, LRW, DD1, MOR, SHM, EVE, DRB, ME2, ALA, DD2, CFX, DDC, ARB, M10, TD0, FVE, HOP, ME3, ZEN, DDD, PDS, WWK, DDE, ROE, DPA, ARC, M11",
  "banned": ["Amulet of Quoz","Ancestral Recall","Balance","Bazaar of Baghdad","Black Lotus","Black Vise","Bronze Tablet","Channel","Chaos Orb","Contract from Below","Darkpact","Demonic Attorney","Demonic Consultation","Demonic Tutor","Earthcraft","Falling Star","Fastbond","Flash","Frantic Search","Goblin Recruiter","Gush","Hermit Druid","Imperial Seal","Jeweled Bird","Land Tax","Library of Alexandria","Mana Crypt","Mana Drain","Mana Vault","Memory Jar","Mind Twist","Mind's Desire","Mishra's Workshop","Mox Emerald","Mox Jet","Mox Pearl","Mox Ruby","Mox Sapphire","Mystical Tutor","Necropotence","Oath of Druids","Rebirth","Shahrazad","Skullclamp","Sol Ring","Strip Mine","Tempest Efreet","Time Spiral","Time Vault","Time Walk","Timetwister","Timmerian Fiends","Tinker","Tolarian Academy","Vampiric Tutor","Wheel of Fortune","Windfall","Worldgorger Dragon","Yawgmoth's Bargain","Yawgmoth's Will"],
}

LEGACY_2011 = dict(LEGACY_2010)
LEGACY_2011.update({
  "year": 2011, "start": "2011-07-15", "end": "2011-09-30", "format": "Legacy (M12)",
  "sets": LEGACY_2010["sets"] + ", FVR, DDF, SOM, TD1, PD2, ME4, MBS, DDG, NPH, TD2, COM, M12",
  "banned": LEGACY_2010["banned"] + ["Survival of the Fittest"],
})

# --- Fixture A: Mishra's Workshop must be refused in EVERY era (spot-checked on 2010 and 2011) ---
workshop_main = [(4, "MRD", "Mishra's Workshop"), (4, "MRD", "Lodestone Golem"), (52, "LEA", "Plains")]
workshop_side = []

for era, label in ((LEGACY_2010, "2010"), (LEGACY_2011, "2011")):
    ill, unk = analyze.legality(workshop_main, workshop_side, era, set(era["banned"]))
    print(f"[Mishra's Workshop fixture, era {label}] illegal={ill} unknown={unk}")
    assert any("Mishra's Workshop" in i and "banned" in i for i in ill), f"expected Workshop refused in {label}"

# --- Fixture B: Survival of the Fittest legal in 2010, banned from 2011 onward ---
survival_main = [(4, "USG", "Survival of the Fittest"), (4, "WTH", "Wall of Blossoms"), (52, "LEA", "Forest")]
survival_side = []

ill10, unk10 = analyze.legality(survival_main, survival_side, LEGACY_2010, set(LEGACY_2010["banned"]))
print(f"[Survival fixture, era 2010 (2010-07-16)] illegal={ill10} unknown={unk10}")
assert not ill10 and not unk10, "expected Survival LEGAL in the 2010 Legacy era"

ill11, unk11 = analyze.legality(survival_main, survival_side, LEGACY_2011, set(LEGACY_2011["banned"]))
print(f"[Survival fixture, era 2011 (2011-07-15)] illegal={ill11} unknown={unk11}")
assert any("Survival of the Fittest" in i and "banned" in i for i in ill11), "expected Survival REFUSED in the 2011 Legacy era"

print("ALL FIXTURE ASSERTIONS PASSED")
