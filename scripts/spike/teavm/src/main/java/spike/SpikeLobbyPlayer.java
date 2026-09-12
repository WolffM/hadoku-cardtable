package spike;

import forge.LobbyPlayer;
import forge.game.Game;
import forge.game.player.IGameEntitiesFactory;
import forge.game.player.Player;
import forge.game.player.PlayerController;

/**
 * The minimum a Game needs to exist: forge.game.Game casts each
 * RegisteredPlayer's LobbyPlayer to IGameEntitiesFactory and asks it for an
 * in-game Player.
 *
 * Forge's own implementations (LobbyPlayerAi, LobbyPlayerHuman) live in
 * forge-ai and forge-gui, which this spike deliberately does not link -- the
 * question is whether forge-core + forge-game alone reach a browser.
 */
public class SpikeLobbyPlayer extends LobbyPlayer implements IGameEntitiesFactory {
    public SpikeLobbyPlayer(String name) {
        super(name);
    }

    @Override
    public void hear(LobbyPlayer player, String message) {
    }

    @Override
    public Player createIngamePlayer(Game game, int id) {
        Player player = new Player(getName(), game, id);
        player.setFirstController(new SpikePlayerController(game, player, this));
        return player;
    }

    @Override
    public PlayerController createMindSlaveController(Player master, Player slave) {
        return new SpikePlayerController(slave.getGame(), slave, this);
    }
}
