package spike;

import org.teavm.extension.spi.reflection.SimpleReflectionPolicy;

/**
 * Overlay: tells TeaVM which Forge classes must keep reflection metadata.
 *
 * Forge's dispatch is an enum holding class literals, and the enum's own
 * constructor reflectively instantiates the class:
 *
 *   ApiType(Class&lt;? extends SpellAbilityEffect&gt; cls) {
 *       instanceEffect = ReflectionUtil.makeDefaultInstanceOf(cls);  // getConstructor().newInstance()
 *   }
 *
 * TeaVM's DCE follows the class literals fine — the classes are linked — but
 * java.lang.reflect only sees members a ReflectionPolicy declares. Without this
 * file the WASM build links and then dies at runtime with
 * "No default constructor found in class forge.game.ability.effects.AbandonEffect".
 *
 * Four packages need it, one per reflective dispatch table:
 *   forge.game.ability.effects  — ApiType,          getConstructor().newInstance()
 *   forge.game.keyword          — Keyword,          getConstructor().newInstance()
 *   forge.game.replacement      — ReplacementType,  getDeclaredConstructors()
 *   forge.game.trigger          — TriggerType,      getDeclaredConstructors()
 *
 * Registered through META-INF/services/org.teavm.extension.spi.reflection.ReflectionPolicy.
 * Nothing under forge/ is touched.
 */
public class ForgeReflectionPolicy extends SimpleReflectionPolicy {
    private static final String[] REFLECTIVE_PACKAGES = {
        "forge.game.ability.effects",
        "forge.game.keyword",
        "forge.game.replacement",
        "forge.game.trigger",
    };

    @Override
    protected void setup() {
        for (String pkg : REFLECTIVE_PACKAGES) {
            selectPackage(pkg, true)
                    .foundByName()
                    .reflectableMembers(member -> true);
        }
    }
}
