package spike;

import java.util.ArrayList;
import java.util.List;

import forge.StaticData;
import forge.CardStorageReader;
import forge.deck.Deck;
import forge.game.Game;
import forge.game.GameRules;
import forge.game.GameStage;
import forge.game.GameType;
import forge.game.Match;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.player.RegisteredPlayer;
import forge.game.zone.ZoneType;
import forge.item.IPaperCard;

/**
 * The go/no-go target: forge-core + forge-game only -- no forge-gui, no
 * forge-ai, no UI -- load card scripts, construct a Game, resolve a scripted
 * card interaction, print the result.
 *
 * The interaction is Glorious Anthem + Grizzly Bears. Grizzly Bears is a
 * printed 2/2; Glorious Anthem is a static "creatures you control get +1/+1".
 * Nothing about that is hardcoded in Java: both cards are text files under
 * res/cardsfolder, parsed by forge-core, and the +1/+1 is applied by
 * forge-game's continuous-effect layer system when checkStateEffects runs.
 * If the printout says 3/3 the engine really executed a card script.
 *
 * It needs no player input, so SpikePlayerController (which throws on every
 * decision) is never called -- deliberate, see that file.
 *
 * arg[0] is the Forge res/ directory. Under WASM there is no filesystem, which
 * is the point of running the same class on both backends.
 */
public final class SpikeMain {
    private SpikeMain() {
    }

    public static void main(String[] args) {
        String res = args.length > 0 ? args[0] : "res";
        System.out.println("[spike] res dir: " + res);

        // forge-core's Localizer is a hard prerequisite: Player.setName goes
        // through it. It resolves .properties files through a URLClassLoader
        // over a directory -- see the notes in docs/spikes/teavm-go-no-go.md.
        forge.util.Localizer.getInstance().initialize("en-US", res + "/languages");
        forge.util.Lang.createInstance("en-US");
        // Card.fromPaperCard reaches ImageKeys even headless. Empty dirs: this
        // project never touches card images (see CLAUDE.md), and nothing here
        // resolves one.
        forge.ImageKeys.initializeDirs("", new java.util.HashMap<>(), "", "", "", "", "", "", "");

        long t0 = System.currentTimeMillis();
        loadCardData(res);
        System.out.println("[spike] card data loaded in " + (System.currentTimeMillis() - t0) + " ms");
        System.out.println("[spike] cards in db: " + StaticData.instance().getCommonCards().getAllCards().size());

        Game game = newGame();
        Player p = game.getPlayers().get(0);
        System.out.println("[spike] game constructed, players: " + game.getPlayers().size()
                + ", life: " + p.getLife());

        Card bears = addToBattlefield("Grizzly Bears", p);
        game.getAction().checkStateEffects(true);
        System.out.println("[spike] Grizzly Bears alone:            "
                + bears.getNetPower() + "/" + bears.getNetToughness());

        addToBattlefield("Glorious Anthem", p);
        game.getAction().checkStateEffects(true);
        System.out.println("[spike] Grizzly Bears + Glorious Anthem: "
                + bears.getNetPower() + "/" + bears.getNetToughness());

        boolean pass = bears.getNetPower() == 3 && bears.getNetToughness() == 3;
        System.out.println("[spike] RESULT: " + (pass ? "PASS" : "FAIL")
                + " (expected 3/3 after the anthem's static ability applied)");
        if (!pass) {
            throw new AssertionError("static ability did not apply");
        }
    }

    private static void loadCardData(String res) {
        String sep = "/";
        new StaticData(
                new CardStorageReader(res + sep + "cardsfolder", null, false),
                null,
                res + sep + "editions",
                res + sep + "editions",
                res + sep + "blockdata",
                "LATEST_ART_ALL_EDITIONS",
                false,
                true);
    }

    private static Game newGame() {
        List<RegisteredPlayer> players = new ArrayList<>();
        players.add(new RegisteredPlayer(new Deck()).setPlayer(new SpikeLobbyPlayer("spike-a")));
        players.add(new RegisteredPlayer(new Deck()).setPlayer(new SpikeLobbyPlayer("spike-b")));
        GameRules rules = new GameRules(GameType.Constructed);
        Match match = new Match(rules, players, "spike");
        Game game = new Game(players, rules, match);
        game.setAge(GameStage.Play);
        game.getPhaseHandler().devModeSet(PhaseType.MAIN1, game.getPlayers().get(0));
        game.getPhaseHandler().onStackResolved();
        return game;
    }

    private static Card addToBattlefield(String name, Player p) {
        IPaperCard paper = StaticData.instance().getCommonCards().getCard(name);
        if (paper == null) {
            throw new IllegalStateException("card not in db: " + name);
        }
        Card c = Card.fromPaperCard(paper, p);
        c.setGameTimestamp(p.getGame().getNextTimestamp());
        p.getZone(ZoneType.Battlefield).add(c);
        return c;
    }
}
