/*
 * hadoku-cardtable: does the deck library resolve in Forge's own card database?
 * Copyright (C) 2026  hadoku-cardtable contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import forge.CardStorageReader;
import forge.ImageKeys;
import forge.StaticData;
import forge.card.CardDb;
import forge.card.CardEdition;
import forge.item.PaperCard;
import forge.util.Lang;
import forge.util.Localizer;

import java.util.HashMap;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Standalone (no PlayBridge, no GuiBase) check: does Forge's own card database,
 * built straight from CARDTABLE_FORGE_RES, know this exact printing? Driven by
 * `../library-resolve.jvm.test.ts`, which feeds it every `(name, set)` pair the
 * committed deck library plays.
 *
 * Launched with Java's single-file source-code launcher (`java -cp forge.jar
 * ResolveCheck.java <res-dir>`, the same trick `host.ts`'s `defaultBridgeSource`
 * uses for `PlayBridge.java`), so there is no separate compile step and no
 * `.class` file to commit or clean up.
 *
 * Reads "Name\tSET" lines from stdin (one per distinct card reference a deck
 * plays), one per line, and for each prints:
 *
 *   OK\tName\tSET          - that edition is known AND the card is printed in it
 *   UNKNOWN_SET\tName\tSET - the SET code itself is not a Forge edition at all
 *   NO_SET\tName\tSET      - the edition is known, but this card is not printed there
 *   UNKNOWN\tName\tSET     - the card NAME itself is not in Forge's database
 *
 * `CardDb.getCard(name, set)` is deliberately NOT what this checks: Forge's own
 * `tryGetCard` (CardDb.java:835-858) falls back silently to a name-only lookup
 * whenever the edition code is not recognised, so it returns a playable card
 * for ANY set code as long as the name exists anywhere — `getCard("Snow-Covered
 * Mountain", "CS")` succeeds even though Forge has no "CS" edition, because the
 * card resolves under the Coldsnap printing via the fallback path regardless.
 * That graceful behaviour is real and good for a player typing a deck by hand,
 * but it means `getCard(name, set)` cannot tell a correct set code from a
 * wrong one, which is exactly what this check exists to catch. So it goes one
 * level lower: look the edition up by itself first (`StaticData.getEditions()`)
 * and, only if that succeeds, ask for the card from THAT edition specifically
 * (`CardDb.getCardFromSet`, which returns null rather than falling back when
 * the card is not printed there). This is exactly how it found two real
 * transcription faults building this library (wave 34 lane D, see
 * `build-library.ts`'s `CARD_SET_FIXUPS`): six Time Spiral "timeshifted"
 * reprints mtgtop8 labels under the main set's code, which Forge has no
 * printing of at all under that code.
 *
 * Usage: java -cp forge.jar ResolveCheck.java <res-dir>
 */
public class ResolveCheck {
    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: ResolveCheck <res-dir>");
            System.exit(2);
        }
        String res = args[0];
        if (!res.endsWith("/")) res = res + "/";

        Localizer.getInstance().initialize("en-US", res + "languages/");
        Lang.createInstance("en-US");
        ImageKeys.initializeDirs(null, new HashMap<>(), null, null, null, null, null, null, null);

        CardStorageReader reader = new CardStorageReader(res + "cardsfolder/", null, false);
        CardStorageReader customReader = null;
        try {
            customReader = new CardStorageReader(res + "customcards/", null, false);
        } catch (Exception e) {
            customReader = null;
        }
        StaticData staticData = new StaticData(
                reader, customReader,
                res + "editions/",
                res + "editions/",
                res + "blockdata/",
                "Latest Art All Editions",
                true, false);
        CardDb db = staticData.getCommonCards();

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        int ok = 0, unknownSet = 0, noSet = 0, unknown = 0;
        while ((line = in.readLine()) != null) {
            if (line.isEmpty()) continue;
            int tab = line.indexOf('\t');
            if (tab < 0) continue;
            String name = line.substring(0, tab);
            String set = line.substring(tab + 1);

            CardEdition edition = staticData.getEditions().get(set.toUpperCase());
            if (edition == null) {
                System.out.println("UNKNOWN_SET\t" + name + "\t" + set);
                unknownSet++;
                continue;
            }

            PaperCard bySet = db.getCardFromSet(name, edition, -1, null, false);
            if (bySet != null) {
                System.out.println("OK\t" + name + "\t" + set);
                ok++;
                continue;
            }
            PaperCard byName = db.getCard(name);
            if (byName != null) {
                System.out.println("NO_SET\t" + name + "\t" + set);
                noSet++;
            } else {
                System.out.println("UNKNOWN\t" + name + "\t" + set);
                unknown++;
            }
        }
        System.err.println("ok=" + ok + " unknownSet=" + unknownSet + " noSet=" + noSet + " unknown=" + unknown);
    }
}
