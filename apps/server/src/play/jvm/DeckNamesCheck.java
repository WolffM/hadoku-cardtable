/*
 * hadoku-cardtable: which card does Forge play for a deck line?
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
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.item.PaperCard;
import forge.util.Lang;
import forge.util.Localizer;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Each line of a file, as one deck's only card in its main deck and its
 * sideboard, read by the bridge's own {@code PlayBridge.parseDeck} against Forge's
 * card database built straight from CARDTABLE_FORGE_RES. Prints, per section,
 * {@code section TAB line TAB forge-name TAB edition TAB OK|UNSUPPORTED}: the card
 * Forge would play, or the one it would remove at the start.
 *
 * Driven by {@code ../deck-names.jvm.test.ts}, compiled and run on a classpath
 * that holds the compiled bridge and the Forge jar.
 */
public class DeckNamesCheck {
    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: DeckNamesCheck <res-dir> <lines-file>");
            System.exit(2);
        }
        String res = args[0].endsWith("/") ? args[0] : args[0] + "/";
        Localizer.getInstance().initialize("en-US", res + "languages/");
        Lang.createInstance("en-US");
        ImageKeys.initializeDirs(null, new HashMap<>(), null, null, null, null, null, null, null);
        new StaticData(
                new CardStorageReader(res + "cardsfolder/", null, false), null,
                res + "editions/", res + "editions/", res + "blockdata/",
                "Latest Art All Editions", true, false);

        for (String line : Files.readAllLines(Path.of(args[1]), StandardCharsets.UTF_8)) {
            if (line.isBlank()) continue;
            Deck deck = PlayBridge.parseDeck("[metadata]\nName=check\n[Main]\n1 " + line + "\n[Sideboard]\n1 " + line + "\n");
            for (DeckSection section : List.of(DeckSection.Main, DeckSection.Sideboard)) {
                for (Map.Entry<PaperCard, Integer> e : deck.get(section)) {
                    PaperCard card = e.getKey();
                    System.out.println(section + "\t" + line + "\t" + card.getName() + "\t" + card.getEdition() + "\t" + (card.getRules().isUnsupported() ? "UNSUPPORTED" : "OK"));
                }
            }
        }
    }
}
