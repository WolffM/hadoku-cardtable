package spike;

import forge.game.ability.ApiType;
import forge.game.trigger.TriggerType;
import forge.game.replacement.ReplacementType;

/**
 * Cheapest possible TeaVM probe: no game, no card data, no file I/O.
 *
 * Touching {@code ApiType.values()} runs the enum's static initialiser, which
 * holds 206 class literals (one per ability effect). If TeaVM's whole-program
 * dead-code elimination cannot follow that pattern this is where it breaks,
 * and it breaks in seconds instead of after a full engine link.
 *
 * Run: see scripts/spike/run.sh probe
 */
public final class Probe {
    private Probe() {
    }

    public static void main(String[] args) {
        System.out.println("ApiType constants:         " + ApiType.values().length);
        System.out.println("TriggerType constants:     " + TriggerType.values().length);
        System.out.println("ReplacementType constants: " + ReplacementType.values().length);

        // ApiType's constructor calls ReflectionUtil.makeDefaultInstanceOf, i.e.
        // Class.getConstructor().newInstance(), for every stateless entry. This
        // line proves whether that reflective instantiation survived.
        System.out.println("DealDamage effect class:   "
                + ApiType.DealDamage.getSpellEffect().getClass().getName());
        System.out.println("smartValueOf(\"dealdamage\"): " + ApiType.smartValueOf("dealdamage"));
    }
}
