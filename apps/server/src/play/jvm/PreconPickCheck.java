/*
 * hadoku-cardtable: which precon does a seed pick, whatever order the directory lists?
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
import forge.util.Lang;
import forge.util.Localizer;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Random;

/**
 * For each seed, the precon the bridge's own {@code PlayBridge.randomPrecon} deals
 * two seats in a row from the quest precons of CARDTABLE_FORGE_RES, once over the
 * directory's listing and once over the same files in reverse: a filesystem lists
 * a directory in whatever order it likes, and hokon and the claws differ. Prints
 * {@code seed TAB order TAB first-deck TAB second-deck}.
 *
 * Driven by {@code ../precon-pick.jvm.test.ts}, compiled and run on a classpath
 * that holds the compiled bridge and the Forge jar.
 */
public class PreconPickCheck {
    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: PreconPickCheck <res-dir> <seed>...");
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

        File[] listed = new File(res + "quest/precons/").listFiles((d, n) -> n.endsWith(".dck"));
        List<File> reversed = new ArrayList<>(Arrays.asList(listed));
        Collections.reverse(reversed);
        for (int i = 1; i < args.length; i++) {
            long seed = Long.parseLong(args[i]);
            print(seed, "listed", listed);
            print(seed, "reversed", reversed.toArray(new File[0]));
        }
    }

    private static void print(long seed, String order, File[] files) {
        Random random = new Random(seed);
        String first = PlayBridge.randomPrecon(files, random).getName();
        String second = PlayBridge.randomPrecon(files, random).getName();
        System.out.println(seed + "\t" + order + "\t" + first + "\t" + second);
    }
}
